# Spec — H4 · Async graceful drain; SIGTERM + Electron quit handling

| Field | Value |
|---|---|
| **Item ID** | H4 |
| **Title** | Async graceful drain; SIGTERM + Electron quit handling |
| **Plan reference** | [`upgrade-plan.md` → H4](../upgrade-plan.md) |
| **Target** | Both |
| **Severity** | High |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | H1 (provides the tracked in-flight execution set) |
| **Author / reviewer** | claude / wweber |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` runs a `WorkflowHost` that owns three background workers
(`WorkflowQueueWorker`, `EventQueueWorker`, `PollWorker`). Each worker drives a `setInterval`
timer and, on each tick, dequeues IDs and fires processing **without awaiting** the resulting
promise. Shutdown today is synchronous and incomplete. There are four concrete defects.

**Defect 1 — `stop()` only clears timers; in-flight executions are abandoned.**
`WorkflowHost.stop()` is synchronous and just loops over workers calling `worker.stop()`:

```ts
// core/src/services/workflow-host.ts:43-49
public stop() {
    this.logger.log("Stopping workflow host...");
    for (let worker of this.workers) {
        worker.stop();
    }
}
```

Each worker's `stop()` only calls `clearInterval`:

```ts
// core/src/services/workflow-queue-worker.ts:31-35
public stop() {
    this.logger.log("Stopping workflow queue worker...");
    if (this.processTimer)
        clearInterval(this.processTimer);
}
```

But `processQueue` fires `processWorkflow` fire-and-forget (the promise is only `.catch`-ed,
never awaited):

```ts
// core/src/services/workflow-queue-worker.ts:42-45
self.processWorkflow(self, workflowId)
    .catch((err) => {
        self.logger.error("Error processing workflow", workflowId, err);
    });
