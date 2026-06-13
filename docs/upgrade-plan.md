# Enterprise Upgrade Plan — `@reactorynet/workflow-es`

**Status:** Draft 1 · **Audited core version:** `2.3.6-reactory.3` · **Owner:** Reactory platform team
**Primary target:** Cloud workflow runner (horizontally scaled) · **Secondary target:** Electron/desktop-wrapped app (legitimate, supported)

> This is the **master plan**. It is intentionally high-level: one short section per work item with
> just enough to understand the problem, the goal, and the blast radius. Each item is then **fleshed
> out as its own specification document** under [`docs/specs/`](./specs/) before any code is written.
>
> Implementation is frequently delegated to **lesser models** (GitHub Copilot CLI / Sonnet-class, per
> the conventions in [`../UPGRADES.md`](../UPGRADES.md)). Because of that, the per-item specs must be
> **unusually precise and self-contained** — see [§5 Spec authoring standard](#5-spec-authoring-standard).
> The quality bar lives in the specs, not in the implementer's judgement.

---

## 1. How to read this document

- **§3 Roadmap** is the single source of truth for *ordering and status*. Work top to bottom.
- Each item has a **stable ID** (e.g. `C1`, `H2`) carried over from the enterprise audit so findings,
  plan, specs, branches, and commits all cross-reference cleanly.
- Each item links to its spec at `docs/specs/<id>-<slug>.md`. **No code is written until that spec
  exists, is reviewed, and is marked `Ready`.**
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

1. **Cloud-first, but never desktop-hostile.** Every change must keep the engine runnable in a single
   process with zero external infrastructure (the Electron path). Cloud features are *additive*
   providers and config, never assumptions baked into the core.
2. **Correctness before features.** The Phase 0 concurrency/durability work gates everything. We do not
   add observability or tenancy on top of an engine that can double-execute steps.
3. **Provider parity is a contract.** Any change to a core interface (`IPersistenceProvider`,
   `IDistributedLockProvider`, `IQueueProvider`) must update *all* providers in the same change and is
   not Done until every provider builds and passes integration tests in CI.
4. **No silent behavioural change.** Public API and on-disk/at-rest formats are versioned. Migrations
   are explicit and documented.
5. **Spec-first, one item at a time.** Per `UPGRADES.md`. No batching unrelated items into one change.
6. **Backward compatibility window.** The consuming `reactory-express-server` integrates via a `file:`
   tarball. Breaking changes require a coordinated version bump and a migration note in the spec.

---

## 3. Roadmap

Ordered for execution. Phase 0 is the critical path for cloud; Phase 1 unlocks Electron durability and
resilience for both; Phases 2–3 are operability, security, and hardening.

| # | ID | Item | Target | Severity | Owner | Status | Spec |
|---|----|------|--------|----------|-------|--------|------|
| **Phase 0 — Multi-instance correctness (cloud critical path)** |
| 1 | C1 | Working distributed lock + queue providers; optimistic concurrency | Cloud | Critical | `[claude]` | done | `specs/c1-distributed-providers.md` |
| 2 | H2 | Close lock-release race (post-processing inside lock) | Both | High | `[claude]` | done | `specs/h2-lock-release-race.md` |
| 3 | H3 | Lease/lock the poll worker | Cloud | High | `[claude]` | done | `specs/h3-poll-worker-lease.md` |
| 4 | H4 | Async graceful drain; SIGTERM + Electron quit handling | Both | High | `[claude]` | done | `specs/h4-graceful-shutdown.md` |
| 5 | H1 | Bounded concurrency / backpressure | Both | High | `[claude]` | done | `specs/h1-bounded-concurrency.md` |
| **Phase 1 — Durability & resilience** |
| 6 | C2 | Embedded SQLite/file persistence provider (Electron unlock) | Electron | Critical | `[claude]` | done | `specs/c2-embedded-persistence.md` |
| 7 | H5 | Dead-letter + configurable max retries | Both | High | `[claude]` | done | `specs/h5-dead-letter.md` |
| 8 | C3 | Repair or deprecate Mongo & MySQL providers | Cloud | Critical | `[copilot+review]` | done | `specs/c3-mongo-mysql-providers.md` |
| 9 | M7 | Provider dependency hygiene (peer-deps, package name, versions) | Cloud | Medium | `[copilot+review]` | done | `specs/m7-provider-deps.md` |
| 10 | M8 | Providers built + integration-tested in CI (Testcontainers) | Cloud | Medium | `[copilot+review]` | done | `specs/m8-provider-ci.md` |
| **Phase 2 — Operability & security** |
| 11 | M5 | OpenTelemetry tracing + metrics + health endpoint | Cloud | Medium | `[claude]` | done | `specs/m5-observability.md` |
| 12 | M4 | Structured logging + correlation IDs | Both | Medium | `[copilot+review]` | spec | `specs/m4-structured-logging.md` |
| 13 | H6 | At-rest encryption/redaction hook for workflow data | Cloud | High | `[claude]` | spec | `specs/h6-data-at-rest.md` |
| 14 | M6 | Multi-tenancy / namespace scoping | Cloud | Medium | `[claude]` | spec | `specs/m6-multi-tenancy.md` |
| **Phase 3 — Hardening & scale polish** |
| 15 | M2 | Mandated provider indexes; remove full-scan hotspots | Cloud | Medium | `[copilot+review]` | spec | `specs/m2-provider-indexes.md` |
| 16 | M1 | Workflow-definition version-safety on load | Both | Medium | `[copilot+review]` | spec | `specs/m1-version-safety.md` |
| 17 | M3 | Document & guard execution model (worker thread for Electron) | Electron | Medium | `[claude]` | spec | `specs/m3-execution-model.md` |

> IDs `C*/H*/M*` map 1:1 to the enterprise audit (Critical / High / Medium). They are stable: never
> renumber. New items append with the next free number in their severity class.

---

## 4. Item summaries

Each summary is the seed for a full spec. Format per item: **Problem · Goal · Affected surface ·
Acceptance (high level) · Depends on**. The spec expands every line into testable detail.

### Phase 0 — Multi-instance correctness

#### C1 — Working distributed lock + queue providers; optimistic concurrency `[claude]`
- **Problem.** Redis and Azure providers are stale stubs (`workflow-es@^2.1.0`, `inversify@^4`, old
  `"workflow-es"` import, pre-`acquireLock` rename) and will not build against current core. The
  default lock/queue are in-memory and per-process. `persistWorkflow` is last-write-wins with no
  version check. Result: more than one node cannot run safely — duplicate/concurrent execution and
  lost updates.
- **Goal.** A production-grade distributed lock + queue provider (Redis/Redlock as the reference),
  plus optimistic concurrency on `persistWorkflow`. Single-node providers explicitly flagged dev-only
  and fail-loud if multiple hosts are detected with them.
- **Affected surface.** `providers/workflow-es-redis/*`, `core/src/abstractions/persistence-provider.ts`
  (add concurrency token), all persistence providers, `core/src/services/workflow-host.ts` startup guard.
- **Acceptance (high level).** Two host instances against shared Redis + Postgres execute a 1000-instance
  fan-out with zero duplicate step executions and zero lost updates, proven by an integration test.
- **Depends on.** none (critical path root). Pairs tightly with H2, H3.

#### H2 — Close the lock-release race `[claude]`
- **Problem.** In `WorkflowQueueWorker.processWorkflow`, the lock is released in the inner `finally`,
  then subscription creation and re-queue decisions read instance state *after* release — a window for
  another worker to acquire and re-execute. Subscription creation outside the lock can double-subscribe.
- **Goal.** All state-derived post-processing (subscription persistence, re-queue decision, event
  seeding) happens inside the lock and is idempotent.
- **Affected surface.** `core/src/services/workflow-queue-worker.ts`, `event-queue-worker.ts`.
- **Acceptance.** Concurrency test shows a workflow that emits subscriptions + re-queues is never
  processed twice for the same pointer; subscriptions are created exactly once under contention.
- **Depends on.** Best landed with C1 (needs a real lock to test meaningfully).

#### H3 — Lease/lock the poll worker `[claude]`
- **Problem.** `PollWorker.process` has `//TODO: lock`. Every node scans `getRunnableInstances()` every
  10s and re-queues the same IDs — wasted work that amplifies H1/H2 across a cluster.
- **Goal.** Poll cycle gated behind a distributed lease (single active poller) or sharded scan;
  interval configurable.
- **Affected surface.** `core/src/services/poll-worker.ts`, config.
- **Acceptance.** With N nodes, each runnable instance is queued by exactly one poller per cycle
  (integration test asserts no duplicate queueing).
- **Depends on.** C1 (lock provider).

#### H4 — Async graceful drain; SIGTERM + Electron quit `[claude]`
- **Problem.** `stop()` only clears interval timers; in-flight `processWorkflow` promises are abandoned
  (fire-and-forget), risking held locks and partial state. Only `SIGINT` is handled (cloud sends
  `SIGTERM`; Electron neither). The signal handler is never removed and stacks per host instance.
- **Goal.** `stop()` becomes async: stop intake → await in-flight executions with a configurable
  timeout → resolve. Handle `SIGTERM` and expose hooks for Electron `before-quit`/`will-quit`. Register
  signal handlers once; remove on stop.
- **Affected surface.** `core/src/services/workflow-host.ts`, all `*-worker.ts`, `IBackgroundWorker`.
- **Acceptance.** Sending SIGTERM mid-execution drains active workflows to a consistent state within the
  timeout; no lock left held; no orphaned timers; idempotent across repeated stop().
- **Depends on.** H1 (drain needs a tracked set of in-flight executions).

#### H1 — Bounded concurrency / backpressure `[claude]`
- **Problem.** `WorkflowQueueWorker` runs on a fixed `setInterval(…,100)` and fires `processWorkflow`
  without awaiting. A burst of N runnable workflows spawns N concurrent executions — no cap, no
  backpressure; exhausts DB connections and event-loop time.
- **Goal.** A bounded worker pool (`maxConcurrentWorkflows`, configurable) with a self-rescheduling loop
  (`setTimeout` after completion, not stacking `setInterval`). Same for the event worker.
- **Affected surface.** `core/src/services/workflow-queue-worker.ts`, `event-queue-worker.ts`, config.
- **Acceptance.** Under a 10k-instance burst, concurrent executions never exceed the configured cap;
  throughput is stable; the in-flight set is observable (feeds H4 drain).
- **Depends on.** none, but co-designed with H4.

### Phase 1 — Durability & resilience

#### C2 — Embedded SQLite/file persistence provider `[claude]`
- **Problem.** Core ships only `MemoryPersistenceProvider`; all state is lost on restart. Mongo/Postgres
  require external servers — unsuitable to bundle in a desktop app. This blocks the Electron target
  entirely.
- **Goal.** A first-class durable embedded provider (SQLite preferred; evaluate better-sqlite3 vs
  sql.js for bundling). Survives app restart; no external services. Doubles as a light option for small
  cloud deployments.
- **Affected surface.** new `providers/workflow-es-sqlite/*`, core docs, packaging notes for Electron.
- **Acceptance.** Kill-and-restart test: in-flight workflows resume to completion after a process
  restart; works inside a packaged Electron build.
- **Depends on.** C1 (final `IPersistenceProvider` shape incl. concurrency token).

#### H5 — Dead-letter + configurable max retries `[claude]`
- **Problem.** The default error strategy and the "step not found" path retry forever
  (`sleepUntil = now + 60000`). A poison step pins a workflow in an endless retry loop. 60s is a magic
  number.
- **Goal.** Per-step/definition `maxRetries`; on exhaustion, transition to a dead-letter terminal state
  and emit a lifecycle event. All retry timings configurable.
- **Affected surface.** `core/src/services/execution-result-processor.ts`,
  `core/src/services/workflow-executor.ts`, models (`WorkflowStatus`/error model), config.
- **Acceptance.** A permanently-failing step dead-letters after exactly `maxRetries`, emits an event,
  and stops consuming the queue. Existing retry/compensate scenarios still pass.
- **Depends on.** none.

#### C3 — Repair or deprecate Mongo & MySQL providers `[copilot+review]`
- **Problem.** Mongo provider uses removed driver v3 callback API (`MongoClient.connect(cb)`,
  `ObjectID`, `useNewUrlParser`) and misuses `.insertOne().then((err,result)=>…)`. MySQL pins EOL
  Sequelize 4 / sequelize-typescript 0.6. Both import old `"workflow-es"`.
- **Goal.** Decide per provider: upgrade Mongo to driver v6 (async/await, `ObjectId`) and MySQL to
  Sequelize 6, **or** formally deprecate and point users at Postgres as the SQL reference. Decision
  recorded in the spec.
- **Affected surface.** `providers/workflow-es-mongodb/*`, `providers/workflow-es-mysql/*`.
- **Acceptance.** Each provider either passes the shared provider integration suite (M8) or is marked
  deprecated with a README banner and excluded from CI.
- **Depends on.** M7, M8 (shared deps + test harness), C1 (interface shape).

#### M7 — Provider dependency hygiene `[copilot+review]`
- **Problem.** Providers declare `inversify@^4`, `reflect-metadata@^0.1`, and `workflow-es` (old name)
  as hard deps; Postgres uses `reflect-metadata@^0.1.13` vs core `^0.2.0`. Duplicate inversify/
  reflect-metadata copies break decorator metadata via dual module instances.
- **Goal.** Core libs become `peerDependencies` across all providers; versions aligned to core; all
  imports use `@reactorynet/workflow-es`.
- **Affected surface.** every `providers/*/package.json`, provider source imports.
- **Acceptance.** Fresh install of any provider resolves a single inversify/reflect-metadata; all
  providers type-check against current core.
- **Depends on.** none (but precedes C3 cleanly).

#### M8 — Providers built + integration-tested in CI `[copilot+review]`
- **Problem.** CI builds/tests `core` only (`working-directory: core`) — exactly why C1/C3 rotted.
- **Goal.** CI matrix builds every provider and runs an integration suite against ephemeral services
  (Testcontainers for Postgres/Mongo/Redis).
- **Affected surface.** `.github/workflows/ci.yml`, a shared provider conformance test suite.
- **Acceptance.** A breaking core-interface change fails provider CI; the conformance suite runs green
  for every non-deprecated provider on PR.
- **Depends on.** M7.

### Phase 2 — Operability & security

#### M5 — OpenTelemetry tracing + metrics + health `[claude]`
- **Problem.** No metrics, traces, or health/readiness — table stakes for a cloud runner.
- **Goal.** OTel spans around step execution; metrics for active instances, queue depth, step duration,
  error/retry rates; a host health method (queue connectivity, lock provider reachable, poll heartbeat).
- **Affected surface.** new `IMetrics`/tracing hooks in core, host, workers.
- **Acceptance.** Spans/metrics emitted to a configured OTel collector in an integration test; health
  method reflects degraded provider state.
- **Depends on.** H1 (in-flight count), H4 (lifecycle).

#### M4 — Structured logging + correlation IDs `[copilot+review]`
- **Problem.** `ILogger` is `printf`-style (`%s/%o`); default `NullLogger` swallows everything; no
  correlation IDs or levels config.
- **Goal.** Structured logger interface (level + message + context object incl. `workflowId`/`stepId`/
  `tenantId`); console adapter retained; pino/winston injectable.
- **Affected surface.** `core/src/abstractions/logger.ts`, all call sites, console-logger.
- **Acceptance.** Every workflow/step log carries correlation context; level filtering works; existing
  call sites migrated without losing information.
- **Depends on.** M6 for `tenantId` field (can ship field as optional first).

#### H6 — At-rest encryption/redaction hook for workflow data `[claude]`
- **Problem.** `WorkflowInstance.data: any` and `eventData` are serialized verbatim (plaintext in DB).
  Enterprise workflows carry PII/secrets. No encryption, size limit, or schema validation.
- **Goal.** A serialization hook for at-rest encryption/redaction of sensitive fields; documented
  data-at-rest model; baseline reliance on DB TDE documented; optional size guard.
- **Affected surface.** persistence boundary (serialize/deserialize hook in core + providers), docs.
- **Acceptance.** With an encryption hook configured, `data`/`eventData` are unreadable at rest and
  round-trip correctly; no plaintext leakage in logs.
- **Depends on.** C1 (provider serialization boundary settled).

#### M6 — Multi-tenancy / namespace scoping `[claude]`
- **Problem.** Nothing partitions instances/events by tenant; `publishEvent` matches globally on
  `eventName`+`eventKey`, so colliding keys cross tenants.
- **Goal.** A tenant/namespace dimension on instances, events, subscriptions, and locks; all provider
  queries scoped by it.
- **Affected surface.** models, `IPersistenceProvider` queries, lock keying, host API.
- **Acceptance.** Two tenants with identical event keys never wake each other's subscriptions; tenant
  scoping enforced at the provider query layer.
- **Depends on.** C1, M4 (logging field).

### Phase 3 — Hardening & scale polish

#### M2 — Mandated provider indexes; remove full-scan hotspots `[copilot+review]`
- **Problem.** `getRunnableEvents`/`getEvents`/`getRunnableInstances` scan-and-filter; no indexes
  mandated by the provider contract.
- **Goal.** Provider contract specifies required indexes (`status+nextExecution`,
  `eventName+eventKey+eventTime`, subscription keys); SQL/Mongo providers create them in sync/migration.
- **Affected surface.** provider contract docs, Postgres/Mongo schema/migration.
- **Acceptance.** Query plans use indexes; a 1M-row benchmark stays within target latency.
- **Depends on.** C1, C3.

#### M1 — Workflow-definition version-safety on load `[copilot+review]`
- **Problem.** An instance referencing a version no longer in the registry throws a generic error deep
  in the executor; no migration guidance.
- **Goal.** Detect missing-version on load → route to dead-letter with a clear, structured error;
  document the "never unregister old versions" rule.
- **Affected surface.** `core/src/services/workflow-executor.ts`, registry, docs.
- **Acceptance.** Loading an instance for an unregistered version dead-letters cleanly with an
  actionable message; documented upgrade procedure.
- **Depends on.** H5 (dead-letter target).

#### M3 — Document & guard the execution model `[claude]`
- **Problem.** Step bodies run inline in the host process — competes with Electron UI/main thread;
  a CPU-heavy step stalls all workflow processing on a node.
- **Goal.** Document the non-blocking/IO-bound contract for step bodies; provide guidance + a supported
  pattern to host the engine in a `utilityProcess`/worker thread for Electron.
- **Affected surface.** docs, Electron integration sample.
- **Acceptance.** Electron sample runs the host off the main thread; documented guidance with a working
  example.
- **Depends on.** C2, H4.

---

## 5. Spec authoring standard

Every roadmap item gets a spec at `docs/specs/<id>-<slug>.md` **before implementation**. Specs are
written to be executed by a **lesser model with no prior context** — so they must be complete,
literal, and verifiable. Use the template at [`docs/specs/_TEMPLATE.md`](./specs/_TEMPLATE.md). A spec
is not `ready` until it satisfies this checklist:

- [ ] **Context** restates the problem from this plan *without requiring the reader to open other docs*.
- [ ] **Exact file list** — every file to be created/modified, by path. No "etc.".
- [ ] **Interface deltas** — full before/after signatures for any changed type, method, or DI binding.
- [ ] **Behavioural contract** — what must happen, including ordering, idempotency, and error paths,
      stated as numbered rules.
- [ ] **Out of scope** — explicit list of what NOT to change (prevents scope creep by the implementer).
- [ ] **Test plan** — concrete test cases (names + arrange/act/assert), including the failing test that
      must exist first (TDD), and how to run them. Reference real existing scenarios in
      `core/spec/scenarios/` as patterns to follow.
- [ ] **Acceptance criteria** — binary, machine-checkable where possible (a command + expected result).
- [ ] **Backward-compat & migration** — on-disk format, public API, and consumer (`reactory-express-server`)
      impact; version bump if any.
- [ ] **Provider parity** — if a core interface changes, the spec enumerates the change to *every*
      provider and requires them to land together.
- [ ] **Dependencies & sequencing** — which item IDs must be `done` first.
- [ ] **Definition of Done** — restated as a single paragraph the reviewer signs off against.

### Why this rigour

Lesser models do not supply missing judgement; they fill gaps with plausible guesses. The spec must
remove the need to guess. If a reviewer reading only the spec cannot predict the resulting diff, the
spec is not `ready`.

---

## 6. Cross-cutting: Definition of Done (applies to every item)

1. Spec exists, was reviewed, and is marked `done` with the reviewer noted.
2. New/changed behaviour is covered by tests; the TDD failing-test-first was real (visible in history
   or PR description).
3. `core` builds and `yarn test` passes on the Node 20 + 22 CI matrix.
4. If a core interface changed: **all** non-deprecated providers build and pass the conformance suite
   (gated by M8 once landed).
5. Single-process / Electron path still works with zero external infrastructure.
6. Docs updated: this plan's status table, the item's spec, and any user-facing README/guide.
7. Consumer impact assessed; if breaking, version bumped and a migration note added to the spec.

---

## 7. Relationship to `UPGRADES.md`

[`../UPGRADES.md`](../UPGRADES.md) is the pre-existing backlog and the source of the delegation
mechanics (Copilot CLI invocation, `[copilot]`/`[claude]` tags, prompt provenance under `.copilot/`).
This plan **supersedes it for enterprise readiness scope and ordering**; items already completed there
(e.g. the saga compensation and ID-generation fixes) are assumed done and are not re-listed. New specs
follow the delegation conventions defined in `UPGRADES.md`.

---

## 8. Cross-cutting implementation conventions (authoritative)

The 17 specs were authored in parallel; several independently invented their own answer to the same
recurring questions (how config is exposed, what the next version number is, what shared primitives are
named). This section is the **single source of truth** and **overrides any conflicting statement in an
individual spec**. When implementing an item, follow this section; if a spec disagrees, this wins and
the spec should be corrected.

### 8.1 Config surface — one rule

`configureWorkflow()` currently takes no arguments and `WorkflowConfig` exposes `useLogger` /
`usePersistence` / `useQueueManager` / `useLockManager` setters. Extend that shape consistently:

- **Scalar / behavioural tunables** → a single options object passed to the factory:
  `configureWorkflow(options?: Partial<WorkflowOptions>)`, bound once as `TYPES.WorkflowOptions` and
  injected wherever needed. The no-arg call **must keep working** (all fields optional, sane defaults).
  `WorkflowOptions` is the union of every scalar introduced by the specs:

  ```ts
  export interface WorkflowOptions {
    pollIntervalMs: number;            // H3 — default 10000
    workflowQueueIntervalMs: number;   // H1 — default 100
    eventQueueIntervalMs: number;      // H1 — default 500
    maxConcurrentWorkflows: number;    // H1 — default 10
    maxConcurrentEvents: number;       // H1 — default 20
    gracefulShutdownTimeoutMs: number; // H4 — default 30000
    retry: {                           // H5
      defaultMaxRetries: number;       //      default 3 (retries after first attempt)
      defaultRetryIntervalMs: number;  //      default 60000
      stepNotFoundRetryIntervalMs: number; // default 60000
    };
    dataCodecMaxBytes: number;         // H6 — default 0 (unlimited)
  }
  ```

  Therefore: **discard** the per-item variants (`TYPES.GracefulShutdownTimeoutMs` in H4,
  `TYPES.WorkerPoolConfig` / `WorkflowConfig.useWorkerPoolConfig` in H1, the standalone
  `WorkflowOptions` in H3). They all collapse into the one `TYPES.WorkflowOptions` binding above.

- **Swappable services / adapters** → a `WorkflowConfig.useX(...)` setter, matching the existing
  pattern: `useLogger` (M4), `useMetrics` / `useTracer` (M5), `useDataCodec` (H6),
  `useLifecycleEventHub` (H5). These rebind a DI token to a provided instance; they are **not** part of
  `WorkflowOptions`.

Rule of thumb: **a value → `WorkflowOptions`; an implementation → a `useX()` setter.**

### 8.2 Shared primitives (already consistent — do not redefine)

These were introduced by one spec and are reused by others. Implement them **once**, in the owning
item, exactly as named:

| Primitive | Owner | Reused by |
|---|---|---|
| `WorkflowInstance.concurrencyToken: number` (default 0) + `WorkflowConcurrencyError` (thrown by `persistWorkflow` on stale write) | C1 | C2, C3, M8, H6 |
| `WorkflowStatus.DeadLettered` + `PointerStatus.DeadLettered` | H5 | M1 |
| `ILifecycleEventHub` (minimal injectable, sync, error-swallowing) + `workflow.dead-lettered` event | H5 | M1, and forward-compatible with M5/M4 |
| `IWorkflowRegistry.tryGetDefinition()` (non-throwing) | M1 | — (executor load path) |

### 8.3 Versioning — do not hard-code

Specs variously guessed `2.3.6-reactory.4` and `2.4.0-reactory.0`. **Do not bake a target version into
a spec's diff.** The version is bumped **at merge time**, per change:

- Items that add members to a public interface (`IPersistenceProvider`, `IDistributedLockProvider`,
  `IQueueProvider`, `ILogger`, `IWorkflowHost`) or to `configureWorkflow` → **minor** pre-release bump.
  C1 is the first such change and takes core to `2.4.0-reactory.0`; subsequent additive items continue
  the `2.4.0-reactory.N` series unless a genuinely breaking change forces a larger bump.
- Pure internal/behavioural items (H2, H3 internals) → **patch** pre-release bump.
- Every breaking change to a public interface requires a migration note in the spec's §10 and a
  coordinated bump of the `file:` tarball reference in `reactory-express-server`.

### 8.4 Ground-truth facts (verified — rely on these, don't re-derive)

- Test helper is **`spinWait`** (promise form) in `core/spec/helpers/spin-wait.ts`. `spinWaitCallback`
  also exists but existing scenarios use `spinWait` — match them.
- Barrels are **flat files**: `core/src/models.ts`, `core/src/abstractions.ts`,
  `core/src/services.ts`, `core/src/primitives.ts`, `core/src/fluent-builders.ts`. There is **no**
  `index.ts` inside those folders.
- DI symbols live in `core/src/abstractions/types.ts` (`TYPES`).
- `WorkflowInstance.version` is the **workflow-definition** version — it is **not** a concurrency
  token. C1's `concurrencyToken` is a separate field.
- `registry.getDefinition()` **throws** on a miss today (`workflow-registry.ts`), so the executor's
  `if (!def)` guard is currently dead code — M1 addresses this with `tryGetDefinition()`.

### 8.5 Dependency ordering (recap of the cross-spec graph)

`C1` is the root (settles `IPersistenceProvider` + concurrency token). `C2`, `C3`, `M8`, `H6`, `M6`
depend on it. `H5` precedes `M1`. `H1` precedes/co-designs with `H4` (shared in-flight set). `M7`
precedes `M8`. Honour the §3 roadmap order; do not start an item whose `Depends on` are not `done`.

