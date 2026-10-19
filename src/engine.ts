import { createHash } from 'node:crypto';
import { RevisionConflictError } from './store.js';
import type {
  AgentRequest, AgentResult, AgentRunner, CreateWorkflowInput, DecideInput,
  Proposal, RunStore, TaskDefinition, TaskKind, TaskState, WorkflowSnapshot,
} from './types.js';

const taskKinds: readonly TaskKind[] = [
  'draft', 'problem-framing', 'ideation', 'evaluation', 'diagnosis', 'next-action', 'commitment',
];

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowValidationError(message);
}

function nonempty(value: unknown, name: string): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0, `${name} must be a nonempty string.`);
}

function strings(value: unknown, name: string, allowEmpty = true): asserts value is string[] {
  assert(Array.isArray(value) && (allowEmpty || value.length > 0), `${name} must be an array${allowEmpty ? '' : ' with at least one item'}.`);
  value.forEach((entry, index) => nonempty(entry, `${name}[${index}]`));
}

function validateWorkflow(input: CreateWorkflowInput): void {
  nonempty(input.id, 'id');
  nonempty(input.goal, 'goal');
  strings(input.criteria, 'criteria', false);
  assert(Array.isArray(input.tasks) && input.tasks.length > 0, 'At least one task is required.');
  const tasks = new Map<string, TaskDefinition>();
  for (const task of input.tasks) {
    assert(task !== null && typeof task === 'object', 'Each task must be an object.');
    nonempty(task.id, 'task.id');
    nonempty(task.role, 'task.role');
    nonempty(task.instructions, 'task.instructions');
    assert(taskKinds.includes(task.kind), `Unknown task kind: ${String(task.kind)}.`);
    strings(task.dependsOn, `Task ${task.id} dependencies`);
    assert(new Set(task.dependsOn).size === task.dependsOn.length, `Task ${task.id} has duplicate dependencies.`);
    assert(!tasks.has(task.id), `Duplicate task id: ${task.id}.`);
    tasks.set(task.id, task);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    assert(!visiting.has(id), `Dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id)!.dependsOn) {
      assert(tasks.has(dependency), `Task ${id} references missing dependency ${dependency}.`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
}

export function validateProposal(value: unknown, task: TaskDefinition): asserts value is Proposal {
  assert(value !== null && typeof value === 'object', 'Runner must return a proposal.');
  const proposal = value as Proposal;
  nonempty(proposal.summary, 'proposal.summary');
  strings(proposal.evidence, 'proposal.evidence');
  strings(proposal.assumptions, 'proposal.assumptions');
  strings(proposal.unknowns, 'proposal.unknowns');
  assert(Array.isArray(proposal.options) && proposal.options.length > 0, 'Proposal needs at least one option.');
  const ids = new Set<string>();
  const results = new Set<string>();
  for (const option of proposal.options) {
    assert(option !== null && typeof option === 'object', 'Each option must be an object.');
    for (const key of ['id', 'label', 'consequence', 'result'] as const) nonempty(option[key], `option.${key}`);
    assert(!ids.has(option.id), `Duplicate option id: ${option.id}.`);
    assert(!results.has(option.result.trim()), 'Options must have distinct results; a choice must affect the outcome.');
    ids.add(option.id);
    results.add(option.result.trim());
  }
  assert(task.kind === 'draft' || proposal.options.length >= 2,
    `Judgment task ${task.id} needs at least two distinct options.`);
  assert(proposal.recommendedOptionId === null || ids.has(proposal.recommendedOptionId),
    'recommendedOptionId must be null or identify an existing option.');
}

function validateResult(value: unknown, task: TaskDefinition): asserts value is AgentResult {
  assert(value !== null && typeof value === 'object', 'Runner must return an object.');
  const result = value as AgentResult;
  validateProposal(result.proposal, task);
  if (result.threadId !== undefined) nonempty(result.threadId, 'threadId');
  if (result.usage !== null) {
    assert(result.usage !== undefined && typeof result.usage === 'object', 'usage must be token counts or null.');
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const) {
      assert(Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0, `usage.${key} must be a nonnegative integer.`);
    }
    assert(result.usage.cachedInputTokens <= result.usage.inputTokens, 'Cached input tokens cannot exceed input tokens.');
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function inputsFor(snapshot: WorkflowSnapshot, task: TaskState): AgentRequest['inputs'] {
  return Object.fromEntries(task.definition.dependsOn.map(id => {
    const dependency = snapshot.tasks.find(candidate => candidate.definition.id === id)!;
    assert(dependency.status === 'completed' && typeof dependency.selectedResult === 'string',
      `Dependency ${id} has not completed.`);
    return [id, { result: dependency.selectedResult,
      ...(dependency.decision ? { decision: structuredClone(dependency.decision) } : {}) }];
  }));
}

function basisFor(snapshot: WorkflowSnapshot, task: TaskState): string {
  return createHash('sha256').update(canonical({
    goal: snapshot.goal, criteria: snapshot.criteria, task: task.definition,
    proposal: task.proposal, inputs: inputsFor(snapshot, task),
  })).digest('hex');
}

export class FrictionEngine {
  private readonly store: RunStore;
  private readonly runner: AgentRunner;
  private readonly concurrency: number;
  private readonly advances = new Map<string, Promise<WorkflowSnapshot>>();

  constructor(options: { store: RunStore; runner: AgentRunner; concurrency?: number }) {
    this.store = options.store;
    this.runner = options.runner;
    this.concurrency = options.concurrency ?? 3;
    assert(Number.isSafeInteger(this.concurrency) && this.concurrency > 0, 'concurrency must be a positive integer.');
  }

  create(input: CreateWorkflowInput): WorkflowSnapshot {
    validateWorkflow(input);
    const now = new Date().toISOString();
    const snapshot: WorkflowSnapshot = {
      id: input.id, revision: 0, goal: input.goal, criteria: structuredClone(input.criteria),
      tasks: input.tasks.map(definition => ({ definition: structuredClone(definition), status: 'pending' })),
      createdAt: now, updatedAt: now,
    };
    this.store.create(snapshot);
    return structuredClone(snapshot);
  }

  inspect(id: string): WorkflowSnapshot {
    const snapshot = this.store.load(id);
    if (!snapshot) throw new Error(`Workflow ${id} does not exist.`);
    validateWorkflow({ ...snapshot, tasks: snapshot.tasks.map(task => task.definition) });
    return snapshot;
  }

  advance(id: string): Promise<WorkflowSnapshot> {
    const active = this.advances.get(id);
    if (active) return active;
    const operation = this.advanceUntilBlocked(id).finally(() => this.advances.delete(id));
    this.advances.set(id, operation);
    return operation;
  }

  decide(id: string, taskId: string, input: DecideInput): WorkflowSnapshot {
    const snapshot = this.inspect(id);
    const task = this.task(snapshot, taskId);
    assert(task.status === 'awaiting-decision' && task.proposal, `Task ${taskId} is not awaiting a decision.`);
    nonempty(input.optionId, 'optionId');
    nonempty(input.rationale, 'rationale');
    nonempty(input.revisitWhen, 'revisitWhen');
    nonempty(input.basisHash, 'basisHash');
    validateProposal(task.proposal, task.definition);
    assert(input.basisHash === task.basisHash && input.basisHash === basisFor(snapshot, task),
      'Decision basis is stale. Reload the workflow and review its current proposal and inputs.');
    const option = task.proposal.options.find(candidate => candidate.id === input.optionId);
    assert(option, `Unknown option: ${input.optionId}.`);
    task.decision = { ...structuredClone(input), decidedAt: new Date().toISOString() };
    task.selectedResult = option.result;
    task.status = 'completed';
    return this.save(snapshot);
  }

  /** Failed tasks never retry automatically. Calling this acknowledges another model call. */
  retry(id: string, taskId: string): WorkflowSnapshot {
    const snapshot = this.inspect(id);
    const task = this.task(snapshot, taskId);
    assert(task.status === 'failed', 'Only a failed task can be retried.');
    task.status = 'pending';
    delete task.error;
    return this.save(snapshot);
  }

  private task(snapshot: WorkflowSnapshot, id: string): TaskState {
    const task = snapshot.tasks.find(candidate => candidate.definition.id === id);
    assert(task, `Unknown task: ${id}.`);
    return task;
  }

  private save(snapshot: WorkflowSnapshot): WorkflowSnapshot {
    const expectedRevision = snapshot.revision;
    snapshot.revision += 1;
    snapshot.updatedAt = new Date().toISOString();
    this.store.save(snapshot, expectedRevision);
    return structuredClone(snapshot);
  }

  private async advanceUntilBlocked(id: string): Promise<WorkflowSnapshot> {
    while (true) {
      const snapshot = this.inspect(id);
      const capacity = this.concurrency - snapshot.tasks.filter(task => task.status === 'running').length;
      const ready = snapshot.tasks.filter(task => task.status === 'pending' &&
        task.definition.dependsOn.every(dependencyId =>
          snapshot.tasks.some(dependency => dependency.definition.id === dependencyId && dependency.status === 'completed')))
        .slice(0, Math.max(0, capacity));
      if (ready.length === 0) return snapshot;
      for (const task of ready) task.status = 'running';
      try {
        this.save(snapshot); // Persist all claims before any runner can be invoked.
      } catch (error) {
        if (error instanceof RevisionConflictError) continue;
        throw error;
      }
      await Promise.all(ready.map(task => this.execute(snapshot, task)));
    }
  }

  private async execute(claimed: WorkflowSnapshot, claimedTask: TaskState): Promise<void> {
    let response: AgentResult;
    try {
      response = await this.runner.run({
        runId: claimed.id, task: structuredClone(claimedTask.definition),
        goal: claimed.goal, criteria: structuredClone(claimed.criteria),
        inputs: inputsFor(claimed, claimedTask),
        ...(claimedTask.threadId ? { priorThreadId: claimedTask.threadId } : {}),
      });
      validateResult(response, claimedTask.definition);
      response = structuredClone(response);
    } catch (error) {
      this.record(claimed.id, claimedTask.definition.id, task => {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      });
      return;
    }
    this.record(claimed.id, claimedTask.definition.id, (task, snapshot) => {
      // The result must still refer to the goal, criteria, and inputs sent to the runner.
      assert(canonical({ goal: claimed.goal, criteria: claimed.criteria, task: claimedTask.definition,
        inputs: inputsFor(claimed, claimedTask) }) === canonical({ goal: snapshot.goal, criteria: snapshot.criteria,
        task: task.definition, inputs: inputsFor(snapshot, task) }), 'Workflow inputs changed while its task was running.');
      task.proposal = response.proposal;
      task.usage = response.usage;
      if (response.threadId) task.threadId = response.threadId;
      task.basisHash = basisFor(snapshot, task);
      if (task.definition.kind === 'draft' && response.proposal.options.length === 1) {
        task.status = 'completed';
        task.selectedResult = response.proposal.options[0]!.result;
      } else {
        task.status = 'awaiting-decision';
      }
    });
  }

  private record(id: string, taskId: string, mutate: (task: TaskState, snapshot: WorkflowSnapshot) => void): void {
    while (true) {
      const snapshot = this.inspect(id);
      const task = this.task(snapshot, taskId);
      assert(task.status === 'running', `Task ${taskId} no longer holds its running claim.`);
      try {
        mutate(task, snapshot);
      } catch (error) {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      }
      try {
        this.save(snapshot);
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
    }
  }
}
