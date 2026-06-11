# Spec — H5 · Dead-letter + configurable max retries

| Field | Value |
|---|---|
| **Item ID** | H5 |
| **Title** | Dead-letter + configurable max retries |
| **Plan reference** | [`upgrade-plan.md` → H5](../upgrade-plan.md) |
| **Target** | Both (Cloud + Electron) |
| **Severity** | High |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | none |
| **Author / reviewer** | claude / wweber |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. When a step body throws, or the engine
cannot find the step referenced by an execution pointer, the engine decides what to do next via an
*error strategy*. Today, **two of those paths retry forever**, which can pin a workflow in an endless
retry loop ("poison step"), and the retry/backoff delay is a hard-coded magic number.

### Offending code

**A. Default error strategy retries forever.** In `core/src/services/execution-result-processor.ts`,
`selectErrorStrategy` has a `default` branch that simply parks the pointer for 60 seconds and bumps the
retry count, with **no upper bound**:

```ts
// core/src/services/execution-result-processor.ts:73-95
private selectErrorStrategy(errorOption: number, workflow, definition, pointer, step) {
    switch (errorOption) {
        case WorkflowErrorHandling.Retry:
            pointer.sleepUntil = (Date.now() + step.retryInterval);
            step.primeForRetry(pointer);
            break;
        case WorkflowErrorHandling.Suspend:
            workflow.status = WorkflowStatus.Suspended;
            break;
        case WorkflowErrorHandling.Terminate:
            workflow.status = WorkflowStatus.Terminated;
            break;
        case WorkflowErrorHandling.Compensate:
            this.compensate(workflow, definition, pointer);
            break;
        default:
            pointer.sleepUntil = (Date.now() + 60000);   // <-- magic number, retries forever
            break;
    }
    pointer.retryCount++;
}
```

Note the `Retry` case **also** retries forever: `pointer.retryCount++` is incremented but never
checked against a limit, and `step.retryInterval` defaults to `60000` (see
`core/src/models/workflow-step.ts:19`).

**B. "Step not found" path retries forever.** In `core/src/services/workflow-executor.ts`, when the
pointer references a step id that is not in the definition, the engine parks the pointer for 60s
forever (the author flagged it):

```ts
// core/src/services/workflow-executor.ts:109-112
else {
    this.logger.error("Could not find step on workflow %s %s", instance.id, pointer.stepId);
    pointer.sleepUntil = (Date.now() + 60000); //todo: make configurable
}
```

**C. The catch block records error history but never caps retries.** In `workflow-executor.ts:85-107`,
the catch pushes structured error info onto `pointer.persistenceData._errors` and into
`result.errors`, then delegates to `handleStepException` — which routes into `selectErrorStrategy`
above. Nothing in this chain ever decides "give up".

### Current model shape

- `WorkflowStatus` (`core/src/models/workflow-status.ts`) = `{ Runnable:0, Suspended:1, Complete:2,
  Terminated:3 }`. There is **no terminal "dead-letter" state**.
- `WorkflowErrorHandling` (`core/src/models/workflow-error-handling.ts`) =
  `{ Retry:1, Suspend:2, Terminate:3, Compensate:4 }`.
- `WorkflowStepBase` (`core/src/models/workflow-step.ts`) has `errorBehavior:number`,
  `retryInterval:number = 60000`. **No `maxRetries` field.**
- `WorkflowDefinition` (`core/src/models/workflow-definition.ts`) has `errorBehavior:number`,
  `retryInterval:number`. **No `maxRetries` field.**
- `ExecutionPointer` (`core/src/models/execution-pointer.ts`) has `retryCount:number = 0` and
  `status:number` from `PointerStatus = { Legacy:0, Pending:1, Running:2, Complete:3, Sleeping:4,
  WaitingForEvent:5, Failed:6, Compensated:7 }`. **No "DeadLettered" pointer status.**
- There is **no event-emitter or lifecycle-hook mechanism** anywhere in the host. The only thing
  resembling lifecycle is `process.on('SIGINT', …)` in `workflow-host.ts:179`. `ILogger` exists but
  is `printf`-style and the default `NullLogger` swallows everything.

### User-visible impact

A workflow with a permanently failing step (a bad downstream service, a programming error, a removed
step id) will re-queue and re-execute every 60 seconds **indefinitely**, consuming a worker slot,
locks, DB connections and log volume forever, with no operator-visible signal that it is stuck and no
way to configure the cadence.

---

## 2. Goal

