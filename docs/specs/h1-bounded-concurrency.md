# Spec — H1 · Bounded concurrency / backpressure

| Field | Value |
|---|---|
| **Item ID** | H1 |
| **Title** | Bounded concurrency / backpressure |
| **Plan reference** | [`upgrade-plan.md` → H1](../upgrade-plan.md) |
| **Target** | Both (Cloud + Electron) |
| **Severity** | High |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | none (co-designed with H4 — this spec adds the in-flight tracking structure H4 reuses) |
| **Author / reviewer** | Werner Weber / — |

---

## 1. Context (self-contained)

The engine has two queue-draining background workers and one poll worker. Two of them
(`WorkflowQueueWorker`, `EventQueueWorker`) have an identical defect: they drain their queue in a
`while` loop and fire each item's processing routine **without awaiting it**, on a fixed
`setInterval`. There is no cap on how many executions run at once and no backpressure on the queue.

### Current code — `core/src/services/workflow-queue-worker.ts`

```ts
private processTimer: any;

public start() {
    this.processTimer = setInterval(this.processQueue, 100, this);   // line 28
}

public stop() {
    this.logger.log("Stopping workflow queue worker...");
    if (this.processTimer)
        clearInterval(this.processTimer);                            // line 34
}

private async processQueue(self: WorkflowQueueWorker): Promise<void> {        // line 37
    try {
        let workflowId = await self.queueProvider.dequeueForProcessing(QueueType.Workflow);
        while (workflowId) {
            self.logger.log("Dequeued workflow " + workflowId + " for processing");
            self.processWorkflow(self, workflowId)            // line 42 — NOT awaited
                .catch((err) => {
                    self.logger.error("Error processing workflow", workflowId, err);
                });
            workflowId = await self.queueProvider.dequeueForProcessing(QueueType.Workflow);
        }
    }
    catch (err) { /* ... */ }
}
```

### Current code — `core/src/services/event-queue-worker.ts`

Identical shape, with a 500ms interval (line 28: `setInterval(this.processQueue, 500, this)`) and
`processEvent` fired without `await` (line 42).

### Why this is wrong

1. **Unbounded concurrency.** If the queue has N runnable items, `processQueue` synchronously
   fires N concurrent `processWorkflow` promises in one tick. Each acquires a lock, reads the
   instance, executes steps, and persists — i.e. each holds DB/connection resources. N is
   unbounded, so a fan-out (e.g. 10 000 instances) spawns ~10 000 concurrent executions, exhausting
   the persistence provider's connection pool and saturating the event loop.
2. **Stacking timers.** `setInterval` re-fires `processQueue` every 100ms regardless of whether the
   previous invocation has finished. Because `processQueue` itself does not await the per-item work,
   and because the dequeue loop can take longer than the interval under load, multiple
   `processQueue` runs overlap and compound the concurrency problem.
3. **No backpressure.** The worker keeps dequeuing as fast as the queue yields IDs; it never pauses
   when it is already saturated. Items are pulled off the queue and turned into in-flight promises
   even when the process cannot keep up.
4. **No observable in-flight set.** Nothing tracks which executions are currently running.
   H4 (graceful drain) needs exactly this set to await on shutdown; today it cannot, which is why
   H4 depends on H1.

### User-visible impact

Under bursty load the runner exhausts DB connections (errors, timeouts), the event loop stalls
(latency spikes, missed timers), and on shutdown in-flight work is silently abandoned. Throughput is
erratic rather than steady.

## 2. Goal

After this change, each of the two queue workers runs a **bounded worker pool**: it processes at
most a configured number of items concurrently (`maxConcurrentWorkflows` / `maxConcurrentEvents`),
applies backpressure by not dequeuing beyond available capacity, and drives itself with a
**self-rescheduling `setTimeout`** that is armed only *after* a poll cycle completes — never a
stacking `setInterval`. Each worker exposes a queryable, live set of in-flight item IDs (and a count)
so H4 can await drain. Default capacities preserve roughly today's working magnitude while putting a
hard ceiling on resource use. The single-process / Electron path keeps working with zero external
infrastructure.

## 3. Out of scope

- **Do NOT** change `PollWorker` (`core/src/services/poll-worker.ts`). Its lease/interval work is H3.
  This spec only touches the two *queue* workers.
