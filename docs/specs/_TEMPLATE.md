# Spec — <ID> · <Title>

> Copy this file to `docs/specs/<id>-<slug>.md` and fill every section. Delete the instructional
> blockquotes (like this one) as you go. This spec will be implemented by a **lesser model with no
> prior context** — write so that a reader who has opened *only this file* could produce the correct
> diff. If anything requires judgement, make the decision here; do not defer it to the implementer.

| Field | Value |
|---|---|
| **Item ID** | <e.g. H2> |
| **Title** | <short title> |
| **Plan reference** | [`upgrade-plan.md` → <ID>](../upgrade-plan.md) |
| **Target** | Cloud / Electron / Both |
| **Severity** | Critical / High / Medium |
| **Owner tag** | `[claude]` / `[copilot]` / `[copilot+review]` |
| **Status** | planned → spec → ready → wip → done |
| **Depends on** | <item IDs that must be `done` first, or "none"> |
| **Author / reviewer** | <name> / <name> |

---

## 1. Context (self-contained)

> Restate the problem in full. Do NOT assume the reader has read the audit or the master plan.
> Include the current behaviour, why it is wrong/insufficient, and the user-visible impact.
> Quote the offending code with `file:line` references and short snippets.

## 2. Goal

> One paragraph: the desired end state in plain language. What is true after this is done that is not
> true now.

## 3. Out of scope

> Explicit bullet list of things the implementer must NOT touch or change. This is the primary guard
> against scope creep. Be specific (file paths, behaviours, refactors to resist).

- ...

## 4. Files to create / modify

> Exhaustive. Every path. No "etc.", no "and related files". If you don't know the file, find it first.

| Path | Action | Why |
|---|---|---|
| `core/src/...` | modify | ... |
| `core/src/...` | create | ... |

## 5. Interface & data-model changes

> Full before/after for every changed type, method signature, DI binding (`TYPES`/`config.ts`), enum,
> or persisted shape. Use fenced TypeScript blocks. If nothing changes, write "None."

```ts
// BEFORE
...

// AFTER
...
```

### DI / config impact
> Any change to `configureWorkflow()`, `WorkflowConfig`, or `TYPES` bindings. State new config options,
> their defaults, and validation.

### Persisted / at-rest format impact
> Any change to what is written to a provider. State the migration (forward and, if needed, backward).

## 6. Behavioural contract (numbered rules)

> The heart of the spec. Numbered, testable rules covering the happy path AND error/edge/ordering/
> idempotency/concurrency behaviour. Each rule should map to at least one test in §8.

1. ...
2. ...
3. **Idempotency:** ...
4. **Concurrency:** ...
5. **Error path:** ...

## 7. Provider parity

> If §5 changes a core interface (`IPersistenceProvider`, `IDistributedLockProvider`, `IQueueProvider`):
> enumerate the exact change required in EVERY provider, and state that they must land in the same PR.
> If no core interface changes, write "No core interface change; no provider impact."

| Provider | Change required |
|---|---|
| memory | ... |
| sqlite | ... |
| postgres | ... |
| mongodb | ... |
| redis | ... |
| azure | ... |

## 8. Test plan (TDD)

> Concrete test cases. For each: name, arrange/act/assert, and which §6 rule it proves. The first test
> listed must be the **failing test that demonstrates the bug/missing behaviour before implementation**.
> Reference existing patterns in `core/spec/scenarios/` and the `spinWaitCallback` helper.

### Failing-test-first
- **`<test name>`** — arrange: ... · act: ... · assert: ... (proves rule §6.1; must fail before the fix)

### Coverage
- **`<test name>`** — ...
- **`<test name>`** — ...

### How to run
```bash
cd core && yarn test            # or the specific scenario file
# provider integration (if applicable): ...
```

## 9. Acceptance criteria (binary)

> Machine-checkable where possible: a command plus its expected result. The reviewer runs these.

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd core && yarn test` passes on Node 20 and 22.
- [ ] <specific assertion, e.g. "two hosts run 1000 instances with 0 duplicate executions — see test X">
- [ ] All providers affected by §7 build and pass the conformance suite.

## 10. Backward compatibility & migration

> Public API changes, on-disk/at-rest format changes, and impact on `reactory-express-server`. State
> the version bump under **strict semver** (MAJOR = breaking, MINOR = additive, PATCH = fix; no
> `-reactory.N` prerelease suffix — reserve real prerelease tags like `-rc.0` for genuine pre-releases)
> and any migration steps a consumer must run.

## 11. Definition of Done

> One paragraph the reviewer signs off against. Restate the essence of §2 + §9 in prose.

## 12. Implementation notes (optional, non-binding)

> Hints, gotchas, suggested order of edits, links to upstream `danielgerlag/workflow-es` equivalents.
> These are guidance only — the contract is §6/§9, not this section.