After this change, every retry path has a **finite, configurable** retry budget. A step that keeps
failing is retried at most `maxRetries` times; on the (`maxRetries`+1)th failure the engine stops
retrying, moves the workflow to a new **terminal `DeadLettered` state**, marks the offending pointer
as dead-lettered, records the final error, and **emits a single `workflow.dead-lettered` lifecycle
event** through a new minimal host-level hook. A dead-lettered workflow is no longer runnable, is never
re-queued, and never appears in `getRunnableInstances()`. The "step not found" path and all retry
delays use named, configurable values instead of the literal `60000`. Existing `Retry` (with budget),
`Suspend`, `Terminate` and `Compensate` behaviour is otherwise unchanged.

---

## 3. Out of scope

- Do **not** add OpenTelemetry, metrics, or structured logging (those are M5/M4). The lifecycle hook
  here is a deliberately minimal in-process callback list, not a full event bus.
- Do **not** add any "requeue/redrive a dead-lettered workflow" API. Recovery tooling is future work.
- Do **not** change the `Compensate` flow's behaviour, the saga container logic, or the
  `compensate()` method's recursion (only the *budget check before retrying* is added; see §6.7).
- Do **not** change `IPersistenceProvider`, `IQueueProvider` or `IDistributedLockProvider` method
  signatures. (Adding a new numeric `WorkflowStatus` value is a value change, not an interface change —
  see §7.)
- Do **not** touch the providers under `providers/*` in this PR (no provider currently filters on a
  hard-coded status list that would break; see §7). Provider work stays in C3/M7/M8.
- Do **not** add `SIGTERM`/graceful-drain handling (that is H4).
- Do **not** rename or renumber existing `WorkflowStatus`, `PointerStatus`, or `WorkflowErrorHandling`
  members. Append only.

---

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/models/workflow-status.ts` | modify | Add terminal `DeadLettered: 4` status. |
| `core/src/models/execution-pointer.ts` | modify | Add `PointerStatus.DeadLettered: 8`. |
| `core/src/models/workflow-step.ts` | modify | Add `maxRetries?: number` field (default `undefined`). |
| `core/src/models/workflow-definition.ts` | modify | Add `maxRetries?: number` field (default `undefined`). |
| `core/src/fluent-builders/workflow-builder.ts` | modify | Default `maxRetries` for the definition; copy into built `WorkflowDefinition`. |
| `core/src/fluent-builders/step-builder.ts` | modify | Extend `onError(...)` to accept an optional `maxRetries`. |
| `core/src/services/retry-config.ts` | create | New `RetryConfig` holder: global defaults (`defaultMaxRetries`, `defaultRetryInterval`, `stepNotFoundRetryInterval`). |
| `core/src/services/lifecycle-events.ts` | create | New minimal lifecycle hook (`ILifecycleEventHub`) + `WorkflowDeadLetteredEvent` payload type. |
| `core/src/abstractions/types.ts` | modify | Add `IRetryConfig` and `ILifecycleEventHub` DI symbols. |
| `core/src/abstractions/lifecycle-events.ts` | create | Interface declarations `IRetryConfig`, `ILifecycleEventHub` (re-exported from abstractions barrel). |
| `core/src/abstractions.ts` (barrel) | modify | Export the new abstraction(s). Confirm actual barrel path before editing (see §12). |
| `core/src/config.ts` | modify | Bind `IRetryConfig`/`ILifecycleEventHub`; add `WorkflowConfig.useRetryConfig(...)` and `onLifecycleEvent(...)`. |
| `core/src/services/execution-result-processor.ts` | modify | Enforce `maxRetries` in `selectErrorStrategy`; dead-letter on exhaustion; inject config + hub. |
| `core/src/services/workflow-executor.ts` | modify | Replace `60000` step-not-found magic number with config value; budget that path too. |
| `core/src/abstractions/workflow-host.ts` | modify | (Optional) expose `onLifecycleEvent` on `IWorkflowHost` — see §5; if exposed, implement in host. |
| `core/src/services/workflow-host.ts` | modify | (If §5 exposes it) delegate `onLifecycleEvent` to the hub. |
| `core/spec/scenarios/dead-letter.spec.ts` | create | New scenario: permanently-failing step dead-letters after exactly N and emits event. |
| `core/spec/scenarios/retry.spec.ts` | create | New scenario: bounded retry then dead-letter; proves `Retry` no longer infinite. |
| `core/src/models.ts` | verify | Barrel already re-exports `workflow-status`, `workflow-step`, `workflow-definition`, `execution-pointer`; new fields/values flow automatically. No edit expected. |

> The implementer MUST `grep -rn "WorkflowStatus" core/src` before editing to confirm no `switch`
> statement enumerates the status set exhaustively (none does today — all comparisons are `==` against
> a single value). If one is found, add a `DeadLettered` branch that is a no-op / "not runnable".

## 5. Interface & data-model changes

### 5.1 New terminal workflow status

```ts
// BEFORE — core/src/models/workflow-status.ts
export var WorkflowStatus = {
    Runnable : 0,
    Suspended : 1,
    Complete : 2,
    Terminated : 3
}

