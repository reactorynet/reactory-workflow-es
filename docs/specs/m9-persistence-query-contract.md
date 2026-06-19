# Spec — M9 · Persistence query, aggregation & delete contract (store-agnostic read layer)

| Field | Value |
|---|---|
| **Item ID** | M9 |
| **Title** | Persistence query/aggregation/delete contract + store-agnostic read layer |
| **Plan reference** | [`upgrade-plan.md` → M9](../upgrade-plan.md) |
| **Target** | Cloud + Electron (Both) |
| **Severity** | High |
| **Owner tag** | Phase 1 (contract) `[claude]` · Phase 2 (express refactor) `[copilot+review]` |
| **Status** | spec |
| **Depends on** | C1 (concurrencyToken), M6 (tenantId), M8 (conformance harness), C2/C3 (sqlite/mongo providers) — all done |
| **Author / reviewer** | Reactory platform team |

---

## 1. Context (self-contained)

The workflow engine persists instances through the pluggable `IPersistenceProvider`
(memory / sqlite / postgres / mongo). The **engine** uses this abstraction. But the consuming
`reactory-express-server` **read layer** does not: the workflow execution-history view,
statistics, inspector, and AI macros all read through a hard-wired **mongoose** model
(`WorkflowInstanceModel`, bound to the `workflows` collection) inside `WorkflowLifecycleManager`,
which `core.ReactoryWorkflowService` delegates to.

Consequence: the read layer only works when persistence is MongoDB. With
`WORKFLOW_PERSISTENCE_PROVIDER=sqlite|postgres` the engine writes to SQLite/Postgres but the UI
reads the (empty) Mongo collection → **no history, no stats, no inspector**. (This is also why a
CODE workflow that ran successfully showed "No execution history".)

`IPersistenceProvider` today exposes only operational reads (`getWorkflowInstance`,
`getRunnableInstances`, `getRunnableEvents`, `getSubscriptions`, `getEvents`) — it has **no
filtered query, no aggregation, and no delete**. The express read layer needs all three. This item
adds them to the contract and implements them **natively in every provider** (so each store can use
its own optimizations — SQL `GROUP BY`/indexes, Mongo aggregation pipelines), then refactors express
to read exclusively through the provider and retire the mongoose model.

**Decision (maintainer):** advanced aggregations (average completion time, per-definition rollups,
failed-step rollups, daily time-series) are implemented **natively per provider** rather than
computed in express — more provider code, but closer to the data and individually optimizable.

The exact read surface express needs (from `IReactoryWorkflowService` → `WorkflowLifecycleManager`):
- Filtered + paginated + sorted history: `getWorkflowHistory`, `…ByDefinitionId`, `…ByStatus`,
  `searchWorkflowHistory`, `getRecentWorkflowExecutions`.
- By id: `getWorkflowHistoryById` (engine already has `getWorkflowInstance`).
- Stats bundle (`getWorkflowExecutionStats`): by-status counts + `averageCompletionTime` +
  `byWorkflowDefinition` (top-20: total/complete/terminated). Plus `getInstancesWithFailedSteps`
  (group by definition where any execution pointer is FAILED and status ≠ TERMINATED) and a daily
  time-series (date → total/complete/terminated).
- Delete: `deleteWorkflowHistory` (one), `…Batch` (many), `clearWorkflowHistory` (by definition).

## 2. Goal

`IPersistenceProvider` gains a filtered-query method, a stats/aggregation surface, a daily
time-series method, and delete methods — implemented natively in memory, sqlite, postgres, and mongo,
covered by the shared conformance suite. The express read layer (`ReactoryWorkflowService` /
`WorkflowLifecycleManager`) reads and deletes **only through the active provider** (obtained from the
running `WorkflowHost`/`WorkflowRunner`), so workflow history works identically on Mongo, Postgres,
and SQLite. The mongoose `WorkflowInstanceModel` is retired; YAML executions persist through the
active provider so they appear in history regardless of store.

## 3. Out of scope

- No change to the engine's execution path, queue, lock, or event handling.
- No change to `IQueueProvider` / `IDistributedLockProvider`. Redis/cluster mode is unaffected
  (Redis is coordination only; persistence is independent).
- No new DI bindings or `configureWorkflow` options (these are methods on the existing
  `IPersistenceProvider`).
- Do **not** modernize the deprecated `workflow-es-mysql` provider; it stays CI-excluded.
- Express scheduling, security, configuration managers are untouched except where they read history.

## 4. Files to create / modify

