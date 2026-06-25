# Enterprise Upgrade Plan v2 — `@reactorynet/workflow-es`

**Status:** Draft 1 · **Audited core version:** current HEAD (post-upgrade-plan) · **Owner:** Reactory platform team
**Primary target:** Cloud workflow runner (horizontally scaled) · **Secondary target:** Electron/desktop-wrapped app

> This is the **second upgrade cycle**. It supersedes `upgrade-plan.md` for any item that overlaps; items from the original plan
> that are already complete remain as-is. New items follow the same conventions: stable severity-class IDs (`P0/P1/P2/P3`),
> phased execution ordering, spec-first workflow, and delegation tags per `UPGRADES.md`.
>
> This cycle was produced by a **two-pass audit** (correctness review + security review) against the current codebase. Every
> finding below is traceable to a specific file:line across both reviews.

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

### Phase 0 — Runtime correctness bugs (must-fix before anything else)

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 0 — Silent incorrectness in core logic** |
| 1 | P0.1 | Fix `revertChildrenAfterCompensation()` missing method invocation (`shouldCompensate`, `compensate`) | Both | Critical | `[claude]` | planned | [spec](docs/specs/p0.1-silent-compensation-break.md) |
| 2 | P0.2 | Fix `nextExecution` assigned `null` on `number` type (dead-letter path) | Both | Critical | `[copilot]` | planned | — |
| 3 | P0.3 | Fix `.every()` on empty set causing false loop entry in `determineNextExecutionTime` | Both | Critical | `[claude]` | planned | [spec](docs/specs/p0.3-empty-every.md) |
| 4 | P0.4 | Fix loose equality across three comparison sites (`outcomeValue`, `eventKey`, `errorBehavior`) | Both | High | `[copilot+review]` | planned | [spec](docs/specs/p0.4-loose-equality.md) |
| 5 | P0.5 | Replace `JSON.stringify(scope)` scope comparison with a deterministic, order-independent check | Both | High | `[claude]` | planned | [spec](docs/specs/p0.5-scope-comparison.md) |

### Phase 1 — Data integrity & race windows (security review findings)

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 1 — Race conditions and data loss windows** |
| 6 | P1.1 | Fix Azure lock manager: constructor → `acquireLock` race + unhandled container creation error | Cloud | HIGH | `[claude]` | planned | [spec](docs/specs/p1.1-azure-lock-race.md) |
| 7 | P1.2 | Fix Redis lease renewal `forEach-delete` race (undefined behaviour) | Cloud | HIGH | `[copilot+review]` | planned | — |
| 8 | P1.3 | Fix event processing atomicity: mark processed before or per-subscription, not after loop | Both | HIGH | `[claude]` | planned | [spec](docs/specs/p1.3-event-processed-atomicity.md) |
| 9 | P1.4 | Fix Azure `renewLeases`: delete stale entries on renew failure (match Redis pattern) | Cloud | HIGH | `[copilot+review]` | planned | — |
| 10 | P1.5 | Add pending queue / dead-letter to Azure queue provider (prevent message loss on crash) | Cloud | MEDIUM | `[claude]` | planned | [spec](docs/specs/p1.5-azure-queue-deadletter.md) |

### Phase 2 — Correctness hardening & edge cases

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 2 — Non-critical but important correctness issues** |
| 11 | P2.1 | Fix poll worker: no tenant-awareness for event polling (cross-tenant window) | Cloud | HIGH | `[claude]` | planned | [spec](docs/specs/p2.1-poll-tenant-aware.md) |
| 12 | P2.2 | Fix status zero collision (`PointerStatus.Legacy == WorkflowStatus.Runnable`) — document or resolve default | Both | MEDIUM | `[copilot]` | planned | — |
| 13 | P2.3 | Document connection pool defaults + add a recommended config note in the PostgreSQL provider JSDoc | Cloud | LOW | `[copilot+review]` | planned | — |
| 14 | P2.4 | Fix wildcard regex edge cases in memory and MongoDB search filters (M9 query) | Both | MEDIUM | `[copilot+review]` | planned | [spec](docs/specs/p2.4-wildcard-regex.md) |
| 15 | P2.5 | Add missing queue type default in Azure switch statement; log error on unknown `QueueType` | Cloud | LOW | `[copilot]` | planned | — |