// AFTER
export var WorkflowStatus = {
    Runnable : 0,
    Suspended : 1,
    Complete : 2,
    Terminated : 3,
    DeadLettered : 4      // terminal: retries exhausted; never runnable, never re-queued
}
```

**Decision — workflow-level status vs pointer-level only.** We introduce a **workflow-level**
`WorkflowStatus.DeadLettered` (and *also* a pointer-level `PointerStatus.DeadLettered` for the
offending pointer). Justification: `getRunnableInstances()` filters on
`x.status === WorkflowStatus.Runnable` (`memory-persistence-provider.ts:28`) and the queue worker only
executes when `instance.status == WorkflowStatus.Runnable` (`workflow-queue-worker.ts:65`). The
*cheapest, most robust* way to guarantee "stops consuming the queue" (the §2 acceptance) is to move the
whole instance out of `Runnable` — exactly how `Suspended`/`Terminated` already work. A pointer-only
flag would still leave `instance.status == Runnable`, so `determineNextExecutionTime` could still set
`nextExecution` and the poll worker would keep re-queueing it. We keep the pointer-level
`PointerStatus.DeadLettered` so an operator can see *which* pointer failed.

```ts
// BEFORE — core/src/models/execution-pointer.ts
export var PointerStatus = {
    Legacy: 0, Pending: 1, Running: 2, Complete: 3,
    Sleeping: 4, WaitingForEvent: 5, Failed: 6, Compensated: 7
}

// AFTER
export var PointerStatus = {
    Legacy: 0, Pending: 1, Running: 2, Complete: 3,
    Sleeping: 4, WaitingForEvent: 5, Failed: 6, Compensated: 7,
    DeadLettered: 8
}
```

### 5.2 `maxRetries` location (step → definition default → global config fallback)

`maxRetries` is resolved with a three-level precedence at the moment a retry decision is made:

1. **Step level** (`step.maxRetries`) — most specific, set via `.onError(behavior, retryInterval, maxRetries)`.
2. **Definition default** (`definition.maxRetries`) — set on the `WorkflowBuilder`.
3. **Global config fallback** (`IRetryConfig.defaultMaxRetries`) — engine-wide default.

```ts
// BEFORE — core/src/models/workflow-step.ts (excerpt)
export abstract class WorkflowStepBase {
    public errorBehavior : number;
    public retryInterval : number = 60000;
    public compensationStepId : number;
    ...
}

// AFTER
export abstract class WorkflowStepBase {
    public errorBehavior : number;
    public retryInterval : number = 60000;
    public maxRetries? : number;        // undefined => fall back to definition / global config
    public compensationStepId : number;
    ...
}
```

```ts
// BEFORE — core/src/models/workflow-definition.ts
export class WorkflowDefinition {
    public id : string;
    public version: number;
    public description: string;
    public steps: Array<WorkflowStepBase> = [];
    public errorBehavior : number;
    public retryInterval : number;
}

// AFTER
export class WorkflowDefinition {
    public id : string;
    public version: number;
    public description: string;
    public steps: Array<WorkflowStepBase> = [];
    public errorBehavior : number;
    public retryInterval : number;
    public maxRetries? : number;        // undefined => fall back to global config
}
```

```ts
// BEFORE — core/src/fluent-builders/workflow-builder.ts (excerpt)
export class WorkflowBuilder<TData> {
    public errorBehavior : number = WorkflowErrorHandling.Retry;
    public retryInterval : number = (60 * 1000);

    public build(id: string, version: number): WorkflowDefinition {
        var result = new WorkflowDefinition();
        ...
        result.errorBehavior = this.errorBehavior;
        result.retryInterval = this.retryInterval;
        return result;
    }
}

// AFTER
export class WorkflowBuilder<TData> {
    public errorBehavior : number = WorkflowErrorHandling.Retry;
    public retryInterval : number = (60 * 1000);
    public maxRetries? : number;        // undefined => global config default

    public build(id: string, version: number): WorkflowDefinition {
        var result = new WorkflowDefinition();
        ...
        result.errorBehavior = this.errorBehavior;
        result.retryInterval = this.retryInterval;
        result.maxRetries = this.maxRetries;
        return result;
    }
}
```

```ts
// BEFORE — core/src/fluent-builders/step-builder.ts
public onError(behavior: number, retryInterval: number = null): StepBuilder<TStepBody, TData> {
    this.step.errorBehavior = behavior;
    this.step.retryInterval = retryInterval;
    return this;
}

