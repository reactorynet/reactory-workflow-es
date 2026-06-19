# Spec — C1 · Working distributed lock + queue providers; optimistic concurrency

| Field | Value |
|---|---|
| **Item ID** | C1 |
| **Title** | Working distributed lock + queue providers; optimistic concurrency |
| **Plan reference** | [`upgrade-plan.md` → C1](../upgrade-plan.md) |
| **Target** | Cloud (additive; must not break the single-process / Electron path) |
| **Severity** | Critical |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | none (critical-path root). Pairs tightly with H2, H3. **C2 depends on the `IPersistenceProvider` shape settled here.** |
| **Author / reviewer** | Werner Weber / _TBD_ |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a horizontally-scalable workflow/saga engine. A **workflow host**
(`core/src/services/workflow-host.ts`) runs background workers that dequeue workflow IDs from a
**queue provider** (`IQueueProvider`), take a **distributed lock** on each ID
(`IDistributedLockProvider`), load the instance from a **persistence provider**
(`IPersistenceProvider`), execute one step-cycle, and persist the mutated instance back.

The intent is that **multiple host processes (nodes) share one queue, one lock provider, and one
database**, so work fans out across nodes. Today that is unsafe. Three defects make it impossible to
run more than one node:

**(a) The default lock and queue providers are in-process only.** `configureWorkflow()` binds
`SingleNodeQueueProvider` and `SingleNodeLockProvider` by default
(`core/src/config.ts:41-43`). Both store state in plain instance arrays:

```ts
// core/src/services/single-node-lock-provider.ts:5-19
@injectable()
export class SingleNodeLockProvider implements IDistributedLockProvider {
    private locks: string[] = [];
    public async acquireLock(id: string): Promise<boolean> {
        if (this.locks.includes(id)) return false;
        this.locks.push(id);
        return true;
    }
    public async releaseLock(id: string): Promise<void> { /* splice */ }
}
```

```ts
// core/src/services/single-node-queue-provider.ts:5-27
@injectable()
export class SingleNodeQueueProvider implements IQueueProvider {
    private workflowQueue: string[] = [];
    private eventQueue: string[] = [];
    // push / shift
}
```

Two nodes each get their own arrays. A "lock" held on node A is invisible to node B, so both nodes can
load and execute the **same** workflow instance at the same time — duplicate step execution. The queues
are likewise not shared.

**(b) `persistWorkflow` is last-write-wins with no concurrency check.** The current interface
(`core/src/abstractions/persistence-provider.ts:6`):

```ts
persistWorkflow(instance: WorkflowInstance): Promise<void>;
```

Every provider implements a blind overwrite. Memory
(`core/src/services/memory-persistence-provider.ts:17-20`):

```ts
public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
    const idx = this.instances.findIndex(x => x.id === instance.id);
    this.instances[idx] = instance;
}
```

Postgres (`providers/workflow-es-postgres/src/postgres-provider.ts:55-83`) wraps an
`UPDATE … WHERE id = ?` in a transaction but has **no version predicate** — it is still last-write-wins.
If node A and node B both load instance X at version N, both execute, and both write back, the second
write silently clobbers the first — a **lost update**. The lock in (a) is the only thing standing
between us and this, and the lock is per-process.

**(c) The Redis and Azure providers are stale stubs that will not build against current core.**
`providers/workflow-es-redis/package.json` declares `workflow-es@^2.1.0`, `inversify@^4.1.0`,
`redlock@^3.1.2`, `ioredis@^4.6.2`, `typescript@^2.2.1`. The source imports the **old package name**:

```ts
// providers/workflow-es-redis/src/redis-lock-manager.ts:2
import { IDistributedLockProvider, TYPES, ILogger } from '@reactorynet/workflow-es';
```

The current package is `@reactorynet/workflow-es` (`core/package.json:2`). The lock interface method is
`acquireLock` today; the upstream stub predates that rename in places and uses `redlock` v3's
`redlock.lock()` API (v4+/v5 renamed it to `acquire`). The Azure provider
(`providers/workflow-es-azure/*`) has the same `'workflow-es'` import and `inversify@^4` problems. As a
result neither provider compiles, and CI never caught it because CI builds `core` only.

**User-visible impact.** Scaling the cloud runner past one replica today causes duplicate executions
(side-effects fire twice) and lost updates (workflow state silently regresses). There is no working,
buildable distributed lock/queue provider to deploy. The engine is single-node-only in practice.

This spec fixes all three for the **Redis reference provider** and threads an **optimistic-concurrency
token** through `IPersistenceProvider.persistWorkflow` so that even if two nodes do execute the same
instance (lock provider bug, lock expiry, split brain), the second write is **rejected** rather than
silently lost.

## 2. Goal

After this change: (1) `IPersistenceProvider.persistWorkflow` carries an optimistic-concurrency token
(`WorkflowInstance.concurrencyToken`) and **rejects stale writes** by throwing a typed
`WorkflowConcurrencyError`; every persistence provider (memory, postgres, mongodb, and the
planned-but-stubbed sqlite/mysql) enforces the token compare-and-set and bumps it on success; (2) the
Redis provider builds against current core (`@reactorynet/workflow-es`, current `inversify`,
`redlock` v5, `ioredis` v5) and supplies a production-grade `IDistributedLockProvider` (Redlock) and
`IQueueProvider` (Redis lists with reliable dequeue); (3) `SingleNodeLockProvider` /
`SingleNodeQueueProvider` are explicitly marked dev-only and **fail loud** when more than one host
process tries to share them. Two host instances against shared Redis + a shared SQL database run a
1000-instance fan-out with **zero duplicate step executions and zero lost updates**, proven by an
integration test. The single-process / Electron path (default in-memory providers, one host) is
unchanged and still requires zero external infrastructure.

