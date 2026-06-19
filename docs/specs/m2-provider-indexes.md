# Spec — M2 · Mandated provider indexes; remove full-scan hotspots

| Field | Value |
|---|---|
| **Item ID** | M2 |
| **Title** | Mandated provider indexes; remove full-scan hotspots |
| **Plan reference** | [`upgrade-plan.md` → M2](../upgrade-plan.md) |
| **Target** | Cloud |
| **Severity** | Medium |
| **Owner tag** | `[copilot+review]` |
| **Status** | spec |
| **Depends on** | C1 (final `IPersistenceProvider` shape), C3 (Mongo rewritten on driver v6; MySQL deprecated → covered as a Postgres/Sequelize dialect) |
| **Author / reviewer** | wweber / <reviewer> |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. A horizontally-scaled **cloud** host
polls its persistence provider on a timer for work to do. Three provider query methods run on every
poll cycle, on every node, forever:

1. **`getRunnableInstances()`** — returns the ids of every workflow instance that is due to run. The
   in-memory reference implementation filters on `status === WorkflowStatus.Runnable && nextExecution < Date.now()`
   (`core/src/services/memory-persistence-provider.ts:26-30`).
2. **`getRunnableEvents()`** — returns the ids of every event ready for dispatch. Filters on
   `!isProcessed && eventTime <= now` (`core/src/services/memory-persistence-provider.ts:57-61`).
3. **`getEvents(eventName, eventKey, asOf)`** — looks up events for matching against subscriptions.
   Filters on `eventName === … && eventKey === … && eventTime >= asOf`
   (`core/src/services/memory-persistence-provider.ts:75-79`).

A fourth method runs whenever an event is published:

4. **`getSubscriptions(eventName, eventKey, asOf)`** — finds subscriptions that should wake. Filters
   on `eventName === … && eventKey === … && subscribeAsOf <= asOf`
   (`core/src/services/memory-persistence-provider.ts:37-39`).

The `IPersistenceProvider` interface (`core/src/abstractions/persistence-provider.ts`) declares these
methods but says **nothing** about how a provider must index the underlying tables/collections. As a
result:

- The **Postgres** provider's `getRunnableInstances` translates to
  `SELECT id FROM workflows WHERE status = ? AND "nextExecution" < ?`
  (`providers/workflow-es-postgres/src/postgres-provider.ts:93-102`) against a `workflows` table that
  has **only a primary-key index on `id`** (`providers/workflow-es-postgres/src/models/workflow.ts`).
  Postgres has no choice but a **sequential scan** of the whole table on every poll.
- The same is true for `getRunnableEvents`
  (`providers/workflow-es-postgres/src/postgres-provider.ts:138-147`), `getEvents`
  (`…:157-167`), and `getSubscriptions` (`…:109-118`) — the `events` and `subscriptions` models
  (`providers/workflow-es-postgres/src/models/event.ts`, `…/subscription.ts`) declare **no** secondary
  indexes.
- The **MongoDB** provider runs `find({ status, nextExecution: { $lt } })`,
  `find({ isProcessed:false, eventTime:{ $lt } })`, `find({ eventName, eventKey, eventTime })`, and
  `find({ eventName, eventKey, subscribeAsOf })` (`providers/workflow-es-mongodb/src/mongodb-provider.ts`,
  the post-C3-rewrite equivalents of lines 72-88, 156-170, 198-212, 103-116) against collections that
  are **never given `createIndex` calls** — so each is a full **collection scan**.

**User-visible impact.** On a small table the seq-scan is invisible. At enterprise scale — hundreds of
thousands to millions of rows of historical/complete workflows and processed events sharing the same
table — every 10-second poll on every node re-scans the entire table. Latency climbs linearly with
total row count (not with the number of *runnable* rows), CPU and I/O are wasted cluster-wide, and the
poll cycle eventually cannot keep up. The provider contract does not *mandate* the indexes that would
make these queries `O(matching rows)` instead of `O(table size)`.