// AFTER  (third param optional & backward compatible)
public onError(behavior: number, retryInterval: number = null, maxRetries?: number): StepBuilder<TStepBody, TData> {
    this.step.errorBehavior = behavior;
    this.step.retryInterval = retryInterval;
    if (maxRetries !== undefined)
        this.step.maxRetries = maxRetries;
    return this;
}
```

> NOTE: when `onError` is called with `retryInterval` left as `null`, `step.retryInterval` becomes
> `null`, so the retry path must treat a null/undefined `retryInterval` as "use config default" — see
> rule §6.3. (This is a pre-existing latent issue: `onError(Retry)` today sets `retryInterval=null`,
> making `Date.now()+null === Date.now()`. Fixing it via the config fallback is in-scope and required
> for the retry test to behave deterministically.)

### 5.3 Global retry configuration

```ts
// core/src/abstractions/lifecycle-events.ts  (interface)
export interface IRetryConfig {
    defaultMaxRetries: number;          // default 3
    defaultRetryInterval: number;       // default 60000 (ms)
    stepNotFoundRetryInterval: number;  // default 60000 (ms)
}
```

```ts
// core/src/services/retry-config.ts  (concrete, injectable, default values)
import { injectable } from "inversify";
import { IRetryConfig } from "../abstractions";

@injectable()
export class RetryConfig implements IRetryConfig {
    public defaultMaxRetries: number = 3;
    public defaultRetryInterval: number = 60000;
    public stepNotFoundRetryInterval: number = 60000;
}
```

Named replacements for the magic numbers:

| Old literal | New name | Default | Used at |
|---|---|---|---|
| `60000` (default error strategy) | `IRetryConfig.defaultRetryInterval` | `60000` | `execution-result-processor.ts` default branch |
| `60000` (step not found) | `IRetryConfig.stepNotFoundRetryInterval` | `60000` | `workflow-executor.ts` else branch |
| `step.retryInterval` null fallback | `IRetryConfig.defaultRetryInterval` | `60000` | `execution-result-processor.ts` Retry branch |
| n/a | `IRetryConfig.defaultMaxRetries` | `3` | retry budget when step & definition `maxRetries` undefined |

### 5.4 Lifecycle event hook (minimal, self-contained)

The host has **no event emitter today**. Add a tiny in-process hub so the result processor can fire a
`workflow.dead-lettered` event and consumers (and tests) can observe it. This is deliberately minimal
and forward-compatible with M5/M4 (which may replace the consumer side with a real bus), but is
self-contained: it depends on nothing outside core.

```ts
// core/src/abstractions/lifecycle-events.ts  (interfaces)
export const WORKFLOW_DEAD_LETTERED = "workflow.dead-lettered";

export interface WorkflowDeadLetteredEvent {
    event: "workflow.dead-lettered";
    workflowId: string;
    workflowDefinitionId: string;
    version: number;
    pointerId: string;
    stepId: number;
    retryCount: number;          // total attempts made (== maxRetries + 1 the original try; see §6.1)
    maxRetries: number;          // the budget that was exhausted
    errorMessage: string | null; // last error message, from pointer.persistenceData._errors
    deadLetteredAt: string;      // ISO8601
}

export type LifecycleEvent = WorkflowDeadLetteredEvent;

export interface ILifecycleEventHub {
    on(handler: (evt: LifecycleEvent) => void): void;
    emit(evt: LifecycleEvent): void;
}
```

```ts
// core/src/services/lifecycle-events.ts  (concrete, injectable, singleton)
import { injectable } from "inversify";
import { ILifecycleEventHub, LifecycleEvent } from "../abstractions";

@injectable()
export class LifecycleEventHub implements ILifecycleEventHub {
    private handlers: Array<(evt: LifecycleEvent) => void> = [];
    public on(handler: (evt: LifecycleEvent) => void): void {
        this.handlers.push(handler);
    }
    public emit(evt: LifecycleEvent): void {
        // synchronous, best-effort; a throwing handler must not break the engine
        for (const h of this.handlers) {
            try { h(evt); } catch { /* swallow: handlers must not affect engine state */ }
        }
    }
}
```

### DI / config impact

```ts
// core/src/abstractions/types.ts  — AFTER (append two symbols)
let TYPES = {
    ...
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory"),
    IRetryConfig: Symbol("IRetryConfig"),
    ILifecycleEventHub: Symbol("ILifecycleEventHub")
};
```

In `configureWorkflow()` (`core/src/config.ts`) add singleton bindings:

```ts
bind<IRetryConfig>(TYPES.IRetryConfig).to(RetryConfig).inSingletonScope();
bind<ILifecycleEventHub>(TYPES.ILifecycleEventHub).to(LifecycleEventHub).inSingletonScope();
```

Add to `WorkflowConfig`:

```ts
public useRetryConfig(config: Partial<IRetryConfig>) {
    // merge over defaults, rebind as constant value
    const merged: IRetryConfig = Object.assign(new RetryConfig(), config);
    this.container.rebind<IRetryConfig>(TYPES.IRetryConfig).toConstantValue(merged);
}

