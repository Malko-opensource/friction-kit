# Security boundaries

friction-kit assumes a trusted host application. Workflow decisions are application records, not cryptographic proof of human identity. Enforce authentication and authorization at your own input boundary.

The Codex adapter defaults to analysis: read-only filesystem, disabled model web search and network access, and disabled shell/apps capabilities. Configured MCP integrations are separate capabilities. The adapter must inspect and disable inherited integrations before a live run; failure to establish that state must stop the run. Do not use prompt wording as a substitute for permissions.

Read-only filesystem access does not prevent reading sensitive local files. Use a dedicated workspace and a minimal Codex configuration, and grant only the data a task needs. A host configuration change, executable replacement, or malicious in-process caller is outside this library's protection boundary. No claim of OS-level isolation is made by the workflow tests.

The library does not supply external-action tools. If you add one, bind its execution to the reviewed action, arguments, target, and current state. Isolate the external call from model/review retries, persist an operation identifier, and reconcile uncertain outcomes before retrying. A stored approval alone does not make an API operation idempotent.

Keep credentials, raw private documents, and live decision databases out of public repositories. Model prompts may contain the material supplied by the host; review that material before using a provider. Token usage is not a provider invoice.