```

So when `stop()` returns, any `processWorkflow`/`processEvent` promise that is mid-flight keeps
running detached. If the process exits immediately after `stop()` (the normal shutdown path),
that in-flight execution is killed mid-step: it may have **acquired a distributed lock that is
never released** (`acquireLock(workflowId)` … `releaseLock(workflowId)` in the `finally`) and may
leave **partial, un-persisted state**. On the next start (or on another node) the instance is
either locked-out until the lock TTL expires or resumes from an inconsistent pointer.

**Defect 2 — Only `SIGINT` is handled.** Cleanup is wired to `SIGINT` only:

```ts
// core/src/services/workflow-host.ts:175-183
private registerCleanCallbacks() {
    let self = this;
    if (typeof process !== 'undefined' && process) {
        process.on('SIGINT', () => {
            self.stop();
        });
    }
}
```

Cloud orchestrators (Kubernetes, ECS, systemd) send **`SIGTERM`** on rollout/scale-down, which is
not handled — the pod is hard-killed after the grace period with executions still running.
Electron desktop apps send **neither** signal on window-close/quit; they emit `app.on('before-quit')`
/ `app.on('will-quit')` events, which the engine has no hook for.

**Defect 3 — The signal handler stacks and is never removed.** `registerCleanCallbacks()` calls
`process.on('SIGINT', …)` every time a host is started, and nothing ever calls
`process.removeListener`. Creating and starting N hosts in one process (common in test suites —
every scenario file builds its own host) registers N SIGINT handlers that all fire on one signal,
and they survive after `stop()`. This also trips Node's `MaxListenersExceededWarning`.

**Defect 4 — `stop()` is not idempotent / not awaitable.** `stop()` returns `void`, so callers
cannot await the drain. Calling it twice (e.g. a SIGTERM followed by an explicit `host.stop()`)
re-runs the teardown against already-stopped workers.

**User-visible impact.** Cloud deploys drop in-flight work and orphan locks on every rollout;
Electron apps never shut the engine down cleanly; test suites leak signal handlers and timers.

> **Coupling with H1.** A correct drain requires the workers to expose the *set of currently
> in-flight executions* so `stop()` can await them. H1 (bounded concurrency) introduces exactly
> that tracked in-flight set as part of its worker-pool rework. This spec **defines the in-flight
> tracking set and the `drain()` contract**, and H1 must build its concurrency cap on top of the
> same set (single source of truth — do not introduce a second, parallel set). H4 is implemented
> after H1 so the set already exists; if H1 is not yet `done`, the implementer adds the minimal
> in-flight `Set<Promise<void>>` described in §5 and H1 later reuses it.

## 2. Goal

After this change, `IWorkflowHost.stop()` and `IBackgroundWorker.stop()` both return
`Promise<void>` and perform a **graceful drain**: they first stop accepting new work (stop the
timer / intake loop), then **await every in-flight execution** up to a configurable timeout
(`gracefulShutdownTimeoutMs`, default `30000`), then resolve. If the timeout elapses, the drain
force-completes and returns (it does not hang forever), leaving any still-running execution to its
own lock `finally` blocks. Signal handlers for **both `SIGTERM` and `SIGINT`** are registered
**exactly once** when the host starts and **removed** when it stops. `stop()` is **idempotent**: a
second call resolves immediately. A documented `requestStop()`/`stop()` method exists for Electron
consumers to call from `app.on('before-quit')`. No held lock is leaked for executions that finish
inside the timeout; no `setInterval`/`setTimeout` timer survives a completed `stop()`.

## 3. Out of scope

- **Do NOT change the bounded-concurrency / worker-pool mechanics** (that is H1). This spec only
  *consumes* the in-flight set; it does not add a concurrency cap or change the `setInterval`
  cadence into a self-rescheduling loop. If H1 has not landed, add only the minimal in-flight set.
- **Do NOT change the lock-release ordering or post-processing** inside `processWorkflow` /
  `processEvent` (that is H2). Drain must await the existing promise as-is.
- **Do NOT change `PollWorker`'s polling logic or add the poll lease** (that is H3).
- **Do NOT add new persistence/lock/queue provider methods.** No `IPersistenceProvider`,
  `IDistributedLockProvider`, or `IQueueProvider` change.
- **Do NOT add an Electron dependency** to `core`. The Electron hook is a plain method consumers
  call; `core` must not `import('electron')` or reference `app`.
- **Do NOT change `start()`'s return type** (it is already `Promise<void>`).
- Do not introduce OpenTelemetry/health hooks (M5) or structured logging (M4).

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/background-worker.ts` | modify | `stop()` → `Promise<void>`. |
| `core/src/abstractions/workflow-host.ts` | modify | `stop()` → `Promise<void>`; add `requestStop()` doc alias if chosen (see §6.8). |
| `core/src/services/workflow-host.ts` | modify | Make `stop()` async + idempotent; await all `worker.stop()`; register/remove SIGTERM+SIGINT once; expose Electron hook. |
| `core/src/services/workflow-queue-worker.ts` | modify | Track in-flight `processWorkflow` promises; `stop()` async: stop intake, await in-flight with timeout. |
| `core/src/services/event-queue-worker.ts` | modify | Same drain treatment for `processEvent`. |
| `core/src/services/poll-worker.ts` | modify | `stop()` async; clear timer and await any in-flight `process` tick. |
| `core/src/config.ts` | modify | Thread `gracefulShutdownTimeoutMs` config to the host/workers (see §5 DI). |
| `core/src/abstractions/index.ts` | modify (only if a new exported type/symbol is added) | Export any new config shape. |
| `core/spec/scenarios/graceful-shutdown.spec.ts` | create | Tests for §8. |

> The implementer must confirm by grep that no other file calls `worker.stop()` or relies on
> `IBackgroundWorker.stop()`/`IWorkflowHost.stop()` returning `void`. Search:
> `grep -rn "\.stop(" core/src core/spec providers`.

## 5. Interface & data-model changes

### `IBackgroundWorker.stop()` → async

```ts
// BEFORE — core/src/abstractions/background-worker.ts
export interface IBackgroundWorker {
    start(): void;
    stop(): void;
}

// AFTER
export interface IBackgroundWorker {
    start(): void;
    /**
     * Stop intake immediately, then await all in-flight work for up to
     * `timeoutMs`. Resolves when drained or when the timeout elapses,
     * whichever comes first. MUST be idempotent.
     * @param timeoutMs upper bound on the drain wait, in milliseconds.
     */
    stop(timeoutMs: number): Promise<void>;
}
```