## 3. Out of scope

The implementer must NOT:

- Change `H2` (lock-release-race in `workflow-queue-worker.ts` / `event-queue-worker.ts`). Do **not**
  move post-processing inside the lock. C1 only adds the concurrency token and the providers; the
  worker's call sites are touched **only** to pass/refresh the token and to catch
  `WorkflowConcurrencyError` (see §6.7). The broader race is H2's job.
- Change `H3` (poll-worker lease) or `core/src/services/poll-worker.ts` beyond leaving it as-is.
- Change `H1`/`H4` (bounded concurrency, graceful drain).
- Touch `getRunnableInstances`, `getRunnableEvents`, `getEvents`, `getSubscriptions`, or any query
  method signature. Only `persistWorkflow` changes on `IPersistenceProvider`.
- Repair or rewrite the **MySQL** or **MongoDB** business logic beyond the mechanical token change in
  §7 (MySQL/Mongo full repair is C3). For MySQL specifically you make **only** the interface-conformance
  edit; do not modernise its Sequelize 4 stack.
- Create the SQLite provider (that is C2). You only document the token contract it must honour.
- Add OpenTelemetry, structured logging, tenancy, encryption, dead-letter, or retry changes.
- Rename `WorkflowInstance.version` (that is the **workflow-definition version**, an entirely different
  concept — see §5). The new field is `concurrencyToken`.
