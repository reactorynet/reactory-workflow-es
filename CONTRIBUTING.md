# Contributing to @reactorynet/workflow-es

## Persistence provider index requirement (M2)

Any new durable `IPersistenceProvider` implementation MUST create the following
four indexes idempotently in its schema-init path and MUST use the canonical
names listed below so operational tooling can recognise them across providers.

| # | Access pattern | Canonical index name | Columns (in order) |
|---|---|---|---|
| 1 | `getRunnableInstances()` — `status===Runnable && nextExecution<now [&& tenantId==t]` | `idx_workflows_status_next_execution` | `tenantId, status, nextExecution` |
| 2 | `getRunnableEvents()` — `!isProcessed && eventTime<=now [&& tenantId==t]` | `idx_events_isprocessed_eventtime` | `tenantId, isProcessed, eventTime` |
| 3 | `getEvents()` — `tenantId==t && eventName==n && eventKey==k && eventTime>=asOf` | `idx_events_name_key_eventtime` | `tenantId, eventName, eventKey, eventTime` |
| 4 | `getSubscriptions()` — `tenantId==t && eventName==n && eventKey==k && subscribeAsOf<=asOf` | `idx_subscriptions_name_key_subscribeasof` | `tenantId, eventName, eventKey, subscribeAsOf` |

### Rules

- **Idempotent creation.** Index creation must not error on a second call/restart.
  SQL providers use Sequelize `@Table({ indexes })` (which emits `CREATE INDEX IF NOT EXISTS`);
  MongoDB providers use `collection.createIndex()` with the same key spec (no-op if already present).
- **Equality-before-range column order.** Equality-matched columns (`tenantId`, `eventName`,
  `eventKey`, `status`, `isProcessed`) appear before range-bounded columns (`nextExecution`,
  `eventTime`, `subscribeAsOf`). This ordering lets the index serve both the equality
  and the range predicate efficiently.
- **No extra indexes.** Do not add indexes beyond the four mandated above.
  Each extra index costs write throughput.
- **The in-memory provider is exempt.** `MemoryPersistenceProvider` array-filters and
  has no index concept.

### Reference implementations

- SQL (Postgres / SQLite): `providers/workflow-es-postgres/src/models/{workflow,event,subscription}.ts`
  and `providers/workflow-es-sqlite/src/models/{workflow,event,subscription}.ts` — `@Table({ indexes })`
  options passed to the Sequelize model decorator.
- MongoDB: `providers/workflow-es-mongodb/src/mongodb-provider.ts` — `createIndex` calls
  in the async constructor connect path, placed after the collections are obtained and
  before the connect promise resolves.

See also: `docs/specs/m2-provider-indexes.md` for the full normative spec.