> `stop` takes the timeout as an explicit argument so the host owns the single configured value
> and passes it down; workers do not each read config. (Alternative considered: no argument, each
> worker reads config — rejected because it duplicates the source of truth.)

### `IWorkflowHost.stop()` → async

```ts
// BEFORE — core/src/abstractions/workflow-host.ts
export interface IWorkflowHost {
    start(): Promise<void>;
    stop(): void;
    startWorkflow(id: string, version: number, data: any): Promise<string>;
    registerWorkflow<TData>(workflow: new () => WorkflowBase<TData>): void;
    publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void>;
    suspendWorkflow(id: string): Promise<boolean>;
    resumeWorkflow(id: string): Promise<boolean>;
    terminateWorkflow(id: string): Promise<boolean>;
}

// AFTER
export interface IWorkflowHost {
    start(): Promise<void>;
    /**
     * Graceful shutdown. Stops intake on all workers, awaits in-flight
     * executions up to the configured `gracefulShutdownTimeoutMs`, removes
     * registered process signal handlers, and resolves. Idempotent: a second
     * call resolves immediately. Safe to call from an Electron
     * `app.on('before-quit')` handler.
     */
    stop(): Promise<void>;
    startWorkflow(id: string, version: number, data: any): Promise<string>;
    registerWorkflow<TData>(workflow: new () => WorkflowBase<TData>): void;
    publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void>;
    suspendWorkflow(id: string): Promise<boolean>;
    resumeWorkflow(id: string): Promise<boolean>;
    terminateWorkflow(id: string): Promise<boolean>;
}
```

> No separate `requestStop()` method is added to the interface — `stop()` is already the
> Electron-safe entry point (it is async and idempotent). See §6.8 for the documented Electron
> usage. (Alternative considered: a distinct `requestStop()` returning a "shutting down"
> observable — rejected as over-engineered for this item.)

### In-flight tracking set (couples with H1)

Each queue worker maintains a set of the promises it has started but not yet settled. This is the
set H4's drain awaits and the set H1's concurrency cap counts against — **one set, shared
purpose**.

```ts
// core/src/services/workflow-queue-worker.ts (illustrative, in WorkflowQueueWorker)
// BEFORE: no tracking; promise is fire-and-forget
self.processWorkflow(self, workflowId)
    .catch((err) => { self.logger.error("Error processing workflow", workflowId, err); });

// AFTER: track the promise; self-remove on settle; a `shuttingDown` flag gates intake
private inFlight: Set<Promise<void>> = new Set();
private shuttingDown: boolean = false;

// inside processQueue's dequeue loop:
if (self.shuttingDown) break;                 // stop pulling new work once draining
const p = self.processWorkflow(self, workflowId)
    .catch((err) => { self.logger.error("Error processing workflow", workflowId, err); })
    .finally(() => { self.inFlight.delete(p); });
self.inFlight.add(p);
```

`EventQueueWorker` mirrors this for `processEvent`. `PollWorker` has at most one in-flight
`process(self)` tick; it tracks that single promise (a `Set` of size ≤ 1 is acceptable, or a
single nullable `currentTick: Promise<void> | null`).

The shared `stop(timeoutMs)` body on each worker:

```ts
public async stop(timeoutMs: number): Promise<void> {
    if (this.shuttingDown) {                 // idempotency guard
        // already draining/drained — await the same drain
        await this.drainPromise ?? Promise.resolve();
        return;
    }
    this.shuttingDown = true;
    if (this.processTimer) {                 // 1) stop intake
        clearInterval(this.processTimer);
        this.processTimer = null;
    }
    // 2) await in-flight, but no longer than timeoutMs
    this.drainPromise = Promise.race([
        Promise.allSettled(Array.from(this.inFlight)),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]).then(() => undefined);
    await this.drainPromise;
}
```

> The `setTimeout` used for the race MUST be cleared if the drain wins, OR (simpler and acceptable
> here) be `.unref()`-ed so it never keeps the process alive. Choose `.unref()`; the timer object
> is local and unreferenced after the race settles. This satisfies the "no orphaned timers" rule.