- **Do NOT** implement the graceful-drain `stop()` semantics (awaiting in-flight work, SIGTERM,
  Electron quit). That is H4. This spec only *exposes* the in-flight set H4 will consume; `stop()`
  here must still stop intake and clear the timer, and must be safe to call repeatedly, but it does
  **not** await in-flight executions.
- **Do NOT** change the lock-release / post-processing ordering inside `processWorkflow` /
  `processEvent` (the `finally` blocks, subscription creation, re-queue decisions). That is H2.
  Preserve the existing body of those methods verbatim except for in-flight bookkeeping wrappers.
- **Do NOT** change any persistence, queue, or lock provider, or any provider package. No core
  interface that providers implement changes (see §7).
- **Do NOT** change `IQueueProvider`, `QueueType`, or the dequeue/queue contract.
- **Do NOT** change the public `configureWorkflow()` *signature* (it stays zero-arg); add
  configuration via a new method on `WorkflowConfig` and a config object (see §5).
- **Do NOT** add new runtime dependencies. Use built-in `setTimeout`, `Promise`, `Set`/`Map` only.

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/worker-config.ts` | create | New `WorkerPoolConfig` interface + `defaultWorkerPoolConfig` constant (config object holding the caps and intervals). |
| `core/src/abstractions/background-worker.ts` | modify | Extend `IBackgroundWorker` with an in-flight introspection contract (`getActiveCount()`, `getActiveIds()`) that both queue workers implement and H4 consumes. |
| `core/src/abstractions.ts` | modify | Add `export * from "./abstractions/worker-config";` to the barrel. |
| `core/src/services/workflow-queue-worker.ts` | modify | Replace `setInterval` + unbounded fire-and-forget with a bounded pool + self-rescheduling `setTimeout`; track in-flight IDs. |
| `core/src/services/event-queue-worker.ts` | modify | Same change for the event worker. |
| `core/src/config.ts` | modify | Inject the `WorkerPoolConfig` value into the container; add `WorkflowConfig.useWorkerPoolConfig(...)`; pass config into worker construction. |
| `core/spec/scenarios/bounded-concurrency.spec.ts` | create | New scenario test (burst of instances, assert cap never exceeded, throughput stable). See §8. |
| `docs/upgrade-plan.md` | modify | Flip H1 status `planned → spec` in the §3 roadmap table (status bookkeeping only). |

> Note: there is no `core/src/abstractions/index.ts`; the barrel is the single file
> `core/src/abstractions.ts`. The DI symbol table is `core/src/abstractions/types.ts` (`TYPES`).
> The services barrel is `core/src/services.ts`.

## 5. Interface & data-model changes

### 5.1 New config object — `core/src/abstractions/worker-config.ts` (create)

```ts
// AFTER (new file)

/**
 * Tuning for the bounded queue-worker pools. One shared object is bound in the
 * container under TYPES.WorkerPoolConfig and consumed by both queue workers.
 * All values are positive integers (milliseconds for intervals, item counts for caps).
 */
export interface WorkerPoolConfig {
    /** Max workflow executions running concurrently in WorkflowQueueWorker. Must be >= 1. */
    maxConcurrentWorkflows: number;
    /** Max event seedings running concurrently in EventQueueWorker. Must be >= 1. */
    maxConcurrentEvents: number;
    /**
     * Delay (ms) before the workflow worker re-polls the queue after a poll cycle
     * finds nothing OR completes. Replaces the old setInterval(…,100). Must be >= 1.
     */
    workflowPollIntervalMs: number;
    /**
     * Delay (ms) before the event worker re-polls the queue after a poll cycle
     * finds nothing OR completes. Replaces the old setInterval(…,500). Must be >= 1.
     */
    eventPollIntervalMs: number;
}

export const defaultWorkerPoolConfig: WorkerPoolConfig = {
    maxConcurrentWorkflows: 10,
    maxConcurrentEvents: 20,
    workflowPollIntervalMs: 100,   // unchanged from the old setInterval value
    eventPollIntervalMs: 500,      // unchanged from the old setInterval value
};
```

**Default justification.**
- `maxConcurrentWorkflows = 10`: a sane ceiling that fits the default connection-pool sizes of the
  SQL/Mongo providers (typically 10) and keeps the event loop responsive, while still allowing
  meaningful parallelism. Today the code is *unbounded*; capping at 10 is strictly safer and is the
  documented behavioural change (see §10). Operators with a larger pool raise it via config.
- `maxConcurrentEvents = 20`: event seeding is lighter than full workflow execution (it touches
  subscriptions/pointers, not full step bodies), so a higher cap is reasonable; keep it ≥ workflow
  cap so event fan-in does not become the bottleneck.
- `workflowPollIntervalMs = 100` / `eventPollIntervalMs = 500`: identical to the current
  `setInterval` periods, so idle-poll cadence is unchanged. The semantic difference (rule §6.3) is
  that the timer is now armed *after* a cycle finishes, not on a fixed wall-clock interval.

### 5.2 DI symbol — `core/src/abstractions/types.ts` (modify)

```ts
// BEFORE
let TYPES = {
    IWorkflowRegistry: Symbol("IWorkflowRegistry"),
    // ...
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory")
};

