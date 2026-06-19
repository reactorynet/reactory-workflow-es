# Spec — H2 · Close the lock-release race

| Field | Value |
|---|---|
| **Item ID** | H2 |
| **Title** | Close the lock-release race (post-processing inside lock) |
| **Plan reference** | [`upgrade-plan.md` → H2](../upgrade-plan.md) |
| **Target** | Both |
| **Severity** | High |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | C1 (a real distributed lock + queue provider is required to *test* this meaningfully; see §8). The code change itself does not depend on C1 and should be authored against the current core. |
| **Author / reviewer** | [claude] / <reviewer> |

---

## 1. Context (self-contained)

This repo (`@reactorynet/workflow-es`) is a TypeScript workflow/saga engine. Background workers
dequeue workflow IDs and event IDs, acquire a per-ID lock via `IDistributedLockProvider`, load the
instance from `IPersistenceProvider`, execute it, persist the result, and then create event
subscriptions and decide whether to re-queue the instance.

The bug is an **ordering defect** in `WorkflowQueueWorker.processWorkflow`: the lock is released
**before** the state-derived post-processing runs, and the post-processing then reads instance fields
(`status`, `nextExecution`) and the executor result (`subscriptions`) that were captured under the
lock but are acted upon after it. This opens a window where a second worker (another node, or another
tick on the same node) can acquire the lock for the same workflow ID and re-execute the instance, and
where subscriptions can be created more than once.

### 1.1 The exact current ordering (offending code)

`core/src/services/workflow-queue-worker.ts:55-99` — `processWorkflow`:

```ts
private async processWorkflow(self: WorkflowQueueWorker, workflowId: string): Promise<void> {
    try {
        const gotLock = await self.lockProvider.acquireLock(workflowId);           // L57  acquire
        if (gotLock) {
            let complete = false;
            try {
                var instance: WorkflowInstance = await self.persistence.getWorkflowInstance(workflowId); // L61
                if (!instance)
                    throw new Error(`Workflow ${workflowId} not found`);

                if (instance.status == WorkflowStatus.Runnable) {
                    try {
                        var result = await self.executor.execute(instance);        // L67  execute
                        complete = true;
                    }
                    finally {
                        await self.persistence.persistWorkflow(instance);          // L71  persist
                    }
                }
            }
            finally {
                await self.lockProvider.releaseLock(workflowId);                   // L76  RELEASE (too early)
                if (complete) {
                    //TODO: cleanup
                    for (let sub of result.subscriptions) {                        // L79  subscribe AFTER release
                        await self.subscribeEvent(self, sub);
                    }

                    if ((instance.status == WorkflowStatus.Runnable) && (instance.nextExecution !== null)) { // L83 re-queue decision AFTER release
                        if (instance.nextExecution < Date.now()) {                 // L84  reads instance state AFTER release
                            self.queueProvider.queueForProcessing(workflowId, QueueType.Workflow); // L85
                        }
                    }
                }
            }
        }
        else {
            self.logger.log("Workflow locked: " + workflowId);
        }
    }
    catch (err) {
        const error = toError(err);
        self.logger.error("Error processing workflow: " + error.message);
    }
}
```

### 1.2 Why this is wrong — the race window, precisely

1. Worker A executes the instance (L67), persists it (L71), then **releases the lock at L76**.
2. The block at **L77–L88 runs after the lock is gone.** It reads `result.subscriptions` (L79),
   `instance.status` and `instance.nextExecution` (L83–L84), and re-queues at L85.
3. Between L76 (release) and L85 (re-queue), **any other worker** — another node sharing the lock, or
   the next 100 ms `setInterval` tick on the same node (`start()` at L28 fires `processQueue` every
   100 ms) that dequeues the same ID — can call `acquireLock(workflowId)` at L57, succeed, reload the
   now-persisted instance, see `status == Runnable` (true whenever the workflow still has a
   `nextExecution`, e.g. a re-queue or a `waitFor`/delay step), and **re-execute the same pointer.**
   That re-execution is exactly the double-step-execution the plan's Phase 0 is meant to eliminate.