### Phase 3 — Provider hygiene & operability polish

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 3 — Dependency updates and documentation** |
| 16 | P3.1 | Audit Azure storage SDK deprecation (`azure-storage` v1 → `@azure/storage-queues`) + migrate if feasible | Cloud | MEDIUM | `[claude]` | planned | [spec](docs/specs/p3.1-azure-sdk-upgrade.md) |
| 17 | P3.2 | EventKey reference comparison in-memory provider — document the limitation, provide guidance for users | Both | LOW | `[copilot+review]` | planned | — |
| 18 | P3.3 | MongoDB `persistWorkflow`: verify and document pointer update atomicity with `$set` on parent doc | Cloud | LOW | `[copilot+review]` | planned | — |
| 19 | P3.4 | Document SQLite multi-host write contention limitation in WAL mode (single writer) | Both | LOW | `[copilot]` | planned | — |
| 20 | P3.5 | Add `getActiveIds()` to PollWorker (return empty array; health/operability) | Both | LOW | `[copilot]` | planned | — |

### Phase 4 — Observability & logging fixes

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 4 — Error reporting and diagnostics** |
| 21 | P4.1 | Remove unreachable `//todo: check host status` in `publishEvent`; add shutdown guard to prevent event accumulation | Both | MEDIUM | `[copilot+review]` | planned | [spec](docs/specs/p4.1-publish-shutdown-guard.md) |
| 22 | P4.2 | Document Azure lock manager constructor error swallowing (`//TODO: log`) as a known issue + fix the callback | Cloud | LOW | `[copilot+review]` | planned | — |
| 23 | P4.3 | Audit and document `retryCount && retryCount > 0` redundancy in workflow-executor | Both | LOW | `[copilot]` | planned | — |

---

## 4. Item summaries

Each summary is the seed for a full spec (for items that need one). Format per item: **Problem · Affected surface ·
Acceptance (high level) · Depends on**. Items without specs can be implemented directly by a lesser model using this summary
as the complete specification.

### Phase 0 — Runtime correctness bugs

#### P0.1 — Silent compensation break: `revertChildrenAfterCompensation()` called as property access `[claude]`

- **Problem.** In `shouldCompensate` (execution-result-processor.ts:257) and `compensate` (line 196),
  `step.revertChildrenAfterCompensation` is accessed as a property instead of invoked as a method. The function reference is
  always truthy, so the condition always evaluates to `true`. In `shouldCompensate`, every step with a non-null
  `compensationStepId` returns `true` regardless of the step's actual intent. In `compensate`, both branches of the `||`
  evaluate using the parent's values unconditionally — the conditional logic is completely bypassed.

- **Affected surface.** `core/src/services/execution-result-processor.ts:257, 196`. Affects all saga compensation scenarios.

- **Acceptance.** `shouldCompensate` correctly invokes both `revertChildrenAfterCompensation()` and
  `resumeChildrenAfterCompensation()`. Compensation logic only runs when the step's methods return `true`. Existing scenario
  tests (saga-compensation.spec.ts) reflect corrected behavior.

- **Depends on.** none.

#### P0.2 — `nextExecution` assigned `null` on `number` type `[copilot]`

- **Problem.** `WorkflowInstance.nextExecution` is typed `number`. In two locations, `null` is assigned: `deadLetterMissingDefinition` (workflow-executor.ts:234) and `determineNextExecutionTime` initialisation (line 297). This violates the type invariant and creates ambiguity — does `null` mean "never run" or "uninitialized"? Downstream comparisons (`pointer.sleepUntil < instance.nextExecution`) produce `NaN` when comparing against `null`.

