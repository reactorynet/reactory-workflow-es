# Spec — H3 · Lease/lock the poll worker

| Field | Value |
|---|---|
| **Item ID** | H3 |
| **Title** | Lease/lock the poll worker |
| **Plan reference** | [`upgrade-plan.md` → H3](../upgrade-plan.md) |
| **Target** | Cloud (must remain correct on Electron/single-process) |
| **Severity** | High |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | C1 (distributed lock provider) |
| **Author / reviewer** | Werner Weber / _TBD_ |

---

## 1. Context (self-contained)

The engine runs three background workers, all bound as `IBackgroundWorker` and started together by
the host (`core/src/config.ts:49-51`, `core/src/services/workflow-host.ts:16-37`). One of them is the
**poll worker** (`core/src/services/poll-worker.ts`). Its job is to find workflow instances and events
that have become runnable (e.g. a `delay`/`schedule` whose `nextExecution` time has now passed, or an
event whose `eventTime` has arrived) and push their ids onto the in-process queue so the
`WorkflowQueueWorker` / `EventQueueWorker` pick them up.

The poll loop runs every 10 seconds on a fixed timer and has **no coordination between nodes**:

```ts
// core/src/services/poll-worker.ts:24-58
public start() {
    this.processTimer = setInterval(this.process, 10000, this);   // hard-coded 10000ms
}
...
private async process(self: PollWorker): Promise<void> {
    self.logger.info("pollRunnables " + " - now = " + Date.now());
    //TODO: lock                                                   // <-- the gap this spec closes
    try {
        let runnables = await self.persistence.getRunnableInstances();
        for (let item of runnables) {
            self.queueProvider.queueForProcessing(item, QueueType.Workflow);
        }
    }
    catch (err) { ... }

    try {
        let events = await self.persistence.getRunnableEvents();
        for (let item of events) {
            self.queueProvider.queueForProcessing(item, QueueType.Event);
        }
    }
    catch (err) { ... }
}
```

`getRunnableInstances()` / `getRunnableEvents()` return the **same set of ids** to every node that
calls them — they are global "what is due now" scans with no host affinity
(`core/src/services/memory-persistence-provider.ts:26-30, 57-61`).

**Why this is wrong.** In a cluster of N nodes, every node's poll worker wakes up (roughly) every 10s,
runs the identical scan, and queues the identical ids. Each id is therefore queued up to N times per
cycle. Downstream, `WorkflowQueueWorker.processWorkflow` does protect correctness with a per-workflow
lock (`workflow-queue-worker.ts:57`), so the *duplicate dequeues mostly become wasted lock-contention
churn* rather than double execution — but it is exactly the amplification this plan calls out: N nodes
doing N× the scan work and N× the queue/lock traffic, magnifying the cost of H1 (no concurrency cap)
and H2 (lock-release race) across the fleet. On a single process the `//TODO: lock` is harmless; in
the cloud it is pure waste and a scaling hazard.

**User-visible impact.** Queue/lock storms, redundant DB scans every 10s per node, and degraded
throughput that gets worse the more nodes you add — the opposite of horizontal scaling. The 10s
interval is also a hard-coded magic number with no way to tune it per deployment.

## 2. Goal