### DI / config impact

`configureWorkflow()` currently takes **no arguments** (`core/src/config.ts:38`) and there is no
config object threaded to the host. Add the drain timeout as follows, with **the smallest viable
surface**:

```ts
// AFTER — core/src/config.ts (signature)
export interface WorkflowOptions {
    /** Max time (ms) stop() waits for in-flight executions to drain. Default 30000. */
    gracefulShutdownTimeoutMs?: number;
}

export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30000;

export function configureWorkflow(options?: WorkflowOptions): WorkflowConfig { ... }
```

Bind the resolved value as a constant the host can inject:

```ts
// inside the ContainerModule
const gracefulShutdownTimeoutMs =
    options?.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;
bind<number>(TYPES.GracefulShutdownTimeoutMs).toConstantValue(gracefulShutdownTimeoutMs);
```

Add `GracefulShutdownTimeoutMs: Symbol("GracefulShutdownTimeoutMs")` to `TYPES` (in
`core/src/abstractions`, wherever `TYPES` is declared — grep `TYPES =` to find it). The host
injects it via `@inject(TYPES.GracefulShutdownTimeoutMs) private gracefulShutdownTimeoutMs: number`
and passes it to each `worker.stop(this.gracefulShutdownTimeoutMs)`.

- **Validation:** if `gracefulShutdownTimeoutMs` is provided and is `< 0` or not finite, fall back
  to the default and `logger.log` a warning. `0` is permitted and means "do not wait — force stop
  immediately".
- **Backward compatibility:** `configureWorkflow()` with no args keeps working (default 30000).

### Persisted / at-rest format impact

None. No change to anything written to a provider.

## 6. Behavioural contract (numbered rules)

