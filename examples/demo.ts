import { FrictionEngine, MemoryStore, type AgentRunner } from '../src/index.js';

const runner: AgentRunner = {
  async run(request) {
    const isDraft = request.task.kind === 'draft';
    return {
      usage: null,
      proposal: {
        summary: isDraft ? 'Continue with the selected direction' : 'Compare two approaches',
        evidence: ['Fixture data: no model or real-world research was used.'],
        assumptions: [], unknowns: ['Real user response has not been observed.'],
        options: isDraft ? [{
          id: 'draft', label: 'Draft', consequence: 'A local example artifact only.',
          result: JSON.stringify(request.inputs),
        }] : [
          { id: 'broad', label: 'Build a broad prototype', consequence: 'More features, less validation time.', result: 'Build broad functionality.' },
          { id: 'probe', label: 'Test one user problem', consequence: 'Less scope, more direct feedback.', result: 'Test one user problem with a small prototype.' },
        ],
        recommendedOptionId: isDraft ? null : 'broad',
      },
    };
  },
};

const engine = new FrictionEngine({ store: new MemoryStore(), runner });
engine.create({
  id: 'fixture-demo', goal: 'Learn which user problem deserves a prototype',
  criteria: ['Prefer observed learning over feature count'],
  tasks: [
    { id: 'direction', role: 'planner', kind: 'ideation', instructions: 'Compare directions', dependsOn: [] },
    { id: 'draft', role: 'builder', kind: 'draft', instructions: 'Follow the selected direction', dependsOn: ['direction'] },
  ],
});
const waiting = await engine.advance('fixture-demo');
const task = waiting.tasks.find(t => t.definition.id === 'direction')!;
console.log('MODEL-FREE FIXTURE. Human judgment is simulated for this example.');
console.log('Before decision:', waiting.tasks.map(t => `${t.definition.id}: ${t.status}`).join(', '));
engine.decide('fixture-demo', 'direction', {
  optionId: 'probe', rationale: 'Simulated example: direct feedback matters more than scope.',
  revisitWhen: 'Simulated example: the initial problem is not observed in interviews.',
  basisHash: task.basisHash!,
});
const done = await engine.advance('fixture-demo');
console.log('After decision:', done.tasks.map(t => `${t.definition.id}: ${t.status}`).join(', '));
console.log('Downstream received:', done.tasks.find(t => t.definition.id === 'draft')?.selectedResult);
