import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FrictionEngine, MemoryStore, SQLiteStore, RevisionConflictError,
  type AgentRequest, type AgentResult, type AgentRunner, type Proposal,
  type RunStore, type TaskDefinition, type TaskKind,
} from '../src/index.js';

function task(id: string, kind: TaskKind = 'draft', dependsOn: string[] = []): TaskDefinition {
  return { id, role: 'analyst', kind, instructions: `Analyze ${id} without executing external actions.`, dependsOn };
}

function proposal(count = 1): Proposal {
  return {
    summary: 'Review these options.', evidence: ['A supplied observation'], assumptions: [], unknowns: [],
    options: Array.from({ length: count }, (_, index) => ({
      id: `option-${index + 1}`, label: `Option ${index + 1}`,
      consequence: `Consequence ${index + 1}`, result: `Result ${index + 1}`,
    })),
    recommendedOptionId: 'option-1',
  };
}

function result(count = 1): AgentResult {
  return { proposal: proposal(count), threadId: 'thread-generic', usage: null };
}

function runner(run: AgentRunner['run'] = async request => result(request.task.kind === 'draft' ? 1 : 2)): AgentRunner {
  return { run };
}

function create(engine: FrictionEngine, tasks = [task('draft')], id = 'sample') {
  return engine.create({ id, goal: 'Prepare a useful plan.', criteria: ['Explain the tradeoffs.'], tasks });
}

