import { CodexRunner } from '../src/index.js';

// Explicitly opt-in: this uses real Codex access and may consume account usage.
const runner = new CodexRunner({ workingDirectory: process.cwd(),
  ...(process.env.CODEX_PATH ? { codexPath: process.env.CODEX_PATH } : {}),
  ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
  timeoutMs: 90_000,
});
console.log('Live Codex SDK connection check; only generic test data is sent.');
const response = await runner.run({
  runId: 'generic-live-smoke', goal: 'Verify structured SDK output using generic test data',
  criteria: ['Return one usable draft option', 'Do not claim research or tool verification'],
  task: { id: 'connection-check', role: 'test', kind: 'draft', dependsOn: [],
    instructions: 'Produce one short draft result saying that this generic structured response was generated. Evidence may cite only this prompt; do not claim external facts or tool use.' },
  inputs: {},
});
console.log(JSON.stringify({ success: true, threadId: response.threadId,
  options: response.proposal.options.length, usage: response.usage,
  billing: 'Not confirmed; token usage is not an invoice.' }, null, 2));
