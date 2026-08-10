# // CUSTOM AGENT AUTHORING GUIDE

> CONFIGURATION, DEPLOYMENT, AND CONSTRAINTS FOR CUSTOM SUB-AGENTS VIA `.pi/agents/*.md` FILES.

---

## // QUICK START BOOTSTRAP

Target directory: `.pi/agents/typescript-reviewer.md` at project root.

```markdown
---
display_name: "TypeScript Reviewer"
description: "Read-only reviewer for TypeScript changes"
tools: read, grep, bash
disallowed_tools: write, edit
extensions: false
skills: true
max_turns: 20
prompt_mode: replace
---
You are a senior TypeScript code reviewer.

Focus on type safety, error handling, async control flow, and maintainability.
Report findings with severity, exact file paths, and actionable fixes.
Never modify files.
```

Filename equates to system identifier (`typescript-reviewer`).

**Load paths:**
1. Project scope: `.pi/agents/*.md`
2. Global scope: `$PI_CODING_AGENT_DIR/agents/*.md` or `~/.pi/agent/agents/*.md`

Project scope strictly overrides global scope collisions.

---

> **Allowed `tools` values** match `BUILTIN_TOOL_NAMES` in `src/agent-types.ts`: `read`, `bash`, `edit`, `write`, `grep` (plus `*` for all). Host tools named `find` / `ls` are **not** in the allowlist and are rejected or ignored by the loader.

## // DEFINITION FORMAT

Markdown primitive format with YAML frontmatter. Post-frontmatter body block parses as the system prompt directive.

```markdown
---
description: "Short description shown in menus"
tools: read, grep
---
System prompt starts here.
```

Subdirectories are explicitly ignored. Symlink references are skipped.

---

## // FRONTMATTER SCHEMA

| Directive | Primitive Type | Default Value | Operational Definition |
|---|---|---|---|
| `display_name` | string | file name | User-interface label. |
| `description` | string | file name | Telemetry and menu description string. |
| `tools` | CSV / `none` | all | Authorized primitive toolset. |
| `disallowed_tools` | CSV | none | Hard floor nullification block. Trumps availability. |
| `extensions` | boolean / CSV / `none` | `true` | Module access. Set `false`/`none` for zero expansion. |
| `skills` | boolean / CSV / `none` | `true` | Skill primitive preload list. |
| `model` | string | host default | Model execution override. Resolves via host registry. Tool `params.model` overrides profile when set. |
| `thinking` | string | none | Inference effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Tool `params.thinking` overrides profile when set. |
| `max_turns` | number | host default | Maximum bounded turn integer (`0` = infinite). |
| `prompt_mode` | `replace` / `append` | `replace` | System directive injection mode. |
| `inherit_context` | boolean | caller defined | Inheritance directive for vector payload. |
| `run_in_background` | boolean | caller defined | Execution thread blocking control. |
| `isolated` | boolean | caller defined | Sandbox topology switch. |
| `memory` | `user` / `project` / `local` | none | State persistence storage volume. |
| `isolation` | `worktree` | none | Git worktree detachment mode. |
| `handoff` | boolean / string | `false` | Produce structured JSON handoff at end of response. Enables chain-of-agents workflows. |
| `prompt_compression` | `minimal` / `balanced` / `aggressive` | inherits global | Per-agent selection for generated read-only/handoff guidance. It does not compress this file's custom prompt body. With the default `handoff: false`, it currently has no effect on an ordinary custom agent. |
| `enabled` | boolean | `true` | Binary load toggle. |

Non-schema fields are silently dropped. Loader explicitly ignores `name`, `systemPrompt`, `builtinToolNames`, `disallowedTools`, `validators` within the YAML block.

See [Prompt compression](prompt-compression.md) for the exact scope and measurement limitations.

---

## // TOOL CONSTRAINTS

Valid primitive values:

| Primitive | Operation |
|---|---|
| `read` | Retrieve block contents. |
| `write` | Create or overwrite blocks. |
| `edit` | Mutate block state. |
| `bash` | Execute shell commands. |
| `grep` | Stream content search. |

Syntax:

```yaml
tools: read, grep
disallowed_tools: write, edit
```

Syntax for nullified execution (prompt-only): `tools: none`.

---

## // SECURITY DIRECTIVES

### Explicit Nullification Floors

Read-only agents mandate both an allowlist and a disallow list:

```yaml
tools: read, grep, bash
disallowed_tools: write, edit
```

### Module Boundary Enforcement

```yaml
extensions: false
```

Extensions expand attack surface matrices. Nullify default access for narrow review, planning, and enumeration agents.

### Worktree State Separation

```yaml
tools: read, write, edit, grep, bash
isolation: worktree
```

Forces parallel physical detachment from master working tree state pending deliberate integration.

### Override Collisions

Custom definitions override primitive definitions by identical filename. Wildcard primitive overrides fail validation checks.

---

## // DIRECTIVE INJECTION MODES

### `replace`

Agent payload completely overwrites generic instructions. Optimal state for isolated domains.

```yaml
prompt_mode: replace
```

### `append`

Agent payload attaches to standard vector instruction block. Use strictly for sub-variant topologies.

```yaml
prompt_mode: append
```

---

## // CANONICAL EXAMPLES

Reference material located at `examples/agents/`:

| Specimen | Subsystem Function |
|---|---|
| `adversarial-validator.md` | Non-mutating code analysis. |
| `handoff-chain-researcher.md` | Data gathering agent outputting structured JSON payload. |
| `handoff-chain-implementer.md` | Worktree-detached logic builder driven by JSON payload. |
| `scheduled-explorer.md` | Temporal chronometric scan agent. |
| `worktree-isolated-editor.md` | Physical detachment editing block. |

Copy target specimen to `.pi/agents/` to activate inside scope.

---

## // HANDOFF WORKFLOWS

When `handoff: true` is set, the agent produces a structured JSON handoff at the end of its response. This enables chain-of-agents pipelines where one agent's output feeds directly into the next.

### Handoff + Compression

Compression levels affect only the generated handoff instructions; they do not rewrite the custom prompt body:

| Level | Handoff Prompt Style |
|---|---|
| `minimal` | Full verbose instructions with field descriptions and two examples |
| `balanced` | Concise instructions with one example (default) |
| `aggressive` | Minimal required schema; optional protocol detail is omitted |

```markdown
---
display_name: "Researcher"
tools: read, grep
handoff: true
prompt_compression: minimal
---

Investigate the codebase and emit a structured handoff JSON with:
- "task": what needs to be done
- "files": affected file paths
- "approach": recommended implementation strategy
- "evidence": supporting code snippets
```

### Three-Example Pipeline

See README.md "Chain of Agents" section for complete Research→Write→Review, Test→Fix→Verify, and Multi-perspective Analysis examples.

---

## // TROUBLESHOOTING MATRIX

### Definition Missing From Load

Validation checks:
- Suffix requires `.md`.
- Placement must be top-level `.pi/agents/`.
- YAML block requires strict `---` boundaries.
- `enabled` flag must evaluate `true`.
- Symlink pointers fail standard ingestion.

### Constraint Violations

Base state includes full primitive access. Explicit definition of `tools` and `disallowed_tools` is mandatory to restrict capabilities.

### Corrupted System Directives

System prompt defined strictly via post-frontmatter Markdown. YAML field definitions (`systemPrompt: ...`) fail ingestion parser.