function decide(engine: FrictionEngine, taskId: string, id = 'sample', optionId = 'option-2') {
  const pending = engine.inspect(id).tasks.find(item => item.definition.id === taskId)!;
  return engine.decide(id, taskId, {
    optionId, rationale: 'I value the second outcome.', revisitWhen: 'The underlying goal changes.',
    basisHash: pending.basisHash!,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('requires a goal, criteria, valid task ids, and an acyclic dependency graph before dispatch', () => {
  let calls = 0;
  const engine = new FrictionEngine({ store: new MemoryStore(), runner: runner(async () => {
    calls += 1;
    return result();
  }) });
  const valid = { id: 'sample', goal: 'Goal', criteria: ['Criterion'], tasks: [task('a')] };
  for (const input of [
    { ...valid, goal: ' ' }, { ...valid, criteria: [] }, { ...valid, criteria: [' '] },
    { ...valid, tasks: [task('a'), task('a')] },
    { ...valid, tasks: [task('a', 'draft', ['missing'])] },
    { ...valid, tasks: [task('a', 'draft', ['b']), task('b', 'draft', ['a'])] },
    { ...valid, tasks: [task('a', 'draft', ['a'])] },
  ]) assert.throws(() => engine.create(input));
  assert.equal(calls, 0);
});

test('a single draft completes automatically while multi-option drafts require a choice', async () => {
  const engine = new FrictionEngine({ store: new MemoryStore(), runner: runner(async request =>
    result(request.task.id === 'single' ? 1 : 2)) });
  create(engine, [task('single'), task('multiple')]);
  const snapshot = await engine.advance('sample');
  assert.equal(snapshot.tasks[0]!.status, 'completed');
  assert.equal(snapshot.tasks[0]!.selectedResult, 'Result 1');
  assert.equal(snapshot.tasks[0]!.decision, undefined);
  assert.equal(snapshot.tasks[0]!.usage, null);
  assert.equal(snapshot.tasks[1]!.status, 'awaiting-decision');
});

test('every judgment kind waits for a human even when the runner recommends an option', async () => {
  const kinds: TaskKind[] = ['problem-framing', 'ideation', 'evaluation', 'diagnosis', 'next-action', 'commitment'];
  const engine = new FrictionEngine({ store: new MemoryStore(), runner: runner() });
  create(engine, kinds.map(kind => task(kind, kind)));
  const snapshot = await engine.advance('sample');
  for (const state of snapshot.tasks) {
    assert.equal(state.status, 'awaiting-decision');
    assert.equal(state.decision, undefined);
    assert.equal(state.selectedResult, undefined);
  }
});

test('the selected result and human rationale reach dependent tasks, including a nonrecommended choice', async () => {
  const requests: AgentRequest[] = [];
  const engine = new FrictionEngine({ store: new MemoryStore(), runner: runner(async request => {
    requests.push(request);
    return result(request.task.kind === 'draft' ? 1 : 2);
  }) });
  create(engine, [task('choice', 'evaluation'), task('followup', 'draft', ['choice'])]);
  await engine.advance('sample');
  assert.deepEqual(requests.map(request => request.task.id), ['choice']);
  const chosen = decide(engine, 'choice');
  assert.equal(chosen.tasks[0]!.selectedResult, 'Result 2');
  await engine.advance('sample');
  assert.equal(requests[1]!.inputs.choice!.result, 'Result 2');
  assert.equal(requests[1]!.inputs.choice!.decision!.rationale, 'I value the second outcome.');
  assert.equal(requests[1]!.inputs.choice!.decision!.revisitWhen, 'The underlying goal changes.');
  assert.deepEqual(requests[1]!.criteria, ['Explain the tradeoffs.']);
});

test('rejects empty reasoning, unknown options, stale hashes, and repeated decisions', async () => {
  const engine = new FrictionEngine({ store: new MemoryStore(), runner: runner() });
  create(engine, [task('choice', 'ideation')]);
  const pending = (await engine.advance('sample')).tasks[0]!;
  const valid = { optionId: 'option-2', rationale: 'A reason', revisitWhen: 'A condition', basisHash: pending.basisHash! };
  for (const input of [
    { ...valid, rationale: '' }, { ...valid, revisitWhen: ' ' },
    { ...valid, optionId: 'missing' }, { ...valid, basisHash: 'stale' },
  ]) assert.throws(() => engine.decide('sample', 'choice', input));
  engine.decide('sample', 'choice', valid);
  assert.throws(() => engine.decide('sample', 'choice', valid), /not awaiting/);
});

test('fingerprints detect changed goals, criteria, proposals, and dependency decisions', async () => {
  for (const change of ['goal', 'criteria', 'proposal', 'dependency'] as const) {
    const store = new MemoryStore();
    const engine = new FrictionEngine({ store, runner: runner() });
    create(engine, [task('first', 'evaluation'), task('second', 'evaluation', ['first'])]);
    await engine.advance('sample');
    decide(engine, 'first');
    const waiting = await engine.advance('sample');
    const basisHash = waiting.tasks[1]!.basisHash!;
    const modified = store.load('sample')!;
    if (change === 'goal') modified.goal = 'A different goal';
    if (change === 'criteria') modified.criteria.push('A different priority');
    if (change === 'proposal') modified.tasks[1]!.proposal!.options[0]!.result = 'A changed outcome';
    if (change === 'dependency') modified.tasks[0]!.decision!.rationale = 'Changed rationale';
    const previous = modified.revision;
    modified.revision += 1;
    store.save(modified, previous);
    assert.throws(() => engine.decide('sample', 'second', {
      optionId: 'option-2', rationale: 'Reason', revisitWhen: 'Condition', basisHash,
    }), /stale/);
  }
});

test('malformed or fake-choice outputs fail and are not automatically retried', async () => {
  const invalid = [
    { ...result(1) },
    { ...result(2), proposal: { ...proposal(2), options: [] } },
    { ...result(2), proposal: { ...proposal(2), recommendedOptionId: 'missing' } },
    { ...result(2), proposal: { ...proposal(2), options: [proposal(2).options[0]!, proposal(2).options[0]!] } },
    { ...result(2), proposal: { ...proposal(2), options: proposal(2).options.map(option => ({ ...option, result: 'Same' })) } },
    { ...result(2), usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 1 } },
  ];
  for (const response of invalid) {
    let calls = 0;
    const engine = new FrictionEngine({ store: new MemoryStore(), runner: runner(async () => {
      calls += 1;
      return response;
    }) });
    create(engine, [task('choice', 'diagnosis'), task('blocked', 'draft', ['choice'])]);
    const failed = await engine.advance('sample');
    assert.equal(failed.tasks[0]!.status, 'failed');
    assert.equal(failed.tasks[1]!.status, 'pending');
    assert.ok(failed.tasks[0]!.error);
    await engine.advance('sample');
    assert.equal(calls, 1);
  }
});

test('explicit retry permits a failed task to make another call', async () => {
  let calls = 0;
  const engine = new FrictionEngine({ store: new MemoryStore(), runner: runner(async () => {
    calls += 1;
    if (calls === 1) throw new Error('A simulated transient failure.');
    return result();
  }) });
  create(engine);
  await engine.advance('sample');
  assert.equal(calls, 1);
  assert.equal(engine.retry('sample', 'draft').tasks[0]!.status, 'pending');
  assert.equal((await engine.advance('sample')).tasks[0]!.status, 'completed');
  assert.equal(calls, 2);
  assert.throws(() => engine.retry('sample', 'draft'), /Only a failed/);
});

test('concurrent advances persist a running claim before calling a runner and never duplicate calls', async () => {
  const store = new MemoryStore();
  const gate = deferred<AgentResult>();
  let calls = 0;
  const sharedRunner = runner(async () => {
    calls += 1;
    assert.equal(store.load('sample')!.tasks[0]!.status, 'running');
    return gate.promise;
  });
  const first = new FrictionEngine({ store, runner: sharedRunner });
  const second = new FrictionEngine({ store, runner: sharedRunner });
  create(first);
  const advancing = first.advance('sample');
  const sameOperation = first.advance('sample');
  assert.equal(advancing, sameOperation);
  assert.equal((await second.advance('sample')).tasks[0]!.status, 'running');
  assert.equal(calls, 1);
  gate.resolve(result());
  assert.equal((await advancing).tasks[0]!.status, 'completed');
  assert.equal(calls, 1);
});

test('concurrency bounds independent tasks and makes progress through the DAG', async () => {
  const gates = [deferred<AgentResult>(), deferred<AgentResult>(), deferred<AgentResult>()];
  const started: string[] = [];
  const engine = new FrictionEngine({ store: new MemoryStore(), concurrency: 2, runner: runner(async request => {
    started.push(request.task.id);
    return gates[Number(request.task.id)]!.promise;
  }) });
  create(engine, [task('0'), task('1'), task('2')]);
  const advancing = engine.advance('sample');
  assert.deepEqual(started, ['0', '1']);
  gates[0]!.resolve(result());
  gates[1]!.resolve(result());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['0', '1', '2']);
  gates[2]!.resolve(result());
  assert.ok((await advancing).tasks.every(state => state.status === 'completed'));
});

test('store snapshots are isolated and compare-and-swap rejects stale writes', () => {
  const store = new MemoryStore();
  const engine = new FrictionEngine({ store, runner: runner() });
  const original = create(engine);
  original.goal = 'Mutating a returned object';
  assert.equal(engine.inspect('sample').goal, 'Prepare a useful plan.');
  const first = store.load('sample')!;
  const stale = store.load('sample')!;
  first.revision += 1;
  store.save(first, 0);
  stale.revision += 1;
  assert.throws(() => store.save(stale, 0), RevisionConflictError);
  assert.throws(() => create(engine), RevisionConflictError);
});

test('SQLite restart preserves awaiting choices and the selected outcome for dependencies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'friction-kit-'));
  const path = join(directory, 'workflow.sqlite');
  let store: SQLiteStore | undefined;
  try {
    store = new SQLiteStore(path);
    const first = new FrictionEngine({ store, runner: runner() });
    create(first, [task('choice', 'evaluation'), task('followup', 'draft', ['choice'])]);
    const waiting = await first.advance('sample');
    const basis = waiting.tasks[0]!.basisHash;
    store.close();
    store = new SQLiteStore(path);
    const requests: AgentRequest[] = [];
    const resumed = new FrictionEngine({ store, runner: runner(async request => {
      requests.push(request);
      return result();
    }) });
    assert.equal(resumed.inspect('sample').tasks[0]!.basisHash, basis);
    decide(resumed, 'choice');
    await resumed.advance('sample');
    assert.deepEqual(requests.map(request => request.task.id), ['followup']);
    assert.equal(requests[0]!.inputs.choice!.result, 'Result 2');
    store.close();
    store = new SQLiteStore(path);
    assert.equal(store.load('sample')!.tasks[0]!.decision!.optionId, 'option-2');
    assert.equal(store.load('sample')!.tasks[1]!.status, 'completed');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('separate SQLite connections share atomic claims and reject stale snapshots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'friction-kit-concurrency-'));
  const path = join(directory, 'workflow.sqlite');
  const firstStore = new SQLiteStore(path);
  const secondStore = new SQLiteStore(path);
  try {
    let calls = 0;
    const gate = deferred<AgentResult>();
    const sharedRunner = runner(async () => { calls += 1; return gate.promise; });
    const first = new FrictionEngine({ store: firstStore, runner: sharedRunner });
    const second = new FrictionEngine({ store: secondStore, runner: sharedRunner });
    create(first);
    const stale = secondStore.load('sample')!;
    const advancing = first.advance('sample');
    assert.equal((await second.advance('sample')).tasks[0]!.status, 'running');
    stale.revision += 1;
    assert.throws(() => secondStore.save(stale, 0), RevisionConflictError);
    gate.resolve(result());
    await advancing;
    assert.equal(calls, 1);
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a changed execution basis fails safely instead of publishing a stale proposal', async () => {
  const store: RunStore = new MemoryStore();
  const gate = deferred<AgentResult>();
  const engine = new FrictionEngine({ store, runner: runner(async () => gate.promise) });
  create(engine);
  const advancing = engine.advance('sample');
  const changed = store.load('sample')!;
  const revision = changed.revision;
  changed.goal = 'A different goal';
  changed.revision += 1;
  store.save(changed, revision);
  gate.resolve(result());
  const snapshot = await advancing;
  assert.equal(snapshot.tasks[0]!.status, 'failed');
  assert.match(snapshot.tasks[0]!.error!, /inputs changed/);
  assert.equal(snapshot.tasks[0]!.proposal, undefined);
});