public onLifecycleEvent(handler: (evt: LifecycleEvent) => void) {
    this.container.get<ILifecycleEventHub>(TYPES.ILifecycleEventHub).on(handler);
}
```

**Host API (decision):** also expose `onLifecycleEvent(handler)` on `IWorkflowHost` and
`WorkflowHost`, delegating to the injected hub, so consumers that only hold a host can subscribe. This
is a purely additive interface method.

`ExecutionResultProcessor` gains two injected dependencies:

```ts
@inject(TYPES.IRetryConfig) private retryConfig: IRetryConfig;
@inject(TYPES.ILifecycleEventHub) private lifecycle: ILifecycleEventHub;
```

`WorkflowExecutor` gains:

```ts
@inject(TYPES.IRetryConfig) private retryConfig: IRetryConfig;
```

### Persisted / at-rest format impact

- `WorkflowInstance.status` may now hold the new value `4` (`DeadLettered`). It is a plain number on
  an already-persisted field — no schema change in any provider; existing serializers round-trip it.
- `ExecutionPointer.status` may now hold `8` (`DeadLettered`) — same, already-persisted number field.
- New optional `maxRetries` numbers on step/definition are part of the in-memory registry only
  (definitions are not persisted), so **no at-rest migration**. `WorkflowInstance` does not carry step
  definitions. No forward/backward migration required.

## 6. Behavioural contract (numbered rules)

> "Attempt" = one execution of the step body. The first run is attempt #1. `pointer.retryCount` starts
> at `0` and is incremented once per failed strategy application (existing behaviour at
> `execution-result-processor.ts:94`).

1. **Retry-count semantics.** `pointer.retryCount` counts *failed attempts that have been processed by
   the error strategy*. After the first failure it is `1`. The budget compares `retryCount` against the
   **resolved `maxRetries`** (see §5.2 precedence). `maxRetries` is the number of **re-tries** allowed
   *after* the first failure — i.e. total attempts = `maxRetries + 1`.

2. **Exact-N then dead-letter (Retry strategy).** With resolved `maxRetries = N`, a permanently-failing
   step is executed exactly `N + 1` times. On attempts `1..N` the engine sets
   `pointer.status = PointerStatus.Failed`, schedules `pointer.sleepUntil = Date.now() + interval`, and
   the workflow stays `Runnable`. On attempt `N + 1`, *before* scheduling another retry, the engine
   detects `pointer.retryCount >= maxRetries` and **dead-letters** instead of re-scheduling (see §6.5).
   With the default `N = 3`, the body runs 4 times total.

3. **Retry interval resolution.** The retry delay used by the `Retry` strategy is, in order:
   `step.retryInterval` if it is a finite number > 0; else `IRetryConfig.defaultRetryInterval`.
   (`onError(Retry)` with no interval sets `step.retryInterval = null`, which falls through to the
   config default — fixes the latent `Date.now()+null` bug.)

4. **Default-strategy budget.** The `default` branch of `selectErrorStrategy` (no recognised
   `errorBehavior`) is treated identically to `Retry` for budgeting: it retries with
   `IRetryConfig.defaultRetryInterval` until `retryCount >= maxRetries`, then dead-letters. The literal
   `60000` is removed.

5. **Dead-letter transition (the give-up action).** When the budget is exhausted the engine performs,
   atomically within the same execution pass:
   - `pointer.active = false`
   - `pointer.status = PointerStatus.DeadLettered`
   - `pointer.endTime = new Date()` (if not already set)
   - `workflow.status = WorkflowStatus.DeadLettered`
   - emit exactly one `WorkflowDeadLetteredEvent` via `ILifecycleEventHub.emit(...)`, with
     `errorMessage` = the `message` of the last entry in `pointer.persistenceData._errors` (or `null`),
     `retryCount` = `pointer.retryCount`, `maxRetries` = resolved budget.
   - The pointer's `sleepUntil` is **not** advanced.

6. **Dead-lettered workflow stops consuming the queue.** Because `workflow.status` is no longer
   `Runnable`: (a) `WorkflowQueueWorker.processWorkflow` skips execution (its `if (instance.status ==
   WorkflowStatus.Runnable)` guard, `workflow-queue-worker.ts:65`); (b) the re-queue branch
   (`workflow-queue-worker.ts:83`) is not taken because it also requires `Runnable`; (c)
   `getRunnableInstances()` excludes it (`memory-persistence-provider.ts:28`). The workflow is executed
   **zero** further times after dead-lettering. `determineNextExecutionTime` must leave a dead-lettered
   instance alone — see §6.10.

7. **Compensate path keeps a budget too, without changing compensation behaviour.** Inside
   `compensate()` (`execution-result-processor.ts:97`), the recursive call
   `this.selectErrorStrategy(this.isNull(step.errorBehavior, WorkflowErrorHandling.Retry), …)` for a
   non-compensating inner step now flows through the same budgeted `Retry` logic. The *compensation
   mechanics* (building compensation pointers, revert of siblings) are unchanged. Only the case where an
   inner step is itself in `Retry` and exhausts its budget changes: it dead-letters rather than
   retrying forever. The two existing saga scenarios do not exercise that branch (their failing steps
   are inside a `saga(...)` and resolve via `Compensate`), so they are unaffected — see §6.8.

8. **Existing strategies unchanged.**
   - `WorkflowErrorHandling.Suspend` → `workflow.status = Suspended` (unchanged).
   - `WorkflowErrorHandling.Terminate` → `workflow.status = Terminated` (unchanged).
   - `WorkflowErrorHandling.Compensate` → runs `compensate(...)` (unchanged).
   The named regression scenarios that must still pass: `core/spec/scenarios/saga-compensation.spec.ts`
   ("saga compensation scenario" and "saga revert scenario"), and all other scenario specs
   (`basic-workflow`, `if`, `while`, `foreach`, `parallel`, `outcome-fork`, `delay`, `schedule`,
   `external-events`, `data-io`).

9. **"Step not found" path.** In `workflow-executor.ts`, the else branch uses
   `IRetryConfig.stepNotFoundRetryInterval` instead of `60000`, and increments
   `pointer.retryCount`; once `pointer.retryCount >= IRetryConfig.defaultMaxRetries` (there is no step
   object to read `maxRetries` from, so the global default applies), it dead-letters the pointer and
   workflow exactly as §6.5. (This makes the `//todo: make configurable` resolved and bounds the loop.)