This item makes the required indexes **part of the provider contract** (documented in the
`IPersistenceProvider` source and CONTRIBUTING notes) and adds them to the SQL (Postgres, SQLite) and
Mongo providers so they are created idempotently at `sync()`/connect time.

> **Scope note (depends on C1, C3).** C1 finalises the `IPersistenceProvider` shape (it may add an
> optimistic-concurrency token column). C3 rewrites the Mongo provider on driver v6 and **deprecates**
> the standalone MySQL package (MySQL is henceforth a Sequelize *dialect* of the Postgres provider).
> This spec therefore touches **Postgres**, **SQLite (C2)**, and **MongoDB**, and does **not** touch
> the deprecated `workflow-es-mysql` package. If C1 added a concurrency token, this spec does **not**
> index it (no query filters on it).

## 2. Goal

After this item: the `IPersistenceProvider` contract explicitly documents, as a requirement, the four
index access-patterns that back the four scan-and-filter queries. Every non-deprecated, non-in-memory
provider (Postgres, SQLite, MongoDB) **creates those indexes idempotently** when it initialises its
schema (`sequelize.sync()` for the SQL providers via `@Table({ indexes: [...] })` model options;
`createIndex` calls at connect time for Mongo). The index names are stable and explicit. A Postgres
`EXPLAIN` of `getRunnableInstances` and `getEvents` shows an **index scan**, not a sequential scan,
and a 1M-row table stays within the latency target. The in-memory provider is unchanged (N/A — it is
an array filter and is dev/test only).

## 3. Out of scope

- **Do NOT** change the `IPersistenceProvider` method signatures, the query *logic*, or the returned
  shapes in any provider. This item adds **indexes and documentation only** — the `where` clauses in
  `postgres-provider.ts` and the `find(...)` filters in `mongodb-provider.ts` stay byte-for-byte the
  same.
- **Do NOT** add a migration framework, a CLI, or versioned migration files. Indexes are created
  through the providers' existing schema-init path (`sequelize.sync()` / connect-time `createIndex`).
- **Do NOT** touch `providers/workflow-es-mysql/*` — it is deprecated by C3 and excluded from CI. MySQL
  is covered transparently because the Postgres model `indexes` options are dialect-agnostic Sequelize.
- **Do NOT** touch `providers/workflow-es-redis/*` or `providers/workflow-es-azure/*` (lock/queue
  providers, not persistence providers — they implement no `IPersistenceProvider` query methods here).
- **Do NOT** modify `core/src/services/memory-persistence-provider.ts` (array filtering; no index
  concept) beyond what §5 specifies for the **doc comment** on the interface.
- **Do NOT** add indexes beyond the four mandated access-patterns (no speculative indexing of
  `workflowDefinitionId`, `version`, foreign keys, etc.). Each extra index costs write throughput.
- **Do NOT** change DI bindings, `configureWorkflow()`, `WorkflowConfig`, or `TYPES`.
- **Do NOT** add or drop columns. Indexes only.

## 4. Files to create / modify

