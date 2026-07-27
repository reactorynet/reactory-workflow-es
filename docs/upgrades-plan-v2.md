# Enterprise Upgrade Plan v2 — `@reactorynet/workflow-es`

**Status:** Draft 1 · **Audited core version:** current HEAD (post-upgrade-plan) · **Owner:** Reactory platform team
**Primary target:** Cloud workflow runner (horizontally scaled) · **Secondary target:** Electron/desktop-wrapped app

> This is the **second upgrade cycle**. It supersedes `upgrade-plan.md` for any item that overlaps; items from the original plan
> that are already complete remain as-is. New items follow the same conventions: stable severity-class IDs (`P0/P1/P2/P3`),
> phased execution ordering, spec-first workflow, and delegation tags per `UPGRADES.md`.
>
> This cycle was produced by a **two-pass audit** (correctness review + security review) against the current codebase. Every
> finding below is traceable to a specific file:line across both reviews.
>
> **⚠️ Verification pass (2026-06-27).** Every finding was re-checked against the actual code at its cited `file:line`. The audit
> over-reported: of the 23 findings, **12 are valid**, **3 are partially valid** (real code, overstated or mislabeled claims),
> and **8 are false positives or non-issues** — including several rated *Critical/High*. The headline corrections:
> the Phase 0 "Critical" tier is the weakest part of the original audit; P1.2 is internally contradicted by P1.4; and the
> proposed fixes for **P1.3** and **P2.4** would *introduce regressions* if implemented as written. See the **Verification
> verdict** table below and the `✓/⚠/✗` line at the top of each §4 summary. `Status` and `Severity` columns in §3 have been
> re-graded accordingly (`rejected` = verified false positive, retained for traceability; do not implement).

---

## 1. How to read this document

- **§3 Roadmap** is the single source of truth for *ordering and status*. Work top to bottom.
- Each item has a **stable ID** (e.g. `P0.1`, `P1.4`) carried over from this audit so findings, plan, specs, branches, and
  commits all cross-reference cleanly.
- Each item links to its spec at `docs/specs/<id>-<slug>.md` if one exists. **No code is written until that spec exists, is
  reviewed, and is marked `Ready`.** (Items still pending a spec are listed in the roadmap without a link.)
- An item is **Done** only when its spec's acceptance criteria are met *and* verified in CI.

### Status legend

| Status | Meaning |
|---|---|
| `planned` | In this plan; spec not yet written |
| `spec` | Spec being authored / under review |
| `ready` | Spec approved; ready to implement |
| `wip` | Implementation in progress |
| `done` | Merged and verified in CI |
| `rejected` | Verified false positive in the 2026-06-27 pass; retained for traceability — **do not implement** |

### Owner tags (from `UPGRADES.md`)

- `[claude]` — design judgement, concurrency, public API, test design. Kept for Claude Code / human.
- `[copilot]` — mechanical, well-bounded, low risk. Delegated to a lesser model.
- `[copilot+review]` — lesser model drafts; human/Claude reviews before merge.

---

## 2. Guiding principles & non-negotiables

Identical to the original plan (`upgrade-plan.md` §2) unless noted:

1. **Cloud-first, but never desktop-hostile.** Every change must keep the engine runnable in a single process with zero
   external infrastructure (the Electron path). Cloud features are *additive* providers and config, never assumptions baked
   into the core.
2. **Correctness before features.** The Phase 0 concurrency/durability work gates everything. We do not add observability or
   tenancy on top of an engine that can double-execute steps or silently lose data.
3. **Provider parity is a contract.** Any change to a core interface (`IPersistenceProvider`, `IDistributedLockProvider`,
   `IQueueProvider`) must update *all* providers in the same change and is not Done until every provider builds and passes
   integration tests in CI.
4. **No silent behavioural change.** Public API and on-disk/at-rest formats are versioned. Migrations are explicit and
   documented.
5. **Spec-first, one item at a time.** Per `UPGRADES.md`. No batching unrelated items into one change.
6. **Backward compatibility window.** The consuming `reactory-express-server` integrates via a `file:` tarball. Breaking
   changes require a coordinated version bump and a migration note in the spec.

---

## 3. Roadmap

Ordered for execution. Phase 0 is the critical path (runtime bugs that cause silent incorrectness). Phase 1 resolves
race conditions and data integrity windows from the security review. Phases 2–3 are correctness hardening, provider hygiene,
and operability improvements.

### Parsed finding provenance

| Review | Severity range | Items |
|---|---|---|
| Code review (core logic) | Critical → Low | C1–C4 (Critical), H1–H4 (High), M1–M4 (Medium), L1–L4 (Low) |
| Security review (providers + concurrency) | HIGH → LOW | S1–S5 (HIGH), S6–S9 (MEDIUM), S10–S12 (LOW) |

### Verification verdict (2026-06-27)

`✓` valid · `⚠` partially valid (real code, claim corrected) · `✗` false positive / non-issue (do not implement).

