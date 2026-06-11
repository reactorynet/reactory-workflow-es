# Spec — M6 · Multi-tenancy / namespace scoping

| Field | Value |
|---|---|
| **Item ID** | M6 |
| **Title** | Multi-tenancy / namespace scoping |
| **Plan reference** | [`upgrade-plan.md` → M6](../upgrade-plan.md) |
| **Target** | Cloud (additive; Electron/single-tenant unaffected) |
| **Severity** | Medium |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | C1 (final `IPersistenceProvider` shape incl. concurrency token), M4 (`tenantId` logging field — may ship the field as optional first) |
| **Author / reviewer** | claude / <reviewer> |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. A `WorkflowHost` starts workflow
instances and publishes external events. Workflows can pause on `waitFor(eventName, eventKey)`; when a
matching event is published the engine wakes the waiting instance.

**There is no tenant/namespace dimension anywhere in the engine.** All instances, events and
subscriptions live in one global namespace, and event matching is purely by `(eventName, eventKey)`:

- `core/src/models/workflow-instance.ts` — `WorkflowInstance` has no tenant field (lines 3–18).
- `core/src/models/event.ts` — `Event` has `eventName`, `eventKey`, no tenant (lines 1–8).
- `core/src/models/event-subscription.ts` — `EventSubscription` has `eventName`, `eventKey`, no tenant (lines 1–9).
- `core/src/services/workflow-host.ts` `publishEvent` (lines 77–90) builds an `Event` from
  `(eventName, eventKey, eventData, eventTime)` only.
- `core/src/services/event-queue-worker.ts` `processEvent` (lines 55–86) calls
  `getSubscriptions(evt.eventName, evt.eventKey, evt.eventTime)` and then `seedSubscription` wakes
  **every** matching subscription regardless of who owns it.
- `core/src/abstractions/persistence-provider.ts` — every query method is un-scoped:
  `getRunnableInstances()`, `getSubscriptions(eventName, eventKey, asOf)`,
  `getEvents(eventName, eventKey, asOf)`, `getRunnableEvents()` (lines 8, 11, 16, 21).
- `core/src/abstractions/distributed-lock-provider.ts` — `acquireLock(id)` / `releaseLock(id)` take a
  bare id; lock keys are not namespaced (lines 1–5).

**User-visible impact.** If two tenants both run a workflow that waits on, say, event name
`"order-paid"` with key `"123"`, a `publishEvent("order-paid", "123", ...)` from **either** tenant wakes
**both** tenants' subscriptions. This is a cross-tenant data-leak / incorrect-execution bug: tenant A's
event drives tenant B's workflow, and tenant B receives tenant A's `eventData`. Lock keys built from a
bare workflow/event id are globally unique today (UUIDs), so locks do not currently collide — but once
ids are tenant-scoped or reused per tenant, un-namespaced lock keys become a hazard; we namespace them
defensively as part of this item.

The engine must gain an **optional** tenant/namespace dimension that partitions instances, events,
subscriptions and locks, and is enforced at the provider query layer — while leaving existing
single-tenant and Electron deployments working byte-for-byte unchanged.

## 2. Goal

After this change, every `WorkflowInstance`, `Event` and `EventSubscription` carries a `tenantId`
string. `startWorkflow` and `publishEvent` accept an optional `tenantId` that defaults to the sentinel
`"default"`. All `IPersistenceProvider` query methods take a `tenantId` parameter and only ever return
rows for that tenant. Distributed lock keys are namespaced by tenant. As a result, two tenants using
identical `(eventName, eventKey)` pairs never wake each other's subscriptions, while any code that omits
`tenantId` transparently operates in the `"default"` tenant exactly as before.

## 3. Out of scope

- **Authentication / authorization.** This item does not validate *who* may use a `tenantId`; it only
  partitions data by the string supplied. Caller (e.g. `reactory-express-server`) is responsible for
  trust.
- **Per-tenant configuration, quotas, or rate limiting.** No per-tenant `maxConcurrentWorkflows`, no
  per-tenant providers. One host serves all tenants with one provider set.
- **Cross-tenant queries / admin "list all tenants" APIs.** Not added.
- **Tenant on `ExecutionPointer`, `WorkflowDefinition`, or the workflow registry.** Definitions remain
  global (a definition id+version is registered once and shared by all tenants). Do **not** add
  `tenantId` to `ExecutionPointer` — pointers are owned by their parent instance, which carries the
  tenant.
