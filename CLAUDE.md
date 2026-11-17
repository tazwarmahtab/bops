@AGENTS.md

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate, unless one read-only check confirms the cause and a narrow fix (then fix it and run the focused test)
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Testing

Plane tests: `node --test host/test/*.test.ts` (Node v22 on this machine; the suite uses `node:test`, `node:assert/strict`, `withPlane`, and `FakeDriver`).

Cloud core and edge stay on CI (`.github/workflows/ci.yml`). They need Postgres and Node 24.

<!-- gstack-shortcut(dec-a4ee77be-0f9b-4feb-9f33-8b0ea44dfccf): 7/10, upgrade when Node 24 and Postgres are available for the Cloud suites -->