> Exhaustive. The SQLite provider files exist only after C2 lands; if C2 is not yet merged when this
> item is implemented, apply the SQLite changes to the C2 files as part of the same access-pattern
> work (the model files mirror Postgres exactly per C2 §4).

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/persistence-provider.ts` | modify | Add the **Required indexes** doc block (JSDoc) to the `IPersistenceProvider` interface stating the four mandated access-patterns. No code change. |
| `CONTRIBUTING.md` | modify (create if absent) | Add a "Persistence provider index requirement" section duplicating the contract for provider authors. |
| `providers/workflow-es-postgres/src/models/workflow.ts` | modify | Add `indexes` to `@Table` for `(status, nextExecution)`. |
| `providers/workflow-es-postgres/src/models/event.ts` | modify | Add `indexes` to `@Table` for `(isProcessed, eventTime)` and `(eventName, eventKey, eventTime)`. |
| `providers/workflow-es-postgres/src/models/subscription.ts` | modify | Add `indexes` to `@Table` for `(eventName, eventKey, subscribeAsOf)`. |
| `providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts` | modify | Add the `EXPLAIN`/index-presence assertions of §8 (gated behind the M8 integration env). |
| `providers/workflow-es-postgres/README.md` | modify | Document the indexes created at `sync()`. |
| `providers/workflow-es-mongodb/src/mongodb-provider.ts` | modify | Add idempotent `createIndex` calls in the connect path (§5). |
| `providers/workflow-es-mongodb/README.md` | modify (create if absent) | Document the indexes created at connect. |
| `providers/workflow-es-sqlite/src/models/workflow.ts` | modify (C2 file) | Same `(status, nextExecution)` index as Postgres. |
| `providers/workflow-es-sqlite/src/models/event.ts` | modify (C2 file) | Same event indexes as Postgres. |
| `providers/workflow-es-sqlite/src/models/subscription.ts` | modify (C2 file) | Same subscription index as Postgres. |
| `providers/workflow-es-sqlite/README.md` | modify (C2 file) | Document the indexes. |

## 5. Interface & data-model changes

No method signatures, no DI, no persisted *column/field* shape changes. The interface change is a
**documented requirement** plus the **index definitions** per provider.

### 5.1 Contract documentation — `IPersistenceProvider`

Add the following JSDoc block immediately above the `IPersistenceProvider` interface in
`core/src/abstractions/persistence-provider.ts`. This is the normative statement of the requirement.

```ts
// BEFORE
import { WorkflowInstance, EventSubscription, Event } from "../models";

export interface IPersistenceProvider {
```

```ts
// AFTER
import { WorkflowInstance, EventSubscription, Event } from "../models";

/**
 * Persistence contract for the workflow engine.
 *
 * REQUIRED INDEXES (provider contract — M2).
 * A conforming durable provider (SQL, document, etc.) MUST back the following
 * poll/lookup queries with an index so they are O(matching rows), not
 * O(table size). The in-memory provider is exempt (array filtering). Index
 * names below are the canonical, stable names; SQL providers create them via
 * the model `@Table({ indexes })` option, document providers via `createIndex`
 * at connect time. All index creation MUST be idempotent.
 *
 *   1. getRunnableInstances()  filters status === Runnable && nextExecution < now
 *      -> index on (status, nextExecution)            name: idx_workflows_status_next_execution
 *
 *   2. getRunnableEvents()     filters !isProcessed && eventTime <= now
 *      -> index on (isProcessed, eventTime)           name: idx_events_isprocessed_eventtime
 *
 *   3. getEvents(name,key,asOf) filters eventName == && eventKey == && eventTime >= asOf
 *      -> index on (eventName, eventKey, eventTime)    name: idx_events_name_key_eventtime
 *
 *   4. getSubscriptions(name,key,asOf) filters eventName == && eventKey == && subscribeAsOf <= asOf
 *      -> index on (eventName, eventKey, subscribeAsOf) name: idx_subscriptions_name_key_subscribeasof
 *
 * See CONTRIBUTING.md → "Persistence provider index requirement".
 */
export interface IPersistenceProvider {
```

### 5.2 CONTRIBUTING note

Add a section to `CONTRIBUTING.md` (create the file with this single section if it does not exist)
restating the table above and the rule: *"Any new durable `IPersistenceProvider` implementation MUST
create these four indexes idempotently in its schema-init path and MUST use the canonical names so
operational tooling can recognise them across providers."*

### 5.3 Postgres index definitions (Sequelize `@Table({ indexes })`)

Indexes are declared on the models so `sequelize.sync()` creates them idempotently (Sequelize issues
`CREATE INDEX IF NOT EXISTS` semantics on sync; an explicit `name` makes the creation idempotent and
stable). `eventKey` is a `JSONB` column in the Postgres `events`/`subscriptions` models; B-tree
indexing of a `jsonb` column is valid for the equality comparisons used here.

**`providers/workflow-es-postgres/src/models/workflow.ts`** — `@Table` decorator:

```ts
// BEFORE
@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'workflows'
})