- Change `IQueueProvider`/`IDistributedLockProvider` **interface signatures** (the shapes in §5 are
  exactly today's). You implement them in Redis; you do not change the interfaces.

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/models/workflow-instance.ts` | modify | Add `concurrencyToken?: number` field. |
| `core/src/abstractions/persistence-provider.ts` | modify | `persistWorkflow` signature unchanged in arity but contract now requires CAS on `instance.concurrencyToken`; add doc comment. |
| `core/src/abstractions/errors.ts` | modify | Add and export `WorkflowConcurrencyError`. |
| `core/src/services/memory-persistence-provider.ts` | modify | Implement CAS + token bump in `persistWorkflow`; seed token in `createNewWorkflow`. |
| `core/src/services/workflow-host.ts` | modify | (a) Catch `WorkflowConcurrencyError` in `suspendWorkflow`/`resumeWorkflow`/`terminateWorkflow` and retry-once; (b) add multi-host guard wiring for single-node providers (see §5 DI). |
| `core/src/services/workflow-queue-worker.ts` | modify | Catch `WorkflowConcurrencyError` from `persistWorkflow` and re-queue the workflow instead of crashing (see §6.7). |
| `core/src/services/single-node-lock-provider.ts` | modify | Add `markShared()`/process-instance guard that throws if instantiated/started in a second host within the same process is impossible — instead detect cross-process sharing intent (see §5/§6.9). |
| `core/src/services/single-node-queue-provider.ts` | modify | Same dev-only fail-loud guard as the lock provider. |
| `core/src/config.ts` | modify | New `WorkflowConfig` validation: when the bound lock/queue/persistence are the single-node defaults AND `usePersistence` was pointed at a shared/networked provider, warn; add `allowSingleNodeProviders` escape hatch (see §5 DI). |
| `providers/workflow-es-redis/package.json` | modify | Rename package to `@reactorynet/workflow-es-redis`; core libs → `peerDependencies`; bump `ioredis`→`^5`, `redlock`→`^5`, `inversify` aligned to core, `typescript` aligned to core; drop `redis`/`@types/node_redis`; modern `@types/*`. |
| `providers/workflow-es-redis/src/redis-lock-manager.ts` | modify | Port to `@reactorynet/workflow-es`, `redlock` v5 API (`acquire`/`release`), inject `ILogger`, implement `IDistributedLockProvider`. |
| `providers/workflow-es-redis/src/redis-queue-provider.ts` | modify | Port to `@reactorynet/workflow-es`; reliable dequeue (BRPOPLPUSH-style or RPOPLPUSH processing list) so a crashed node does not lose a dequeued id. |
| `providers/workflow-es-redis/src/index.ts` | modify | Re-export both providers (unchanged shape, verify after rename). |
| `providers/workflow-es-redis/tsconfig.json` | modify | Align with postgres provider tsconfig (target/module/decorators). |
| `providers/workflow-es-redis/spec/redis-providers.spec.ts` | create | Provider unit/integration tests against a real or Testcontainers Redis (lock mutual-exclusion, queue FIFO + reliable dequeue). |
| `providers/workflow-es-redis/spec/support/jasmine.json` | create | Jasmine runner config mirroring the postgres provider. |
| `providers/workflow-es-postgres/src/postgres-provider.ts` | modify | Implement CAS on `concurrencyToken` in `persistWorkflow`; throw `WorkflowConcurrencyError`; seed token in `createNewWorkflow`. |
| `providers/workflow-es-postgres/src/models/workflow.ts` | modify | Add `concurrencyToken` column. |
| `providers/workflow-es-mongodb/src/mongodb-provider.ts` | modify | Implement CAS on `concurrencyToken` in `persistWorkflow` (`findOneAndUpdate` filtered on token); throw `WorkflowConcurrencyError`; seed token in `createNewWorkflow`. |
| `providers/workflow-es-mysql/src/mysql-provider.ts` | modify | **Interface-conformance only:** add `concurrencyToken` to its update predicate so it still compiles/satisfies the contract; do not modernise the stack (C3 owns repair). |
| `providers/workflow-es-mysql/src/models/workflow.ts` | modify | Add `concurrencyToken` column (interface-conformance only). |
| `providers/workflow-es-azure/src/azure-lock-manager.ts` | modify | Port import to `@reactorynet/workflow-es` so it builds (lock/queue providers do not touch the persistence token, but they must compile against current core). |
| `providers/workflow-es-azure/src/azure-queue-provider.ts` | modify | Same import port. |
| `providers/workflow-es-azure/package.json` | modify | Rename to `@reactorynet/workflow-es-azure`; core libs → peerDeps; align `inversify`/`typescript`/`@types`. |
| `core/spec/scenarios/concurrency-token.spec.ts` | create | Unit-level scenario proving CAS / stale-write rejection on the memory provider (the failing-test-first). |
| `core/spec/scenarios/two-host-fanout.spec.ts` | create | Two-host, 1000-instance fan-out integration test with a shared in-memory lock/queue/persistence test-double proving 0 duplicate executions (see §8). |
| `docs/upgrade-plan.md` | modify | Flip C1 status `planned`→`done` only at sign-off (not during impl). |

> If, while implementing, a referenced provider `models/workflow.ts` does not exist for MySQL, create
> the column on whatever model file the provider's `persistWorkflow` reads/writes. Do not invent new
> model files for MySQL beyond the column.

## 5. Interface & data-model changes

### 5.1 `WorkflowInstance` — new concurrency token field

```ts
// BEFORE — core/src/models/workflow-instance.ts
export class WorkflowInstance {
    public id : string;
    public workflowDefinitionId : string;
    public version : number;          // <-- this is the WORKFLOW DEFINITION version (unrelated)
    public description : string;
    public nextExecution : number;
    public status : number;
    public data : any;
    public createTime : Date;
    public completeTime : Date;
    public executionPointers : Array<ExecutionPointer> = [];
    constructor() {}
}
```

```ts
// AFTER — core/src/models/workflow-instance.ts
export class WorkflowInstance {
    public id : string;
    public workflowDefinitionId : string;
    public version : number;          // unchanged: workflow definition version
    public description : string;
    public nextExecution : number;
    public status : number;
    public data : any;
    public createTime : Date;
    public completeTime : Date;
    public executionPointers : Array<ExecutionPointer> = [];

    /**
     * Optimistic-concurrency token. Monotonically increasing integer, owned by the
     * persistence provider. `createNewWorkflow` seeds it to 0. Every successful
     * `persistWorkflow` MUST (a) only succeed if the stored token equals the token on
     * the instance being written (compare-and-set), and (b) increment the stored token
     * by 1 and write that new value back onto the in-memory `instance.concurrencyToken`
     * so the caller can persist again in the same execution without re-loading.
     * Undefined/absent is treated as 0 for backward compatibility with rows written
     * before this field existed (see §10).
     */
    public concurrencyToken?: number = 0;

    constructor() {}
}
```

### 5.2 `IPersistenceProvider.persistWorkflow` — contract change (signature arity unchanged)

The **signature is unchanged in arity** (still one argument, still `Promise<void>`); the **contract**
changes: it is now a compare-and-set on `instance.concurrencyToken`.

```ts
// BEFORE — core/src/abstractions/persistence-provider.ts
persistWorkflow(instance: WorkflowInstance): Promise<void>;
```

```ts
// AFTER — core/src/abstractions/persistence-provider.ts
/**
 * Persist a mutated workflow instance using optimistic concurrency.
 *
 * Compare-and-set semantics (REQUIRED of every provider):
 *  - Let `expected = instance.concurrencyToken ?? 0`.
 *  - Atomically update the stored row ONLY where the stored token === `expected`.
 *  - On success: set the stored token to `expected + 1`, and mutate the passed
 *    `instance.concurrencyToken = expected + 1` in place (so the same in-memory
 *    instance can be persisted again without reload).
 *  - On no-match (stored token !== expected, i.e. another node wrote first):
 *    reject with `WorkflowConcurrencyError` and DO NOT write.
 *
 * `createNewWorkflow` MUST seed the stored token and `instance.concurrencyToken` to 0.
 */
persistWorkflow(instance: WorkflowInstance): Promise<void>;
```

> **Decision (documented in §13 as the one genuinely ambiguous call):** the token is a provider-owned
> **monotonic integer `concurrencyToken`**, not `updatedAt`, and `persistWorkflow` keeps returning
> `Promise<void>` and **throws** `WorkflowConcurrencyError` on conflict (rather than returning a
> boolean/new token). Rationale in §13.

### 5.3 New typed error

```ts
// AFTER — core/src/abstractions/errors.ts (append; keep existing toError export)
export const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Thrown by IPersistenceProvider.persistWorkflow when the optimistic-concurrency
 * compare-and-set fails: the stored concurrencyToken did not match the expected token,
 * meaning another node persisted this instance first. The caller should discard its
 * in-memory instance, NOT retry the write blindly, and re-queue the workflow for a
 * fresh load-execute-persist cycle.
 */