1. **Stop intake first.** On `stop()`, every worker MUST stop accepting new work *before* awaiting
   drain: set `shuttingDown = true`, `clearInterval` the timer, and break out of any active
   dequeue loop so no new `processWorkflow`/`processEvent` is started. (Proven by §8 "no new
   dequeues after stop".)
2. **Await in-flight with timeout.** `stop(timeoutMs)` MUST await all currently in-flight
   execution promises, but for no longer than `timeoutMs`. If they all settle first, resolve as
   soon as the last one settles. (Proven by §8 "drains active workflow".)
3. **Force-stop after timeout.** If `timeoutMs` elapses with executions still running, `stop()`
   MUST resolve anyway (never hang). Still-running executions are left to their own `finally`
   blocks; the host does not kill them. With `timeoutMs === 0`, resolve essentially immediately
   without awaiting. (Proven by §8 "force-stop after timeout".)
4. **Leave locks consistent.** The drain MUST NOT forcibly release locks it does not own. By
   awaiting in-flight executions, any execution that *finishes inside the timeout* runs its
   existing `finally { releaseLock(...) }` and leaves no lock held. Executions that exceed the
   timeout retain whatever lock state they hold; the host does not reach into the lock provider.
   (Proven by §8 "no held lock after drain".)
5. **Remove signal listeners.** `stop()` (at the host level) MUST remove the exact `SIGTERM` and
   `SIGINT` listener functions it registered in `start()` via `process.removeListener('SIGTERM', fn)`
   / `process.removeListener('SIGINT', fn)`. After a completed `stop()`, the host contributes zero
   process signal listeners. (Proven by §8 "removes signal listeners".)
6. **Register once.** Signal handlers are registered **exactly once per host start**, and only if
   not already registered for this host (guard with a stored handler reference / `registered`
   flag). Starting → stopping → starting the same host re-registers cleanly (one set each time).
   Starting N hosts registers N handlers total (one per host), each removed by its own `stop()`.
   No host registers a handler more than once per `start()`. (Proven by §8 "register once".)
7. **Idempotent stop.** Calling `host.stop()` (or a worker's `stop()`) more than once MUST be
   safe: the second and subsequent calls resolve without re-running teardown, without throwing,
   and without removing already-removed listeners a second time (use the idempotency guard from
   §5). Concurrent `stop()` calls share the same drain promise. (Proven by §8 "idempotent stop".)
8. **Electron integration hook.** `host.stop()` is the documented, supported method for Electron
   consumers to call from `app.on('before-quit', async (e) => { e.preventDefault(); await host.stop(); app.exit(); })`
   (or `'will-quit'`). It MUST be safe to call before the renderer/app exits and MUST resolve so
   the consumer can then quit. `core` MUST NOT import or depend on `electron`; the hook is just the
   async, idempotent `stop()`. Document this usage in the spec and (if a docs/README exists for the
   host) note it there. (Behavioural part proven by §8 "idempotent stop"; the Electron call site is
   documentation, not a core test.)
9. **SIGTERM and SIGINT both handled.** `start()` MUST register handlers for **both** `SIGTERM`
   and `SIGINT`; each handler calls `host.stop()` (fire the async stop; the handler itself may be
   sync and not await — Node keeps the loop alive while the drain timer/promises are pending). The
   handler MUST NOT call `process.exit()` itself (leave exit to the runtime / consumer). (Proven by
   §8 "drains active workflow" which signals via the registered handler.)
10. **No orphaned timers.** After a completed `stop()`, no `setInterval` from any worker remains
    active, and the drain's internal timeout timer MUST NOT keep the event loop alive (use
    `.unref()` per §5). (Proven by §8 "no orphaned timers".)
11. **Concurrency:** while draining, in-flight executions continue to mutate their own instance and
    release their own locks normally; the drain only observes completion, it does not serialize or
    pause them. (Covered implicitly by §8 "drains active workflow".)
12. **Error path:** if an in-flight execution rejects during drain, it MUST NOT cause `stop()` to
    reject — use `Promise.allSettled` (per §5), not `Promise.all`. (Proven by §8 "stop resolves
    even if an in-flight execution throws".)

## 7. Provider parity

`IBackgroundWorker` and `IWorkflowHost` are **core-internal** abstractions; they are **not**
`IPersistenceProvider`, `IDistributedLockProvider`, or `IQueueProvider`. No provider implements
either interface. Therefore:

> **No core *provider* interface change; no provider package impact.** Confirmed: `IBackgroundWorker`
> is implemented only by the three core workers, and `IWorkflowHost` only by core `WorkflowHost`.

The signature changes do, however, ripple within `core` to **every implementer of the changed
interfaces** — these MUST all land in this PR:

| Implementer | File | Change required |
|---|---|---|
| `WorkflowQueueWorker` | `core/src/services/workflow-queue-worker.ts` | `stop(timeoutMs): Promise<void>`; in-flight set + drain. |
| `EventQueueWorker` | `core/src/services/event-queue-worker.ts` | `stop(timeoutMs): Promise<void>`; in-flight set + drain. |
| `PollWorker` | `core/src/services/poll-worker.ts` | `stop(timeoutMs): Promise<void>`; await single in-flight tick. |
| `WorkflowHost` | `core/src/services/workflow-host.ts` | `stop(): Promise<void>` async; `await` each worker.stop; signal register/remove once; idempotency guard. |
| All scenario specs calling `host.stop()` | `core/spec/scenarios/*.spec.ts` | `host.stop()` now returns a promise; `afterAll(() => host.stop())` should become `afterAll(async () => { await host.stop(); })`. Enumerated: `basic-workflow`, `data-io`, `delay`, `external-events`, `foreach`, `if`, `outcome-fork`, `parallel`, `saga-compensation`, `schedule`, `while`. |

Provider parity table (for completeness):

| Provider | Change required |
|---|---|
| memory (core) | None |
| sqlite | None (provider not yet present) |
| postgres | None |
| mongodb | None |
| redis | None |
| azure | None |

## 8. Test plan (TDD)

Create `core/spec/scenarios/graceful-shutdown.spec.ts`, following the structure of
`core/spec/scenarios/delay.spec.ts` and `external-events.spec.ts` (build a host with
`configureWorkflow()`, `usePersistence(new MemoryPersistenceProvider())`, register a workflow,
`await host.start()`). Use `spinWait` / `spinWaitCallback` from `core/spec/helpers/spin-wait.ts` to
poll for instance state. Use a step whose `run` blocks on a controllable promise (a module-scoped
"gate" the test resolves) so an execution can be held mid-flight while `stop()` is called.

Pattern for a controllable blocking step:

```ts
let releaseStep: (() => void) | null = null;
const stepEntered = new Promise<void>((r) => { /* set a flag the test spinWaits on */ });
class BlockingStep extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> {
        scope.entered = true;
        return new Promise((resolve) => { releaseStep = () => resolve(ExecutionResult.next()); });
    }
}
```

### Failing-test-first

- **`stop() awaits an in-flight execution before resolving`** — arrange: a workflow whose first
  step is `BlockingStep`; `await host.start()`, `startWorkflow(...)`, `spinWait` until
  `scope.entered === true` (execution is mid-flight, holding the lock). act: call
  `const stopPromise = host.stop();` then assert `stopPromise` is **not yet resolved** (e.g. race
  it against a short `setTimeout` flag) while the step is still blocked; then `releaseStep!()` and
  `await stopPromise`. assert: `stopPromise` resolves only **after** the step was released; the
  instance reaches `Complete`/consistent state. (Proves §6.2; **must fail before the fix** because
  today `stop()` is synchronous `void` and returns immediately, abandoning the execution.)

### Coverage

- **`SIGTERM mid-execution drains the active workflow to a consistent state within the timeout`** —
  arrange: host configured with `gracefulShutdownTimeoutMs: 5000`, a `BlockingStep` workflow
  running and `scope.entered`. act: `process.emit('SIGTERM')`, then `releaseStep!()`, then
  `spinWait` for the host's stop to settle (expose the stop promise, or `spinWait` on instance
  status). assert: instance status is `Complete` (consistent), drain completed within timeout.
  (Proves §6.9 + §6.2.)
- **`no held lock after drain`** — arrange: same as above using `SingleNodeLockProvider`; capture
  the lock provider. act: after `releaseStep!()` and `await host.stop()`. assert: a fresh
  `acquireLock(workflowId)` succeeds (lock was released by the execution's `finally`). (Proves
  §6.4.)
- **`force-stop after timeout resolves without hanging`** — arrange: host with
  `gracefulShutdownTimeoutMs: 300`; a `BlockingStep` that is **never** released. act:
  `const t0 = Date.now(); await host.stop();`. assert: resolves in roughly `<= 300ms + slack`
  (e.g. `< 2000ms`) even though the step never completed. (Proves §6.3.)
- **`stop resolves even if an in-flight execution throws`** — arrange: a step that rejects
  after the host is stopping. act: `await host.stop()`. assert: no rejection propagates out of
  `stop()`. (Proves §6.12.)
- **`idempotent repeated stop`** — arrange: started host. act: `await Promise.all([host.stop(), host.stop()]); await host.stop();`. assert: no throw; all resolve; teardown ran once
  (e.g. assert listener count stayed correct, see next test). (Proves §6.7.)
- **`removes signal listeners on stop`** — arrange: record
  `const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')` before
  `start()`. act: `await host.start(); await host.stop();`. assert:
  `process.listenerCount('SIGTERM') === beforeTerm && process.listenerCount('SIGINT') === beforeInt`
  (net zero added by this host after stop). (Proves §6.5.)
- **`registers signal handlers exactly once per start`** — arrange: record counts. act:
  `await host.start()`. assert: `SIGTERM` count increased by exactly 1 and `SIGINT` by exactly 1;
  calling `start()` semantics are out of scope but registering twice is not. (Proves §6.6.)
- **`no orphaned timers after stop`** — arrange: started host with running workers. act:
  `await host.stop()`. assert: the process can exit naturally — practically, assert (via a spy or
  by checking `worker['processTimer']` is `null`) that every worker cleared its interval and the
  drain timeout was `.unref()`-ed. (Proves §6.10 + §6.1.)

### How to run

```bash
cd core && yarn build
cd core && yarn test
# single scenario:
cd core && npx jasmine --config=spec/support/jasmine.json --filter="graceful shutdown"
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds (no type errors from the `Promise<void>` signature changes).
- [ ] `cd core && yarn test` passes on Node 20 and 22, including the new `graceful-shutdown.spec.ts`.
- [ ] The failing-first test (`stop() awaits an in-flight execution before resolving`) is shown to
      fail on the pre-change code and pass after.
- [ ] After `await host.stop()`, `process.listenerCount('SIGTERM')` and `'SIGINT'` are back to
      their pre-`start()` values (net zero leaked) — asserted by the listener test.
- [ ] `host.stop()` called twice concurrently and again serially never throws and resolves — asserted
      by the idempotency test.
- [ ] With an unreleased in-flight step and `gracefulShutdownTimeoutMs: 300`, `host.stop()` resolves
      in well under the default 30s — asserted by the force-stop test.
- [ ] `grep -rn "process.on('SIGINT'\|process.on('SIGTERM'" core/src` shows registration only via
      the once-guarded host path, and a matching `removeListener` exists.
- [ ] No provider package required changes (per §7).

## 10. Backward compatibility & migration

- **Public API change (breaking, source-level):** `IWorkflowHost.stop()` and
  `IBackgroundWorker.stop()` change return type from `void` to `Promise<void>`. Callers that did
  `host.stop();` still compile (ignoring a promise is legal) but SHOULD migrate to
  `await host.stop();` to get the drain guarantee. `IBackgroundWorker.stop()` gains a required
  `timeoutMs` argument — this only affects code that calls a worker's `stop()` directly (none
  outside core).
- **`configureWorkflow()` gains an optional `options` argument** — fully backward compatible
  (no-arg call unchanged; default timeout 30000ms).
- **No at-rest/on-disk format change.**
- **Consumer (`reactory-express-server`) impact:** if it calls `host.stop()` in shutdown code, it
  keeps working; recommend `await host.stop()` in its SIGTERM handler and removing any duplicate
  SIGINT handling it added to compensate for Defect 1/2. Note in its changelog.
- **Version bump:** `2.3.6-reactory.3` → `2.3.6-reactory.4` (additive + minor source-breaking on a
  pre-1.0-style reactory channel; coordinate with the consumer's `file:` tarball update).

## 11. Definition of Done

`stop()` is asynchronous, idempotent, and graceful end to end: invoking it (directly, via
`SIGTERM`, via `SIGINT`, or from an Electron `before-quit` handler) stops all worker intake, awaits
in-flight executions up to the configured `gracefulShutdownTimeoutMs` (default 30000), then
resolves — force-completing if the timeout elapses rather than hanging. Executions that finish
inside the window release their locks via their existing `finally` blocks, so no lock is leaked and
state stays consistent. `SIGTERM` and `SIGINT` handlers are registered exactly once per host start
and removed on stop, leaving zero net process listeners and no live timers behind. The single
in-flight tracking set is the same one H1 builds its concurrency cap on. All eleven existing
scenario specs and the new `graceful-shutdown.spec.ts` pass on Node 20 and 22, no provider package
changed, and the version is bumped with a consumer migration note.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) change the two interfaces; (2) add `TYPES.GracefulShutdownTimeoutMs` +
  config plumbing; (3) implement the worker `stop`/in-flight set (start with `WorkflowQueueWorker`,
  copy to `EventQueueWorker`, then `PollWorker`); (4) rewrite `WorkflowHost.stop()` + signal
  register/remove; (5) update the eleven `afterAll` blocks to `await host.stop()`; (6) write tests;
  (7) version bump.
- The current workers bind `processQueue`/`process` via `setInterval(this.processQueue, 100, this)`
  passing `self` as an argument — keep `inFlight`/`shuttingDown` as instance fields on the worker
  (`this`), since `self` is the same instance.
- Upstream `danielgerlag/workflow-es` later versions made `stop()` async with a similar drain; this
  is a reasonable reference but their concurrency model differs — follow §5/§6 here, not upstream.
- Keep the drain timeout timer local and `.unref()`-ed so test processes and Electron quit cleanly.
- The handler functions registered on `process` must be stored on the host instance (e.g.
  `private sigtermHandler?: () => void`) so `removeListener` can pass the *same* reference — passing
  a fresh closure to `removeListener` is a no-op and would leak the listener.