### Phase 1 — `reactory-workflow-es` (the contract)
| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/persistence-provider.ts` | modify | add the query/stats/timeseries/delete methods + JSDoc |
| `core/src/abstractions/workflow-query.ts` | create | `WorkflowInstanceQuery`, `WorkflowInstanceStats`, `WorkflowDefinitionRollup`, `WorkflowTimeSeriesPoint`, `WorkflowTimeSeriesQuery` types |
| `core/src/abstractions.ts` | modify | barrel-export the new types |
| `core/src/services/memory-persistence-provider.ts` | modify | implement natively (in-array) |
| `core/src/testing/conformance/persistence-conformance.ts` | modify | add query/stats/timeseries/delete conformance cases |
| `providers/workflow-es-postgres/src/postgres-provider.ts` | modify | implement via Sequelize `findAndCountAll` + `fn`/`literal` aggregations + `destroy` |
| `providers/workflow-es-sqlite/src/sqlite-provider.ts` | modify | same shape as postgres (sqlite dialect) |
| `providers/workflow-es-mongodb/src/mongodb-provider.ts` | modify | implement via `find`/`countDocuments`/aggregation pipelines/`deleteMany` |
| `core/package.json` + provider `package.json`s | modify | version bump at merge time (see §10) |

### Phase 2 — `reactory-express-server` (consume it)
| Path | Action | Why |
|---|---|---|
| `src/modules/reactory-core/workflow/LifecycleManager/LifecycleManager.ts` | modify | read/delete via the provider; `transformToHistoryItem` operates on returned `WorkflowInstance`s |
| `src/modules/reactory-core/services/Workflow/ReactoryWorkflowService.ts` | modify | route history/stats/delete to the provider-backed lifecycle methods |
| `src/modules/reactory-core/workflow/WorkflowRunner/WorkflowRunner.ts` | modify | expose the active `IPersistenceProvider` to the lifecycle manager; route `persistYamlExecution` through the provider |
| `src/modules/reactory-core/workflow/LifecycleManager/models/WorkflowInstanceModel.ts` | delete (or quarantine) | mongoose model retired once reads go through the provider |
| `src/modules/reactory-core/workflow/LifecycleManager/models/index.ts`, `…/index.ts` | modify | drop the model export |

## 5. Interface & data-model changes

### New types (`core/src/abstractions/workflow-query.ts`)
```ts
export interface WorkflowInstanceQuery {
  tenantId?: string;                 // omit = all tenants
  workflowDefinitionId?: string;     // exact, or contains '*' → wildcard (translated per store)
  status?: number | number[];        // WorkflowStatus value(s)
  createdAfter?: Date;  createdBefore?: Date;
  completedAfter?: Date; completedBefore?: Date;
  searchTerm?: string;               // matches workflowDefinitionId | description | id (case-insensitive)
  sortField?: "createTime" | "completeTime" | "workflowDefinitionId" | "status";  // default createTime
  sortOrder?: "asc" | "desc";        // default desc
  skip?: number;                     // default 0
  take?: number;                     // default 50; providers MUST cap (e.g. <= 500) to bound result size
}

export interface WorkflowDefinitionRollup {
  workflowDefinitionId: string;
  total: number;
  complete: number;      // status === Complete
  terminated: number;    // status === Terminated
}

export interface WorkflowInstanceStats {
  total: number;
  byStatus: Record<number, number>;          // WorkflowStatus value -> count
  averageCompletionTimeMs: number | null;     // avg(completeTime - createTime) over Complete instances; null if none
  byDefinition: WorkflowDefinitionRollup[];    // sorted by total desc; capped to topDefinitions (default 20)
  instancesWithFailedSteps: Record<string, number>;  // definitionId -> count of NON-terminated instances with >=1 Failed pointer
}

export interface WorkflowTimeSeriesQuery {
  tenantId?: string;
  from: Date;
  to: Date;                 // inclusive day range
  // bucket is daily (UTC) for v1
}

export interface WorkflowTimeSeriesPoint {
  date: string;             // ISO date "YYYY-MM-DD" (UTC)
  total: number;
  complete: number;
  terminated: number;
}
```

### `IPersistenceProvider` additions (before → after)
```ts
// BEFORE: operational reads only (getWorkflowInstance/getRunnableInstances/…)