| ID | Verdict | One-line reason (corrected) |
|---|---|---|
| P0.1 | ⚠ | Real bug at `:257` (property access, always truthy). The `compensate` `:196` claim is **false** — it is correctly invoked with `()`. |
| P0.2 | ✗ | `null` is an **intentional sentinel**, handled everywhere (`=== null`; queue worker guards `!== null`). `strictNullChecks` is off. "Produces NaN" is wrong (`null`→`0` in `<`); the cited comparison doesn't exist. Not Critical. |
| P0.3 | ✗ | The loop at `:316` only runs for `children.length > 0`, so the empty-`.every()` branch is unreachable in normal operation. Stated "single-path" trigger is wrong. (Proposed `.some()` fix is also semantically wrong.) |
| P0.4 | ⚠ | `==` is real at `:55` and `:206` (hardening). But `:206` is in `seedSubscription`, not `processEvent`; and site 3 (`:73`) is a **false positive** — `WorkflowErrorHandling` has no `0` value, so `!errorOption` is safe. |
| P0.5 | ✓ | Order-dependent `JSON.stringify` compare confirmed at `:232`. Correctly self-described as fragile-but-safe-today (hardening). |
| P0.6 | ✓ | *(post-audit, 2026-07-27 — not part of the 23-finding count above.)* Verified at all cited sites: `workflow-executor.ts:86,:128` pass only `instance.data` to mappers while `:79` sets `stepContext.item`; `workflow-step.ts:23-24` types mappers with two params; `step-builder.ts:143,:158,:173` bind `.foreach`/`.while`/`.if` expressions against `data` alone. Silent wrong results in any foreach body of ≥2 steps. Inherited from upstream. |
| P1.1 | ⚠ | Race + swallowed error real. But "renew timer never starts on failure" is **false** — `setInterval` runs unconditionally inside the callback. |
| P1.2 | ✗ | JS `Map.forEach`+`delete` is **well-defined**, not UB; callback is `async` so mutations occur after iteration; `delete` only on lease-loss (correct). Contradicts P1.4. |
| P1.3 | ✗ | Duplicate-seed already prevented by per-sub `terminateSubscription` + `!eventPublished`. **Proposed "mark-first" fix is a regression** (drops delivery + retry). |
| P1.4 | ✓ | Azure `renewLeases` ignores the error and keeps the stale entry — genuinely missing Redis's delete-on-failure cleanup. |
| P1.5 | ✓ | Azure deletes the message immediately on dequeue (`:48`); Redis uses `rpoplpush` to a processing list (`:33`). Real crash-loss window. |
| P2.1 | ✗ | No cross-tenant leak — isolation is enforced at the seed layer (`getSubscriptions(tenantId,…)`). A single elected poller polling all tenants is correct. Doc-only at most. |
| P2.2 | ✗ | Two separate enums on separate fields; never compared interchangeably. No real ambiguity. |
| P2.3 | ✓ | No explicit pool config; Sequelize default max=5 is real. Fair LOW operability note. |
| P2.4 | ✗ | Escaping covers all metacharacters except the deliberate `*`; `+` **is** escaped. **Proposed fix (escaping `*`) would break wildcard matching.** |
| P2.5 | ✓ | Azure `getQueueName` returns `''` for unknown type; Redis has a `default` (`:41`). Confirmed. |
| P3.1 | ✓ | Deprecated `azure-storage` import confirmed. Corrections: it is **v2.10.7 not v1.x**; replacements are `@azure/storage-blob` + `@azure/storage-queue`. |
| P3.2 | ✓ | `:116` uses `===` on `eventKey: any`. Mostly moot for primitive keys; LOW doc note is fair. |
| P3.3 | ✓ | Pointers embedded; `$set` is atomic-but-undocumented. Doc-only. |
| P3.4 | ✓ | `PRAGMA journal_mode=WAL` at `:70`; single-writer / multi-host contention is accurate. Doc note. |
| P3.5 | ✗ | `getActiveIds()` already has the explanatory comment at `:63–67`. Essentially already satisfied. |
| P4.1 | ✓ | `//todo: check host status` at `:194`; no guard. Real (note: host has no `shuttingDown` field yet — must be added). |
| P4.2 | ✓ | Same swallowed error at `:17–18` (duplicate of P1.1's error aspect). |
| P4.3 | ✓ | `retryCount && retryCount > 0` at `:53` is genuinely redundant. Trivial. |

### Phase 0 — Runtime correctness bugs (must-fix before anything else)

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 0 — Silent incorrectness in core logic** |
| 1 | P0.1 | ⚠ Fix `revertChildrenAfterCompensation` property access in `shouldCompensate` (`:257` only; `compensate` `:196` is already correct) | Both | High *(was Critical)* | `[claude]` | planned | [spec](docs/specs/p0.1-silent-compensation-break.md) |
| 2 | P0.2 | ✗ ~~`nextExecution` assigned `null` on `number` type~~ — intentional sentinel; not a runtime bug | Both | ~~Critical~~ | `[copilot]` | rejected | — |
| 3 | P0.3 | ✗ ~~`.every()` on empty set~~ — branch unreachable when `children.length > 0`; proposed `.some()` fix is wrong | Both | ~~Critical~~ | `[claude]` | rejected | [spec](docs/specs/p0.3-empty-every.md) |
| 4 | P0.4 | ⚠ Fix loose equality at `outcomeValue` (`:55`) and `eventKey` (`:206`, in `seedSubscription`); `errorBehavior` (`:73`) is a false positive | Both | Medium *(was High)* | `[copilot+review]` | planned | [spec](docs/specs/p0.4-loose-equality.md) |
| 5 | P0.5 | ✓ Replace `JSON.stringify(scope)` compare with order-independent check (hardening; safe today) | Both | Medium *(was High)* | `[claude]` | planned | [spec](docs/specs/p0.5-scope-comparison.md) |
| 24 | P0.6 | ✓ Foreach body steps have no per-iteration data isolation — mappers cannot see `contextItem`, `.output()` races into one shared sink *(post-audit, 2026-07-27)* | Both | High | `[claude]` | spec | [spec](docs/specs/p0.6-foreach-scope-isolation.md) |

> **P0.6 is a post-audit addition** (2026-07-27), found while assessing the engine's suitability for
> data-movement workloads. It is not part of the original 23-finding audit and is therefore excluded
> from the verification-pass counts in the header. It was verified directly against the cited
> `file:line` before being recorded. Numbered `24` to keep the roadmap ordinal sequence unique;
> its execution position is **within Phase 0, after P0.1**.

### Phase 1 — Data integrity & race windows (security review findings)

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 1 — Race conditions and data loss windows** |
| 6 | P1.1 | ⚠ Fix Azure lock manager: constructor → `acquireLock` race + swallowed container-creation error (note: timer *does* start on failure) | Cloud | HIGH | `[claude]` | planned | [spec](docs/specs/p1.1-azure-lock-race.md) |
| 7 | P1.2 | ✗ ~~Redis lease renewal `forEach-delete` race~~ — JS `Map.forEach`+`delete` is well-defined; contradicts P1.4 | Cloud | ~~HIGH~~ | `[copilot+review]` | rejected | — |
| 8 | P1.3 | ✗ ~~Event processed-atomicity~~ — already idempotent (`terminateSubscription` + `!eventPublished`); **proposed fix is a regression** | Both | ~~HIGH~~ | `[claude]` | rejected | [spec](docs/specs/p1.3-event-processed-atomicity.md) |
| 9 | P1.4 | ✓ Fix Azure `renewLeases`: delete stale entries on renew failure (match Redis pattern) | Cloud | HIGH | `[copilot+review]` | planned | — |
| 10 | P1.5 | ✓ Add pending/visibility-timeout to Azure queue provider (prevent message loss on crash) | Cloud | MEDIUM | `[claude]` | planned | [spec](docs/specs/p1.5-azure-queue-deadletter.md) |

### Phase 2 — Correctness hardening & edge cases

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 2 — Non-critical but important correctness issues** |
| 11 | P2.1 | ✗ ~~Poll worker cross-tenant window~~ — no leak (isolation at seed layer). Optional: comment that all-tenant polling is intentional | Cloud | LOW *(was HIGH)* | `[claude]` | rejected | [spec](docs/specs/p2.1-poll-tenant-aware.md) |
| 12 | P2.2 | ✗ ~~Status zero collision~~ — separate enums on separate fields; never compared interchangeably | Both | ~~MEDIUM~~ | `[copilot]` | rejected | — |
| 13 | P2.3 | ✓ Document connection pool defaults + recommended config note in the PostgreSQL provider JSDoc | Cloud | LOW | `[copilot+review]` | planned | — |
| 14 | P2.4 | ✗ ~~Wildcard regex edge cases~~ — escaping already complete; **proposed fix (escaping `*`) breaks wildcards** | Both | ~~MEDIUM~~ | `[copilot+review]` | rejected | [spec](docs/specs/p2.4-wildcard-regex.md) |
| 15 | P2.5 | ✓ Add missing queue type default in Azure switch statement; throw/log on unknown `QueueType` | Cloud | LOW | `[copilot]` | planned | — |

### Phase 3 — Provider hygiene & operability polish

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 3 — Dependency updates and documentation** |
| 16 | P3.1 | ✓ Audit Azure storage SDK deprecation (`azure-storage` **v2.10.7** → `@azure/storage-blob` + `@azure/storage-queue`) + migrate if feasible | Cloud | MEDIUM | `[claude]` | planned | [spec](docs/specs/p3.1-azure-sdk-upgrade.md) |
| 17 | P3.2 | ✓ EventKey reference comparison in-memory provider — document the limitation, provide guidance for users | Both | LOW | `[copilot+review]` | planned | — |
| 18 | P3.3 | ✓ MongoDB `persistWorkflow`: verify and document pointer update atomicity with `$set` on parent doc | Cloud | LOW | `[copilot+review]` | planned | — |
| 19 | P3.4 | ✓ Document SQLite multi-host write contention limitation in WAL mode (single writer) | Both | LOW | `[copilot]` | planned | — |
| 20 | P3.5 | ✗ ~~Add `getActiveIds()` comment~~ — explanatory comment already exists at `poll-worker.ts:63–67` | Both | ~~LOW~~ | `[copilot]` | rejected | — |

### Phase 4 — Observability & logging fixes

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 4 — Error reporting and diagnostics** |
| 21 | P4.1 | ✓ Remove `//todo: check host status` in `publishEvent`; add shutdown guard (requires adding a `shuttingDown` field to `WorkflowHost`) | Both | MEDIUM | `[copilot+review]` | planned | [spec](docs/specs/p4.1-publish-shutdown-guard.md) |
| 22 | P4.2 | ✓ Fix Azure lock manager constructor error swallowing (`//TODO: log`) — log + surface readiness | Cloud | LOW | `[copilot+review]` | planned | — |
| 23 | P4.3 | ✓ Simplify redundant `retryCount && retryCount > 0` in workflow-executor (`:53`) | Both | LOW | `[copilot]` | planned | — |

---

## 4. Item summaries

Each summary is the seed for a full spec (for items that need one). Format per item: **Problem · Affected surface ·
Acceptance (high level) · Depends on**. Items without specs can be implemented directly by a lesser model using this summary
as the complete specification.

### Phase 0 — Runtime correctness bugs

#### P0.1 — Silent compensation break: `revertChildrenAfterCompensation()` called as property access `[claude]`

- **⚠ Verdict (verified).** Partially valid. The bug at `:257` is **real**; the claim about `compensate` `:196` is a **false positive**.

- **Problem.** In `shouldCompensate` (execution-result-processor.ts:257), `step.revertChildrenAfterCompensation` is accessed as
  a *property* instead of invoked: `if (step.revertChildrenAfterCompensation) return true;`. The method reference is always
  truthy, so `shouldCompensate` returns `true` for *every* step (it never even reaches the `compensationStepId` check on the
  next line). Effect: `handleStepException` selects `Compensate` as the default error strategy for any step lacking an explicit
  `errorBehavior`. The intended code is `step.revertChildrenAfterCompensation()` (base→`false`, `SagaContainer`→`true`).
  **Correction:** the audit also flagged `compensate` line 196, but lines 196–198 already invoke
  `parentStep.resumeChildrenAfterCompensation()` / `revertChildrenAfterCompensation()` *with* `()` — they are correct. Do **not**
  touch them (adding `()` there would be a no-op or a syntax error).

- **Affected surface.** `core/src/services/execution-result-processor.ts:257` (only). Affects the default-error-strategy path
  for non-saga steps with no `errorBehavior`.

- **Acceptance.** `shouldCompensate` correctly invokes both `revertChildrenAfterCompensation()` and
  `resumeChildrenAfterCompensation()`. Compensation logic only runs when the step's methods return `true`. Existing scenario
  tests (saga-compensation.spec.ts) reflect corrected behavior.

- **Depends on.** none.

#### P0.2 — `nextExecution` assigned `null` on `number` type `[copilot]`

- **✗ Verdict (verified).** False positive — not a runtime bug, and not Critical.

- **Problem (as filed).** `WorkflowInstance.nextExecution` is typed `number` but `null` is assigned at workflow-executor.ts:234
  and :297; claimed to produce `NaN` in `pointer.sleepUntil < instance.nextExecution`.

- **Correction.** `null` is the **intended sentinel** for "next-execution not yet determined this pass," and the code handles it
  consistently: `determineNextExecutionTime` branches on `=== null` (`:315`, `:329`) and `workflow-queue-worker.ts:208` guards
  `instance.nextExecution !== null` *before* comparing. `core/tsconfig.json` has `strictNullChecks` **off**, so assigning `null`
  to a `number` field is not even a type error. The "produces NaN" claim is wrong on two counts: `null` coerces to `0` in `<`
  comparisons (not `NaN`), and the cited comparison `pointer.sleepUntil < instance.nextExecution` does not exist anywhere in the
  codebase. (Minor, separate: `memory-persistence-provider.ts:61` does not guard `null`, but `null<now`→`0<now`→true means at
  worst a benign re-poll, not the claimed harm.) **Do not implement** as a Critical fix; optionally just widen the type to
  `number | null` for documentation.

- **Affected surface.** `core/src/services/workflow-executor.ts:234, 297` (sentinel assignment — working as designed).

- **Depends on.** none.

#### P0.3 — `.every()` on empty set in `determineNextExecutionTime` causes false loop entry `[claude]`

- **✗ Verdict (verified).** False positive — unreachable in normal operation, mischaracterized trigger, and the proposed fix is wrong.

- **Problem (as filed).** `[].every(fn) === true` at workflow-executor.ts:318 supposedly causes "false loop entry" for
  "normal single-path workflows where most pointers have empty scopes."

- **Correction.** The `[].every()===true` JS fact is true, but the enclosing loop (`:316`) iterates only pointers with
  `children.length > 0`. Single-path pointers have `children.length == 0` and are handled by the **first** loop (`:307`) — they
  never reach `:318`. For a pointer that *does* have children, the children were created with that pointer's id in their
  `scope`, so the filter is non-empty; the empty-set branch is therefore unreachable in any consistent state. Severity is not
  Critical. **Also:** the spec's recommended fix (replace `.every()` with negated `.some()`) is semantically wrong — it would
  change "proceed only when *all* children ended" into "proceed when *any* child ended" and break multi-child scheduling. If any
  hardening is wanted at all, add an explicit `if (scopeChildren.length === 0) continue;` guard — nothing more.

- **Affected surface.** `core/src/services/workflow-executor.ts:318` (defensive only; no observed defect).

- **Depends on.** none.

#### P0.4 — Loose equality across three comparison sites `[copilot+review]`

- **⚠ Verdict (verified).** Two of three sites valid (as hardening); site 3 is a false positive.

- **Problem.** Loose equality (`==`) at:
  1. ✓ `outcomeValue` matching in `processExecutionResult` (execution-result-processor.ts:55) — `==` confirmed. Tighten the
     `== stepResult.outcomeValue` half to `===`; **keep** `== null` (intentional null-or-undefined catch).
  2. ✓ `eventKey`/`eventName` comparison (event-queue-worker.ts:206) — `==` confirmed. **Correction:** this is in
     `seedSubscription`, *not* `processEvent` as filed. Low-risk (keys are strings in practice); a defensible hardening.
  3. ✗ **False positive.** `errorBehavior` "falsy check" at execution-result-processor.ts:73 is `if (!errorOption)`, not loose
     equality, and `WorkflowErrorHandling = {Retry:1, Suspend:2, Terminate:3, Compensate:4}` has **no `0` value** — so no valid
     enum member is falsy and `!errorOption` correctly means "unset." Do **not** change this site.

- **Affected surface.** `core/src/services/execution-result-processor.ts:55`; `core/src/services/event-queue-worker.ts:206`.

- **Acceptance.** Sites 1 and 2 use `===` (preserving the intentional `== null`). Site 3 is left as-is. Outcome-matching tests
  confirm strict equality.

- **Depends on.** none.

#### P0.5 — Scope comparison via `JSON.stringify` is order-dependent and fragile `[claude]`

- **✓ Verdict (verified).** Valid as a hardening item (not an active bug — the spec correctly says it is safe today). Severity
  downgraded High → Medium.

- **Problem.** In `compensate` (execution-result-processor.ts:232), scope arrays are compared using
  `JSON.stringify(pointer.scope) == JSON.stringify(x.scope)`. Two logically equivalent scopes `[A, B]` vs `[B, A]` produce
  different JSON strings. While the current code always appends to scope in order (making this theoretically safe today), it is
  a fragile invariant with no assertion guaranteeing order preservation across future refactors. Any change that adds/removes
  siblings out of order would silently break compensation scoping.

- **Affected surface.** `core/src/services/execution-result-processor.ts:232`.

- **Acceptance.** Scope comparison uses a deterministic, order-independent method (e.g., sorted comparison). A test exists that
  verifies two pointers with the same elements in different orders compare equal.

- **Depends on.** none.

#### P0.6 — Foreach body steps have no per-iteration data isolation `[claude]`

- **✓ Verdict (verified 2026-07-27).** Valid. **Post-audit addition** — not part of the original 23-finding count. Every cited
  site was read directly before recording. Inherited from upstream `danielgerlag/workflow-es`, not introduced by this fork.

- **Problem.** `Foreach` correctly stamps each collection element onto its child pointer
  (`execution-pointer-factory.ts:40`, `result.contextItem = branch`) and the executor correctly exposes it to the step body
  (`workflow-executor.ts:79`, `stepContext.item = pointer.contextItem`). But the **input/output mappers never receive it** —
  `workflow-executor.ts:86` calls `input(body, instance.data)` and `:128` calls `output(body, instance.data)`, and the mapper
  contract itself is only two parameters (`models/workflow-step.ts:23-24`). Three consequences, all silent: (a) `.if()`,
  `.while()` and nested `.foreach()` bind their expressions against `instance.data` alone (`step-builder.ts:173`, `:158`,
  `:143`), so a predicate or nested collection **cannot reference the current item**; (b) every iteration's `.output()` writes
  into the same `instance.data`, and because the executor snapshots all active pointers once per pass
  (`workflow-executor.ts:39`) the body advances **lockstep breadth-first** — all N copies of step 1 run and overwrite each other
  before any copy of step 2 runs, so step 2 of item #1 reads item #N's output; (c) the defect is invisible for single-step
  bodies, which is the shape of every existing foreach test and sample. Net: a multi-step foreach body produces **silently
  wrong results** with no error raised.

- **Affected surface.** `core/src/services/workflow-executor.ts:86,:128` · `core/src/models/workflow-step.ts:23-24` ·
  `core/src/fluent-builders/step-builder.ts:81,:86,:143,:158,:173`.

- **Acceptance.** Mappers receive the executing `StepExecutionContext` as an optional third argument; `.if()`/`.while()`/
  `.foreach()` expressions receive the enclosing item as an optional second argument; a three-item, two-step foreach body
  yields three distinct per-item results rather than three copies of the last. Existing two-parameter mappers are unchanged
  and no existing spec file is modified. No provider or at-rest change. MINOR bump (`2.5.0` → `2.6.0`).

- **Depends on.** none. Blocks the corresponding YamlFlow `stepResults` collision fix in `reactory-express-server`, which
  cannot be done correctly until this lands.

### Phase 1 — Data integrity & race windows

#### P1.1 — Azure lock manager: constructor → `acquireLock` race + unhandled container creation error `[claude]`

- **⚠ Verdict (verified).** Valid core (race + swallowed error), but one sub-claim is wrong.

- **Problem.** `AzureLockManager`'s constructor fires an async `createContainerIfNotExists` call via callback, but does not
  await it before returning. If `acquireLock()` is called before the container exists, `createBlob` fails and `acquireLock`
  returns `false` (a spurious "lock held elsewhere" at startup). The error callback has `//TODO: log` (`:18`) — errors are
  swallowed entirely. **Correction:** the audit claimed "the renew timer never starts" on container-creation failure — that is
  false. `self.renewTimer = setInterval(...)` is on `:19` *unconditionally inside the callback*, so it starts on success **and**
  on error. The genuine improvement is therefore the readiness gate + logging, plus starting the timer *only on success*.

- **Affected surface.** `providers/workflow-es-azure/src/azure-lock-manager.ts:14-20`.

- **Acceptance.** A `ready` promise on the lock manager gates all public methods; callers can await it or use try-catch. The
  constructor's error callback logs the failure. All public methods check readiness state before proceeding.

- **Depends on.** none (can be done in parallel with P0 items).

#### P1.2 — Redis lease renewal `forEach-delete` race `[copilot+review]`

- **✗ Verdict (verified).** False positive — and internally contradicted by P1.4.

- **Problem (as filed).** `Map.delete()` inside `.forEach()` in `renewLeases` (redis-lock-manager.ts:67) is "undefined
  behaviour" that skips renewals.

- **Correction.** JavaScript `Map.prototype.forEach` with `delete` is **well-defined** by spec — it is not C++/Java
  iterator-invalidation. Two further reasons it is a non-issue: (a) the callback is `async`, so the `set`/`delete` run in
  microtasks *after* the synchronous `forEach` finishes iterating; (b) the `delete` only fires in the `catch` (lease lost), which
  is the *correct* cleanup. P1.4 explicitly holds up this exact delete-on-failure pattern as the model Azure should copy, so
  calling it a bug here is contradictory. The suggested `Array.from(...)` snapshot is harmless but unnecessary. **Do not implement.**

- **Affected surface.** `providers/workflow-es-redis/src/redis-lock-manager.ts:67` (working as designed).

- **Depends on.** none.

#### P1.3 — Event processing atomicity: mark processed before or per-subscription, not after loop `[claude]`

- **✗ Verdict (verified).** False positive — already idempotent. ⚠️ **The proposed fix would introduce a regression — do not implement.**

- **Problem (as filed).** `markEventProcessed` is called after the seed loop (`:178-179`), so a crash mid-loop lets another node
  re-read the event and re-seed subscriptions, violating at-most-once.

- **Correction.** Re-seeding is already prevented by two existing mechanisms: (a) each successful `seedSubscription` calls
  `terminateSubscription(sub.id)` (`:217`), so a re-read's `getSubscriptions` no longer returns already-seeded subs — this is a
  per-subscription checkpoint that makes a crash *resumable* without duplication; and (b) the pointer filter `!p.eventPublished`
  (`:206`) prevents publishing the same pointer twice. The audit's own acceptance ("mark each subscription seeded before the
  next") is *already implemented* via `terminateSubscription`. Worse, the spec's prescribed fix — `markEventProcessed`
  *unconditionally before* the loop — would **drop delivery**: a subscription that was transiently locked or errored would never
  be retried (the event is already marked processed), turning today's correct at-least-once-with-idempotency into lossy
  best-effort. Keep the current ordering.

- **Affected surface.** `core/src/services/event-queue-worker.ts:175-179` (working as designed).

- **Depends on.** none.

#### P1.4 — Azure `renewLeases`: delete stale entries on renew failure `[copilot+review]`

- **✓ Verdict (verified).** Valid. The `renewLease` callback at `:83-85` is `//TODO: log` and never deletes on failure — confirmed.

- **Problem.** When a renewal fails in the Azure lock manager (line 79-87), the code does nothing — the lock is silently lost
  but the entry remains in `self.leases`. A subsequent `acquireLock` on the same blob could succeed while the old logical holder
  still thinks it owns the resource.

- **Affected surface.** `providers/workflow-es-azure/src/azure-lock-manager.ts:79-87`.

- **Acceptance.** On renew failure, the entry is deleted from the leases map (matching the Redis pattern). The lock can be
  re-acquired by another holder. A retry or alarm mechanism exists to prevent rapid churn.

- **Depends on.** none.

#### P1.5 — Azure queue: add pending queue / dead-letter to prevent message loss `[claude]`

- **✓ Verdict (verified).** Valid. Confirmed: `dequeueForProcessing` calls `deleteMessage` immediately (`:48`) before processing;
  Redis uses `rpoplpush` into a processing list (`redis-queue-provider.ts:33`). Note: a complete fix likely needs an explicit
  ack/complete step (today `dequeueForProcessing` returns the id and the caller never signals completion).

- **Problem.** The Azure queue provider (azure-queue-provider.ts) deletes messages immediately upon receipt. If the processing
  node crashes mid-execution, the message is permanently lost. Redis uses `rpoplpush` which provides a pending queue that
  mitigates this, but the Azure provider has no equivalent.

- **Affected surface.** `providers/workflow-es-azure/src/azure-queue-provider.ts`.

- **Acceptance.** Azure queue provider uses a pending/visibility timeout pattern (or dead-letter queue) so crashed processing
  doesn't lose workflow IDs. Same contract as the Redis queue provider's pending behavior.

- **Depends on.** none.

### Phase 2 — Correctness hardening & edge cases

#### P2.1 — Poll worker: no tenant-awareness for event polling → cross-tenant window `[claude]`

- **✗ Verdict (verified).** False positive — there is no cross-tenant window. Severity downgraded HIGH → LOW (optional doc only).

- **Problem (as filed).** Poll worker calls `getRunnableEvents()` without a tenantId (`:138`), opening a "cross-tenant window."

- **Correction.** No cross-tenant leakage occurs. Each event carries its own `tenantId`; `processEvent` reads it and matches
  subscriptions tenant-scoped via `getSubscriptions(tenantId, …)`, and `seedSubscription` locks/operates under `sub.tenantId`.
  The poll worker is a *single elected poller* (one node holds `POLL_LEASE_KEY`), so polling all tenants is the correct design —
  partitioning it per-tenant would be wrong. Cross-tenant *ordering* on the queue is irrelevant to correctness. (FYI the
  persistence contract *already* exposes `getRunnableEvents(tenantId?)`, so no interface work is needed even if per-tenant
  polling were ever wanted.) At most, add a one-line comment that all-tenant polling is intentional.

- **Affected surface.** `core/src/services/poll-worker.ts:138` (working as designed).

- **Depends on.** none.

#### P2.2 — Status zero collision: `PointerStatus.Legacy == WorkflowStatus.Runnable` `[copilot]`

- **✗ Verdict (verified).** False positive / non-issue.

- **Problem (as filed).** `PointerStatus.Legacy` and `WorkflowStatus.Runnable` both equal `0`, creating ambiguity.

- **Correction.** These are two independent enums applied to two different fields — `ExecutionPointer.status` is always read as
  `PointerStatus`, `WorkflowInstance.status` always as `WorkflowStatus`. There is no code path where a value crosses between
  them, so there is no actual ambiguity. (The cited `execution-pointer.ts:22` is the `status: number = 0` default; the enum
  itself is at `:25-35`.) No change required. If desired purely for readability, renaming `Legacy`→`Unknown` is cosmetic.

- **Affected surface.** `core/src/models/execution-pointer.ts`; `core/src/models/workflow-status.ts` (no defect).

- **Depends on.** none.

#### P2.3 — Document connection pool defaults in PostgreSQL provider JSDoc `[copilot+review]`

- **✓ Verdict (verified).** Valid. Confirmed: constructor (`:37-43`) spreads `...options` with no explicit pool config; Sequelize's default pool max is 5.

- **Problem.** The PostgreSQL constructor passes `...options` to Sequelize without documenting recommended pool settings. Without
  explicit `max`/`min` pool settings, Sequelize defaults to a pool of 5 connections per host. In a multi-host deployment with
  high `maxConcurrentWorkflows`, effective concurrency is silently limited by the pool size.

- **Affected surface.** `providers/workflow-es-postgres/src/postgres-provider.ts:37-43`.

- **Acceptance.** JSDoc on the constructor documents recommended pool settings (`max`, `min`, `idle`). A default pool config is
  provided (e.g., min=2, max=10) if not specified.

- **Depends on.** none.

#### P2.4 — Wildcard regex edge cases in memory and MongoDB search filters `[copilot+review]`

- **✗ Verdict (verified).** False positive — the escaping is already complete. ⚠️ **The spec's proposed fix would break wildcards — do not implement.**

- **Problem (as filed).** The `escapeRegex` helpers "may not cover all edge cases," e.g. `+` could produce unintended patterns.

- **Correction.** Both helpers use `/[.+?^${}()|[\]\\]/g` → `\\$&`, which escapes **every** ECMAScript metacharacter *except* `*`
  (deliberately left as the wildcard, converted to `.*`). `+` **is** escaped; the named concern does not occur. The MongoDB
  `workflowDefinitionId` wildcard path (`:427-434`) escapes per-segment and joins with `.*` — also correct. Critically, the
  spec's recommended escape function escapes `*` too — applying that to the memory provider's `wildcardMatch` would make the
  subsequent `*`→`.*` step a no-op and **break wildcard matching entirely**. The only real (minor, *unfiled*) nuance: Mongo's
  `searchTerm` path (`:456`) feeds `escapeRegex` output straight into a regex, so a literal `*` in a *search term* acts as a
  quantifier, whereas the memory provider's `searchTerm` uses a literal `indexOf` (`:251-254`). That is a small cross-provider
  inconsistency worth at most a doc note — not the metacharacter-coverage bug described.

- **Affected surface.** `core/src/services/memory-persistence-provider.ts:263`; `providers/workflow-es-mongodb/src/mongodb-provider.ts:468` (escaping correct as-is).

- **Depends on.** none.

#### P2.5 — Missing queue type default in Azure switch statement `[copilot]`

- **✓ Verdict (verified).** Valid. Confirmed: Azure `getQueueName` (`:57-68`) has no `default` and returns `''`; Redis has a `default` (`redis-queue-provider.ts:41`).

- **Problem.** The `getQueueName` switch (azure-queue-provider.ts:57-68) returns an empty string for any unknown `QueueType`,
  silently sending/receiving from a non-existent queue. The Redis provider has a `default` case; Azure does not.

- **Affected surface.** `providers/workflow-es-azure/src/azure-queue-provider.ts`.

- **Acceptance.** A `default` case in the switch throws a descriptive error for unknown queue types. No empty string return.

- **Depends on.** none.

### Phase 3 — Provider hygiene & operability polish

#### P3.1 — Audit Azure storage SDK deprecation + migrate if feasible `[claude]`

- **✓ Verdict (verified).** Valid, with two factual corrections.

- **Problem.** The `azure-storage` package is deprecated (Microsoft superseded it with the modular `@azure/storage-*` SDKs); it
  uses callback APIs and lacks modern Azure AD / managed-identity auth — a dependency/maintenance risk. **Corrections:** (1) the
  pinned version is `^2.10.7` (**v2.x**, the package's final release), not "v1.x" as filed; (2) the replacement is **not** a
  single `@azure/storage-queues` package — the lock manager uses Blob leases (needs `@azure/storage-blob`) and the queue
  provider uses queues (needs `@azure/storage-queue`, singular).

- **Affected surface.** `providers/workflow-es-azure/` (`azure-lock-manager.ts` → blob; `azure-queue-provider.ts` → queue).

- **Acceptance.** Decision documented: either migrated to `@azure/storage-blob` + `@azure/storage-queue` (v12+) with full parity,
  or formally deprecated with a migration guide for consumers. Either way, the README banners the decision.

- **Depends on.** none.

#### P3.2 — EventKey reference comparison in-memory provider limitation `[copilot+review]`

- **✓ Verdict (verified).** Valid but minor. Confirmed `===` at `:116` (in `getEvents`); `eventKey` is typed `any`. Mostly moot for primitive keys; doc-only.

- **Problem.** In `memory-persistence-provider.ts:116`, event key comparison uses `===`. Two different object instances with
  identical content will not match. Sequelize and MongoDB handle this correctly by comparing serialized forms, but the memory
  provider (reference of conformance suite) could break tests that pass distinct object instances.

- **Affected surface.** `core/src/services/memory-persistence-provider.ts:116`.

- **Acceptance.** The limitation is documented in a comment on the method. Guidance provided for consumers who need deep equality
  on event keys (e.g., stringify before comparison). No behavioural change unless deemed necessary by reviewer.

- **Depends on.** none.

#### P3.3 — MongoDB `persistWorkflow`: verify pointer update atomicity with `$set` on parent doc `[copilot+review]`

- **✓ Verdict (verified).** Valid (doc-only). Confirmed: `persistWorkflow` (`:120-144`) spreads the instance and `$set`s the whole document, so embedded pointers update atomically — correct but undocumented.

- **Problem.** Execution pointers are stored as embedded array elements within the workflow document in MongoDB. The `$set` on
  the outer document updates them atomically, which is correct for MongoDB. However, this is implicit and undocumented — a
  future refactor could accidentally split pointer updates into a separate operation.

- **Affected surface.** `providers/workflow-es-mongodb/src/mongodb-provider.ts:120-134`.

- **Acceptance.** A comment documents that pointers are embedded sub-documents updated atomically with the parent via `$set`.
  No code changes required unless a refactor is needed.

- **Depends on.** none.

#### P3.4 — Document SQLite multi-host write contention limitation in WAL mode `[copilot]`

- **✓ Verdict (verified).** Valid (doc-only). Confirmed `PRAGMA journal_mode=WAL` at `sqlite-provider.ts:70`; WAL is single-writer.

- **Problem.** WAL mode enables concurrent readers but single writer. Multiple workflow hosts sharing the same SQLite file will
  serialize writes at the OS level; under heavy load, this manifests as "database is locked" errors. The singleton lock provider
  mitigates for single-host scenarios but not for multi-host on the same file.

- **Affected surface.** `providers/workflow-es-sqlite/src/sqlite-provider.ts:70`.

- **Acceptance.** README / JSDoc documents that SQLite is for single-host use only. Multi-host requires PostgreSQL or Redis lock
  coordination (which SQLite doesn't support natively).

- **Depends on.** none.

#### P3.5 — Add `getActiveIds()` to PollWorker `[copiot]`

- **✗ Verdict (verified).** False positive — already satisfied.

- **Problem (as filed).** `getActiveIds()` returns `[]` "without a comment explaining why."

- **Correction.** The explanatory comment already exists at `poll-worker.ts:63-67`: *"…ticks have no item identity, so IDs are
  empty."* It sits on the `getActiveCount`/`getActiveIds` block. Nothing to do (at most, copy the sentence directly above
  `getActiveIds` for emphasis).

- **Affected surface.** `core/src/services/poll-worker.ts:72` (already documented at `:63-67`).

- **Depends on.** none.

### Phase 4 — Observability & logging fixes

#### P4.1 — Remove unreachable `//todo: check host status` in `publishEvent`; add shutdown guard `[copilot+review]`

- **✓ Verdict (verified).** Valid, with an implementation caveat.

- **Problem.** In `workflow-host.ts:194`, the comment says `//todo: check host status` but nothing is checked. Events are
  published to persistence and queued even after `stop()` is called, causing events to accumulate silently on a stopped host.
  **Caveat:** `WorkflowHost` has **no `shuttingDown` field** today — only `stopPromise` (set in `stop()`/`performStop()`). The
  guard must therefore *introduce* a `shuttingDown` boolean (set true in `performStop`, reset in `start`) or check
  `this.stopPromise !== null`. The worker classes' `shuttingDown` flags are not visible from the host.

- **Affected surface.** `core/src/services/workflow-host.ts:193-218` (+ a new shutdown flag).

- **Acceptance.** `publishEvent` checks `shuttingDown` (or equivalent) before accepting new events. A warning is logged when
  publishing to a stopped host. The TODO comment is removed.

- **Depends on.** none.

#### P4.2 — Document Azure lock manager constructor error swallowing `[copilot+review]`

- **✓ Verdict (verified).** Valid. Confirmed `//TODO: log` at `:18` (the call is on `:17`); the error parameter is ignored. Same root issue as P1.1.

- **Problem.** `azure-lock-manager.ts:17`: `//TODO: log` — the container creation callback's error parameter is ignored. If
  creation fails (access denied, network unreachable), all subsequent operations silently fail with no diagnostic.

- **Affected surface.** `providers/workflow-es-azure/src/azure-lock-manager.ts:17`.

- **Acceptance.** The error is logged at least at warn level. A `this.ready` promise resolves to `false` on error, so callers
  know the provider is unusable. Combined with P1.1 if both are implemented.

- **Depends on.** P1.1 (if that spec also covers this).

#### P4.3 — Audit and document `retryCount && retryCount > 0` redundancy `[copilot]`

- **✓ Verdict (verified).** Valid (trivial). Confirmed at `:53`; the `&&` left operand is redundant. Note it only guards a metrics counter increment, so there is no behavioral impact.

- **Problem.** In `workflow-executor.ts:53`, `pointer.retryCount && pointer.retryCount > 0` is redundant — the first check always
  evaluates the same as the second when `retryCount` defaults to `0`. If `retryCount` were ever `undefined` (e.g., deserialized
  JSON), both would be falsy, hiding a bug.

- **Affected surface.** `core/src/services/workflow-executor.ts:53`.

- **Acceptance.** The expression is simplified to `pointer.retryCount > 0`. A comment notes the redundancy was removed. No
  behavioral change.

- **Depends on.** none.

---

## 5. Cross-cutting: Definition of Done (identical to original plan §6)

1. Spec exists, was reviewed, and is marked `done` with the reviewer noted.
2. New/changed behaviour is covered by tests; the TDD failing-test-first was real (visible in history or PR description).
3. `core` builds and `yarn test` passes on the Node 20 + 22 CI matrix.
4. If a core interface changed: **all** non-deprecated providers build and pass the conformance suite (gated by M8 once landed).
5. Single-process / Electron path still works with zero external infrastructure.
6. Docs updated: this plan's status table, the item's spec, and any user-facing README/guide.
7. Consumer impact assessed; if breaking, version bumped and a migration note added to the spec.

---

## 6. Dependencies & sequencing

Most P0 items are independent (no dependencies). P1–P4 items generally don't depend on each other unless noted:

| Item | Depends on |
|------|------------|
| P0.1, P0.2, P0.3, P0.4, P0.5 | none |
| P1.1 | none |
| P1.2 | none |
| P1.3 | none |
| P1.4 | none |
| P1.5 | none |
| P2.1 | none |
| P2.2–P2.5 | none |
| P3.1 | none |
| P3.2–P3.5 | none |
| P4.1–P4.3 | none (P4.2 depends on P1.1 if both cover constructor errors) |

**Recommended execution order (post-verification, 2026-06-27):** The original "all P0 first" ordering assumed five Critical/High
Phase 0 bugs. After verification only **P0.1 (`:257`)** is a real correctness bug — do that first. Then the genuinely-valid
provider fixes **P1.4, P1.5, P2.5, P4.1/P4.2** (Azure-heavy; can run in parallel as they touch distinct code paths). Then the
hardening/cleanup items **P0.4 (sites 1–2), P0.5, P4.3**. Then the documentation items **P2.3, P3.1, P3.2, P3.3, P3.4**.

**Do not implement (verified false positives):** P0.2, P0.3, P1.2, P1.3, P2.1, P2.2, P2.4, P3.5. Two of these ship *harmful*
proposed fixes — **P1.3** (drops event delivery/retry) and **P2.4** (breaks wildcard matching) — and **P0.3**'s suggested
`.some()` rewrite is also wrong. These rows are retained with status `rejected` for traceability only.

---

## 7. Implementation conventions (identical to original plan §8)

Identical to `upgrade-plan.md` §8 — same config surface, shared primitives, versioning rules, and ground-truth facts.
Use those sections verbatim; do not redefine here.