- **Affected surface.** `core/src/services/workflow-executor.ts:234, 297`.

- **Acceptance.** All assignments use a distinct sentinel (e.g. `-1`) or the field is split into two fields. No type errors
  under `strictNullChecks`. Comparisons handle the sentinel explicitly.

- **Depends on.** none.

#### P0.3 — `.every()` on empty set in `determineNextExecutionTime` causes false loop entry `[claude]`

- **Problem.** In `determineNextExecutionTime` (workflow-executor.ts:318), the expression
  `instance.executionPointers.filter(x => x.scope.includes(pointer.id)).every(x => !!x.endTime)` returns `true` when no pointers
  match the filter, because `[].every(fn) === true`. This negates to `false`, causing the loop body to execute even though
  there are zero children. In normal single-path workflows (where most pointers have empty scopes), this leads to unnecessary
  recomputation and potentially incorrect `nextExecution` values.

- **Affected surface.** `core/src/services/workflow-executor.ts:318`.

- **Acceptance.** The dual-pass logic in `determineNextExecutionTime` produces correct `nextExecution` for both single-path
  and multi-pointer workflows. No unnecessary computation on empty sets.

- **Depends on.** none.

#### P0.4 — Loose equality across three comparison sites `[copilot+review]`

- **Problem.** Three locations use `==` (loose equality) where `===` (strict) is appropriate:
  1. `outcomeValue` matching in `processExecutionResult` (execution-result-processor.ts:55): `1 == true`, `"0" == 0`.
  2. `eventKey` comparison in `EventQueueWorker.processEvent` (event-queue-worker.ts:206): string/number confusion.
  3. `errorBehavior` falsy check in `handleStepException` (execution-result-processor.ts:73): `!0 === true`.

- **Affected surface.** `core/src/services/execution-result-processor.ts:55, 73`; `core/src/services/event-queue-worker.ts:206`.

- **Acceptance.** All three sites use `===` (or explicit null-checks where the intent is "undefined or null"). No type coercion
  surprises. Outcome matching tests confirm strict equality.

- **Depends on.** none.

#### P0.5 — Scope comparison via `JSON.stringify` is order-dependent and fragile `[claude]`

- **Problem.** In `compensate` (execution-result-processor.ts:232), scope arrays are compared using
  `JSON.stringify(pointer.scope) == JSON.stringify(x.scope)`. Two logically equivalent scopes `[A, B]` vs `[B, A]` produce
  different JSON strings. While the current code always appends to scope in order (making this theoretically safe today), it is
  a fragile invariant with no assertion guaranteeing order preservation across future refactors. Any change that adds/removes
  siblings out of order would silently break compensation scoping.

- **Affected surface.** `core/src/services/execution-result-processor.ts:232`.

- **Acceptance.** Scope comparison uses a deterministic, order-independent method (e.g., sorted comparison). A test exists that
  verifies two pointers with the same elements in different orders compare equal.

- **Depends on.** none.

### Phase 1 — Data integrity & race windows

#### P1.1 — Azure lock manager: constructor → `acquireLock` race + unhandled container creation error `[claude]`

- **Problem.** `AzureLockManager`'s constructor fires an async `createContainerIfNotExists` call via callback, but does not
  await it before returning. If `acquireLock()` or other public methods are called before the container exists, they fail
  silently. The error callback has `//TODO: log` — errors are swallowed entirely. If container creation fails (e.g., access
  denied), the renew timer never starts; locks can be acquired but never renewed, and old leases silently expire with no
  cleanup.

- **Affected surface.** `providers/workflow-es-azure/src/azure-lock-manager.ts:14-20`.

- **Acceptance.** A `ready` promise on the lock manager gates all public methods; callers can await it or use try-catch. The
  constructor's error callback logs the failure. All public methods check readiness state before proceeding.

- **Depends on.** none (can be done in parallel with P0 items).