10. **`determineNextExecutionTime` must not resurrect a dead-lettered instance.** It currently early-
    returns only for `WorkflowStatus.Complete` (`workflow-executor.ts:133`). Add an equivalent early
    return for `WorkflowStatus.DeadLettered` (and, defensively, `Suspended`/`Terminated` already never
    reach it because the queue worker guards on `Runnable`, but the executor's own pass can flip status
    mid-iteration). Concretely: if `instance.status === WorkflowStatus.DeadLettered`, set
    `instance.nextExecution = null` and return.

11. **Idempotency.** Dead-lettering is terminal and one-shot: once `workflow.status === DeadLettered`,
    no further execution pass occurs (§6.6), so the event is emitted exactly once per workflow. The
    emit happens inside the execution pass that is already holding the workflow lock (the queue worker
    acquires the lock before `executor.execute`), so there is no double-emit under contention.

12. **Event handler isolation.** A lifecycle handler that throws must not affect engine state or
    persistence (`LifecycleEventHub.emit` swallows handler errors — §5.4).

## 7. Provider parity

**No core interface (`IPersistenceProvider`/`IQueueProvider`/`IDistributedLockProvider`) signature
changes.** The only at-rest change is that `WorkflowInstance.status` and `ExecutionPointer.status` may
now contain new numeric values (`4` / `8`). These are existing numeric fields already serialized by
every provider; no schema or query change is required for correctness because:

- `getRunnableInstances()` filters with `status === WorkflowStatus.Runnable` (inclusion test), so a new
  non-runnable value is automatically excluded — it does not need to be enumerated.

| Provider | Change required |
|---|---|
| memory | None. Stores `status` verbatim. |
| sqlite | None (provider not yet landed — C2). |
| postgres | None for correctness. **Note:** the `status` column already stores integers; the new values fit. No migration. |
| mongodb | None. Stores `status` as a number. |
| redis | None. |
| azure | None. |

> Providers must NOT be edited in this PR. If any provider is later found to hard-code an exhaustive
> status whitelist (none do today), that is tracked under M2/C3.

## 8. Test plan (TDD)

Tests follow the existing scenario style in `core/spec/scenarios/`: configure a host with a
`MemoryPersistenceProvider`, register a workflow, `startWorkflow`, then `spinWait` until the instance
leaves the `Runnable` state. Use the `spinWait` promise helper from
`core/spec/helpers/spin-wait.ts` (its callback-style sibling is `spinWaitCallback(until, done)` in the
same file — use whichever matches your test signature; the scenario specs use the promise `spinWait`).
To make retries fast and deterministic, configure tiny intervals via `config.useRetryConfig(...)`.

