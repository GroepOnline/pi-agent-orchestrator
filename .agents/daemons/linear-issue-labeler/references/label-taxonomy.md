# Linear Label Taxonomy (CHEF)

Source: live labels from Linear workspace (team CHEF / ChefSheesh).

## Family: type (single-select)
- Bug
- Feature
- Improvement
- tech-debt

## Family: area (multi-select)
- infrastructure
- devops
- automation
- security
- api
- backend
- database
- docs
- architecture
- agent
- agent-skill
- llm-prompt
- tui

## Family: language (multi-select)
- typescript
- python
- go
- powershell

## Family: effort (single-select, human-owned)
- Effort: S
- Effort: M
- Effort: L
- Effort: XL

## Reserved / system labels (do not auto-apply)
- Devin Playbooks
- !plan
- !implement
- !review
- !triage
- Migrated

## Notes
- For this repository (pi-agent-orchestrator), default area seed is `infrastructure`; add others only with evidence from changed files or issue text.
- `agent-skill` applies when the issue involves skill loading, registration, or skill lifecycle managed by the orchestrator.
- `rag`, `skill-grinder`, and `web` are excluded from this repo's taxonomy; those labels apply to other GroepOnline repositories.