4. **Subscription double-create.** `subscribeEvent` (L101–L110) calls
   `persistence.createEventSubscription(subscription)` unconditionally. The memory provider
   (`core/src/services/memory-persistence-provider.ts:32-35`) assigns a fresh UID and pushes — there
   is **no dedup**. If the same instance is processed twice (per the window above), or if a re-queue
   re-runs a step that re-emits the same subscription, the subscription is created twice. Each
   duplicate then matches the same published event and seeds the workflow twice
   (`event-queue-worker.ts:63-67`), compounding duplicate execution.

In short: **state captured under the lock is consumed after the lock is released, and the
side-effects (subscribe, re-queue) are neither inside the lock nor idempotent.**

### 1.3 The event worker is correctly scoped (do not "fix" it the same way)

`core/src/services/event-queue-worker.ts` already does its persistence-affecting work **inside** the
lock (`processEvent` L57–L77: load event, seed subscriptions, mark processed, then release at L75).
However, note `seedSubscription` (L88–L118): it acquires the *workflow* lock (L90), persists the
workflow (L100), terminates the subscription (L101), then in its `finally` (L109–L112) **releases the
lock at L110 and immediately `queueForProcessing` at L111 after release.** That re-queue-after-release
is benign *only if* re-queue is idempotent — which we are about to require (see §6). This spec touches
`event-queue-worker.ts` **only** to relocate that single `queueForProcessing` call to inside the lock
(before L110), to satisfy the "release is the last action" contract uniformly. No other change to the
event worker.

### 1.4 User-visible impact

Under more than one host (the cloud target) or under burst load on a single host, the same workflow
pointer can execute twice (duplicate side-effects in user step bodies — duplicate emails, charges,
records) and the same `waitFor` subscription can be created twice (a single published event wakes the
workflow twice). This violates guiding principle #2 ("we do not add features on top of an engine that
can double-execute steps").

## 2. Goal

After this change, **all state-derived post-processing for a workflow — creating event subscriptions,
seeding any matching already-arrived events, and deciding whether to re-queue the instance — happens
INSIDE the lock, using state read under that lock, and `releaseLock` is the final action before the
worker returns.** Subscription creation and re-queue are idempotent, so that even if a duplicate
acquisition or a re-emitting step occurs, a given subscription is created at most once and a given
pointer is processed effectively once. The race window between release and post-processing is
eliminated.

## 3. Out of scope

- Do **not** change the `IDistributedLockProvider`, `IPersistenceProvider`, or `IQueueProvider`
  interface signatures. (Idempotency is achieved with existing methods; see §6 and §7.)
- Do **not** implement the optimistic-concurrency token on `persistWorkflow` — that is item **C1**.
- Do **not** change the `setInterval`/polling cadence, add a worker pool, or add backpressure — those
  are **H1**. Keep `start()`/`stop()` exactly as they are except where this spec requires.
- Do **not** add lease/locking to the poll worker — that is **H3**.
- Do **not** alter `WorkflowExecutor.execute`, the `ExecutionResult`/`StepExecutionContext` shapes, or
  any step-body behaviour.
- Do **not** change the event worker beyond relocating the single `queueForProcessing` call described
  in §1.3 / §6 rule 8.
- Do **not** refactor `subscribeEvent` into "its own class" (the existing `//TODO`); only adjust its
  call site and add the idempotency guard.