#### P1.2 — Redis lease renewal `forEach-delete` race `[copilot+review]`

- **Problem.** In `renewLeases` (redis-lock-manager.ts:67), `Map.delete()` is called inside `.forEach()`. Deleting an entry that
  has not yet been visited in the iteration is undefined behaviour — it can silently skip renewal of locks still held by other
  nodes.

- **Affected surface.** `providers/workflow-es-redis/src/redis-lock-manager.ts:67`.

- **Acceptance.** Lease renewal snapshots entries first: `Array.from(this.leases).forEach(...)`. Renewal is never skipped for a
  lease that exists at the start of the timer tick.

- **Depends on.** none.

#### P1.3 — Event processing atomicity: mark processed before or per-subscription, not after loop `[claude]`

- **Problem.** In `event-queue-worker.ts:175-179`, `markEventProcessed` is called *after* all subscription seeding completes. If
  a node crashes between seeding the last subscription and marking the event as processed, another node will read the same event
  again and seed the same subscriptions a second time — violating the at-most-once guarantee for event seeding.

- **Affected surface.** `core/src/services/event-queue-worker.ts:175-179`.

- **Acceptance.** Each subscription is marked as seeded before processing the next (or the event is marked processed before
  starting the seed loop). A crash at any point in the seed sequence does not cause re-seeding. Integration test proves no
  duplicate seeds under crash simulation.

- **Depends on.** none.

#### P1.4 — Azure `renewLeases`: delete stale entries on renew failure `[copilot+review]`

- **Problem.** When a renewal fails in the Azure lock manager (line 79-87), the code does nothing — the lock is silently lost
  but the entry remains in `self.leases`. A subsequent `acquireLock` on the same blob could succeed while the old logical holder
  still thinks it owns the resource.

- **Affected surface.** `providers/workflow-es-azure/src/azure-lock-manager.ts:79-87`.

- **Acceptance.** On renew failure, the entry is deleted from the leases map (matching the Redis pattern). The lock can be
  re-acquired by another holder. A retry or alarm mechanism exists to prevent rapid churn.

- **Depends on.** none.

#### P1.5 — Azure queue: add pending queue / dead-letter to prevent message loss `[claude]`

- **Problem.** The Azure queue provider (azure-queue-provider.ts) deletes messages immediately upon receipt. If the processing
  node crashes mid-execution, the message is permanently lost. Redis uses `rpoplpush` which provides a pending queue that
  mitigates this, but the Azure provider has no equivalent.

- **Affected surface.** `providers/workflow-es-azure/src/azure-queue-provider.ts`.

- **Acceptance.** Azure queue provider uses a pending/visibility timeout pattern (or dead-letter queue) so crashed processing
  doesn't lose workflow IDs. Same contract as the Redis queue provider's pending behavior.

- **Depends on.** none.

### Phase 2 — Correctness hardening & edge cases

#### P2.1 — Poll worker: no tenant-awareness for event polling → cross-tenant window `[claude]`

- **Problem.** The poll worker calls `getRunnableEvents()` without a tenantId, which (per the persistence contract) returns events
  across ALL tenants. This creates a window where non-tenant-scoped events can be queued before the subscription seed checks
  tenant isolation — specifically, if an event arrives from tenant A and another from tenant B simultaneously, they may be
  interleaved in processing order before per-tenant locks serialize them.

- **Affected surface.** `core/src/services/poll-worker.ts:138`.

- **Acceptance.** Poll worker passes a tenantId (or iterates tenants) to `getRunnableEvents()`, or the persistence layer handles
  tenant-scoped polling natively. Cross-tenant event ordering is documented as acceptable (serialized by per-event locks).

- **Depends on.** none.

#### P2.2 — Status zero collision: `PointerStatus.Legacy == WorkflowStatus.Runnable` `[copilot]`

