export type TaskKind =
  | 'draft'
  | 'problem-framing'
  | 'ideation'
  | 'evaluation'
  | 'diagnosis'
  | 'next-action'
  | 'commitment';

export interface TaskDefinition {
  id: string;
  role: string;
  kind: TaskKind;
  instructions: string;
  dependsOn: string[];
}

export interface ProposalOption {
  id: string;
  label: string;
  consequence: string;
  result: string;
}

export interface Proposal {
  summary: string;
  evidence: string[];
  assumptions: string[];
  unknowns: string[];
  options: ProposalOption[];
  recommendedOptionId: string | null;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface HumanDecision {
  optionId: string;
  rationale: string;
  revisitWhen: string;
  basisHash: string;
  decidedAt: string;
}

export interface AgentRequest {
  runId: string;
  task: TaskDefinition;
  goal: string;
  criteria: string[];
  inputs: Record<string, { result: string; decision?: HumanDecision }>;
  priorThreadId?: string;
}

export interface AgentResult {
  proposal: Proposal;
  threadId?: string;
  /** Null means usage was not reported; it never means zero cost. */
  usage: TokenUsage | null;
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}

export type TaskStatus = 'pending' | 'running' | 'awaiting-decision' | 'completed' | 'failed';

export interface TaskState {
  definition: TaskDefinition;
  status: TaskStatus;
  proposal?: Proposal;
  decision?: HumanDecision;
  selectedResult?: string;
  basisHash?: string;
  threadId?: string;
  usage?: TokenUsage | null;
  error?: string;
}

export interface WorkflowSnapshot {
  id: string;
  revision: number;
  goal: string;
  criteria: string[];
  tasks: TaskState[];
  createdAt: string;
  updatedAt: string;
}

/** Each operation is synchronous. Save must atomically compare the revision. */
export interface RunStore {
  create(snapshot: WorkflowSnapshot): void;
  load(id: string): WorkflowSnapshot | undefined;
  save(snapshot: WorkflowSnapshot, expectedRevision: number): void;
}

export interface CreateWorkflowInput {
  id: string;
  goal: string;
  criteria: string[];
  tasks: TaskDefinition[];
}

export interface DecideInput {
  optionId: string;
  rationale: string;
  revisitWhen: string;
  basisHash: string;
}