- Do **not** touch any provider package under `providers/*`.

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/services/workflow-queue-worker.ts` | modify | Move subscription creation, event seeding, and the re-queue decision to **inside** the lock (before `releaseLock`); make `releaseLock` the last statement; add idempotency guard to `subscribeEvent`. |
| `core/src/services/event-queue-worker.ts` | modify | Relocate the single `queueForProcessing(sub.workflowId, …)` in `seedSubscription`'s `finally` to **before** `releaseLock` (rule 8). No other change. |
| `core/spec/scenarios/h2-lock-release-race.spec.ts` | create | TDD: concurrency test proving no double-processing and exactly-once subscription creation under lock contention (see §8). |
| `core/spec/helpers/instrumented-lock-provider.ts` | create | A test-only `IDistributedLockProvider` that records acquire/release call order per ID and can deterministically interleave two acquisitions, to drive the race in a test. (Test helper only; not shipped in `src`.) |

> No other files change. The fix is an **internal reordering** within two services plus tests.

## 5. Interface & data-model changes

**None.** No change to any interface, exported type, method signature, DI binding (`TYPES`),
`configureWorkflow()`/`WorkflowConfig`, enum, or persisted shape.

```ts
// IDistributedLockProvider — UNCHANGED
export interface IDistributedLockProvider {
    acquireLock(id: string): Promise<boolean>;
    releaseLock(id: string): Promise<void>;
}
```

### DI / config impact
None. No new config options.

### Persisted / at-rest format impact
None. The set of records written (`WorkflowInstance`, `EventSubscription`, `Event`) is unchanged; only
the **order** and the **at-most-once** guarantee on subscription creation change.

## 6. Behavioural contract (numbered rules)

1. **Corrected ordering — everything inside the lock.** In `WorkflowQueueWorker.processWorkflow`, once
   the lock is acquired, the following must all complete **before** `releaseLock(workflowId)` is
   called, in this order:
   (a) load instance; (b) if `Runnable`, `executor.execute(instance)`; (c) `persistWorkflow(instance)`;
   (d) for each `result.subscriptions`, `subscribeEvent`; (e) the re-queue decision and any
   `queueForProcessing`.
2. **`releaseLock` is the last action.** `releaseLock(workflowId)` must be the final lock-affecting
   statement on every path where the lock was acquired (success, "not runnable", and error), and no
   persistence write, subscription creation, event seeding, or re-queue may occur after it. The
   simplest correct structure: do steps (a)–(e) inside the inner `try`, and put **only**
   `await releaseLock(workflowId)` in the `finally`.
3. **State is read under the lock.** The re-queue decision must use the `instance`/`result` values
   read while the lock is held (it already is — the change is purely that the decision now executes
   before release). Do not re-load the instance after persisting to make the decision.
4. **Re-queue condition unchanged in semantics.** Re-queue iff `instance.status == WorkflowStatus.Runnable`
   AND `instance.nextExecution !== null` AND `instance.nextExecution < Date.now()` — identical to the
   current L83–L85 condition. Only its position moves (inside the lock).
5. **Idempotency — subscription creation.** `subscribeEvent` must create a subscription **at most
   once** for a given `(workflowId, eventName, eventKey, subscribeAsOf)` tuple. Before calling
   `persistence.createEventSubscription`, it must check `persistence.getSubscriptions(eventName,
   eventKey, subscribeAsOf)` and skip creation if an existing subscription for the same `workflowId`
   already exists. If it skips creation, it must **also skip** the subsequent event-seeding loop
   (`getEvents` → `markEventUnprocessed` → `queueForProcessing`) for that subscription, because that
   work was already done when the subscription was first created. (`EventSubscription` carries
   `workflowId`, `stepId`, `eventName`, `eventKey`, `subscribeAsOf` — see
   `core/src/models/event-subscription.ts`.)
6. **Idempotency — re-queue.** Re-queuing the same `workflowId` more than once must be harmless:
   downstream, a duplicate dequeue that finds the instance already advanced/locked must be a no-op
   (this is guaranteed by rules 1–4 + the lock: the second acquirer either fails to get the lock or
   loads an instance whose pointers are no longer `Runnable` for that step). The implementer must NOT
   add a dedup set; correctness comes from the in-lock ordering, not from suppressing re-queues.
7. **Error path.** If `getWorkflowInstance` returns falsy, or `executor.execute` throws, the lock must
   still be released exactly once (in the `finally`), and **no** post-processing (subscribe/re-queue)
   runs (because `complete` is false / the throw skips it). Existing `try/finally` around
   `persistWorkflow` (so the instance is persisted even when a step throws) is preserved.
8. **Event worker symmetry.** In `EventQueueWorker.seedSubscription`, move the
   `self.queueProvider.queueForProcessing(sub.workflowId, QueueType.Workflow)` call from after
   `releaseLock` (current L111, in `finally`) to **before** `releaseLock` — i.e. as the last statement
   inside the `try` after `terminateSubscription`, so release is the last action here too. Behaviour is
   otherwise unchanged; the re-queue still occurs exactly when seeding succeeded.
9. **No double execution under contention.** Two concurrent attempts to `processWorkflow` the same ID
   must result in the instance's runnable step body executing **once** per logical advancement: the
   second acquirer must either be rejected by the lock (because the first has not yet released) or, if
   it acquires after release, find no runnable pointer to advance for that step.

## 7. Provider parity

No core interface change; no provider impact. The fix uses only existing
`IDistributedLockProvider`, `IPersistenceProvider`, and `IQueueProvider` methods. The idempotency
guard in rule 5 relies on `getSubscriptions` + `createEventSubscription`, both already in
`IPersistenceProvider`. Therefore **no `providers/*` change is required and none may be made in this
PR.**

| Provider | Change required |
|---|---|
| memory | None |
| postgres | None |
| mongodb | None |
| mysql | None |
| redis | None |
| azure | None |

## 8. Test plan (TDD)

> **Locking note (Depends-on C1).** The race is best demonstrated with a *real* distributed lock that
> blocks/serialises concurrent holders. Until C1 lands, this spec ships a **test-only**
> `InstrumentedLockProvider` (see §4) that (a) honours real mutual exclusion (a second `acquireLock`
> for a held ID returns `false`, matching `SingleNodeLockProvider`), and (b) records the **call order**
> of acquire/release/persist/subscribe so the test can assert post-processing happened *before*
> release. The failing test below is written against this helper and the in-memory provider so it runs
> in core's existing Jasmine suite with **no external infrastructure**. When C1 is done, an additional
> integration variant (two hosts, shared Redis lock + Postgres) should be added under the C1/M8
> harness; that is tracked there, not here.

Tests use the existing scenario style: `configureWorkflow()`, `MemoryPersistenceProvider`,
`host.start()`, and the `spinWait(until: () => Promise<boolean>): Promise<void>` helper from
`core/spec/helpers/spin-wait.ts` (promise-form; `external-events.spec.ts` is the reference pattern).
Match that file's structure (class-based `WorkflowBase`, `beforeAll` to drive, `afterAll` to
`host.stop()`, `jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000`).

### Failing-test-first
- **`h2: post-processing must occur before lock release`** — _arrange:_ build a workflow with a
  `waitFor("h2-event", () => "k")` step so `executor.execute` returns a `result.subscriptions` entry
  and the instance is re-queued; wrap the lock provider in `InstrumentedLockProvider` that appends a
  marker to a shared `order: string[]` on each `acquireLock("…")`/`releaseLock("…")`, and have the
  test subscription path append `"subscribe"` (via a spy on `persistence.createEventSubscription`) and
  the re-queue path append `"requeue"` (spy on `queueProvider.queueForProcessing`). _act:_ start the
  workflow, `await spinWait(...)` until a subscription for `("h2-event","k")` exists. _assert:_ in the
  recorded `order` for that workflowId, both `"subscribe"` and `"requeue"` indices are **less than**
  the index of `releaseLock(workflowId)`. **This fails today** because L76 release precedes the
  L79/L85 subscribe/re-queue. (Proves rules 1, 2, 8.)

### Coverage
- **`h2: a re-queued + subscribing workflow is never processed twice for the same pointer under
  contention`** — _arrange:_ a workflow whose first step increments a module-level counter
  `scope.runs` then `waitFor`s an event (so it both subscribes and stays `Runnable`/re-queued); use a
  lock provider that lets the test force two overlapping `processWorkflow` attempts for the same ID
  (e.g. queue the same ID twice rapidly, or directly invoke the worker's dequeue path twice).
  _act:_ start the workflow; `spinWait` until `instance.status != Runnable` for the first step's
  advancement, or a fixed settle. _assert:_ `scope.runs === 1` (the runnable step body executed
  exactly once). (Proves rules 6, 9.)
- **`h2: subscriptions are created exactly once under duplicate processing`** — _arrange:_ same
  subscribing workflow; spy/count `persistence.createEventSubscription` calls; deliberately cause the
  instance to be processed twice (duplicate enqueue) for the same pre-event state. _act:_ start; let
  the queue drain via `spinWait` on a subscription existing. _assert:_
  `persistence.getSubscriptions("h2-event","k", new Date())` returns **exactly one** subscription for
  the workflowId, and the `createEventSubscription` spy was invoked **once** (or the second invocation
  was guarded out per rule 5). (Proves rule 5.)
- **`h2: error in step still releases lock exactly once and skips post-processing`** — _arrange:_ a
  workflow whose first step throws; count `releaseLock` and `createEventSubscription`. _act:_ start;
  `spinWait` until the instance reaches a non-runnable/errored settle. _assert:_ `releaseLock` called
  exactly once for the ID; `createEventSubscription` never called; no re-queue after release. (Proves
  rule 7.)
- **`h2: event worker re-queues before releasing the workflow lock`** — _arrange:_ external-events
  style workflow; instrument the lock to record order around `seedSubscription`. _act:_ publish the
  event; `spinWait` until completion. _assert:_ for the `sub.workflowId`, the `queueForProcessing`
  marker index is **less than** the `releaseLock(sub.workflowId)` index. (Proves rule 8.)
- **Regression:** `external-events.spec.ts`, `delay.spec.ts`, `schedule.spec.ts`,
  `saga-compensation.spec.ts`, and `foreach.spec.ts` must still pass unchanged (they exercise
  subscribe + re-queue paths end-to-end).

### How to run
```bash
cd core && yarn build
cd core && yarn test                                   # full suite incl. new h2 spec
# focus the new scenario (jasmine config in core/spec/support):
cd core && yarn test --filter="h2*"                    # or run the single spec file per repo convention
# Integration (after C1 lands; tracked under C1/M8, NOT this PR):
# two hosts on shared Redis lock + Postgres execute a subscribing+re-queue workflow → 1 execution, 1 subscription
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd core && yarn test` passes on Node 20 and 22.
- [ ] The failing-test-first (`post-processing must occur before lock release`) was committed red,
      then green after the reorder (visible in PR history).
- [ ] `h2-lock-release-race.spec.ts` asserts `scope.runs === 1` (no double execution) under duplicate
      processing.
- [ ] `getSubscriptions(...)` returns exactly one subscription for the workflow under duplicate
      processing; `createEventSubscription` invoked at most once for the tuple.
- [ ] In `workflow-queue-worker.ts`, `releaseLock(workflowId)` is the last lock-affecting statement on
      every acquired path, and no subscribe/seed/re-queue/persist follows it (verified by reading the
      diff and by the ordering test).
- [ ] In `event-queue-worker.ts` `seedSubscription`, `queueForProcessing` precedes `releaseLock`.
- [ ] No file under `providers/*` and no core interface changed.

## 10. Backward compatibility & migration

No public API, on-disk, or at-rest format change. Behaviour change is strictly a correctness
improvement (fewer duplicate executions / subscriptions). No migration steps for consumers. The
`reactory-express-server` integration (`file:` tarball) is unaffected at the API level. Version: a
patch-level reactory bump (`2.3.6-reactory.3` → `2.3.6-reactory.4`); no breaking note required.

## 11. Definition of Done

`WorkflowQueueWorker.processWorkflow` performs all state-derived post-processing — subscription
creation, matching-event seeding, and the re-queue decision — **inside** the lock using state read
under that lock, with `releaseLock` as the final action on every path; subscription creation is guarded
to be at-most-once per `(workflowId, eventName, eventKey, subscribeAsOf)`; `EventQueueWorker.seedSubscription`
re-queues before releasing; the race window between release and post-processing is gone. A core-suite
concurrency test proves no double step execution and exactly-once subscription creation under
contention, the prior ordering test fails before the fix and passes after, all existing scenarios
still pass, and no interface or provider changed.

## 12. Implementation notes (optional, non-binding)

- Minimal shape for `processWorkflow`: keep the outer `acquireLock`/`if (gotLock)`; inside it use a
  single `try { … (a)-(e) … } finally { await releaseLock(workflowId); }`. The current code already
  computes `result` and `instance` inside that scope — you are moving the L77–L88 block from the
  `finally` up into the `try`, just before the `finally`.
- For the idempotency guard in `subscribeEvent`: `const existing = await persistence.getSubscriptions(sub.eventName, sub.eventKey, sub.subscribeAsOf); if (existing.some(s => s.workflowId === sub.workflowId)) return;` then proceed to `createEventSubscription` + the events loop only when not skipped.
- The upstream `danielgerlag/workflow-es` resolves this by performing subscription/cleanup inside the
  lock scope; this change brings the Reactory fork in line with that ordering.
- `spinWaitCallback(until, done)` (callback form) also exists in `spin-wait.ts` if a test prefers the
  Jasmine `done` style, but the scenario files use the promise-form `spinWait`; prefer `spinWait`.