// AFTER
let TYPES = {
    IWorkflowRegistry: Symbol("IWorkflowRegistry"),
    // ...
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory"),
    WorkerPoolConfig: Symbol("WorkerPoolConfig")
};
```

### 5.3 `IBackgroundWorker` — `core/src/abstractions/background-worker.ts` (modify)

```ts
// BEFORE
export interface IBackgroundWorker {
    start(): void;
    stop(): void;
}

// AFTER
export interface IBackgroundWorker {
    start(): void;
    stop(): void;
    /**
     * Number of items this worker is currently executing (in-flight). Workers that do
     * not maintain a pool (e.g. PollWorker) return 0. Consumed by H4 graceful drain.
     */
    getActiveCount(): number;
    /**
     * Snapshot (copy) of the item IDs currently in flight. Workers without a pool
     * return an empty array. Must be a copy, not the live set.
     */
    getActiveIds(): string[];
}
```

> Because `IBackgroundWorker` gains two methods, **all three** core worker implementations must
> implement them (`PollWorker` returns `0` / `[]` — it is out of scope to give it a pool here).
> `PollWorker` is touched only to add these two trivial members so it still satisfies the interface.
> This is a *core-internal* interface (not a provider interface) — see §7.

### 5.4 In-flight tracking structure (the H4-reused data structure)

Each queue worker holds:

```ts
private active: Set<string> = new Set<string>();  // IDs currently being processed
```

Contract:
- An ID is added to `active` immediately before its `processWorkflow` / `processEvent` promise is
  created, and removed in that promise's `.finally(...)` (so it is removed on both success and
  failure). The add/remove must bracket the *entire* per-item promise including its `catch`.
- `getActiveCount()` returns `this.active.size`.
- `getActiveIds()` returns `Array.from(this.active)` (a copy).
- `active.size` is the single source of truth for capacity: a worker may dequeue/start a new item
  only while `active.size < cap`.

### 5.5 `WorkflowConfig` / `configureWorkflow` — `core/src/config.ts` (modify)

`configureWorkflow()` stays zero-arg. Add a bound default and a setter:

```ts
// In the ContainerModule passed to container.load(...), add:
bind<WorkerPoolConfig>(TYPES.WorkerPoolConfig).toConstantValue(defaultWorkerPoolConfig);

