# Security

Thanks for helping keep this project safe. This is a local Pi extension: it
runs inside your own Pi coding-agent host and has no package-owned hosted
control plane. Optional PostHog telemetry is disabled unless an operator
explicitly configures it. Small is not zero, though. The extension reads
environment variables and files in your workspace, injects that content into
agent prompts, and can run commands on your machine through the sub-agents it
spawns. This page covers how to report anything that looks wrong.

## Reporting a vulnerability

If you think you've found a security issue, please report it privately first,
so a fix can land before the details are public:

1. **Preferred:** use GitHub's private vulnerability reporting. Open the
   [Security advisories page](https://github.com/GroepOnline/pi-agent-orchestrator/security/advisories/new)
   and click "Report a vulnerability". It's a private channel only the
   maintainers can see.
2. **Or email** **security@chefgroep.nl** if you'd rather not use GitHub.

Please don't open a public GitHub issue for a suspected vulnerability: a public
report can expose an exploitable problem before there's a fix. Public issues
are welcome for clearly non-sensitive bugs, or once we've triaged a report and
agreed it's safe to discuss in the open.

## What we'd like to know

- What you did (the steps or a tiny repro)
- What you saw
- What you expected
- The version (run "npm view @groeponline/pi-agent-orchestrator version" or check the commit hash)

## What we'll do

- Reply within a few days (we're a small team, be patient).
- Confirm or close the report.
- If it's real, ship a fix and credit you in the release notes (unless
  you prefer to stay anonymous).

## Scope

In scope: the source under "src/", the published npm package
"@groeponline/pi-agent-orchestrator", and the example agent templates under
"examples/agents/". If this extension is the source of the problem, it stays in
scope even when the impact lands on the Pi host, a peer extension, or your
machine (for example: the extension running an unintended command, leaking a
secret it read, or mishandling prompt content it injected).

Out of scope (report to their owners when the issue originates in them, not in
this extension):

- The Pi host platform ("@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai", "@earendil-works/pi-agent-core").
- The optional "@groeponline/context-mode" peer extension.
- Your local Pi host, your model provider, and your machine.

## Runtime dependency rationale

The published package intentionally keeps runtime dependencies small and auditable:

| Dependency | Why it is present |
| --- | --- |
| `@opentelemetry/api` | Standard tracing/telemetry interop without owning a backend. |
| `@sinclair/typebox` | Runtime schemas for tool and RPC contracts. |
| `croner` | Cron/interval scheduling for persistent agent jobs. |
| `nanoid` | Collision-resistant local identifiers. |
| `posthog-node` | Optional telemetry bridge; inert until explicitly configured. |
| `proper-lockfile` | Cross-process locking for persisted scheduler/orchestration state. |

Release CI runs the package test/typecheck/lint/build/metadata gates. Dependency changes should be treated as security-relevant review items, especially packages that can affect scheduling, persistence, RPC, or telemetry.

## Cross-extension RPC trust model

The normal runtime creates a random per-process RPC capability token and wires it into the public API. Mutating RPC calls such as `spawn` and `stop` must present the matching token; caller-controlled `extensionId` alone is not authorization. Mutations are rate-limited per sanitized extension identity, and spawn options are reduced to an allowlist so a peer cannot smuggle privilege-escalating options such as arbitrary `cwd` or queue bypasses. The complete protocol is documented in [`docs/api-reference.md`](docs/api-reference.md#-cross-extension-rpc).

## A note on this project

The orchestration runtime is local and stores no user data on a ChefGroep
server. Optional PostHog events are an explicit operator-configured network
boundary and are inert by default. But "local" is not the same as "safe".
Because it reads your environment and workspace, injects that into prompts, and
executes commands through sub-agents, the realistic risks are worth taking
seriously: unintended or destructive commands, privilege escalation, exposure
of secrets or local data, prompt injection through untrusted file content, and
unsafe tool use. We treat those as security issues, not just prompt-review
nitpicks, so please report them. Reading the prompts your sub-agents run and
pinning their tools genuinely reduces the risk.