### Failing-test-first
- **`dead-letter.spec.ts` › "permanently failing step dead-letters after exactly maxRetries and emits
  one event"** — *must fail before implementation* (today the workflow loops forever and never leaves
  `Runnable`; `WorkflowStatus.DeadLettered` does not exist).
  - **arrange:** A workflow `dead-letter-workflow` whose single step body increments a module counter
    then `throw new Error("always fails")`. The step uses `.onError(WorkflowErrorHandling.Retry, 50, 2)`
    (interval 50ms, maxRetries 2). `config.useRetryConfig({ defaultRetryInterval: 50, defaultMaxRetries: 2 })`.
    `config.onLifecycleEvent(evt => events.push(evt))`.
  - **act:** `startWorkflow`; `await spinWait(async () => { instance = await persistence.getWorkflowInstance(id);
    return instance.status === WorkflowStatus.DeadLettered; })`.
  - **assert:** `counter === 3` (maxRetries 2 ⇒ 3 total attempts, proves §6.2);
    `instance.status === WorkflowStatus.DeadLettered`;
    the offending pointer `.status === PointerStatus.DeadLettered` and `.active === false` (§6.5);
    `events.length === 1` and `events[0].event === "workflow.dead-lettered"` with
    `events[0].maxRetries === 2`, `events[0].retryCount === 2`, `events[0].errorMessage === "always fails"`
    (§6.5/§6.11).

### Coverage
- **`dead-letter.spec.ts` › "dead-lettered workflow stops consuming the queue"** — after dead-letter,
  record `counter`, wait an extra `>= 3 * interval` via `spinWait`, assert `counter` is unchanged and
  `getRunnableInstances()` does not include the id (proves §6.6).
- **`retry.spec.ts` › "Retry strategy retries up to the budget then dead-letters"** — step fails the
  first 2 attempts then would succeed on the 3rd, but `maxRetries = 1` ⇒ it dead-letters after attempt
  2 (counter === 2, status DeadLettered). Then a sibling test where the step *succeeds* on attempt 2
  with `maxRetries = 3` ⇒ workflow completes, status `Complete`, counter === 2 (proves §6.1/§6.2 and
  that a recovering step is not dead-lettered).
- **`dead-letter.spec.ts` › "step-not-found path dead-letters after the global budget"** — construct an
  instance whose pointer references a non-existent `stepId` (build a workflow, then mutate the genesis
  pointer's `stepId` to an unused number before queueing, or register a definition then start and patch
  via persistence). `defaultMaxRetries = 1`, `stepNotFoundRetryInterval = 50`. Assert it reaches
  `DeadLettered` and emits the event (proves §6.9). *If patching the instance is impractical in the
  scenario harness, this case may be a unit test against `WorkflowExecutor.execute` with a hand-built
  `WorkflowInstance` + a registered empty definition.*
- **Regression — `saga-compensation.spec.ts`** must still pass unmodified: "saga compensation scenario"
  (compensation runs once, post-saga step runs once, status `Complete`) and "saga revert scenario"
  (siblings reverted, status `Complete`) — proves §6.7/§6.8 (Compensate unchanged).
- **Regression — `delay.spec.ts`, `schedule.spec.ts`, `external-events.spec.ts`** still pass — proves
  `sleepUntil`/`WaitingForEvent` paths are untouched (these set `pointer.status` to `Sleeping`/
  `WaitingForEvent`, never the error path).
- **Suspend/Terminate** — add `retry.spec.ts` cases: a failing step with
  `.onError(WorkflowErrorHandling.Suspend)` ends `Suspended` (not `DeadLettered`); with `.Terminate`
  ends `Terminated` — proves §6.8.