// New method on WorkflowConfig:
public useWorkerPoolConfig(config: Partial<WorkerPoolConfig>) {
    const merged: WorkerPoolConfig = { ...defaultWorkerPoolConfig, ...config };
    // validate: every numeric field must be a finite number >= 1; throw Error otherwise.
    this.container.rebind<WorkerPoolConfig>(TYPES.WorkerPoolConfig).toConstantValue(merged);
}
```

Each queue worker injects it:

```ts
@inject(TYPES.WorkerPoolConfig)
private poolConfig: WorkerPoolConfig;
```

Validation rule for `useWorkerPoolConfig`: for each of the four fields in the merged object, if it is
not a finite number `>= 1`, throw `new Error("WorkerPoolConfig.<field> must be a finite number >= 1")`.

## 6. Behavioural contract (numbered rules)

For **each** of `WorkflowQueueWorker` and `EventQueueWorker` (substitute the matching cap/interval):

1. **Never exceed the cap.** At no instant may the number of in-flight executions
   (`active.size`) exceed the configured cap (`maxConcurrentWorkflows` / `maxConcurrentEvents`).
   A poll cycle dequeues-and-starts items only while `active.size < cap`; the moment the cap is
   reached it stops dequeuing for that cycle. (Test §8 failing-test-first.)
2. **Backpressure — do not dequeue beyond capacity.** The worker must not pull an ID off the queue
   that it cannot immediately start. Concretely: the dequeue loop's guard is `active.size < cap`; if
   capacity is full the worker performs no further `dequeueForProcessing` call this cycle and leaves
   pending items on the queue. (Today it dequeues until the queue is empty regardless of load — that
   is the defect.)
3. **Self-reschedule via `setTimeout` after completion; no stacked timers.** The worker drives
   itself with `setTimeout`, not `setInterval`. Exactly one timer handle exists at a time. The next
   poll cycle is armed only when the current cycle's *dequeue-and-dispatch* phase returns (i.e. at
   the end of `processQueue`), using the configured interval. A new cycle is never armed while one is
   already scheduled or running. (Note: the cycle awaits the *dequeue* I/O but does **not** await the
   per-item execution promises — those run in the pool; rearming does not wait for them to finish.)
4. **Capacity frees up promptly.** When an in-flight execution settles (resolve or reject), its ID is
   removed from `active` in a `.finally`, freeing a slot. If after freeing a slot there is queued
   work, it will be picked up by the next scheduled poll cycle (no busy-wait; correctness does not
   depend on immediate pickup, only on the next `setTimeout` cycle). The per-item `.catch` that logs
   errors (existing behaviour) is preserved and runs before/within the `.finally`.
5. **In-flight set is queryable.** `getActiveCount()` and `getActiveIds()` reflect the live set at
   call time. `getActiveIds()` returns a copy (mutating it must not affect the worker). When idle,
   `getActiveCount() === 0` and `getActiveIds()` is `[]`.
6. **Idempotent / safe lifecycle.** `start()` arms the first poll cycle once; calling `start()` when
   already started must not create a second timer chain. `stop()` clears the pending `setTimeout` and
   prevents any further cycle from being armed; calling `stop()` repeatedly, or before `start()`, is
   a no-op and never throws. (Awaiting in-flight work on stop is H4 and explicitly out of scope —
   §3.)
7. **No behavioural change to per-item processing.** The bodies of `processWorkflow` /
   `processEvent` (lock acquire/release ordering, instance load, execute, persist, subscription
   handling, re-queue) are unchanged. Only the *scheduling and bookkeeping* around them change.
8. **Error isolation.** A failure dequeuing (the `dequeueForProcessing` call) or in one item's
   processing must not abort the worker or the other in-flight items, and must not leak a slot
   (`active` entry removed in `finally`). The next cycle is still armed (rule §6.3) so the worker
   self-heals.
9. **Functional parity.** All existing scenario specs in `core/spec/scenarios/` continue to pass
   unchanged (they assert completion, not concurrency). The cap must be high enough by default, and
   the self-rescheduling cadence equal enough to the old interval, that these complete within their
   existing `jasmine.DEFAULT_TIMEOUT_INTERVAL`.

## 7. Provider parity

No provider-facing interface changes. `IBackgroundWorker` is a **core-internal** abstraction — the
only implementers are `WorkflowQueueWorker`, `EventQueueWorker`, and `PollWorker`, all inside
`core/src/services`. No provider package implements `IBackgroundWorker`, `IQueueProvider`, or the new
`WorkerPoolConfig`. `IPersistenceProvider`, `IDistributedLockProvider`, and `IQueueProvider` are
untouched.

| Provider | Change required |
|---|---|
| memory (core) | none |
| sqlite | none |
| postgres | none |
| mongodb | none |
| mysql | none |
| redis | none |
| azure | none |

**No core interface change that providers implement; no provider impact.** This work need not land
with any provider change.

## 8. Test plan (TDD)

Use Jasmine (the repo's runner). Tests compile from `core/spec/**` to `build/spec/**` (see
`core/spec/support/jasmine.json`) and run with `yarn test` (which runs `npm run build` first via
`pretest`). Follow the structure of `core/spec/scenarios/foreach.spec.ts` and use the `spinWait`
helper from `core/spec/helpers/spin-wait.ts`.

New file: `core/spec/scenarios/bounded-concurrency.spec.ts`.

### Test fixture

- Define a workflow `Concurrency_Workflow` (id `"bounded-concurrency-workflow"`, version 1) whose
  single/first step body, on `run`, does the following before returning `ExecutionResult.next()`:
  1. increment a shared module-level `currentlyRunning` counter and update
     `maxObservedConcurrency = Math.max(maxObservedConcurrency, currentlyRunning)`;
  2. `await` a short delay (e.g. `await new Promise(r => setTimeout(r, 50))`) so executions overlap
     in time and the cap is actually exercised;
  3. decrement `currentlyRunning`;
  4. increment a shared `completedCount`.
- Configure the host with `MemoryPersistenceProvider` and set a **small** cap to make the assertion
  sharp: `config.useWorkerPoolConfig({ maxConcurrentWorkflows: 3 })`.
- Set `jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000` (the burst takes time at cap 3).

### Failing-test-first

- **`should never exceed the configured concurrency cap`** — *arrange:* register
  `Concurrency_Workflow`, start host, set `maxConcurrentWorkflows: 3`. *act:* start a burst of
  instances in a loop (use **200** instances for CI speed — large enough to force the cap, small
  enough to finish quickly; the spec's 10k acceptance figure is the production target, 200 is the
  unit-test proxy — see §9 note), then `await spinWait(async () => completedCount === 200)`.
  *assert:* `expect(maxObservedConcurrency).toBeLessThanOrEqual(3)` and
  `expect(completedCount).toBe(200)`. **Proves rule §6.1/§6.2.** This *must fail before the fix*:
  against the current `setInterval` + fire-and-forget code, `maxObservedConcurrency` will be far
  greater than 3 (it will approach 200), so the `toBeLessThanOrEqual(3)` assertion fails.

### Coverage

- **`should drain the whole burst to completion`** — asserts `completedCount === 200` and every
  instance reaches `WorkflowStatus.Complete` (sample a few via
  `persistence.getWorkflowInstance(id)`). Proves rule §6.4/§6.8 (no slot leak; self-heals; all work
  eventually runs). Reuse the same `beforeAll` burst as above.
- **`should expose the in-flight set while running and empty it when idle`** — *arrange:* a fresh
  host with cap 3 and a workflow whose step blocks on a manually-resolved promise (a "gate") so you
  can observe mid-flight. *act:* start ~5 instances; *assert (while gate closed):*
  the workflow worker's `getActiveCount()` is `> 0` and `<= 3`, and `getActiveIds().length` equals
  `getActiveCount()`; then open the gate and `spinWait` until `getActiveCount() === 0` and
  `getActiveIds()` is `[]`. Proves rule §6.5. (Obtain the worker via the container:
  `config.getContainer().getAll(TYPES.IBackgroundWorker)` and pick the `WorkflowQueueWorker`
  instance, or expose a test accessor — keep the accessor in the spec, not in production code.)
- **`should arm at most one timer and self-reschedule (no stacked setInterval)`** — *arrange:* spy
  on / count timer arming. Simplest robust form: assert that after the burst completes and the host
  is idle, `getActiveCount()` stays `0` across two poll intervals and the process does not spin
  (`completedCount` does not change). Proves rule §6.3/§6.6. If a tighter assertion is wanted, inject
  a fake clock is out of scope; the idle-stability check is sufficient.
- **`existing scenarios still pass`** — no new code; running the full suite (`basic-workflow`,
  `foreach`, `parallel`, `delay`, `schedule`, `saga-compensation`, `external-events`, etc.) green
  proves rule §6.7/§6.9.

### How to run

```bash
cd core && yarn test                       # builds then runs all Jasmine specs
# single file after a build:
cd core && yarn build && npx jasmine build/spec/scenarios/bounded-concurrency.spec.js
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd core && yarn test` passes on Node 20 and 22.
- [ ] The new spec's `should never exceed the configured concurrency cap` test:
      (a) **fails** when run against the pre-fix worker code (demonstrated in the PR description /
      history), and (b) **passes** after the fix, with `maxObservedConcurrency <= 3`.
- [ ] All pre-existing `core/spec/scenarios/*.spec.ts` pass unchanged.
- [ ] `WorkflowQueueWorker` and `EventQueueWorker` contain **no** `setInterval`; both use
      `setTimeout` self-rescheduling. (Grep: `grep -rn "setInterval" core/src/services/workflow-queue-worker.ts core/src/services/event-queue-worker.ts` returns nothing.)
- [ ] `IBackgroundWorker.getActiveCount()`/`getActiveIds()` exist and are implemented by all three
      workers; `getActiveIds()` returns a copy.
- [ ] No provider package is modified (see §7).

> Note on the 10k figure: the upgrade plan's acceptance language ("under a 10k-instance burst")
> describes the production load target. For the automated unit test we use 200 instances at a cap of
> 3 as a fast, deterministic proxy that proves the identical property (cap never exceeded, full
> drain, stable throughput). A 10k run is appropriate for a manual/perf check, not the CI unit suite;
> the implementer should keep the test count small for CI but MAY parameterise it.

## 10. Backward compatibility & migration

- **Public API:** *additive.* `configureWorkflow()` keeps its zero-arg signature. New surface:
  `WorkflowConfig.useWorkerPoolConfig(config: Partial<WorkerPoolConfig>)`, the exported
  `WorkerPoolConfig` interface, and `defaultWorkerPoolConfig`. Existing consumers
  (`reactory-express-server`, which integrates via a `file:` tarball) compile and run unchanged.
- **Behavioural change (documented, intentional):** previously concurrency was *unbounded*; it is now
  capped (default 10 workflows / 20 events). This is a deliberate ceiling. The default magnitude is
  chosen to match common provider pool sizes; consumers that genuinely relied on more parallelism
  raise the cap with `useWorkerPoolConfig`. Idle poll cadence (100ms / 500ms) is unchanged, so
  latency for low load is unaffected.
- **At-rest format:** no change. Nothing new is persisted; `WorkerPoolConfig` is process-local
  runtime config only.
- **Version bump:** `2.3.6-reactory.3 → 2.3.6-reactory.4` (additive public API + behavioural ceiling;
  no breaking signature or format change). Add a one-line note to the package CHANGELOG/README that
  worker concurrency is now bounded and configurable.

## 11. Definition of Done

Both queue workers run as bounded pools driven by a self-rescheduling `setTimeout`: under a burst,
concurrent executions never exceed the configured cap (default 10 workflows / 20 events), the queue
is back-pressured rather than fully drained into memory, timers never stack, and each worker exposes
a live, queryable in-flight set (`getActiveCount`/`getActiveIds`) for H4 to drain. The change is
additive to the public API, introduces no provider changes, and all existing scenario specs plus the
new `bounded-concurrency.spec.ts` (whose cap-assertion failed before the fix) pass on the Node 20+22
CI matrix. The single-process / Electron path still runs with zero external infrastructure.

## 12. Implementation notes (optional, non-binding)

Suggested `processQueue` shape (workflow worker; event worker mirrors it):

```ts
private async processQueue(self: WorkflowQueueWorker): Promise<void> {
    if (self.stopped) return;
    try {
        // backpressure: only dequeue while we have spare capacity (rule §6.1/§6.2)
        while (self.active.size < self.poolConfig.maxConcurrentWorkflows) {
            const workflowId = await self.queueProvider.dequeueForProcessing(QueueType.Workflow);
            if (!workflowId) break;                       // queue empty this cycle
            self.active.add(workflowId);                   // reserve the slot BEFORE awaiting work
            self.processWorkflow(self, workflowId)
                .catch((err) => self.logger.error("Error processing workflow", workflowId, err))
                .finally(() => self.active.delete(workflowId));   // free slot, success or fail (rule §6.4/§6.8)
        }
    }
    catch (err) {
        self.logger.error("Error processing workflow queue: " + toError(err).message);
    }
    finally {
        self.scheduleNext();   // arm exactly one setTimeout (rule §6.3)
    }
}

private scheduleNext() {
    if (this.stopped) return;
    this.processTimer = setTimeout(() => this.processQueue(this), this.poolConfig.workflowPollIntervalMs);
}

public start() {
    this.stopped = false;
    this.scheduleNext();        // single chain (rule §6.6); guard against double-start
}

public stop() {
    this.stopped = true;
    if (this.processTimer) { clearTimeout(this.processTimer); this.processTimer = undefined; }
}
```

Gotchas:
- Reserve the slot (`active.add`) **before** the `await` that starts the work, or two iterations can
  both see spare capacity and overshoot the cap (rule §6.1).
- Keep `processWorkflow` / `processEvent` bodies byte-for-byte unchanged except that you no longer
  attach `.catch` *inside* them — the dispatcher attaches `.catch`/`.finally`. (The existing inner
  try/catch in those methods stays; the outer `.catch` on the call site moves into the dispatcher
  chain.)
- Add a `private stopped: boolean = false;` and `private processTimer: any;` to each worker.
- `PollWorker` only needs `getActiveCount(){return 0;}` and `getActiveIds(){return [];}` to satisfy
  the widened interface — do not give it a pool here (that is H3).
- Upstream `danielgerlag/workflow-es` later versions use a comparable "queue worker with a
  configurable `maxConcurrentItems` and `setTimeout` reschedule" pattern; this is the same idea.
