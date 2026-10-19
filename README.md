# friction-kit

Intentional friction for multi-agent workflows built with the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

Agents prepare evidence and meaningfully different alternatives. People set criteria, choose a direction, and record when to reconsider. The selected result and the person's reason become inputs to dependent tasks. An AI recommendation never counts as a human decision.

## What runs today

- Dependency graphs with bounded parallel execution and independent Codex threads.
- Six judgment points: problem framing, ideation, evaluation, diagnosis, next action, and commitment.
- Automatic continuation for ordinary drafts; judgment tasks pause until a person chooses.
- Decisions bound to a proposal fingerprint; stale or repeated decisions are rejected.
- SQLite checkpoints, optimistic concurrency, explicit retries, and token usage provenance.
- A real Codex SDK adapter and a model-free example for inspecting the workflow.

This is a workflow library, not evidence that added friction improves cognition. The default Codex runner prepares proposals in a read-only environment. It does not implement publication, payments, calendar writes, or a general-purpose autonomous executor.

## Quick start

Requires Node.js 22.13+ (SQLite support) and npm. Live runs additionally require an installed, authenticated Codex CLI. Model access and usage limits are separate from this package.

```sh
npm ci
npm run check
npm run demo
```

The demo uses deterministic fixtures and makes no model calls. To use the library:

For an explicit live connection check, run `npm run smoke` from a Git checkout after installing and authenticating the Codex CLI. It sends generic test data and consumes real account usage. An omitted model uses your configured default. The restricted runner cannot browse sources or implement files; supply relevant evidence as workflow inputs.

```ts
import { FrictionEngine, SQLiteStore, CodexRunner } from '@malko-opensource/friction-kit';

const engine = new FrictionEngine({
  store: new SQLiteStore('.runtime/workflows.sqlite'),
  runner: new CodexRunner({ workingDirectory: process.cwd() }),
  concurrency: 2,
});

engine.create({
  id: 'example',
  goal: 'Choose which problem to solve for a small prototype',
  criteria: ['Learn from a real user', 'Keep the scope achievable'],
  tasks: [{
    id: 'direction', role: 'planner', kind: 'ideation',
    instructions: 'Compare distinct directions, evidence gaps, and trade-offs.',
    dependsOn: [],
  }],
});

const snapshot = await engine.advance('example');
// Render the awaiting-decision task's options to a person.
// Only call engine.decide with their actual selection, reason,
// reconsideration condition, and the displayed task.basisHash.
```

Do not fill in the person's reason with generated text. Let the person say they do not know, gather evidence, reject the alternatives, or start a revised workflow. A longer answer is not necessarily a better decision.

## Contracts and boundaries

`draft` tasks return exactly one result and may continue automatically. Judgment tasks must return at least two distinct results. A runner returns evidence, assumptions, unknowns, alternatives, and optional usage. These fields are structured claims, not independent verification.

The workflow store owns task state and decisions. The runner owns model execution. The host application owns human identity, input authenticity, tool permissions, and any external effects. Code calling `decide()` is trusted; this package cannot distinguish a real person from a caller impersonating one. An HTTP service must authenticate decision requests itself.

See [architecture](docs/architecture.md), [research and evaluation](docs/research.md), and [security boundaries](SECURITY.md). APIs are initial and may change before 1.0.

## Development

`npm run build` compiles the library. `npm test` exercises workflow gates, choice propagation, persistence, concurrent advances, and adapter behavior with injected model fixtures. Those checks establish software behavior, not native sandbox guarantees or cognitive benefit.

MIT licensed.