// AFTER — append (all additive; existing methods unchanged):
queryWorkflowInstances(query: WorkflowInstanceQuery): Promise<{ instances: WorkflowInstance[]; total: number }>;
getWorkflowInstanceStats(query?: WorkflowInstanceQuery & { topDefinitions?: number }): Promise<WorkflowInstanceStats>;
getWorkflowInstanceTimeSeries(query: WorkflowTimeSeriesQuery): Promise<WorkflowTimeSeriesPoint[]>;
deleteWorkflowInstance(id: string): Promise<boolean>;                 // true if a row was removed
deleteWorkflowInstances(ids: string[]): Promise<number>;             // count removed
deleteWorkflowInstancesByDefinitionId(workflowDefinitionId: string, tenantId?: string): Promise<number>;  // count removed
```

### DI / config impact
None. No new bindings, no `configureWorkflow` change.

### Persisted / at-rest format impact
None. Reads/deletes only. (Deletes remove rows; documented in §10.)

## 6. Behavioural contract (numbered rules)

1. **Filtering** — `queryWorkflowInstances` returns instances matching ALL provided filters (AND):
   `tenantId` (omit = all tenants), `workflowDefinitionId` (exact unless it contains `*`, then a
   wildcard match — translate `*`→`%`/regex per store, anchored), `status` (single or any-of array),
   `createdAfter/Before` against `createTime`, `completedAfter/Before` against `completeTime`,
   `searchTerm` (case-insensitive substring over `workflowDefinitionId`, `description`, `id`).
2. **Sorting** — by `sortField` (default `createTime`) / `sortOrder` (default `desc`). Ties broken by
   `id` for stable pagination.
3. **Pagination** — `skip` (default 0), `take` (default 50, capped at 500). `total` is the unpaged
   match count.
4. **Returned shape** — `instances` are full `WorkflowInstance` objects (incl. `executionPointers`,
   `id` set, `data`, `tenantId`, `concurrencyToken`) identical to `getWorkflowInstance` output.
5. **Stats** — `getWorkflowInstanceStats(query?)` honours the same filters (a `query` scopes the
   stats; omit = whole store). `byStatus` maps every present `WorkflowStatus` to its count;
   `total` = sum. `averageCompletionTimeMs` = mean of `(completeTime - createTime)` in ms over
   instances with `status === Complete` and non-null `completeTime`; `null` when none.
   `byDefinition` groups by `workflowDefinitionId` (`total`, `complete`, `terminated`), sorted by
   `total` desc, capped to `topDefinitions` (default 20). `instancesWithFailedSteps` counts, per
   definition, instances that have ≥1 execution pointer with `PointerStatus.Failed` **and**
   `status !== Terminated`.
6. **Time series** — `getWorkflowInstanceTimeSeries` returns one point per **UTC day** in `[from, to]`
   that has ≥1 instance (by `createTime`), each with `total`/`complete`/`terminated`, ordered by date
   asc. Days with no instances MAY be omitted (express fills gaps).
7. **Tenant scoping** — every method honours `tenantId` when provided; omitted = all tenants
   (consistent with M6 `getRunnableInstances`). Stats/time-series likewise.
8. **Deletes** — `deleteWorkflowInstance` removes the instance (and its owned execution pointers in
   SQL providers via the existing cascade/`destroy`); returns `true` iff a row existed. `deleteWorkflowInstances`
   returns the number removed (missing ids ignored — idempotent). `deleteWorkflowInstancesByDefinitionId`
   removes all matching (scoped by `tenantId` when given) and returns the count. Deletes are hard
   deletes (no soft-delete in v1).
9. **Equivalence** — all four providers MUST produce equivalent results for the same data (the
   conformance suite is the arbiter). Memory is the reference semantics.
10. **No interference** — these methods are read/delete only; they MUST NOT mutate instance state,
    concurrencyToken, or events/subscriptions, and MUST NOT participate in the CAS path.

## 7. Provider parity

`IPersistenceProvider` changes → every non-deprecated provider implements the new methods in the
**same PR**, and the conformance suite passes for each (principle #3).

| Provider | Implementation |
|---|---|
| memory (core) | In-array filter/sort/slice; reduce for stats; group by day for time-series. Reference semantics. |
| postgres | Sequelize `findAndCountAll` (where/order/limit/offset); aggregations via `fn`/`col`/`literal` `GROUP BY` (avg over `EXTRACT(EPOCH …)`, day bucket via `date_trunc`); `destroy`. JSONB `data` untouched. Reuse M2 indexes. |
| sqlite | Same as postgres via the sqlite dialect (day bucket via `strftime('%Y-%m-%d', …)`, avg over julianday/epoch diff); `destroy`. |
| mongodb | `find`/`countDocuments` for query; aggregation pipelines for stats (`$group`, `$cond`, `$avg` of `$subtract`), failed-steps (`$match` on `executionPointers.status`), time-series (`$group` on `$dateToString`); `deleteMany`. Honour the tenantId default already added. |
| mysql | **Deprecated** — not implemented; stays CI-excluded. |

The shared conformance suite (`core/src/testing/conformance/persistence-conformance.ts`) gains a
query/stats/timeseries/delete block run by sqlite, postgres, and mongo (and memory via core).

## 8. Test plan (TDD)

Add a conformance block (run by all non-deprecated providers + memory). Seed a known fixture set
(several instances across 2 definitions, 2 tenants, mixed statuses, known createTime/completeTime,
some with a Failed pointer) in `beforeAll`.

### Failing-first
- **`queryWorkflowInstances filters by workflowDefinitionId + status and paginates`** — assert the
  right subset + `total`; fails before the method exists (compile error / not a function).

### Coverage
- Wildcard `workflowDefinitionId`, status array, date-range, `searchTerm`, sort asc/desc + stable
  tie-break, `skip`/`take` + `total`, `take` cap.
- Tenant scoping (query/stats/time-series return only the tenant's rows; omit = all).
- Stats: `byStatus` sums to `total`; `averageCompletionTimeMs` matches the seeded durations (and
  `null` when no Complete); `byDefinition` ordering + top-N cap; `instancesWithFailedSteps` counts
  non-terminated-with-Failed-pointer correctly.
- Time series: correct daily buckets over a range; ordering.
- Deletes: single (true/false), batch (count, idempotent on missing), by-definition (count, tenant
  scoped); deleted rows no longer returned by query; pointers removed (SQL).

### How to run
```bash
cd core && yarn test
# providers (live services): cd providers/workflow-es-<p> && WORKFLOW_ES_<P>_TEST_URL=... yarn test
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build && yarn test` passes (conformance additions included).
- [ ] sqlite conformance passes locally on `:memory:`; postgres + mongo pass against live services
      (CI / Testcontainers — see M8).
- [ ] Every non-deprecated provider implements all six methods; a deliberate omission fails provider CI.
- [ ] Phase 2: with `WORKFLOW_PERSISTENCE_PROVIDER` set to `sqlite`, `postgres`, and `mongo` in turn,
      the express execution-history view, stats, inspector, search, recent, and delete all work, and
      the mongoose `WorkflowInstanceModel` is removed from the codebase.

## 10. Backward compatibility & migration

- Additive to `IPersistenceProvider` (new methods) — existing callers unaffected. New methods ripple
  to all providers (principle #3). **Version bump at merge time, not hard-coded** (per
  upgrade-plan §8.3): continues the `2.4.0-reactory.N` additive series. Rebuild core + provider
  tarballs; bump the `reactory-express-server` `file:` refs.
- Express: `ReactoryWorkflowService`/`LifecycleManager` read via the provider; the `id`-from-`_id`
  patch (commit on `feat/upgrade`) becomes redundant (the provider yields `id`) — leave or remove.
- **YAML executions**: `persistYamlExecution` currently writes the mongoose model. It must persist
  through the active provider so YAML history appears for any store. Spec the mapping: build a
  `WorkflowInstance` (workflowDefinitionId, version, status, data, createTime/completeTime,
  executionPointers from executed steps) and `createNewWorkflow` + `persistWorkflow`, or a single
  insert via a small provider-agnostic helper.
- Deletes are hard deletes (history rows removed). Document for operators that "clear history" is
  irreversible (unchanged from current behaviour).

## 11. Definition of Done

`IPersistenceProvider` exposes a store-agnostic query/stats/time-series/delete surface implemented
natively and conformance-verified in memory, sqlite, postgres, and mongo; the express workflow read
layer reads and deletes exclusively through the active provider; workflow execution history, stats,
inspector, search, recent, and deletes work identically under Mongo, Postgres, and SQLite
persistence; YAML executions appear in history for any store; and the mongoose `WorkflowInstanceModel`
is retired.

## 12. Implementation notes (non-binding)

- SQL: prefer one `findAndCountAll` for query; one grouped aggregation query per stat where possible
  (a single pass for `byStatus`, a second for `byDefinition`+failed-steps via a join/sub-select, one
  for the day bucket). Watch BIGINT `nextExecution`/epoch-as-string coercion (already handled in the
  models) and `data` JSON(B) passthrough.
- Mongo: `executionPointers` is an embedded array — `instancesWithFailedSteps` is a single
  `$match`/`$group`; time-series uses `$dateToString` on `createTime`.
- Memory: keep it simple and correct — it's the conformance reference.
- Phase 2 is a separate `[copilot+review]` change once Phase 1 is merged and the new tarballs are
  installed; it removes the mongoose model and the second DB connection entirely (express reads go
  through the engine's provider — no TypeORM entity needed for workflow history after all).