// AFTER
@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'workflows',
    indexes: [
        {
            name: 'idx_workflows_status_next_execution',
            fields: ['status', 'nextExecution']
        }
    ]
})
```

**`providers/workflow-es-postgres/src/models/event.ts`** — `@Table` decorator:

```ts
// BEFORE
@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'events'
})

// AFTER
@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'events',
    indexes: [
        {
            name: 'idx_events_isprocessed_eventtime',
            fields: ['isProcessed', 'eventTime']
        },
        {
            name: 'idx_events_name_key_eventtime',
            fields: ['eventName', 'eventKey', 'eventTime']
        }
    ]
})
```

**`providers/workflow-es-postgres/src/models/subscription.ts`** — `@Table` decorator:

```ts
// BEFORE
@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'subscriptions'
})

// AFTER
@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'subscriptions',
    indexes: [
        {
            name: 'idx_subscriptions_name_key_subscribeasof',
            fields: ['eventName', 'eventKey', 'subscribeAsOf']
        }
    ]
})
```

> **Column-name note.** The `fields` values are the **model attribute names**, which Sequelize maps to
> the actual column names. Because the models use no `field:` overrides and `freezeTableName: true`,
> the column names equal the attribute names verbatim (`nextExecution`, `eventTime`, etc.). Sequelize
> double-quotes them in Postgres, so the generated index covers the camelCase columns as defined.

### 5.4 SQLite index definitions (C2 provider)

The SQLite provider (C2) mirrors the Postgres models exactly. Apply the **identical** `@Table({ indexes })`
blocks from §5.3 to `providers/workflow-es-sqlite/src/models/{workflow,event,subscription}.ts`. SQLite
honours `CREATE INDEX IF NOT EXISTS` through `sequelize.sync()`. (`eventKey` is JSON-encoded text in
SQLite; the equality comparisons still index correctly.)

### 5.5 MongoDB index definitions (`createIndex` at connect)

Add idempotent `createIndex` calls to the Mongo provider's connect path (the post-C3 connect method,
which is `async/await` against driver v6). `createIndex` is idempotent: re-creating an index with the
same key spec is a no-op. Specify explicit `name`s matching the canonical names. Place these calls
**after** the collections are obtained and **before** the connect promise resolves, so a connected
provider is guaranteed to have its indexes.

```ts
// In the connect path, after workflowCollection / eventCollection /
// subscriptionCollection are assigned, before resolve():

await this.workflowCollection.createIndex(
    { status: 1, nextExecution: 1 },
    { name: "idx_workflows_status_next_execution" }
);

await this.eventCollection.createIndex(
    { isProcessed: 1, eventTime: 1 },
    { name: "idx_events_isprocessed_eventtime" }
);

await this.eventCollection.createIndex(
    { eventName: 1, eventKey: 1, eventTime: 1 },
    { name: "idx_events_name_key_eventtime" }
);