### How to run
```bash
cd core && yarn build
cd core && yarn test                                   # full scenario suite
# single file (jasmine via the repo's spec config):
cd core && yarn test --filter="dead-letter*"           # if supported; otherwise run full suite
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds with the new model fields, status values, config, and hub.
- [ ] `cd core && yarn test` passes on Node 20 and 22, including the new `dead-letter.spec.ts` and
      `retry.spec.ts`.
- [ ] The failing-first test (`permanently failing step dead-letters after exactly maxRetries`) is shown
      to fail on the pre-change tree and pass after.
- [ ] A permanently-failing step with `maxRetries = N` executes its body exactly `N + 1` times, ends in
      `WorkflowStatus.DeadLettered`, emits exactly one `workflow.dead-lettered` event, and is executed
      zero further times (queue + poll), verified by the coverage tests.
- [ ] `grep -n "60000" core/src/services/execution-result-processor.ts core/src/services/workflow-executor.ts`
      returns no matches in the error-handling branches (magic numbers removed; only the model default
      `retryInterval = 60000` in `workflow-step.ts` may remain as the field default).
- [ ] All existing scenario specs (saga + the rest) pass unchanged.
- [ ] No provider package is modified; `git status providers/` shows no changes from this PR.

## 10. Backward compatibility & migration

- **Public API:** purely additive — new `WorkflowStatus.DeadLettered`, `PointerStatus.DeadLettered`,
  optional `maxRetries` on step/definition/builder, `onError(...)`'s optional third param,
  `WorkflowConfig.useRetryConfig` / `onLifecycleEvent`, `IWorkflowHost.onLifecycleEvent`. No existing
  signature changes; no member renumbered.
- **Behavioural change (intentional, documented):** workflows that previously retried *forever* on the
  default/Retry/step-not-found paths will now stop after `defaultMaxRetries` (default `3`) and
  dead-letter. This is the desired fix. Consumers relying on infinite retry must set a large
  `defaultMaxRetries` or per-step `maxRetries`. Call this out in the changelog.
- **At-rest:** no schema migration; new status integers fit existing numeric columns/fields.
- **Consumer `reactory-express-server`:** integrates via a `file:` tarball. It will see two new status
  values it may need to handle in any status-display logic, and may register a dead-letter handler. No
  breaking change to its current calls.
- **Version bump:** `2.3.6-reactory.3` → `2.3.6-reactory.4` (additive feature, no breaking API). Update
  `core/package.json` and the consumer tarball reference if this lands standalone.

## 11. Definition of Done

Every retry path in the engine — the explicit `Retry` strategy, the unrecognised-behaviour default
branch, and the "step not found" branch — now retries a finite, configurable number of times. On
exhausting its budget a workflow transitions to the new terminal `WorkflowStatus.DeadLettered` state,
marks the offending pointer `PointerStatus.DeadLettered`, records the final error, emits exactly one
`workflow.dead-lettered` lifecycle event through a minimal in-process hub, and is never executed or
re-queued again. `maxRetries` resolves step → definition → global-config, and all former `60000`
literals in the error paths are replaced by named config values (`defaultMaxRetries=3`,
`defaultRetryInterval=60000`, `stepNotFoundRetryInterval=60000`). The new `dead-letter.spec.ts` and
`retry.spec.ts` pass, the failing-first test was demonstrably red before the change, every existing
scenario (notably both saga scenarios, `Suspend`, `Terminate`, `delay`, `schedule`, `external-events`)
still passes, no provider package is touched, and `core` builds and tests green on Node 20 + 22.

## 12. Implementation notes (optional, non-binding)

- **Suggested edit order:** (1) models (`workflow-status`, `execution-pointer`, `workflow-step`,
  `workflow-definition`); (2) abstractions (`types.ts`, new `lifecycle-events.ts` interfaces + barrel
  export); (3) concrete `retry-config.ts` + `lifecycle-events.ts`; (4) `config.ts` bindings + helpers;
  (5) `execution-result-processor.ts` budget + dead-letter; (6) `workflow-executor.ts` step-not-found
  branch + `determineNextExecutionTime` early-return; (7) builders; (8) tests.
- **Barrel paths to verify before editing:** the models barrel is `core/src/models.ts` (a flat file,
  not `models/index.ts`) and it already re-exports `workflow-status`, `workflow-step`,
  `workflow-definition`, `execution-pointer`. The abstractions barrel is `core/src/abstractions.ts`
  (confirm; the imports use `from "../abstractions"`). Add the new
  `lifecycle-events` re-export wherever `types.ts` is re-exported. Run
  `grep -rn "execution-pointer-factory\|workflow-host\"" core/src/abstractions.ts` to find the existing
  re-export list and append alongside it.
- **Budget helper:** factor the precedence (`step.maxRetries ?? definition.maxRetries ??
  retryConfig.defaultMaxRetries`) into a small private method on `ExecutionResultProcessor`, e.g.
  `resolveMaxRetries(step, definition)`, and `resolveRetryInterval(step)` for the interval. Keep it
  pure.
- **Where to put the budget check in `selectErrorStrategy`:** at the top of the `Retry` and `default`
  cases, compute `maxRetries = resolveMaxRetries(...)`; if `pointer.retryCount >= maxRetries`, call a
  new private `deadLetter(workflow, definition, pointer, step, maxRetries)` and `return` (so
  `pointer.retryCount++` at the bottom is skipped for the terminal case). Otherwise proceed to schedule
  the retry, then `retryCount++` as today.
- **Reading the last error for the event payload:** the executor already pushes `{ message, stack,
  errorTime, retryCount }` to `pointer.persistenceData._errors` (`workflow-executor.ts:99`). Read
  `_errors[_errors.length - 1]?.message`.
- **Upstream reference:** the canonical `danielgerlag/workflow-es` has no dead-letter state; this is a
  Reactory enhancement. Keep the new state numbering append-only so any future upstream sync is clean.