- **Problem.** Both `PointerStatus.Legacy` and `WorkflowStatus.Runnable` equal `0`. If a pointer's status is deserialized or
  persisted as `0`, it's ambiguous which enum it belongs to. Should be resolved via explicit default matching or documented.

- **Affected surface.** `core/src/models/execution-pointer.ts:22`; `core/src/models/workflow-status.ts:2`.

- **Acceptance.** The zero collision is either resolved (e.g., `PointerStatus.Legacy` renamed to `Unknown`) or documented in
  the model as an intentional alias with a clear migration path. Code uses explicit enum references, not bare numbers.

- **Depends on.** none.

#### P2.3 — Document connection pool defaults in PostgreSQL provider JSDoc `[copilot+review]`

- **Problem.** The PostgreSQL constructor passes `...options` to Sequelize without documenting recommended pool settings. Without
  explicit `max`/`min` pool settings, Sequelize defaults to a pool of 5 connections per host. In a multi-host deployment with
  high `maxConcurrentWorkflows`, effective concurrency is silently limited by the pool size.

- **Affected surface.** `providers/workflow-es-postgres/src/postgres-provider.ts:37-43`.

- **Acceptance.** JSDoc on the constructor documents recommended pool settings (`max`, `min`, `idle`). A default pool config is
  provided (e.g., min=2, max=10) if not specified.

- **Depends on.** none.

#### P2.4 — Wildcard regex edge cases in memory and MongoDB search filters `[copilot+review]`

- **Problem.** The `escapeRegex` helper in both `memory-persistence-provider.ts:263` and `mongodb-provider.ts:468` escapes
  metacharacters, but the character class `[\\]` handling may not cover all edge cases. If user input contains characters that
  become special regex syntax after replacement (e.g., `+` followed by another character), edge cases could produce unintended
  patterns.

- **Affected surface.** `core/src/services/memory-persistence-provider.ts:263`; `providers/workflow-es-mongodb/src/mongodb-provider.ts:468`.

- **Acceptance.** Both providers use identical, well-tested regex escaping. A test exists that passes a string containing every
  common metacharacter and verifies no injection occurs. The implementation is reviewed against the full set of ECMAScript
  regex metacharacters.

- **Depends on.** none.

#### P2.5 — Missing queue type default in Azure switch statement `[copilot]`

- **Problem.** The `getQueueName` switch (azure-queue-provider.ts:57-68) returns an empty string for any unknown `QueueType`,
  silently sending/receiving from a non-existent queue. The Redis provider has a `default` case; Azure does not.

- **Affected surface.** `providers/workflow-es-azure/src/azure-queue-provider.ts`.

- **Acceptance.** A `default` case in the switch throws a descriptive error for unknown queue types. No empty string return.

- **Depends on.** none.

### Phase 3 — Provider hygiene & operability polish

#### P3.1 — Audit Azure storage SDK deprecation + migrate if feasible `[claude]`

- **Problem.** The legacy `azure-storage` package (v1.x) is no longer maintained and does not support modern Azure AD
  authentication or managed identities. This is a supply-chain / dependency risk.

- **Affected surface.** `providers/workflow-es-azure/`.

- **Acceptance.** Decision documented: either migrated to `@azure/storage-queues` (v12+) with full parity, or formally
  deprecated with a migration guide for consumers. Either way, the README banners the decision.

- **Depends on.** none.

#### P3.2 — EventKey reference comparison in-memory provider limitation `[copilot+review]`

- **Problem.** In `memory-persistence-provider.ts:116`, event key comparison uses `===`. Two different object instances with
  identical content will not match. Sequelize and MongoDB handle this correctly by comparing serialized forms, but the memory
  provider (reference of conformance suite) could break tests that pass distinct object instances.

- **Affected surface.** `core/src/services/memory-persistence-provider.ts:116`.

- **Acceptance.** The limitation is documented in a comment on the method. Guidance provided for consumers who need deep equality
  on event keys (e.g., stringify before comparison). No behavioural change unless deemed necessary by reviewer.