export class WorkflowConcurrencyError extends Error {
    public readonly workflowId: string;
    public readonly expectedToken: number;
    constructor(workflowId: string, expectedToken: number) {
        super(`Optimistic concurrency conflict persisting workflow ${workflowId} ` +
              `(expected token ${expectedToken}); another node wrote first.`);
        this.name = "WorkflowConcurrencyError";
        this.workflowId = workflowId;
        this.expectedToken = expectedToken;
        // Restore prototype chain for instanceof under ES2020/commonjs target.
        Object.setPrototypeOf(this, WorkflowConcurrencyError.prototype);
    }
}
```

`WorkflowConcurrencyError` is re-exported automatically via `core/src/abstractions.ts:15`
(`export * from "./abstractions/errors"`) and then via `core/src/index.ts:4`. No barrel edit needed,
but verify the symbol is reachable as `import { WorkflowConcurrencyError } from "@reactorynet/workflow-es"`.

### 5.4 `IDistributedLockProvider` and `IQueueProvider` (shapes the Redis provider implements — UNCHANGED)

These interfaces do **not** change. They are reproduced here so the implementer ports the Redis
provider to exactly these shapes:

```ts
// core/src/abstractions/distributed-lock-provider.ts  (unchanged target shape)
export interface IDistributedLockProvider {
    acquireLock(id: string): Promise<boolean>;   // true if lock obtained, false if already held
    releaseLock(id: string): Promise<void>;
}
```

```ts
// core/src/abstractions/queue-provider.ts  (unchanged target shape)
export enum QueueType {
    Workflow = 0,
    Event = 1,
}
export interface IQueueProvider {
    queueForProcessing(id: string, queue: QueueType): Promise<void>;
    dequeueForProcessing(queue: QueueType): Promise<string>;   // returns null/undefined when empty
}
```

Redis implementations must satisfy:
- `acquireLock(id)` → Redlock `acquire([id], ttlMs)`; store the returned lock keyed by `id`; return
  `true`. On Redlock failure (already held) return `false` (do not throw). Auto-renew leases on a
  timer (existing stub pattern at `redis-lock-manager.ts:18,40-44`, ported to v5 `lock.extend`).
- `releaseLock(id)` → `lock.release()` for the stored lock; tolerate missing/expired lock (no throw).
- `queueForProcessing(id, queue)` → `LPUSH <queueKey> id`.
- `dequeueForProcessing(queue)` → reliable pop: `RPOPLPUSH <queueKey> <processingKey>` (or
  `LMOVE`/`BRPOPLPUSH`) so an in-flight id survives a node crash; return `null` when the source list is
  empty. (A processing-list reaper is **out of scope** here — just don't lose the id on the happy path;
  document the processing key.)

### DI / config impact

`configureWorkflow()` (`core/src/config.ts:38-63`) still binds the single-node defaults. Add:

1. **`WorkflowConfig.allowSingleNodeProviders(allow: boolean)`** — default `false`. New optional method.
2. **Multi-host fail-loud guard.** `SingleNodeLockProvider` and `SingleNodeQueueProvider` gain a static
   module-level registration counter. When a `WorkflowHost.start()` runs with one of these bound, it
   calls a `markStarted()` on the provider. If a **second `WorkflowHost.start()` in the same process**
   marks the same singleton-bound single-node provider as started (the realistic in-process multi-host
   case), and `allowSingleNodeProviders` is `false`, throw:
   `Error("SingleNodeLockProvider/SingleNodeQueueProvider are dev-only and cannot be shared by multiple workflow hosts. Use a distributed provider (e.g. @reactorynet/workflow-es-redis) or call configureWorkflow().allowSingleNodeProviders(true) to override.")`.
   Because true cross-process sharing of an in-memory provider is physically impossible, the guard's job
   is to catch the **mistaken belief** that the default providers scale: it fires when (a) more than one
   host starts in one process on the shared singleton, or (b) a distributed persistence provider is
   configured (`usePersistence` set to something whose constructor name is not `MemoryPersistenceProvider`)
   while the lock or queue is still a single-node default. Case (b) is the high-value check for cloud
   deployments and MUST be implemented in `WorkflowHost.start()`:

   ```ts
   // WorkflowHost.start() guard (pseudocode for the implementer)
   const lockIsSingleNode  = this.lockProvider  instanceof SingleNodeLockProvider;
   const queueIsSingleNode = this.queueProvider instanceof SingleNodeQueueProvider;
   const persistenceIsMemory = this.persistence.constructor.name === "MemoryPersistenceProvider";
   if (!this.allowSingleNodeProviders && !persistenceIsMemory && (lockIsSingleNode || queueIsSingleNode)) {
       throw new Error(/* message above */);
   }
   ```

   The `allowSingleNodeProviders` flag is read from the container (bind a
   `TYPES`-less constant or a config value on the host). Simplest binding: `WorkflowConfig`
   stores the boolean and sets it on the `WorkflowHost` instance via a setter before `getHost()`
   returns. Implementer chooses the wiring; the **observable behaviour in §6.9 is the contract**.

3. No new `TYPES` symbol is required. No change to the existing bindings at `config.ts:41-43`.

### Persisted / at-rest format impact

- New column/field `concurrencyToken` (integer) on the workflow record in every SQL/Mongo provider.
- **Forward migration:** providers using `sequelize.sync()` (postgres, mysql) add the column
  automatically on next start; the column default is `0`. Mongo is schemaless — absent field reads as
  `0`. **No destructive migration. No backfill needed** (absent ⇒ 0; see §10).
- The in-memory provider has no at-rest format.

## 6. Behavioural contract (numbered rules)

1. **Token seeding.** `createNewWorkflow(instance)` sets `instance.concurrencyToken = 0` and stores `0`.
   (Memory, postgres, mongodb, mysql, and the planned sqlite.)
2. **Successful persist increments.** A `persistWorkflow(instance)` whose `instance.concurrencyToken`
   equals the stored token: updates the row, sets the **stored** token to `expected + 1`, sets
   `instance.concurrencyToken = expected + 1`, and resolves. Re-persisting the same in-memory instance
   immediately afterward (token now `expected + 1`) succeeds again (proves in-place token refresh).
3. **Idempotency / repeated persist.** Calling `persistWorkflow` twice in a row on the same instance,
   each after the previous resolved, succeeds both times and leaves the stored token at the post-second
   value. There is no double-increment from a single logical save.
4. **Concurrency (two readers).** Given instance X stored at token N: load it twice into two separate
   in-memory instances A and B (both have token N). `persistWorkflow(A)` succeeds (stored token → N+1).
   A subsequent `persistWorkflow(B)` (still token N) **rejects with `WorkflowConcurrencyError`** and
   **does not modify the stored row** (token stays N+1, data stays A's).
5. **Error path — typed rejection.** The conflict in rule 4 rejects with an error that is
   `instanceof WorkflowConcurrencyError`, carries `workflowId === X.id` and `expectedToken === N`, and
   the provider performs **no write** on that call.
6. **Lock independence.** The concurrency token is a *second* line of defence; it does not replace the
   distributed lock. With a correct distributed lock, rule 4's conflict should not occur in normal
   operation, but the provider MUST still enforce CAS so that lock-expiry / split-brain produces a
   rejected stale write rather than a lost update.
7. **Worker handling of conflict.** In `WorkflowQueueWorker.processWorkflow`
   (`workflow-queue-worker.ts`), when the `persistWorkflow` in the inner `finally` rejects with
   `WorkflowConcurrencyError`, the worker logs it at `info`/`warn` (not `error`), does **not** mark
   `complete`, and **re-queues** `workflowId` to `QueueType.Workflow` for a fresh load-execute cycle.
   Any other error preserves today's behaviour (logged, swallowed). The lock is still released in the
   `finally` exactly as today (H2 owns moving that).
8. **Host control methods.** `suspendWorkflow`/`resumeWorkflow`/`terminateWorkflow`
   (`workflow-host.ts:93-173`) currently load → mutate status → `persistWorkflow`. On
   `WorkflowConcurrencyError` they MUST retry the **whole load-mutate-persist** sequence **once**; if it
   conflicts again, return `false` (do not throw out of these public methods — they already return
   `boolean` and swallow errors today).
9. **Dev-only providers fail loud.** With a non-memory persistence provider configured and a single-node
   lock or queue provider still bound, `WorkflowHost.start()` throws the §5 error **unless**
   `configureWorkflow().allowSingleNodeProviders(true)` was called. With the all-default configuration
   (memory persistence + single-node lock + single-node queue, one host) `start()` does **not** throw —
   the Electron/single-process path is unaffected.
10. **Redis lock mutual exclusion.** Against one shared Redis, `acquireLock("X")` from host A returns
    `true`; a concurrent `acquireLock("X")` from host B returns `false` until A `releaseLock("X")`.
11. **Redis queue FIFO + reliable dequeue.** `queueForProcessing` then `dequeueForProcessing` returns
    ids in FIFO order; `dequeueForProcessing` on an empty queue returns `null`/`undefined` (never
    throws); a dequeued id is moved to a processing list (not deleted) so a crash between dequeue and
    ack does not silently drop it.
12. **No regression of single-node semantics.** `SingleNodeLockProvider.acquireLock` still returns
    `false` for an already-held id; `SingleNodeQueueProvider` still FIFO via push/shift. The guard in
    rule 9 is the only behavioural addition.

## 7. Provider parity

§5 changes the **`IPersistenceProvider.persistWorkflow` contract** (concurrency token). Per the plan's
non-negotiable #3, **every persistence provider changes in this same PR and all must build and pass
their tests together.** The lock/queue interface signatures are unchanged, but the Redis (reference) and
Azure providers must be ported to current core in this PR because they currently do not build.

| Provider | Change required |
|---|---|
| **memory** (`core/src/services/memory-persistence-provider.ts`) | `createNewWorkflow`: set `instance.concurrencyToken = 0`. `persistWorkflow`: read stored instance, compute `expected = instance.concurrencyToken ?? 0`; if stored token (`?? 0`) !== expected → throw `WorkflowConcurrencyError(instance.id, expected)`; else store a copy with token `expected+1`, set `instance.concurrencyToken = expected+1`. (Be careful: today it stores the *same object reference*; CAS requires comparing the previously-stored token, so store the token on the stored object.) |
| **sqlite** (planned, C2 — `providers/workflow-es-sqlite`, does not exist yet) | **No code in this PR.** This spec mandates that the future SQLite provider implements the exact CAS contract in §5.2 / §6: `concurrencyToken` column default 0, `UPDATE … WHERE id=? AND concurrencyToken=?` then check affected-rows; 0 rows → throw `WorkflowConcurrencyError`. Recorded here so C2 inherits the settled shape. |
| **postgres** (`providers/workflow-es-postgres/src/postgres-provider.ts`, `models/workflow.ts`) | Add `concurrencyToken` column (INTEGER, default 0). `createNewWorkflow`: token 0. `persistWorkflow`: inside the existing transaction, run `Workflow.update({ …, concurrencyToken: expected+1 }, { where: { id, concurrencyToken: expected } })`; if the returned `[affectedCount]` is 0 → throw `WorkflowConcurrencyError(id, expected)` (transaction rolls back, so the pointer destroy/recreate does not commit); else set `instance.concurrencyToken = expected+1`. |
| **mongodb** (`providers/workflow-es-mongodb/src/mongodb-provider.ts`) | Add token handling. `createNewWorkflow`: set token 0 before insert. `persistWorkflow`: `findOneAndUpdate({ _id, concurrencyToken: expected }, { $set: {…}, $inc: { concurrencyToken: 1 } })`; if result/`value` is null → throw `WorkflowConcurrencyError(id, expected)`; else set `instance.concurrencyToken = expected+1`. (This is the modern async API; the file currently uses the removed v3 callback API — make the **minimum** change to add CAS without a broader rewrite, which is C3. If the callback API blocks a clean CAS, wrap the existing pattern; full modernisation is explicitly C3.) |
| **mysql** (`providers/workflow-es-mysql/src/mysql-provider.ts`, `models/workflow.ts`) | **Interface-conformance only.** Add `concurrencyToken` column (default 0) and add `concurrencyToken: expected` to the update `where` plus set it to `expected+1`; on 0 affected rows throw `WorkflowConcurrencyError`. Do **not** modernise Sequelize 4 (C3). The goal is only that it satisfies the contract and type-checks. |
| **redis** (`providers/workflow-es-redis/*`) | Not a persistence provider — no token work. But it MUST be ported to build against current core: imports → `@reactorynet/workflow-es`; `redlock` v5 (`acquire`/`release`/`extend`); `ioredis` v5; package renamed `@reactorynet/workflow-es-redis`; core libs as peerDeps. Implements `IDistributedLockProvider` + `IQueueProvider` per §5.4. This is the **reference distributed provider** for the §8 two-host test. |
| **azure** (`providers/workflow-es-azure/*`) | Not a persistence provider — no token work. Port imports → `@reactorynet/workflow-es`; rename package `@reactorynet/workflow-es-azure`; core libs peerDeps; align `inversify`/`typescript`. Just needs to **build** against current core; full Azure integration testing is out of scope (no Azure target in M8's container matrix). |

## 8. Test plan (TDD)

Existing scenarios in `core/spec/scenarios/` follow a fixed shape: build a `WorkflowBase`, create the
host with `configureWorkflow()`, `host.start()`, `host.startWorkflow(...)`, then `await spinWait(async
() => …)` polling the persistence provider until a condition holds (see `external-events.spec.ts:31-55`,
`saga-compensation.spec.ts:73`). Two spin helpers exist in `core/spec/helpers/spin-wait.ts`:
`spinWait(until): Promise<void>` (promise form, used by all current scenarios) and
`spinWaitCallback(until, done)` (callback form). New tests use `spinWait`.

### Failing-test-first

- **`concurrency-token.spec.ts` → "rejects a stale write with WorkflowConcurrencyError"** — arrange:
  `const p = new MemoryPersistenceProvider();` create a workflow instance `wf` (status Runnable),
  `await p.createNewWorkflow(wf)`; load it twice: `const a = await p.getWorkflowInstance(wf.id)` and
  `const b = await p.getWorkflowInstance(wf.id)` (two independent copies, both token 0). · act:
  `await p.persistWorkflow(a)` (succeeds, token→1); then attempt `await p.persistWorkflow(b)` (b still
  token 0). · assert: the second call rejects, `err instanceof WorkflowConcurrencyError`,
  `err.workflowId === wf.id`, `err.expectedToken === 0`, and `(await p.getWorkflowInstance(wf.id)).concurrencyToken === 1`.
  **This test must fail before implementation** (today `persistWorkflow` is last-write-wins and there is
  no `WorkflowConcurrencyError` symbol — the test won't even compile until §5.3 lands, which is the
  intended red state). (Proves §6.1, §6.2, §6.4, §6.5.)

> Note: `getWorkflowInstance` on the memory provider currently returns the **stored object reference**,
> so "two independent copies" requires the provider to return clones, OR the test clones via
> `JSON.parse(JSON.stringify(...))`. The implementer MUST make the memory provider's CAS correct
> regardless of reference aliasing — store the token on the stored record and compare against the
> incoming `instance.concurrencyToken`. The test clones defensively to model real provider behaviour.

### Coverage

- **`concurrency-token.spec.ts` → "increments token on each successful persist"** — persist the same
  instance three times in sequence; assert stored token is 3 and `instance.concurrencyToken === 3`.
  (Proves §6.2, §6.3.)
- **`concurrency-token.spec.ts` → "seeds token to 0 on createNewWorkflow"** — assert
  `wf.concurrencyToken === 0` and `(await p.getWorkflowInstance(wf.id)).concurrencyToken === 0`.
  (Proves §6.1.)
- **`two-host-fanout.spec.ts` → "two hosts run 1000 instances with zero duplicate executions"** — see
  detailed arrange/act/assert below. (Proves §6.4, §6.6, §6.7, §6.10, §6.11.)
- **`two-host-fanout.spec.ts` → "single-node providers fail loud when a non-memory persistence is configured"**
  — arrange: a stub persistence provider whose `constructor.name !== "MemoryPersistenceProvider"`,
  default single-node lock+queue, `allowSingleNodeProviders` left `false`. · act: `await host.start()`.
  · assert: rejects/throws with a message containing "dev-only". Then repeat with
  `config.allowSingleNodeProviders(true)` and assert it does **not** throw. (Proves §6.9.)
- **`providers/workflow-es-redis/spec/redis-providers.spec.ts` → "lock is mutually exclusive"** —
  two `RedisLockManager` instances on one Redis: `acquireLock("X")` on #1 → true; on #2 → false; after
  `#1.releaseLock("X")`, `#2.acquireLock("X")` → true. (Proves §6.10.)
- **`providers/workflow-es-redis/spec/redis-providers.spec.ts` → "queue is FIFO and reliable"** —
  enqueue `a,b,c`; dequeue thrice → `a,b,c`; dequeue empty → null; assert the processing list received
  the dequeued ids. (Proves §6.11.)

### The two-host fan-out integration test (detailed)

Real Redis/Postgres in a unit run is heavy; the **core** integration test models two hosts sharing one
backend using **shared in-process doubles** that mimic distributed semantics, so it runs in CI without
containers. (A separate Testcontainers-backed variant belongs to M8.)

- **Arrange.**
  - A `SharedQueue` and `SharedLock` test-double (single instances) passed to **both** hosts via
    `config.useQueueManager(sharedQueue)` / `config.useLockManager(sharedLock)`. `SharedLock` enforces
    real mutual exclusion across both hosts (a `Set<string>` of held ids); `SharedQueue` is one shared
    FIFO. These doubles live in the test file (or `core/spec/helpers/`), not in `src/`.
  - One shared `MemoryPersistenceProvider`-derived double **with CAS enabled** (the real memory provider
    after this change is sufficient) passed to both hosts via `config.usePersistence(shared)`.
  - Because persistence is the (memory) default class, the §6.9 guard does not fire even with the shared
    lock/queue doubles — acceptable; this test is about correctness, not the guard.
  - A workflow whose single step **records its execution** by pushing
    `(workflowId, executionPointerId)` into a shared `executionLog: string[]` and returns
    `ExecutionResult.next()` to complete. Use an `inversify`-free `StepBody` like the existing scenarios.
  - Two hosts built from two `configureWorkflow()` configs but sharing the three doubles above; both
    `registerWorkflow` and `await host.start()`.
- **Act.** Start 1000 instances (`for i in 0..999: hostA.startWorkflow("fanout", 1, { i })`). Then
  `await spinWait(async () => completedCount(shared) === 1000)` with a generous count (raise
  `jasmine.DEFAULT_TIMEOUT_INTERVAL`, e.g. 60000, as scenarios already raise it to 20000).
- **Assert.**
  - All 1000 instances reach `WorkflowStatus.Complete`.
  - `executionLog` has **exactly 1000** entries — **zero duplicate** `(workflowId)` executions
    (assert `new Set(executionLog.map(e => e.workflowId)).size === 1000` and `executionLog.length === 1000`).
  - No `WorkflowConcurrencyError` escaped as an unhandled rejection (zero lost updates: every instance's
    final `concurrencyToken >= 1`).

### How to run

```bash
cd core && yarn build && yarn test           # runs the new concurrency-token + two-host scenarios
# redis provider:
cd providers/workflow-es-redis && yarn install && yarn build && yarn test
#   (redis spec uses REDIS_URL env or Testcontainers; if neither, it is skipped with a clear pending note)
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds (TypeScript compiles with the new field, error, and CAS).
- [ ] `cd core && yarn test` passes on the Node 20 and Node 22 CI matrix.
- [ ] The failing-first test `concurrency-token.spec.ts → "rejects a stale write…"` is present, was red
      before the implementation (visible in PR history), and is green after.
- [ ] `two-host-fanout.spec.ts → "two hosts run 1000 instances with zero duplicate executions"` passes:
      `executionLog.length === 1000` and `new Set(executionLog.map(e => e.workflowId)).size === 1000`.
- [ ] `two-host-fanout.spec.ts → "single-node providers fail loud…"` passes (throws "dev-only" without
      the flag; does not throw with `allowSingleNodeProviders(true)`).
- [ ] `cd providers/workflow-es-redis && yarn build` succeeds against `@reactorynet/workflow-es`.
- [ ] `cd providers/workflow-es-redis && yarn test` passes the lock mutual-exclusion and FIFO/reliable
      queue specs against a real Redis (or is pending-skipped with a clear message when no Redis is
      available, never silently green).
- [ ] `cd providers/workflow-es-postgres && yarn build` succeeds with the `concurrencyToken` column.
- [ ] `cd providers/workflow-es-mongodb && yarn build` and `cd providers/workflow-es-mysql && yarn build`
      and `cd providers/workflow-es-azure && yarn build` succeed against current core
      (`@reactorynet/workflow-es`).
- [ ] `grep -R "from '@reactorynet/workflow-es'" providers/workflow-es-redis providers/workflow-es-azure` returns no
      matches (old package name fully removed in the touched providers).
- [ ] `WorkflowConcurrencyError` is importable as `import { WorkflowConcurrencyError } from "@reactorynet/workflow-es"`.

## 10. Backward compatibility & migration

- **Public API.** Additive: new optional field `WorkflowInstance.concurrencyToken?` (default 0) and new
  exported `WorkflowConcurrencyError`. `persistWorkflow`'s signature arity is unchanged; its contract is
  stricter (it can now reject). Callers that previously ignored a lost update now get a typed rejection
  — this is the intended fix, not a break, and the two in-core callers (worker, host control methods)
  are updated in this PR (§6.7, §6.8).
- **At-rest.** New `concurrencyToken` column (INTEGER default 0) in SQL providers via `sequelize.sync()`;
  schemaless in Mongo. **Rows written before this change have no token; they are read as `0`.** The
  first `persistWorkflow` on such a row expects token `0`, matches (absent ⇒ 0), and moves it to `1`.
  No backfill, no downtime, no destructive migration. Backward read of an old tarball against a new
  DB is safe (extra column ignored).
- **Consumer (`reactory-express-server`).** Integrates via a `file:` tarball. No code change required on
  the consumer unless it calls `persistWorkflow` directly (it does not — it uses the host). Bump core
  version `2.3.6-reactory.3` → **`2.4.0-reactory.0`** (minor: additive public API + new behaviour;
  follows the plan's "versioned, explicit migration" rule). Redis/Azure providers renamed to the
  `@reactorynet/` scope get their own minor bump and a README note that the package name changed.

## 11. Definition of Done

`IPersistenceProvider.persistWorkflow` enforces optimistic concurrency via a provider-owned
`WorkflowInstance.concurrencyToken`: a stale write is rejected with `WorkflowConcurrencyError` instead of
silently lost, every persistence provider (memory, postgres, mongodb, mysql, and — by documented
contract — the future sqlite) implements the compare-and-set + increment, and `createNewWorkflow` seeds
the token to 0. The Redis provider builds against current core and supplies a working Redlock
`IDistributedLockProvider` and a reliable Redis-list `IQueueProvider`; the Azure provider builds against
current core. The single-node lock/queue providers are marked dev-only and `WorkflowHost.start()` fails
loud when they are paired with a non-memory persistence provider unless explicitly overridden, while the
default single-process / Electron path still starts with zero external infrastructure. Proven by: the
failing-first stale-write test (red→green), the two-host 1000-instance fan-out test asserting exactly
1000 executions with zero duplicates, the redis lock/queue specs, and all affected providers building.
All §9 boxes are checked in CI on Node 20 + 22.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) `errors.ts` + `workflow-instance.ts` (so the test can compile red);
  (2) `concurrency-token.spec.ts` (red); (3) memory provider CAS (green); (4) worker + host conflict
  handling (§6.7/§6.8); (5) `two-host-fanout.spec.ts`; (6) postgres CAS; (7) mongo/mysql CAS;
  (8) single-node guard + config flag; (9) redis port; (10) azure build-only port.
- Upstream `danielgerlag/workflow-es` Redis provider used `redlock@^3` (`redlock.lock`/`lock.unlock`).
  `redlock@^5` exports a `Redlock` class with `acquire(resources, duration)` returning a `Lock` with
  `release()` and `extend(duration)`. Mirror the existing renew-timer (`redis-lock-manager.ts:18,40-44`)
  but call `lock.extend`.
- Memory-provider gotcha: today `getWorkflowInstance` returns the live stored reference and
  `persistWorkflow` replaces by index. For correct CAS, compare the **incoming**
  `instance.concurrencyToken` to the **stored record's** token; on success store with the new token.
  Returning clones from `getWorkflowInstance` is the cleanest way to make CAS observable in tests, but
  is not strictly required if the stored token is tracked separately — choose the minimal correct change.
- The `data` round-trip is untouched (H6 owns serialization hooks). Do not add `json-stable-stringify`.

## 13. Genuinely ambiguous decisions made in this spec

1. **Token type & failure signalling.** Choice: a provider-owned **monotonic integer**
   `concurrencyToken` (not a timestamp `updatedAt`), and `persistWorkflow` **throws**
   `WorkflowConcurrencyError` (rather than returning a boolean or the new token). *Why:* an integer CAS
   is immune to multi-node clock skew that an `updatedAt` comparison suffers; throwing keeps the
   `Promise<void>` signature arity stable (so no signature break ripples through every provider and
   call-site) while still being unambiguously detectable via `instanceof`. C2 (sqlite) and C3
   (mongo/mysql repair) inherit this exact shape.
2. **Provider rename scope.** Choice: rename Redis and Azure to the `@reactorynet/` scope **in this PR**
   because they must be edited to build anyway; MySQL/Mongo renames are left to M7/C3. *Why:* minimise
   blast radius — only providers that must change to satisfy C1 get touched.
3. **Multi-host guard is best-effort, not bulletproof.** Choice: the fail-loud guard keys off "non-memory
   persistence configured + single-node lock/queue still bound" plus a same-process second-start check,
   rather than a true distributed presence check. *Why:* an in-memory provider genuinely cannot be shared
   cross-process, so the realistic failure is a misconfigured cloud deploy that keeps the defaults; that
   exact case is what the persistence-class check catches. A real cross-node presence beacon would be
   over-engineering for C1 and overlaps H3.