await this.subscriptionCollection.createIndex(
    { eventName: 1, eventKey: 1, subscribeAsOf: 1 },
    { name: "idx_subscriptions_name_key_subscribeasof" }
);
```

> The Mongo field names are the document field names used in the existing `find(...)` filters
> (`status`, `nextExecution`, `isProcessed`, `eventTime`, `eventName`, `eventKey`, `subscribeAsOf`) —
> see `providers/workflow-es-mongodb/src/mongodb-provider.ts` query shapes. Field order in the key spec
> matches the equality-then-range principle (equality fields first, range/bounded field last).

### DI / config impact
None. No change to `configureWorkflow()`, `WorkflowConfig`, or `TYPES`.

### Persisted / at-rest format impact
No column/field added or removed. Indexes are pure metadata over existing columns; they are created on
the next `sync()`/connect and require **no data migration** and **no backward migration** (dropping an
index is non-destructive). Forward: an existing deployment gains the indexes the next time the provider
initialises. No reindex of data values is needed.

## 6. Behavioural contract (numbered rules)

1. **`getRunnableInstances` is index-backed.** The `workflows` table/collection has an index on
   `(status, nextExecution)` named `idx_workflows_status_next_execution`. A Postgres `EXPLAIN` of the
   query in `postgres-provider.ts:93-102` against a populated table reports an **index scan / bitmap
   index scan**, not `Seq Scan`.
2. **`getRunnableEvents` is index-backed.** The `events` table/collection has an index on
   `(isProcessed, eventTime)` named `idx_events_isprocessed_eventtime`.
3. **`getEvents` is index-backed.** The `events` table/collection has an index on
   `(eventName, eventKey, eventTime)` named `idx_events_name_key_eventtime`.
4. **`getSubscriptions` is index-backed.** The `subscriptions` table/collection has an index on
   `(eventName, eventKey, subscribeAsOf)` named `idx_subscriptions_name_key_subscribeasof`.
5. **Created at schema init.** SQL providers create all four indexes during `sequelize.sync()`; the
   Mongo provider creates them via `createIndex` before the connect promise resolves. After a fresh
   `connect`/`sync`, all four indexes exist.
6. **Idempotent (rule).** Running `sync()`/`connect` repeatedly creates each index exactly once and
   never errors on the second run (Sequelize `IF NOT EXISTS` by stable name; Mongo `createIndex` with a
   matching key spec is a no-op). Calling the providers' init path twice in one process is safe.
7. **Stable names (rule).** The index names are exactly the canonical names in §5 across all providers;
   they are not auto-generated and do not vary by environment, so operational tooling can detect them
   uniformly.
8. **No behavioural/result change.** The set and order of ids returned by all four query methods is
   identical to pre-M2 behaviour for the same data; only the access path changes. Existing provider
   conformance tests (round-trip, runnable filtering) still pass unchanged.
9. **In-memory provider unaffected.** `MemoryPersistenceProvider` continues to array-filter and is not
   required to (and does not) declare indexes.
10. **No index beyond the four.** No other index is created on any of the four tables/collections by
    this change.

## 7. Provider parity

This item documents a contract addition to `IPersistenceProvider` (a doc-only requirement; no method
signature changes). The required indexes apply to every **durable** provider:

| Provider | Change required |
|---|---|
| memory | **N/A.** Array-filtering in-memory store; no index concept. No change (rule §6.9). |
| sqlite (C2) | Add the four `@Table({ indexes })` blocks (§5.4) to its mirrored models; created on `sequelize.sync()`. Must land with this item (or be folded into C2 if C2 merges later). |
| postgres | Add the four `@Table({ indexes })` blocks (§5.3); created on `sequelize.sync()`. **Canonical SQL reference.** Also covers the deprecated MySQL package transparently — the same models, run with `{ dialect: "mysql" }` (per C3), generate equivalent MySQL indexes. |
| mongodb | Add the four `createIndex` calls (§5.5) to the C3-rewritten async connect path; created before connect resolves. |
| mysql (deprecated, C3) | **No direct change.** Package is deprecated/CI-excluded; MySQL users use the Postgres provider with `{ dialect: "mysql" }`, which carries the §5.3 indexes. Do not edit `workflow-es-mysql/*`. |
| redis | **N/A.** Lock/queue provider; implements no persistence query methods covered here. |
| azure | **N/A.** Lock/queue provider; no persistence query methods covered here. |

The Postgres, SQLite, and MongoDB index additions must land in the same PR as the contract doc so
providers stay in sync with the documented requirement.

## 8. Test plan (TDD)

The verification is provider-integration (real Postgres / Mongo), so these run under the M8
integration harness (Testcontainers / a reachable test DB), gated by the same env vars as the existing
provider specs. The Postgres spec already boots a provider and `sync({ force: true })`s a clean schema
(`providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts:16-22`) — extend it.

### Failing-test-first
- **`getRunnableInstances uses an index, not a seq scan`** (Postgres) — *arrange:* connect a
  `PostgresPersistence`, `sync({ force: true })`, then bulk-insert e.g. 5,000 `workflows` rows (mix of
  Runnable/Complete, varied `nextExecution`). *act:* run
  `await provider.sequelize.query('EXPLAIN SELECT id FROM workflows WHERE status = 0 AND "nextExecution" < ' + Date.now())`
  (use the real `WorkflowStatus.Runnable` value). *assert:* the plan text contains `Index Scan` /
  `Bitmap Index Scan` referencing `idx_workflows_status_next_execution` and does **not** contain
  `Seq Scan on workflows`. **This must FAIL before the index is added** (pre-M2 the plan is `Seq Scan`)
  and pass after. Proves rules §6.1, §6.5.

### Coverage
- **`getEvents uses idx_events_name_key_eventtime`** (Postgres) — `EXPLAIN` the `getEvents` query
  (`eventName = ? AND eventKey = ? AND eventTime >= ?`) over a populated `events` table; assert an
  index scan on `idx_events_name_key_eventtime`, no `Seq Scan`. Proves §6.3.
- **`getRunnableEvents uses idx_events_isprocessed_eventtime`** (Postgres) — `EXPLAIN` the
  `isProcessed = false AND eventTime <= now` query; assert index scan on
  `idx_events_isprocessed_eventtime`. Proves §6.2.
- **`getSubscriptions uses idx_subscriptions_name_key_subscribeasof`** (Postgres) — `EXPLAIN` the
  subscription lookup; assert index scan. Proves §6.4.
- **`all four indexes exist after sync`** (Postgres) — query `pg_indexes`
  (`SELECT indexname FROM pg_indexes WHERE tablename IN ('workflows','events','subscriptions')`) and
  assert the four canonical names are present. Proves §6.5, §6.7.
- **`sync is idempotent for indexes`** (Postgres) — call `provider.sequelize.sync()` a second time;
  assert it resolves without error and `pg_indexes` still lists exactly the four indexes (no
  duplicates). Proves §6.6.
- **`mongo creates the four indexes on connect`** (MongoDB, M8 harness) — `await provider.connect`,
  then `await collection.indexes()` (or `listIndexes().toArray()`) for `workflows`, `events`,
  `subscriptions`; assert the four canonical index names exist with the expected key specs. Re-run
  `connect` path and assert no error / no duplicates. Proves §6.5–§6.7 for Mongo.
- **`query results unchanged`** (Postgres + Mongo) — existing conformance assertions for
  `getRunnableInstances`/`getEvents`/`getSubscriptions` (the current provider specs) still pass,
  confirming results are identical post-index. Proves §6.8.

### Benchmark / 1M-row verification
- **`runnable-instances latency at 1M rows`** (Postgres, optional perf gate) — seed 1,000,000
  `workflows` rows of which a small fraction are Runnable-and-due; `EXPLAIN ANALYZE` the
  `getRunnableInstances` query and assert (a) plan uses `idx_workflows_status_next_execution`, and
  (b) execution time is within the target (suggested gate: **< 50 ms** for the index scan returning the
  due subset; the seq-scan baseline on 1M rows is hundreds of ms+). Same approach for the
  `getEvents` lookup. This is the M8 "1M-row benchmark stays within target latency" acceptance from the
  plan. Mark this test `xit`/env-gated if 1M-row seeding is too heavy for default CI; the EXPLAIN
  index-scan assertions above are the always-on guard.

### How to run
```bash
# Postgres provider integration (M8 harness / reachable test DB)
cd providers/workflow-es-postgres && yarn build && yarn test
#   WORKFLOW_ES_PG_TEST_URL overrides the default postgres URL.

# MongoDB provider integration (M8 harness)
cd providers/workflow-es-mongodb && yarn build && yarn test

# Core still builds/tests (contract doc-only change):
cd core && yarn build && yarn test
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds (contract JSDoc added; no code change).
- [ ] `cd providers/workflow-es-postgres && yarn build` succeeds.
- [ ] After `sync()`, `SELECT indexname FROM pg_indexes WHERE tablename IN ('workflows','events','subscriptions')`
      returns the four canonical names from §5.
- [ ] `EXPLAIN` of the `getRunnableInstances` and `getEvents` queries on a populated Postgres table
      shows an **index scan** referencing the canonical index, **not** `Seq Scan` (test §8).
- [ ] The pre-implementation failing test (`getRunnableInstances uses an index, not a seq scan`) failed
      on the un-indexed schema and passes after.
- [ ] `cd providers/workflow-es-mongodb && yarn build` succeeds and `listIndexes()` for the three
      collections returns the four canonical index names after `connect`.
- [ ] Re-running `sync()`/`connect` does not error and produces no duplicate indexes.
- [ ] Existing provider conformance tests still pass (result set unchanged).
- [ ] (Perf gate, if enabled) the 1M-row `getRunnableInstances` `EXPLAIN ANALYZE` stays within the
      latency target and uses the index.

## 10. Backward compatibility & migration

- **Public API:** unchanged — no signature or DI change.
- **At-rest format:** unchanged — no column/field added or dropped. Indexes are metadata; they are
  created on the next `sync()`/connect of an already-deployed provider. **No data migration** and **no
  manual step** is required by a consumer; redeploying the provider package and letting it init is
  sufficient. Dropping the indexes later is non-destructive (no backward migration needed).
- **Consumer (`reactory-express-server`):** no code change required. On next start its provider syncs
  and gains the indexes. First sync against a very large existing table will spend time building
  indexes once (online for Postgres unless `CONCURRENTLY` is needed — out of scope; document in the
  Postgres README that an initial large-table sync may take time).
- **Version bump:** providers get a patch/minor bump (e.g. Postgres `…-reactory.N → N+1`). Core's
  doc-only change does not require a functional bump but ships with the coordinated provider release.

## 11. Definition of Done

The `IPersistenceProvider` contract documents the four required index access-patterns and CONTRIBUTING
restates the rule for future provider authors. The Postgres, SQLite, and MongoDB providers create
exactly those four indexes — under the canonical, stable names — idempotently in their schema-init
path, with no change to query logic or result sets. A Postgres `EXPLAIN` proves the runnable-instances
and event-lookup queries are index-backed (not sequential scans), the pre-M2 failing test confirms the
regression guard is real, and a 1M-row benchmark stays within the latency target. The deprecated MySQL
package and the redis/azure lock-queue providers are untouched; the in-memory provider is exempt.

## 12. Implementation notes (optional, non-binding)

- Equality-before-range ordering matters: the composite keys list equality-matched columns first
  (`eventName`, `eventKey`) and the bounded/range column last (`eventTime`/`subscribeAsOf`) so the
  index serves both the equality and the range predicate.
- Upstream `danielgerlag/workflow-es` providers historically shipped without these indexes — this is a
  Reactory hardening step, not a port.
- For the Postgres `EXPLAIN` assertion, normalise the plan text to lowercase before substring matching;
  the planner may pick `Bitmap Index Scan` over `Index Scan` depending on selectivity — accept either,
  reject only `seq scan on <table>`.
- Seed enough rows in the EXPLAIN tests that the Postgres planner prefers the index over a seq scan
  (a near-empty table is always seq-scanned regardless of indexes — that is expected and is why the
  failing-first test must populate the table).
- If C2 (SQLite) has not merged when implementing this item, add the §5.4 index blocks directly to the
  C2 model files as part of C2; otherwise apply them as edits here. Either way they share the canonical
  names.