- **Queue partitioning.** `IQueueProvider` (`queueForProcessing`/`dequeueForProcessing`) is **not**
  changed. Queue entries are bare ids; the owning row's `tenantId` is read after dequeue. Do not add a
  tenant parameter to the queue interface.
- **Renaming or migrating existing data to a non-default tenant.** Existing rows are treated as
  `"default"` (see §10).
- **The `getWorkflowInstance(id)` / `getEvent(id)` / `createNewWorkflow` / `persistWorkflow` /
  `createEvent` / `createEventSubscription` / `terminateSubscription` / `markEventProcessed` /
  `markEventUnprocessed` signatures.** These operate on a single row by its globally-unique id and do
  **not** gain a `tenantId` parameter; the tenant travels *inside* the row object. Only the
  **multi-row query** methods are scoped.
- Do not change `H6` data-at-rest hooks, `M4` logger interface shape, or any worker concurrency logic.

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/models/workflow-instance.ts` | modify | add `tenantId: string` field |
| `core/src/models/event.ts` | modify | add `tenantId: string` field |
| `core/src/models/event-subscription.ts` | modify | add `tenantId: string` field |
| `core/src/abstractions/persistence-provider.ts` | modify | add `tenantId` param to the four query methods |
| `core/src/abstractions/types.ts` | modify | export `DEFAULT_TENANT` sentinel constant |
| `core/src/services/workflow-host.ts` | modify | `startWorkflow`/`publishEvent` accept optional `tenantId`; stamp it on instance/event; namespace lock keys in suspend/resume/terminate |
| `core/src/abstractions/workflow-host.ts` | modify | update `IWorkflowHost` signatures for `startWorkflow`/`publishEvent` |
| `core/src/services/execution-result-processor.ts` | modify | copy `instance.tenantId` onto created `EventSubscription` |
| `core/src/services/event-queue-worker.ts` | modify | pass `evt.tenantId` to `getSubscriptions`; namespace lock keys |
| `core/src/services/workflow-queue-worker.ts` | modify | pass `subscription.tenantId` to `getEvents`; namespace lock keys |
| `core/src/services/poll-worker.ts` | modify | scan per-tenant (see §6.7) |
| `core/src/services/memory-persistence-provider.ts` | modify | store + filter by `tenantId` |
| `providers/workflow-es-postgres/src/postgres-provider.ts` | modify | add `tenantId` to all queries |
| `providers/workflow-es-postgres/src/models/workflow.ts` | modify | add `tenantId` column + index |
| `providers/workflow-es-postgres/src/models/event.ts` | modify | add `tenantId` column + index |
| `providers/workflow-es-postgres/src/models/subscription.ts` | modify | add `tenantId` column + index |
| `providers/workflow-es-mongodb/src/mongodb-provider.ts` | modify | add `tenantId` to all queries (only if not deprecated under C3) |
| `providers/workflow-es-mysql/*` | modify | add `tenantId` to all queries (only if not deprecated under C3) |
| `providers/workflow-es-redis/src/redis-lock-manager.ts` | modify | accept already-namespaced key (no change to signature; see §6.8) |
| `providers/workflow-es-azure/src/azure-lock-manager.ts` | modify | accept already-namespaced key; sanitize blob name (see §7) |
| `core/spec/scenarios/multi-tenancy.spec.ts` | create | two-tenant isolation + default-tenant regression test |
| `core/spec/scenarios/external-events.spec.ts` | modify | only if a `getSubscriptions` call needs the new param — pass `DEFAULT_TENANT` |
| `core/package.json` | modify | version bump (§10) |

> The poll-worker change (§6.7) requires the provider to enumerate distinct tenants. To avoid adding a
> "list tenants" query, the poll worker instead scans **all** runnable instances/events across tenants
> via the *un-scoped variant* — see §5 "`getRunnableInstances` decision".

## 5. Interface & data-model changes

### Sentinel constant

```ts
// core/src/abstractions/types.ts — ADD (alongside the TYPES export)
export const DEFAULT_TENANT = "default";
```

Re-exported through `core/src/abstractions.ts` (barrel re-exports `./abstractions/types`) and therefore
available from the package root.

### Models

```ts
// BEFORE — core/src/models/workflow-instance.ts
export class WorkflowInstance {
    public id : string;
    public workflowDefinitionId : string;
    // ...
}

// AFTER
export class WorkflowInstance {
    public id : string;
    public tenantId : string;          // NEW — defaults to "default" when not set by the host
    public workflowDefinitionId : string;
    // ...
}
```

```ts
// BEFORE — core/src/models/event.ts
export class Event {
    public id: string;
    public eventName: string;
    public eventKey: string;
    public eventData: any;
    public eventTime: Date;
    public isProcessed: boolean;
}

// AFTER
export class Event {
    public id: string;
    public tenantId: string;           // NEW
    public eventName: string;
    public eventKey: string;
    public eventData: any;
    public eventTime: Date;
    public isProcessed: boolean;
}
```

```ts
// BEFORE — core/src/models/event-subscription.ts
export class EventSubscription {
    public id: string;
    public workflowId: string;
    public stepId: number;
    public eventName: string;
    public eventKey: any;
    public subscribeAsOf: Date;
}

// AFTER
export class EventSubscription {
    public id: string;
    public tenantId: string;           // NEW
    public workflowId: string;
    public stepId: number;
    public eventName: string;
    public eventKey: any;
    public subscribeAsOf: Date;
}
```

### `IPersistenceProvider` — decision: explicit `tenantId` query parameter

**Decision (chosen):** scope by an **explicit `tenantId` first parameter** on the multi-row query
methods, NOT by reading a field off an ambient object. Rationale: the query methods do not receive an
instance/event object, scoping must be enforceable at the provider (SQL `WHERE tenantId = $1`), and an
explicit parameter makes the contract unambiguous for a lesser-model implementer. Single-row methods
keyed by globally-unique id are unchanged (the tenant rides inside the row object on write).

```ts
// BEFORE — core/src/abstractions/persistence-provider.ts
export interface IPersistenceProvider {
    createNewWorkflow(instance: WorkflowInstance): Promise<string>;
    persistWorkflow(instance: WorkflowInstance): Promise<void>;
    getWorkflowInstance(workflowId: string): Promise<WorkflowInstance>;
    getRunnableInstances(): Promise<Array<string>>;

    createEventSubscription(subscription: EventSubscription): Promise<void>;
    getSubscriptions(eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>>;
    terminateSubscription(id: string): Promise<void>;

    createEvent(event: Event): Promise<string>;
    getEvent(id: string): Promise<Event>;
    getRunnableEvents(): Promise<Array<string>>;

    markEventProcessed(id: string): Promise<void>;
    markEventUnprocessed(id: string): Promise<void>;

    getEvents(eventName: string, eventKey: any, asOf: Date): Promise<Array<string>>;
}

// AFTER
export interface IPersistenceProvider {
    createNewWorkflow(instance: WorkflowInstance): Promise<string>;        // unchanged (tenant inside instance)
    persistWorkflow(instance: WorkflowInstance): Promise<void>;           // unchanged
    getWorkflowInstance(workflowId: string): Promise<WorkflowInstance>;   // unchanged (id is globally unique)

    // CHANGED: tenant param. `undefined` => return runnable instances for ALL tenants
    // (used by the poll worker, which is tenant-agnostic — see §6.7).
    getRunnableInstances(tenantId?: string): Promise<Array<string>>;

    createEventSubscription(subscription: EventSubscription): Promise<void>; // unchanged (tenant inside subscription)
    // CHANGED: tenant param (required)
    getSubscriptions(tenantId: string, eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>>;
    terminateSubscription(id: string): Promise<void>;                        // unchanged

    createEvent(event: Event): Promise<string>;                              // unchanged (tenant inside event)
    getEvent(id: string): Promise<Event>;                                    // unchanged
    // CHANGED: `undefined` => all tenants (poll worker — see §6.7)
    getRunnableEvents(tenantId?: string): Promise<Array<string>>;

    markEventProcessed(id: string): Promise<void>;                           // unchanged
    markEventUnprocessed(id: string): Promise<void>;                         // unchanged

    // CHANGED: tenant param (required)
    getEvents(tenantId: string, eventName: string, eventKey: any, asOf: Date): Promise<Array<string>>;
}
```

> **`getRunnableInstances` / `getRunnableEvents` decision.** These run only from the tenant-agnostic
> poll worker, which has no tenant context. Rather than force the poll worker to enumerate tenants, the
> tenant param is **optional**; when omitted (or `undefined`) the provider returns rows across **all**
> tenants (current behaviour). This keeps the poll worker simple and is safe because the worker only
> *queues ids* — the subsequent `getWorkflowInstance(id)`/`getEvent(id)` and the event→subscription
> match are still tenant-correct because the row carries its own `tenantId`.

### Host API

```ts
// BEFORE — core/src/abstractions/workflow-host.ts (IWorkflowHost)
startWorkflow(id: string, version: number, data: any): Promise<string>;
publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void>;

// AFTER
startWorkflow(id: string, version: number, data: any, tenantId?: string): Promise<string>;
publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date, tenantId?: string): Promise<void>;
```

```ts
// BEFORE — core/src/services/workflow-host.ts
public async startWorkflow(id: string, version: number, data: any = {}): Promise<string> {
    // ...
    let wf = new WorkflowInstance();
    wf.data = data;
    // ... (no tenant)
}

// AFTER
public async startWorkflow(id: string, version: number, data: any = {}, tenantId: string = DEFAULT_TENANT): Promise<string> {
    // ...
    let wf = new WorkflowInstance();
    wf.tenantId = tenantId;            // NEW
    wf.data = data;
    // ...
}
```

```ts
// BEFORE — core/src/services/workflow-host.ts publishEvent
public async publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void> {
    let evt = new Event();
    evt.eventData = eventData;
    // ... (no tenant)
}

// AFTER
public async publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date, tenantId: string = DEFAULT_TENANT): Promise<void> {
    let evt = new Event();
    evt.tenantId = tenantId;           // NEW
    evt.eventData = eventData;
    // ...
}
```

### Lock-key namespacing

A bare id (`workflowId` / `eventId` / `subscription.workflowId`) is replaced at every
`acquireLock`/`releaseLock` call site with a tenant-namespaced key built by a single helper. The
`IDistributedLockProvider` interface **does not change** — providers receive an opaque string and must
not parse it. The helper:

```ts
// Place in core/src/abstractions/distributed-lock-provider.ts (export alongside the interface)
export function tenantLockKey(tenantId: string, id: string): string {
    return `${tenantId || DEFAULT_TENANT}:${id}`;
}
```

Call sites change from `acquireLock(id)` → `acquireLock(tenantLockKey(instance.tenantId, id))`, and the
**matching** `releaseLock` uses the identical key. In `workflow-host.ts` suspend/resume/terminate, the
id is available but the tenant is not until the instance is loaded — therefore: load the instance under
a **bare-id** lock is NOT acceptable (would defeat namespacing). Instead these three methods gain the
same optional `tenantId` only internally is **not** required by §6; see decision below.

> **Suspend/resume/terminate lock-key decision.** These take only `(id)` and have no tenant context.
> Because the workflow id is globally unique (UUID), and the lock is paired (acquire+release with the
> same key) within the method, scoping them adds no isolation benefit and would force an API change to
> three public methods for no behavioural gain. **Decision:** namespace these three with the constant
> `DEFAULT_TENANT` prefix via `tenantLockKey(DEFAULT_TENANT, id)` so the key *shape* is consistent
> across the codebase, but do NOT add a `tenantId` parameter to `suspendWorkflow`/`resumeWorkflow`/
> `terminateWorkflow`. The worker paths (workflow-queue-worker, event-queue-worker) DO have the tenant
> (from the loaded instance/event/subscription) and MUST use it — see §6.8.

### DI / config impact

`configureWorkflow()` and `WorkflowConfig` are **unchanged**. No new config option, no new binding,
no new validation. `DEFAULT_TENANT` is a plain exported constant, not a configurable value.

### Persisted / at-rest format impact

A new non-null `tenantId` column is added to the `workflows`, `events`, and `subscriptions` tables
(Postgres) and a `tenantId` field to Mongo documents, each defaulting to `"default"`. Forward
migration backfills existing rows to `"default"`; no backward migration needed because the column is
additive and old code never read it. See §10.

## 6. Behavioural contract (numbered rules)

1. **Default tenant.** When `startWorkflow`/`publishEvent` are called without `tenantId`, the created
   `WorkflowInstance`/`Event` has `tenantId === "default"` (`DEFAULT_TENANT`).
2. **Tenant stamped through.** A workflow started with `tenantId = "T"` produces an instance with
   `tenantId === "T"`; every `EventSubscription` it creates (in `execution-result-processor.ts`,
   copied from `instance.tenantId`) has `tenantId === "T"`.
3. **Scoped subscription match.** `getSubscriptions(tenantId, eventName, eventKey, asOf)` returns only
   subscriptions whose `tenantId` equals the argument AND `eventName`/`eventKey` match AND
   `subscribeAsOf <= asOf`.
4. **Scoped event match.** `getEvents(tenantId, eventName, eventKey, asOf)` returns only events whose
   `tenantId` equals the argument (in addition to the existing name/key/time filters).
5. **Cross-tenant isolation (the headline rule).** Given two subscriptions with identical
   `(eventName, eventKey)` but `tenantId` `"A"` and `"B"` respectively: publishing an event with
   `tenantId = "A"` wakes ONLY the `"A"` subscription. The `"B"` workflow's matching pointer is NOT
   activated and its `eventData` is NOT set. (event-queue-worker passes `evt.tenantId` to
   `getSubscriptions`.)
6. **Back-compat / single-tenant.** A deployment that never passes a `tenantId` behaves exactly as
   before: all rows are `"default"`, every query is implicitly `"default"`-scoped, and existing
   scenarios pass unchanged.
7. **Poll worker is tenant-agnostic.** `PollWorker.process` calls `getRunnableInstances()` and
   `getRunnableEvents()` with **no** tenant argument, receiving runnable ids across all tenants, and
   queues each id. Correctness is preserved because the queued id is later loaded as a full row
   (carrying its own `tenantId`) before any tenant-scoped query runs.
8. **Lock keys namespaced.** In `workflow-queue-worker` and `event-queue-worker`, every
   `acquireLock`/`releaseLock` uses `tenantLockKey(tenantId, id)` where `tenantId` is the tenant of the
   loaded instance/event/subscription, and the paired release uses the identical key. Two tenants
   acquiring a lock on the same underlying id never block each other.
9. **Idempotency.** Re-running §6.2/§6.5 (e.g. publishing the same event twice) does not change the
   isolation outcome: only same-tenant subscriptions are ever woken; an already-processed event still
   matches only its own tenant.
10. **Error path.** A `tenantId` of `""`, `null`, or `undefined` supplied to the host is coerced to
    `DEFAULT_TENANT` (via the default-parameter value and `tenantLockKey`'s `|| DEFAULT_TENANT`). The
    engine never throws on a missing tenant.

## 7. Provider parity

§5 changes `IPersistenceProvider` (three query signatures) and adds a `tenantId` model field. This is a
**significant parity item**: all changes below MUST land in the same PR, and no provider is "done" until
it builds and passes the conformance suite (gated by M8 once landed).

| Provider | Change required |
|---|---|
| **memory** (`core/src/services/memory-persistence-provider.ts`) | `getSubscriptions`/`getEvents` take leading `tenantId` and add `x.tenantId === tenantId` to the `.filter(...)`. `getRunnableInstances`/`getRunnableEvents` take optional `tenantId`; when defined, add `x.tenantId === tenantId` to the filter, else no tenant filter. No storage change (objects already carry `tenantId`). |
| **postgres** (`postgres-provider.ts` + 3 models) | Models: add `@Column(DataType.STRING) @Default("default") @Index tenantId: string;` to `Workflow`, `Event`, `Subscription`. Provider: `getSubscriptions` adds `tenantId` to the `where`; `getEvents` adds `tenantId` to the `where`; `getRunnableInstances`/`getRunnableEvents` add `...(tenantId !== undefined ? { tenantId } : {})` to the `where`. Composite indexes per §10. `createNewWorkflow`/`createEvent`/`createEventSubscription` already pass the whole object (`instance as any`) so `tenantId` persists automatically. |
| **mongodb** (`mongodb-provider.ts`) | Only if NOT deprecated by C3. `getSubscriptions`/`getEvents` add `tenantId` to the query filter; `getRunnableInstances`/`getRunnableEvents` add `tenantId` to the filter only when defined. Documents already insert the whole object so `tenantId` round-trips. (Note: this provider is on the obsolete driver-v3 callback API and is a C3 target; if C3 deprecates it, mark it deprecated and exclude from CI instead of editing.) |
| **mysql** (`providers/workflow-es-mysql/*`) | Only if NOT deprecated by C3. Same shape as postgres: add `tenantId` column + index to the Sequelize models, add `tenantId` to the four query `where` clauses. (Also a C3 target.) |
| **redis** (`redis-lock-manager.ts`) | No interface change — `IDistributedLockProvider` is unchanged. The lock key arrives already namespaced (`tenant:id`). Verify the key is used verbatim as the Redlock resource name (it is, line 23). No edit required beyond confirming; add a one-line comment. (This provider is a C1 target for the rename to `@reactorynet/workflow-es`; if C1 lands first, no extra import work here.) |
| **azure** (`azure-lock-manager.ts`) | No interface change. The namespaced key (`tenant:id`) becomes a blob name; `:` is **not** a legal Azure blob-name character in all contexts. Sanitize: replace `:` with `-` (or `__`) before using as `blobName`, consistently in `createBlob`/`acquireLock`/`releaseLock`/`renewLeases`. (Also a C1 stale-stub target.) |

## 8. Test plan (TDD)

Follow the pattern in `core/spec/scenarios/external-events.spec.ts`: one host, `MemoryPersistenceProvider`,
`configureWorkflow()`, `await host.start()`, and the `spinWait` helper from
`core/spec/helpers/spin-wait.ts`. New file: `core/spec/scenarios/multi-tenancy.spec.ts`.

The workflow under test is the same single-`waitFor` shape as `external-events.spec.ts`:

```ts
class TenantStep1 extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
}
class TenantData { public myValue: string; }
class TenantWorkflow implements WorkflowBase<TenantData> {
    public id = "tenant-workflow"; public version = 1;
    public build(b: WorkflowBuilder<TenantData>) {
        b.startWith(TenantStep1)
         .waitFor("tenant-event", data => "shared-key")   // SAME key for both tenants
            .output((step, data) => data.myValue = step.eventData);
    }
}
```

### Failing-test-first

- **`event published for tenant A must not wake tenant B`** — *arrange:* start the workflow twice,
  once with `host.startWorkflow("tenant-workflow", 1, {}, "A")` → `idA`, once with `...,"B")` → `idB`;
  `spinWait` until `getSubscriptions("A", "tenant-event", "shared-key", new Date())` AND
  `getSubscriptions("B", ...)` each return a sub. *act:* `await host.publishEvent("tenant-event",
  "shared-key", "for-A", new Date(), "A")`; then `spinWait` until instance `idA` is no longer
  `Runnable`. *assert:* `getWorkflowInstance(idA).status === Complete` and `.data.myValue === "for-A"`;
  AND `getWorkflowInstance(idB).status === Runnable` (still waiting) and `.data.myValue` is undefined.
  Proves §6.5. **Before the fix** (global match), B would also complete with `"for-A"`, so this test
  fails on current code.

### Coverage

- **`workflow inherits the tenant it was started with`** — start with `"A"`, `spinWait` for the
  subscription, assert the persisted `EventSubscription.tenantId === "A"` and
  `getWorkflowInstance(idA).tenantId === "A"`. Proves §6.2.
- **`default tenant regression — no tenantId behaves as before`** — replicate `external-events.spec.ts`
  exactly (no `tenantId` args). Assert the instance completes with `"Pass"` and that its `tenantId` is
  `"default"`. Proves §6.1 and §6.6. (Can be the existing `external-events.spec.ts` left unchanged plus
  one added assertion on `instance.tenantId`.)
- **`tenant B woken by its own event`** — after the headline test, publish `("tenant-event",
  "shared-key", "for-B", new Date(), "B")`, `spinWait` for `idB` to leave `Runnable`, assert
  `idB.status === Complete` and `.data.myValue === "for-B"`. Proves isolation is symmetric (§6.5/§6.9).

### How to run

```bash
cd core && yarn test                                  # full suite (Node 20 + 22 in CI)
cd core && npx jasmine spec/scenarios/multi-tenancy.spec.ts   # this scenario only
# provider integration (once M8 lands): the conformance suite must pass for postgres
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd core && yarn test` passes on Node 20 and 22, including `multi-tenancy.spec.ts`.
- [ ] The headline test `event published for tenant A must not wake tenant B` fails on the
      pre-change code and passes after (visible in PR / git history).
- [ ] Every existing scenario in `core/spec/scenarios/` still passes with no `tenantId` arguments.
- [ ] `grep -n "tenantId" core/src/models/workflow-instance.ts core/src/models/event.ts core/src/models/event-subscription.ts` shows the new field on all three.
- [ ] All providers affected by §7 (memory + postgres, plus mongodb/mysql if not deprecated by C3) build
      and pass the conformance suite; redis/azure lock providers build and use the namespaced key.
- [ ] No public host method other than `startWorkflow`/`publishEvent` changed its signature.

## 10. Backward compatibility & migration

**Public API.** `startWorkflow` and `publishEvent` gain a trailing **optional** `tenantId` parameter.
Existing 4-arg `publishEvent` and 3-arg `startWorkflow` calls compile and behave identically (default
`"default"`). `IWorkflowHost` is source- and binary-compatible for existing callers.

**`reactory-express-server` impact.** The consumer integrates via a `file:` tarball and calls
`host.startWorkflow(...)` / `host.publishEvent(...)`. Because the new parameter is optional and defaults
to `"default"`, **no consumer change is required**. A consumer that *wants* multi-tenancy passes its
tenant id as the new trailing argument. Document this in the consumer's upgrade note.

**At-rest / schema migration (Postgres).**
- Add column `tenantId VARCHAR NOT NULL DEFAULT 'default'` to `workflows`, `events`, `subscriptions`.
  `sequelize.sync()` (used by the provider, `postgres-provider.ts` line 41) adds the column on existing
  tables only with `alter: true`; for production, ship an explicit migration:
  ```sql
  ALTER TABLE workflows     ADD COLUMN "tenantId" VARCHAR NOT NULL DEFAULT 'default';
  ALTER TABLE events        ADD COLUMN "tenantId" VARCHAR NOT NULL DEFAULT 'default';
  ALTER TABLE subscriptions ADD COLUMN "tenantId" VARCHAR NOT NULL DEFAULT 'default';
  CREATE INDEX idx_subscriptions_tenant_name_key ON subscriptions ("tenantId","eventName","eventKey");
  CREATE INDEX idx_events_tenant_name_key_time   ON events        ("tenantId","eventName","eventKey","eventTime");
  CREATE INDEX idx_workflows_tenant_status_next  ON workflows     ("tenantId","status","nextExecution");
  ```
  (The composite indexes coordinate with M2; M2 may extend them — keep `tenantId` as the leading column.)
- **Backfill:** the `DEFAULT 'default'` clause backfills existing rows automatically. No backward
  migration is needed; dropping the column restores the prior schema.

**Mongo:** add `tenantId: "default"` to existing documents (`updateMany({ tenantId: { $exists: false } },
{ $set: { tenantId: "default" } })`) for each of `workflows`, `events`, `subscriptions` — only if the
provider is retained under C3.

**Version bump.** `core/package.json` `2.3.6-reactory.3` → `2.3.6-reactory.4` (additive, backward
compatible — patch-level reactory bump).

## 11. Definition of Done

`WorkflowInstance`, `Event`, and `EventSubscription` each carry a `tenantId`; `startWorkflow` and
`publishEvent` accept an optional `tenantId` defaulting to `"default"`; the three multi-row
`IPersistenceProvider` query methods are tenant-scoped (`getSubscriptions`/`getEvents` require a tenant,
`getRunnableInstances`/`getRunnableEvents` accept an optional one for the tenant-agnostic poll worker);
worker lock keys are namespaced per tenant. Two tenants sharing identical `(eventName, eventKey)` never
wake each other's subscriptions (proven by `multi-tenancy.spec.ts`), and every existing single-tenant /
Electron scenario passes unchanged with no `tenantId` argument. All affected providers (memory +
postgres at minimum; mongo/mysql if retained; redis/azure lock key namespacing) build and pass, landing
in one PR. The version is bumped to `2.3.6-reactory.4` and the consumer migration note is recorded.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) `DEFAULT_TENANT` + `tenantLockKey` in core abstractions; (2) three model
  fields; (3) interface signatures; (4) host `startWorkflow`/`publishEvent`; (5) `execution-result-
  processor.ts` subscription stamping; (6) the two workers (lock keys + scoped queries); (7) memory
  provider; (8) write the failing test and watch it fail; (9) postgres models + provider; (10)
  mongo/mysql/redis/azure; (11) version bump.
- The event→subscription wake path is the *only* place isolation is enforced at runtime; the rest
  (poll worker, lock keys) is hygiene/defence-in-depth. Get the `event-queue-worker.processEvent` →
  `getSubscriptions(evt.tenantId, ...)` change right first.
- `eventKey` is typed `any`/`string` inconsistently across the codebase (e.g. subscription model uses
  `JSONB`); do not "fix" that here — only add `tenantId`.
- Upstream `danielgerlag/workflow-es` has no tenancy concept; there is no upstream equivalent to mirror.