- **Depends on.** none.

#### P3.3 — MongoDB `persistWorkflow`: verify pointer update atomicity with `$set` on parent doc `[copilot+review]`

- **Problem.** Execution pointers are stored as embedded array elements within the workflow document in MongoDB. The `$set` on
  the outer document updates them atomically, which is correct for MongoDB. However, this is implicit and undocumented — a
  future refactor could accidentally split pointer updates into a separate operation.

- **Affected surface.** `providers/workflow-es-mongodb/src/mongodb-provider.ts:120-134`.

- **Acceptance.** A comment documents that pointers are embedded sub-documents updated atomically with the parent via `$set`.
  No code changes required unless a refactor is needed.

- **Depends on.** none.

#### P3.4 — Document SQLite multi-host write contention limitation in WAL mode `[copilot]`

- **Problem.** WAL mode enables concurrent readers but single writer. Multiple workflow hosts sharing the same SQLite file will
  serialize writes at the OS level; under heavy load, this manifests as "database is locked" errors. The singleton lock provider
  mitigates for single-host scenarios but not for multi-host on the same file.

- **Affected surface.** `providers/workflow-es-sqlite/src/sqlite-provider.ts:70`.

- **Acceptance.** README / JSDoc documents that SQLite is for single-host use only. Multi-host requires PostgreSQL or Redis lock
  coordination (which SQLite doesn't support natively).

- **Depends on.** none.

#### P3.5 — Add `getActiveIds()` to PollWorker `[copiot]`

- **Problem.** `PollWorker.getActiveCount()` exists (via H1), but `getActiveIds()` returns an empty array without a comment
  explaining why. For health/status reporting, it would be useful to know which poll cycles are active. Returning `[]` is fine
  (poll ticks don't have item identity) but should be documented.

- **Affected surface.** `core/src/services/poll-worker.ts:72`.

- **Acceptance.** `getActiveIds()` returns `[]` with a comment explaining that poll ticks are anonymous. Health reporting uses
  the count from `getActiveCount()`. No behavioral change.

- **Depends on.** none.

### Phase 4 — Observability & logging fixes

#### P4.1 — Remove unreachable `//todo: check host status` in `publishEvent`; add shutdown guard `[copilot+review]`

- **Problem.** In `workflow-host.ts:194`, the comment says `//todo: check host status` but nothing is checked. Events are
  published to persistence and queued even after `stop()` is called, causing events to accumulate silently on a stopped host.

- **Affected surface.** `core/src/services/workflow-host.ts:193-218`.

- **Acceptance.** `publishEvent` checks `shuttingDown` (or equivalent) before accepting new events. A warning is logged when
  publishing to a stopped host. The TODO comment is removed.

- **Depends on.** none.

#### P4.2 — Document Azure lock manager constructor error swallowing `[copilot+review]`

- **Problem.** `azure-lock-manager.ts:17`: `//TODO: log` — the container creation callback's error parameter is ignored. If
  creation fails (access denied, network unreachable), all subsequent operations silently fail with no diagnostic.

- **Affected surface.** `providers/workflow-es-azure/src/azure-lock-manager.ts:17`.

- **Acceptance.** The error is logged at least at warn level. A `this.ready` promise resolves to `false` on error, so callers
  know the provider is unusable. Combined with P1.1 if both are implemented.

- **Depends on.** P1.1 (if that spec also covers this).

#### P4.3 — Audit and document `retryCount && retryCount > 0` redundancy `[copilot]`

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

**Recommended execution order:** All P0 first (critical correctness), then P1 (race conditions), then P2 (hardening), then
P3/P4 (hygiene). P1 items can be done in parallel since they touch different providers or distinct code paths.

---

## 7. Implementation conventions (identical to original plan §8)

Identical to `upgrade-plan.md` §8 — same config surface, shared primitives, versioning rules, and ground-truth facts.
Use those sections verbatim; do not redefine here.
