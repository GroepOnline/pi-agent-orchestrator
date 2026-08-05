# Security

Thanks for helping keep this project safe. This is a local Pi extension: it
runs inside your own Pi coding-agent host and makes no outbound network calls
of its own, so the attack surface is small. Small is not zero, though. The
extension reads environment variables and files in your workspace, injects that
content into agent prompts, and can run commands on your machine through the
sub-agents it spawns. This page covers how to report anything that looks wrong.

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
- The optional "@onlinechef/context-mode" peer extension.
- Your local Pi host, your model provider, and your machine.

## A note on this project

This extension is local-only: it makes no outbound network calls of its own and
stores no user data on any server. But "local" is not the same as "safe".
Because it reads your environment and workspace, injects that into prompts, and
executes commands through sub-agents, the realistic risks are worth taking
seriously: unintended or destructive commands, privilege escalation, exposure
of secrets or local data, prompt injection through untrusted file content, and
unsafe tool use. We treat those as security issues, not just prompt-review
nitpicks, so please report them. Reading the prompts your sub-agents run and
pinning their tools genuinely reduces the risk.