After this change there is **at most one active poller per poll cycle across the entire cluster**. The
poll cycle is gated behind a distributed lease acquired via the existing `IDistributedLockProvider`:
each node attempts to acquire a well-known lease key at the start of its cycle; only the node that wins
performs the scan-and-queue; losers skip the cycle and try again next tick. The lease is always
released when the cycle finishes (success or failure), and would expire on its own if a holder died
(C1's lock provider provides TTL semantics). On a single process / Electron build the same code path
trivially "wins" the lease every cycle, so behaviour is unchanged there. The poll interval becomes a
configurable option (default 10000ms) instead of a hard-coded literal.

## 3. Out of scope

- Do **not** change `IDistributedLockProvider`'s shape (`acquireLock(id)`/`releaseLock(id)`). This spec
  uses it as-is. (See §7.)
- Do **not** implement the sharded-scan alternative. The lease approach is chosen; do not build both.
- Do **not** touch `WorkflowQueueWorker` / `EventQueueWorker` per-workflow locking, dequeue loops, or
  the H1/H2 concerns — those are separate items. This spec only gates the *poll scan*.
- Do **not** change `getRunnableInstances` / `getRunnableEvents` signatures or add host-affinity
  filtering to persistence providers (that would be the sharded approach — out of scope).
- Do **not** change the in-memory `SingleNodeLockProvider` implementation
  (`core/src/services/single-node-lock-provider.ts`). It already satisfies "single process always wins".
- Do **not** add the lease behaviour to the other two workers.
- Do **not** introduce graceful-drain / SIGTERM handling (that is H4).
- Do **not** convert `start()`/`stop()` on `IBackgroundWorker` to async (that is H4).

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/services/poll-worker.ts` | modify | Wrap the scan body in lease acquire/release; read interval from injected config; remove `//TODO: lock` and the hard-coded `10000`. |
| `core/src/config.ts` | modify | Add a `WorkflowOptions` value bound in the container; add `pollInterval` (default 10000) with validation; allow `configureWorkflow(options?)` to override it. |
| `core/src/abstractions/workflow-options.ts` | create | Define the `WorkflowOptions` interface, the `TYPES.WorkflowOptions` symbol entry, the lease key constant, and `DEFAULT_POLL_INTERVAL`. |
| `core/src/abstractions/types.ts` | modify | Add `WorkflowOptions: Symbol("WorkflowOptions")` and (optionally) re-export from the abstractions barrel. |
| `core/src/abstractions/index.ts` | modify | Export the new `workflow-options` module so `WorkflowOptions`/constants are importable from `../abstractions`. |
| `core/spec/scenarios/poll-worker-lease.spec.ts` | create | Integration test: N simulated pollers, each runnable instance queued by exactly one poller per cycle. |

> Note: confirm the exact barrel filename. The abstractions are re-exported from
> `core/src/abstractions/index.ts` (the workers import `... } from "../abstractions"`). If the barrel
> file is named differently, add the export there instead — grep `core/src/abstractions/` for the file
> that re-exports `IDistributedLockProvider`.

## 5. Interface & data-model changes

### New: `WorkflowOptions` (`core/src/abstractions/workflow-options.ts`)

```ts
// core/src/abstractions/workflow-options.ts  (NEW FILE)

/** Default poll-worker interval in milliseconds. */
export const DEFAULT_POLL_INTERVAL = 10000;

/**
 * Well-known lease key used by the poll worker to elect a single active poller
 * per cycle via IDistributedLockProvider. Namespaced to avoid colliding with
 * per-workflow lock ids (which are workflow instance UUIDs).
 */
export const POLL_LEASE_KEY = "workflow-es:poll-lease";

export interface WorkflowOptions {
    /**
     * Interval, in milliseconds, between poll-worker scan cycles.
     * Must be a finite integer >= 1000. Defaults to DEFAULT_POLL_INTERVAL (10000).
     */
    pollInterval: number;
}
```

### Changed: DI symbols (`core/src/abstractions/types.ts`)

```ts
// BEFORE (excerpt)
export const TYPES = {
    ...
    IBackgroundWorker: Symbol("IBackgroundWorker"),
    ...
};

// AFTER (excerpt) — add one entry
export const TYPES = {
    ...
    IBackgroundWorker: Symbol("IBackgroundWorker"),
    WorkflowOptions: Symbol("WorkflowOptions"),
    ...
};
```

### Changed: `PollWorker` (`core/src/services/poll-worker.ts`)

```ts
// BEFORE (relevant parts)
public start() {
    this.processTimer = setInterval(this.process, 10000, this);
}

private async process(self: PollWorker): Promise<void> {
    self.logger.info("pollRunnables " + " - now = " + Date.now());
    //TODO: lock
    try {
        let runnables = await self.persistence.getRunnableInstances();
        for (let item of runnables) {
            self.queueProvider.queueForProcessing(item, QueueType.Workflow);
        }
    }
    catch (err) { ... }
    try {
        let events = await self.persistence.getRunnableEvents();
        for (let item of events) {
            self.queueProvider.queueForProcessing(item, QueueType.Event);
        }
    }
    catch (err) { ... }
}
```

```ts
// AFTER (relevant parts)

// New injected field (alongside the existing @inject fields):
@inject(TYPES.WorkflowOptions)
private options: WorkflowOptions;

public start() {
    this.processTimer = setInterval(this.process, this.options.pollInterval, this);
}

private async process(self: PollWorker): Promise<void> {
    self.logger.info("pollRunnables " + " - now = " + Date.now());

    // Elect a single active poller for this cycle via the distributed lease.
    let gotLease = false;
    try {
        gotLease = await self.lockProvider.acquireLock(POLL_LEASE_KEY);
    }
    catch (err) {
        const error = toError(err);
        self.logger.error("Error acquiring poll lease: " + error.message);
        return; // could not determine lease ownership; skip this cycle, retry next tick
    }

    if (!gotLease) {
        self.logger.log("Poll lease held by another node; skipping cycle");
        return;
    }

    try {
        try {
            let runnables = await self.persistence.getRunnableInstances();
            for (let item of runnables) {
                self.queueProvider.queueForProcessing(item, QueueType.Workflow);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error running poll: " + error.message);
        }

        try {
            let events = await self.persistence.getRunnableEvents();
            for (let item of events) {
                self.queueProvider.queueForProcessing(item, QueueType.Event);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error running poll: " + error.message);
        }
    }
    finally {
        // Always release the lease, even if a scan threw. The TTL on the lock
        // provider (C1) is the backstop if this node dies before release.
        try {
            await self.lockProvider.releaseLock(POLL_LEASE_KEY);
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error releasing poll lease: " + error.message);
        }
    }
}
```

> `lockProvider` is already injected on `PollWorker` (`poll-worker.ts:13-14`). `toError` is already
> imported (`poll-worker.ts:3`). The only new import is `WorkflowOptions`, `POLL_LEASE_KEY` from
> `../abstractions`.

### DI / config impact (`core/src/config.ts`)

`configureWorkflow()` gains an optional `options` argument and binds a fully-resolved `WorkflowOptions`
constant into the container.

```ts
// BEFORE
export function configureWorkflow(): WorkflowConfig {
    let workflowModule = new ContainerModule((bind, unbind) => {
        bind<ILogger>(TYPES.ILogger).to(NullLogger);
        ...
    });
    let container = new Container();
    container.bind(Container).toConstantValue(container);
    container.load(workflowModule);
    let config = new WorkflowConfig(container);
    return config;
}
```

```ts
// AFTER
import { WorkflowOptions, DEFAULT_POLL_INTERVAL } from "./abstractions";

/** Resolve caller-supplied partial options against defaults, validating each field. */
function resolveOptions(partial?: Partial<WorkflowOptions>): WorkflowOptions {
    const pollInterval = partial?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    if (!Number.isInteger(pollInterval) || pollInterval < 1000) {
        throw new Error(
            `Invalid pollInterval ${String(pollInterval)}: must be an integer >= 1000 (ms).`
        );
    }
    return { pollInterval };
}

export function configureWorkflow(options?: Partial<WorkflowOptions>): WorkflowConfig {
    const resolved = resolveOptions(options);

    let workflowModule = new ContainerModule((bind, unbind) => {
        bind<WorkflowOptions>(TYPES.WorkflowOptions).toConstantValue(resolved);
        bind<ILogger>(TYPES.ILogger).to(NullLogger);
        ... // (all existing bindings unchanged)
    });

    let container = new Container();
    container.bind(Container).toConstantValue(container);
    container.load(workflowModule);

    let config = new WorkflowConfig(container);
    return config;
}
```

- **New config option:** `pollInterval`, type `number` (ms), **default `10000`** (`DEFAULT_POLL_INTERVAL`).
- **Validation:** must be a finite integer `>= 1000`. Otherwise `configureWorkflow` throws a clear
  `Error` synchronously at configuration time (fail-loud, before the host starts).
- The binding is `toConstantValue`, so it is effectively a singleton constant injected into the poll
  worker. Existing callers of `configureWorkflow()` with no arguments keep the 10000ms default
  unchanged.

### Lease key / TTL design

- **Lease key:** the constant `POLL_LEASE_KEY = "workflow-es:poll-lease"`. It is namespaced with a
  `workflow-es:` prefix so it can never collide with per-workflow lock ids, which are workflow-instance
  UUIDs (`memory-persistence-provider.ts` `generateUID()` → `crypto.randomUUID()`).
- **TTL:** the poll worker does **not** specify a TTL itself — `IDistributedLockProvider.acquireLock`
  takes only an `id` (§7). TTL is the lock provider's responsibility. C1's distributed lock provider
  (Redis/Redlock) must give locks a TTL **comfortably longer than one poll cycle** so a healthy holder
  is never evicted mid-scan, yet short enough that a dead holder's lease auto-expires and another node
  can poll on a subsequent cycle. Recommended provider TTL: `>= 3 × pollInterval` (i.e. `>= 30s` at the
  default). This is a **note to the C1 implementer**, recorded here; H3 itself does not set TTL.
- **Release:** the lease is released in a `finally` at the end of every cycle (see §5 AFTER). TTL is
  only the crash backstop, not the normal release path.

### Persisted / at-rest format impact

None. No change to any persisted shape; the lease lives entirely in the lock provider.

## 6. Behavioural contract (numbered rules)

1. **Interval is configurable.** The poll worker schedules its cycle using `options.pollInterval`
   (ms), not a hard-coded literal. With no options supplied, the interval is exactly `10000`.
2. **Validation is fail-loud.** `configureWorkflow({ pollInterval })` throws synchronously if
   `pollInterval` is not an integer `>= 1000`. A valid value is accepted and used verbatim.
3. **Single elected poller.** At the start of each cycle, the poll worker calls
   `lockProvider.acquireLock(POLL_LEASE_KEY)`. It performs the scan-and-queue **only if** the call
   resolves `true`.
4. **Losers skip cleanly.** If `acquireLock` resolves `false`, the worker logs and returns without
   scanning or queueing anything this cycle. It does **not** call `releaseLock` (it never held the
   lease). It retries on the next tick.
5. **Lease always released by the winner.** A winning poller releases the lease via
   `releaseLock(POLL_LEASE_KEY)` in a `finally` block that runs whether the instance scan, the event
   scan, both, or neither threw. The lease is never left held by a worker that completed its cycle.
6. **Scan errors are isolated and do not leak the lease.** An exception thrown by
   `getRunnableInstances()` is caught so the event scan still runs; an exception in either scan still
   reaches the `finally` and releases the lease (rule 5). This preserves the existing per-section
   try/catch isolation in `process`.
7. **Acquire errors skip the cycle.** If `acquireLock` itself rejects, the worker logs the error and
   returns without scanning and without calling `releaseLock`. The next tick retries.
8. **Single-process correctness (Electron).** With the default `SingleNodeLockProvider`, there is one
   process, so `acquireLock(POLL_LEASE_KEY)` returns `true` at the start of the cycle and the worker
   releases it at the end — every cycle the single node wins and polls. Behaviour is functionally
   identical to today minus the duplicate-across-nodes problem (which does not exist on a single node).
9. **No double-queue across nodes (the core fix).** **Concurrency:** Within a single poll cycle, across
   N nodes sharing one lock provider, the lease is held by at most one node, so each runnable instance
   id and each runnable event id is enqueued by **exactly one** poller that cycle (zero by the losers).
10. **Idempotency / liveness.** **Idempotency:** The lease is per-cycle, not sticky — over many cycles
    different nodes may win, but never more than one per cycle. If the winning node crashes before
    releasing, the provider's TTL (C1) expires the lease so a subsequent cycle is not starved
    permanently (this rule is only fully testable with a TTL-bearing provider; with
    `SingleNodeLockProvider` there is only one node so it is moot).

## 7. Provider parity

**No core interface change; minimal provider impact.**

Confirmed by reading `core/src/abstractions/distributed-lock-provider.ts`:

```ts
export interface IDistributedLockProvider {
    acquireLock(id: string): Promise<boolean>;
    releaseLock(id: string): Promise<void>;
}
```

H3 uses this interface exactly as it already exists — `acquireLock(POLL_LEASE_KEY)` /
`releaseLock(POLL_LEASE_KEY)`. No method signature, no new method, no TTL parameter is added by this
spec. Therefore there is **no `IDistributedLockProvider` change to fan out to providers** in this item.

| Provider | Change required |
|---|---|
| memory (`SingleNodeLockProvider`, core) | None. Already returns `true`/`false` correctly; single process always wins (rule 8). |
| redis (C1) | None *for this interface*. C1 must, independently, give acquired locks a TTL `>= 3 × pollInterval` so the poll lease auto-expires if a holder dies (rule 10). Recorded here as a dependency note, not a new method. |
| azure (C1) | Same as redis: TTL backstop is C1's concern. |
| postgres / mongodb / mysql / sqlite | These are persistence providers, not lock providers — unaffected. |

> **Dependency on C1.** True multi-node behaviour (rules 9 & 10) is only realised once C1 ships a
> distributed `IDistributedLockProvider` whose `acquireLock` is genuinely cluster-wide and whose locks
> carry a TTL. Until C1 lands, H3 is correct and active but the only available lock provider is
> single-node, so the multi-node guarantee is vacuously satisfied (one node). H3 introduces **no** core
> interface change and so does not, by itself, force a provider PR.

## 8. Test plan (TDD)

Follow the existing scenario style in `core/spec/scenarios/` (see `basic-workflow.spec.ts`,
`schedule.spec.ts`): `configureWorkflow()` → `useLogger`/`usePersistence` → drive the worker → assert
via the `spinWait(until)` helper in `core/spec/helpers/spin-wait.ts`. (Note: the helper is named
`spinWait`; a callback-style variant `spinWaitCallback(until, done)` also exists in the same file —
prefer the promise-based `spinWait` as the other scenarios do.)

Because `PollWorker.process` is private and the contention we want to assert is *between poll workers*,
the test exercises the lease directly rather than spinning up N full hosts. Construct **one** shared
`SingleNodeLockProvider` and **one** shared `MemoryPersistenceProvider`, seed it with runnable
instances, then create N poller-like callers that each run the elected scan body against a **shared
counting queue provider**, and assert each runnable id is queued exactly once across all N pollers for
that cycle. A capturing `IQueueProvider` test double records every `queueForProcessing(id, type)` call.

### Failing-test-first

- **`poll lease — only one of N pollers queues each runnable id per cycle`** —
  - *arrange:* one shared `SingleNodeLockProvider`; one capturing queue double that appends every
    `queueForProcessing(id, QueueType.Workflow)` to an array; a persistence double whose
    `getRunnableInstances()` returns a fixed set of e.g. 50 ids and `getRunnableEvents()` returns `[]`.
    Wire all N=5 poll workers (via `configureWorkflow()` containers, or by directly newing `PollWorker`
    and injecting the shared doubles) to share the **same** lock provider and **same** queue double.
  - *act:* invoke the poll cycle on all 5 pollers concurrently (`Promise.all` of each worker's process
    cycle for one tick).
  - *assert:* the captured queue array has exactly 50 entries (one per id), every seeded id appears
    exactly once, and 4 of the 5 pollers logged/observed "lease held" (queued nothing).
  - *proves:* rules §6.3, §6.4, §6.9. **Must fail before the fix** — today `process` has no lease, so
    all 5 pollers queue all 50 ids → 250 captured entries.

### Coverage

- **`poll lease — single process always wins and polls every cycle`** — one poller, shared
  `SingleNodeLockProvider`; run two consecutive cycles; assert each cycle queued the full runnable set
  (lease acquired then released between cycles). *Proves §6.5, §6.8.*
- **`poll lease — lease is released after a cycle that throws`** — make `getRunnableInstances()` reject
  once; after the cycle, assert `lockProvider.acquireLock(POLL_LEASE_KEY)` returns `true` again (lease
  not stuck). *Proves §6.5, §6.6.*
- **`poll lease — event scan still runs when instance scan throws`** — `getRunnableInstances()` rejects,
  `getRunnableEvents()` returns 3 ids; assert those 3 event ids were still queued and the lease was
  released. *Proves §6.6.*
- **`config — default poll interval is 10000`** — `configureWorkflow()` with no args; resolve
  `TYPES.WorkflowOptions` from the container and assert `pollInterval === 10000`. *Proves §6.1.*
- **`config — invalid poll interval throws`** — `configureWorkflow({ pollInterval: 100 })` and
  `configureWorkflow({ pollInterval: 1.5 })` each throw; `configureWorkflow({ pollInterval: 5000 })`
  resolves to `5000`. *Proves §6.2.*
- **`config — acquire error skips cycle without releasing`** — lock provider double whose `acquireLock`
  rejects; assert nothing was queued and `releaseLock` was never called. *Proves §6.7.*

### How to run

```bash
cd core && yarn test                 # runs all jasmine scenarios incl. poll-worker-lease.spec.ts
cd core && yarn test 2>&1 | grep -i poll   # focus on the new scenario output
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd core && yarn test` passes on Node 20 and 22.
- [ ] The failing-test-first (`only one of N pollers queues each runnable id per cycle`) is red on the
      pre-fix tree and green after — with N=5 pollers and 50 runnable ids, the capturing queue records
      exactly 50 entries, each id once.
- [ ] `core/src/services/poll-worker.ts` no longer contains the string `//TODO: lock` nor the literal
      `10000`; the interval comes from `this.options.pollInterval`.
- [ ] `configureWorkflow({ pollInterval: 100 })` throws; `configureWorkflow()` yields a bound
      `WorkflowOptions` with `pollInterval === 10000`.
- [ ] After a cycle whose scan throws, the poll lease key is acquirable again (no stuck lease).
- [ ] No change to `IDistributedLockProvider`; no provider package is modified by this PR.

## 10. Backward compatibility & migration

- **Public API:** `configureWorkflow()` gains an **optional** parameter
  (`configureWorkflow(options?: Partial<WorkflowOptions>)`). All existing zero-arg call sites — including
  every `core/spec/scenarios/*.spec.ts` and the consumer `reactory-express-server` — continue to compile
  and behave identically (default 10000ms). This is a non-breaking, additive change.
- **New exports:** `WorkflowOptions`, `DEFAULT_POLL_INTERVAL`, `POLL_LEASE_KEY`, and
  `TYPES.WorkflowOptions` are added to the public surface (additive).
- **At-rest format:** unchanged.
- **`reactory-express-server` impact:** none required; may *optionally* pass `{ pollInterval }` to tune.
- **Version bump:** `2.3.6-reactory.3` → `2.3.6-reactory.4` (additive, non-breaking). Coordinate with
  the C1/H2/H4 series if they land together under a single bump.

## 11. Definition of Done

The poll worker no longer scans blindly on every node. Each poll cycle is gated behind a distributed
lease taken on a namespaced key via the existing `IDistributedLockProvider`: exactly one node per cycle
performs the runnable-instance and runnable-event scan-and-queue; the others skip cleanly; the winner
always releases the lease, even on error, with the provider TTL as the crash backstop. The poll interval
is a validated, defaulted (`10000`ms) config option on `configureWorkflow()`. On a single process the
node always wins the lease, so the Electron path is unchanged. No core interface changed, so no provider
PR is forced; the reviewer confirms the failing-test-first was real (5 pollers, 50 ids → 250 queued
before, 50 after) and that `core` builds and tests green on Node 20 + 22.

## 12. Implementation notes (optional, non-binding)

- The upstream `danielgerlag/workflow-es` `RunnablePoller` wraps its poll body in
  `lockProvider.acquireLock("poll-runnables")` / `releaseLock`. This spec mirrors that pattern; the key
  name differs only to namespace it.
- Suggested edit order: (1) create `workflow-options.ts` + add `TYPES.WorkflowOptions`; (2) wire
  `configureWorkflow` options + validation; (3) edit `poll-worker.ts`; (4) write the spec file last,
  starting with the failing test.
- The simplest way to make the failing-test-first independent of the host's timer is to test the
  elected-scan semantics through the shared lock + shared queue doubles rather than real `setInterval`
  timing. If you instead drive real hosts, give each its own `configureWorkflow()` container but
  `useLockManager(sharedLock)` and `useQueueManager(sharedQueue)` so they contend on one lease.
- Keep the two per-scan `try/catch` blocks; only the lease acquire/release and the interval source
  change. Do not refactor the loop bodies.
