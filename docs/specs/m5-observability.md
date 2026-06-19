# Spec — M5 · OpenTelemetry tracing + metrics + health

| Field | Value |
|---|---|
| **Item ID** | M5 |
| **Title** | OpenTelemetry tracing + metrics + health |
| **Plan reference** | [`upgrade-plan.md` → M5](../upgrade-plan.md) |
| **Target** | Cloud (additive; Electron must keep running with zero OTel deps) |
| **Severity** | Medium |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | H1 (in-flight count / active set), H4 (async lifecycle: `start()`/`stop()` already `Promise<void>`, worker `stop(timeoutMs)`) |
| **Author / reviewer** | claude / wweber |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. A `WorkflowHost`
(`core/src/services/workflow-host.ts`) owns three background workers — `WorkflowQueueWorker`,
`EventQueueWorker`, `PollWorker` (`core/src/services/*-worker.ts`) — that drain queues and drive a
`WorkflowExecutor` (`core/src/services/workflow-executor.ts`). The executor runs each workflow step
by resolving the step body from the DI container and calling `body.run(stepContext)`
(`workflow-executor.ts:76`).

**The problem: the engine is operationally blind.** For a horizontally-scaled cloud runner there is
**no telemetry of any kind**:

- **No traces.** There is no span around step execution. `await body.run(stepContext)`
  (`workflow-executor.ts:76`) runs with no timing, no correlation, no parent/child span linkage.
  When a step is slow or a workflow stalls there is no distributed trace to inspect.
- **No metrics.** Nothing counts active workflow instances, queue depth, step duration, or
  error/retry rates. The only signal today is the logger, and the **default logger is `NullLogger`**
  (`core/src/config.ts:40` binds `TYPES.ILogger` to `NullLogger`), which discards everything. So a
  default-configured host emits *nothing*.
- **No health/readiness.** `WorkflowHost` (`core/src/abstractions/workflow-host.ts`) exposes
  `start`, `stop`, `startWorkflow`, `publishEvent`, `suspend/resume/terminateWorkflow` — but **no
  way to ask "is this host healthy?"**. A Kubernetes liveness/readiness probe or an Electron status
  panel has nothing to call. If the persistence DB, the distributed lock provider, or the queue
  becomes unreachable, the host keeps "running" (timers keep firing) while silently failing every
  cycle — the only trace is `logger.error(...)` swallowed by `NullLogger`.

**Hard constraint — desktop must not pay for the cloud.** The engine is also a supported
Electron/desktop target that must run in a single process with **zero external infrastructure and no
heavy dependencies** (upgrade-plan §2.1). Therefore **`core` must NOT hard-depend on
`@opentelemetry/*`**. OTel must be entirely optional and injected; the default build must pull in no
OTel packages and emit nothing (or no-ops) until an adapter is wired in.

**Relationship to sibling items (compose, do not duplicate).**
- **H1** introduced a tracked in-flight set on the queue workers and the `IBackgroundWorker`
  introspection methods `getActiveCount(): number` / `getActiveIds(): string[]`
  (`core/src/abstractions/background-worker.ts`). M5 **reads** that count for the
  `workflowes.workflow.active` metric — it does **not** introduce a second counter.
- **H4** made `IWorkflowHost.start()`/`stop()` async (`Promise<void>`) and `IBackgroundWorker.stop()`
  take `stop(timeoutMs): Promise<void>`, and centralised signal handling. M5 binds its metrics/tracer
  at host construction and tears nothing extra down — `stop()` semantics are unchanged by M5.
- **M4** (structured logging, *not yet landed*) will rework `ILogger`. M5 must **not** change
  `ILogger` and must keep logging separate from metrics/tracing. M5 adds *new* abstractions
  (`IMetrics`, `ITracer`); it does not fold telemetry into the logger.

### User-visible impact

Operators cannot see throughput, latency, error rates, or queue backlog; they cannot wire a
readiness probe; a degraded provider (DB down, Redis lock unreachable) is invisible until workflows
silently stop progressing.

## 2. Goal

After this change, `core` exposes two new **optional, no-op-by-default** observability abstractions —
`IMetrics` (counters/gauges/histograms) and `ITracer` (a minimal span hook) — bound in the DI
container to **no-op implementations by default** so a default host stays zero-dependency and emits
nothing. The `WorkflowExecutor` wraps each `body.run(...)` in a span (with `workflowId`/`stepId`
attributes) and records step-duration / error / retry metrics; the workers and host record active
instance count and queue depth. `WorkflowHost` gains an async `health()` method returning a
structured status that reflects the reachability of the persistence, lock, and queue providers plus
the poll worker's heartbeat. An **optional, separate** OpenTelemetry adapter package
(`providers/workflow-es-opentelemetry`) implements `IMetrics`/`ITracer` against `@opentelemetry/api`
and is injected via the existing `WorkflowConfig` setters — `core` never imports `@opentelemetry/*`.
The Electron/single-process path keeps working with zero external infrastructure and no OTel
dependency.

## 3. Out of scope

- **Do NOT add `@opentelemetry/*` (or any OTel package) as a dependency, `peerDependency`, or
  `import` in `core`.** Not in `core/package.json`, not in any `core/src/**` file. (Acceptance §9
  greps for this.) The OTel adapter lives only in the new `providers/workflow-es-opentelemetry`
  package.
- **Do NOT modify `ILogger`** (`core/src/abstractions/logger.ts`) or any logging call site. Logging
  rework is M4. Metrics/traces are *separate* abstractions.
- **Do NOT change the bounded-concurrency mechanics** (H1) or add a second in-flight counter — read
  `IBackgroundWorker.getActiveCount()`. Do **not** change `getActiveCount`/`getActiveIds`.
- **Do NOT change `stop()`/`start()` drain semantics or signal handling** (H4). M5 only adds telemetry
  recording and a `health()` method; it does not alter lifecycle.
- **Do NOT change the lock-release / post-processing ordering** inside `processWorkflow` /
  `processEvent` (H2). Telemetry wrappers must not move existing lock/persist calls.
- **Do NOT add retry/dead-letter logic** (H5). M5 only *observes* retries via the existing
  `pointer.retryCount` field; it does not change retry behaviour.
- **Do NOT add an HTTP endpoint/server.** `health()` is a method returning a structured object; the
  consumer (`reactory-express-server`, an Electron status panel) exposes it however it likes. No
  `express`/`http` dependency is added to `core`.
- **Do NOT change `configureWorkflow()`'s signature beyond what H1/H4 already established.** Add
  telemetry via new `WorkflowConfig` setter methods (see §5), not new positional args.
- **Do NOT change any `IPersistenceProvider`/`IDistributedLockProvider`/`IQueueProvider` *required*
  method.** The provider health probe is **optional** (see §7) — providers that do not implement it
  are inferred as healthy/unknown, never broken.

## 4. Files to create / modify

> Exhaustive. The barrels are the single files `core/src/abstractions.ts` and `core/src/services.ts`
> (there is **no** `core/src/abstractions/index.ts`). The DI symbol table is
> `core/src/abstractions/types.ts` (`TYPES`).

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/metrics.ts` | create | `IMetrics` interface (counters/gauges/histograms) + the metric name/unit constants. |
| `core/src/abstractions/tracer.ts` | create | `ITracer` + `ISpan` minimal span hook interface. |
| `core/src/abstractions/health.ts` | create | `HealthStatus`, `HealthReport`, `ComponentHealth`, and the optional `IHealthProbe` provider mixin interface. |
| `core/src/abstractions/types.ts` | modify | Add `IMetrics`, `ITracer` symbols to `TYPES`. |
| `core/src/abstractions.ts` | modify | Barrel-export the three new files. |
| `core/src/abstractions/workflow-host.ts` | modify | Add `health(): Promise<HealthReport>` to `IWorkflowHost`. |
| `core/src/services/no-op-metrics.ts` | create | `NoOpMetrics implements IMetrics` (default binding). |
| `core/src/services/no-op-tracer.ts` | create | `NoOpTracer implements ITracer` (default binding). |
| `core/src/services.ts` | modify | Barrel-export `no-op-metrics` and `no-op-tracer`. |
| `core/src/services/workflow-executor.ts` | modify | Inject `ITracer`+`IMetrics`; wrap `body.run` in a span; record step duration / error / retry metrics. |
| `core/src/services/workflow-host.ts` | modify | Inject `IMetrics`; implement `health()`; set the active-instance gauge from worker `getActiveCount()`. |
| `core/src/services/poll-worker.ts` | modify | Record a `lastPollAt` heartbeat timestamp on each poll tick and expose it for `health()`; record queue-depth gauge if the queue exposes a depth probe. |
| `core/src/services/workflow-queue-worker.ts` | modify | Record `workflowes.queue.depth` (workflow) and active-count gauge via injected `IMetrics`. |
| `core/src/services/event-queue-worker.ts` | modify | Record `workflowes.queue.depth` (event) via injected `IMetrics`. |
| `core/src/abstractions/queue-provider.ts` | modify | Add **optional** `getQueueLength?(queue: QueueType): Promise<number>` to `IQueueProvider` (see §5/§7). |
| `core/src/config.ts` | modify | Bind `NoOpMetrics`/`NoOpTracer` by default; add `WorkflowConfig.useMetrics(...)` / `useTracer(...)`. |
| `core/src/services/poll-worker.ts` (heartbeat accessor) | (covered above) | Expose `getLastPollAt(): number \| null`. |
| `providers/workflow-es-opentelemetry/package.json` | create | New optional adapter package; `@opentelemetry/api` as a `peerDependency`; `@reactorynet/workflow-es` as `peerDependency`. |
| `providers/workflow-es-opentelemetry/tsconfig.json` | create | Mirror `providers/workflow-es-postgres/tsconfig.json`. |
| `providers/workflow-es-opentelemetry/src/index.ts` | create | Barrel re-exporting the adapter classes. |
| `providers/workflow-es-opentelemetry/src/otel-metrics.ts` | create | `OpenTelemetryMetrics implements IMetrics` over `@opentelemetry/api` `metrics`. |
| `providers/workflow-es-opentelemetry/src/otel-tracer.ts` | create | `OpenTelemetryTracer implements ITracer` over `@opentelemetry/api` `trace`. |
| `providers/workflow-es-opentelemetry/README.md` | create | Usage: install peer deps, `config.useMetrics(...)`, `config.useTracer(...)`. |
| `core/spec/scenarios/observability.spec.ts` | create | Tests: fake metrics/tracer records expected spans/metrics; `health()` reflects an unreachable provider. See §8. |
| `core/spec/helpers/fake-telemetry.ts` | create | In-spec `FakeMetrics`/`FakeTracer` recorders + a `BrokenPersistenceProvider` test double. |
| `docs/upgrade-plan.md` | modify | Flip M5 status `planned → spec` in the §3 roadmap table (bookkeeping only). |
| `core/package.json` | modify | Version bump (see §10). |

## 5. Interface & data-model changes

### 5.1 `IMetrics` — `core/src/abstractions/metrics.ts` (create)

A deliberately tiny, synchronous, push-style metrics facade. No OTel types leak into it.

```ts
// AFTER (new file)

/** Key/value labels attached to a metric sample. Values stringified by the adapter. */
export type MetricAttributes = { [key: string]: string | number | boolean };

/**
 * Minimal metrics facade. The default binding (NoOpMetrics) discards everything,
 * so core has zero metrics dependency. An optional adapter (e.g. the
 * workflow-es-opentelemetry package) maps these calls onto a real SDK.
 *
 * Implementations MUST NOT throw — a failing metrics backend must never break
 * workflow execution. Adapters swallow/So log their own errors internally.
 */
export interface IMetrics {
    /** Monotonic counter increment (default delta = 1). e.g. workflows started, errors, retries. */
    incrementCounter(name: string, value?: number, attributes?: MetricAttributes): void;
    /** Set an absolute gauge value. e.g. active instances, queue depth. */
    recordGauge(name: string, value: number, attributes?: MetricAttributes): void;
    /** Record a value into a distribution. e.g. step duration in milliseconds. */
    recordHistogram(name: string, value: number, attributes?: MetricAttributes): void;
}

/** Canonical metric names. Exported so adapters and tests share one source of truth. */
export const METRIC_NAMES = {
    WORKFLOW_STARTED: "workflowes.workflow.started",          // counter, {1}
    WORKFLOW_ACTIVE: "workflowes.workflow.active",            // gauge, {1}
    STEP_DURATION: "workflowes.step.duration",                // histogram, ms
    STEP_ERRORS: "workflowes.step.errors",                    // counter, {1}
    STEP_RETRIES: "workflowes.step.retries",                  // counter, {1}
    EVENT_PUBLISHED: "workflowes.event.published",            // counter, {1}
    QUEUE_DEPTH: "workflowes.queue.depth",                    // gauge, {1}
} as const;

/** Units (UCUM-ish) for each metric, for adapters that register instruments with units. */
export const METRIC_UNITS: { [name: string]: string } = {
    [METRIC_NAMES.WORKFLOW_STARTED]: "{workflow}",
    [METRIC_NAMES.WORKFLOW_ACTIVE]: "{workflow}",
    [METRIC_NAMES.STEP_DURATION]: "ms",
    [METRIC_NAMES.STEP_ERRORS]: "{error}",
    [METRIC_NAMES.STEP_RETRIES]: "{retry}",
    [METRIC_NAMES.EVENT_PUBLISHED]: "{event}",
    [METRIC_NAMES.QUEUE_DEPTH]: "{item}",
};

/** Standard attribute keys used across spans and metrics. */
export const ATTR = {
    WORKFLOW_ID: "workflow.id",
    WORKFLOW_DEFINITION_ID: "workflow.definition.id",
    WORKFLOW_VERSION: "workflow.version",
    STEP_ID: "workflow.step.id",
    STEP_NAME: "workflow.step.name",
    QUEUE: "workflow.queue",           // "workflow" | "event"
} as const;
```

### 5.2 `ITracer` / `ISpan` — `core/src/abstractions/tracer.ts` (create)

A minimal span hook. We deliberately do **not** model OTel context propagation, baggage, or links —
only "start a span, set attributes, mark error, end". The adapter maps this onto a real tracer.

```ts
// AFTER (new file)
import { MetricAttributes } from "./metrics";

export interface ISpan {
    /** Add/replace an attribute on the span. */
    setAttribute(key: string, value: string | number | boolean): void;
    /** Mark the span as errored and (optionally) attach the error. Does not end the span. */
    recordError(error: Error): void;
    /** End the span. MUST be safe to call exactly once; subsequent calls are ignored. */
    end(): void;
}

/**
 * Minimal tracing facade. Default binding (NoOpTracer) returns a no-op span,
 * so core has zero tracing dependency. Implementations MUST NOT throw.
 */
export interface ITracer {
    /**
     * Start a span. The returned span MUST be ended by the caller (in a finally).
     * `attributes` are the initial attributes (e.g. workflow.id, workflow.step.id).
     */
    startSpan(name: string, attributes?: MetricAttributes): ISpan;
}

/** Canonical span names. */
export const SPAN_NAMES = {
    STEP_EXECUTE: "workflowes.step.execute",   // wraps body.run(...)
} as const;
```

### 5.3 Health types — `core/src/abstractions/health.ts` (create)

```ts
// AFTER (new file)

export enum HealthStatus {
    Healthy = "healthy",
    Degraded = "degraded",     // host runs, but at least one component is unreachable/unknown-bad
    Unhealthy = "unhealthy",   // a required component is down
}

/** Per-component health detail. */
export interface ComponentHealth {
    /** Logical component name: "persistence" | "lock" | "queue" | "poll". */
    name: string;
    status: HealthStatus;
    /** Optional human-readable detail (e.g. an error message). */
    detail?: string;
    /** Optional measured latency of the probe, in ms. */
    latencyMs?: number;
}

/** Aggregate host health report returned by IWorkflowHost.health(). */
export interface HealthReport {
    /** Worst-of the component statuses. */
    status: HealthStatus;
    /** ISO-8601 timestamp the report was produced. */
    timestamp: string;
    /** Number of workflow executions currently in flight (from worker getActiveCount). */
    activeWorkflows: number;
    /** Epoch ms of the last completed poll cycle, or null if the poll worker has not yet run. */
    lastPollAt: number | null;
    components: ComponentHealth[];
}

/**
 * OPTIONAL provider health probe. Persistence/lock/queue providers MAY implement
 * this to give health() a real reachability signal. Providers that do not
 * implement it are reported with HealthStatus.Healthy and detail "probe not implemented"
 * (i.e. health is inferred, never assumed broken). MUST resolve quickly and MUST NOT throw
 * for "unhealthy" — throwing/ rejecting is treated as Unhealthy with the error message.
 */
export interface IHealthProbe {
    /** Cheap reachability check (e.g. SELECT 1 / PING). Resolve true if reachable. */
    ping(): Promise<boolean>;
}

/** Runtime type-guard: does a provider implement the optional IHealthProbe? */
export function isHealthProbe(x: unknown): x is IHealthProbe {
    return !!x && typeof (x as IHealthProbe).ping === "function";
}
```

### 5.4 `IQueueProvider` — add optional depth probe — `core/src/abstractions/queue-provider.ts` (modify)

```ts
// BEFORE
export interface IQueueProvider {
    queueForProcessing(id: string, queue: QueueType): Promise<void>;
    dequeueForProcessing(queue: QueueType): Promise<string>;
}

// AFTER
export interface IQueueProvider {
    queueForProcessing(id: string, queue: QueueType): Promise<void>;
    dequeueForProcessing(queue: QueueType): Promise<string>;
    /**
     * OPTIONAL. Current number of items waiting in the given queue. Used only for the
     * workflowes.queue.depth gauge. Optional so existing providers need not implement it;
     * when absent, the depth gauge is simply not recorded.
     */
    getQueueLength?(queue: QueueType): Promise<number>;
}
```

> `getQueueLength` is added as an **optional** member (`?`), so no existing provider is forced to
> implement it and no provider PR is required for M5 to land (see §7). The in-core
> `SingleNodeQueueProvider` SHOULD implement it (it holds two arrays — trivial) so the
> single-process metric works out of the box; that is the only provider M5 touches.

### 5.5 `IWorkflowHost.health()` — `core/src/abstractions/workflow-host.ts` (modify)

```ts
// BEFORE
export interface IWorkflowHost {
    start(): Promise<void>;
    stop(): Promise<void>;            // H4 already changed this to Promise<void>
    startWorkflow(id: string, version: number, data: any): Promise<string>;
    registerWorkflow<TData>(workflow: new () => WorkflowBase<TData>): void;
    publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void>;
    suspendWorkflow(id: string): Promise<boolean>;
    resumeWorkflow(id: string): Promise<boolean>;
    terminateWorkflow(id: string): Promise<boolean>;
}

// AFTER
import { HealthReport } from "./health";

export interface IWorkflowHost {
    start(): Promise<void>;
    stop(): Promise<void>;
    startWorkflow(id: string, version: number, data: any): Promise<string>;
    registerWorkflow<TData>(workflow: new () => WorkflowBase<TData>): void;
    publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void>;
    suspendWorkflow(id: string): Promise<boolean>;
    resumeWorkflow(id: string): Promise<boolean>;
    terminateWorkflow(id: string): Promise<boolean>;
    /**
     * Produce a point-in-time health report: probes the persistence, lock, and queue
     * providers (via the optional IHealthProbe), reports active workflow count and the
     * poll-worker heartbeat, and computes the worst-of aggregate status. Never throws.
     */
    health(): Promise<HealthReport>;
}
```

> If H4 is not yet `done` in the branch this lands on, `stop()` may still be `void`; M5 must **not**
> change `stop()`'s signature either way — leave it exactly as the branch has it.

### 5.6 No-op default implementations

```ts
// core/src/services/no-op-metrics.ts (create)
import { injectable } from "inversify";
import { IMetrics, MetricAttributes } from "../abstractions";

@injectable()
export class NoOpMetrics implements IMetrics {
    public incrementCounter(_name: string, _value?: number, _attributes?: MetricAttributes): void {}
    public recordGauge(_name: string, _value: number, _attributes?: MetricAttributes): void {}
    public recordHistogram(_name: string, _value: number, _attributes?: MetricAttributes): void {}
}

// core/src/services/no-op-tracer.ts (create)
import { injectable } from "inversify";
import { ITracer, ISpan, MetricAttributes } from "../abstractions";

const NOOP_SPAN: ISpan = {
    setAttribute() {},
    recordError() {},
    end() {},
};

@injectable()
export class NoOpTracer implements ITracer {
    public startSpan(_name: string, _attributes?: MetricAttributes): ISpan {
        return NOOP_SPAN;
    }
}
```

### 5.7 DI symbols — `core/src/abstractions/types.ts` (modify)

```ts
// BEFORE
let TYPES = {
    IWorkflowRegistry: Symbol("IWorkflowRegistry"),
    // ... existing ...
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory")
    // (H1 added WorkerPoolConfig; H4 added GracefulShutdownTimeoutMs — keep whatever the branch has)
};

// AFTER (append two symbols; keep all existing ones)
let TYPES = {
    IWorkflowRegistry: Symbol("IWorkflowRegistry"),
    // ... existing ...
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory"),
    IMetrics: Symbol("IMetrics"),
    ITracer: Symbol("ITracer")
};
```

### 5.8 DI / config wiring — `core/src/config.ts` (modify)

In the `ContainerModule`, bind no-op defaults (keep all existing binds):

```ts
bind<IMetrics>(TYPES.IMetrics).to(NoOpMetrics).inSingletonScope();
bind<ITracer>(TYPES.ITracer).to(NoOpTracer).inSingletonScope();
```

Add two setters on `WorkflowConfig` (mirroring `useLogger`/`usePersistence`):

```ts
public useMetrics(service: IMetrics) {
    this.container.rebind<IMetrics>(TYPES.IMetrics).toConstantValue(service);
}

public useTracer(service: ITracer) {
    this.container.rebind<ITracer>(TYPES.ITracer).toConstantValue(service);
}
```

`configureWorkflow()` keeps the signature the branch already has (H4 may have given it an optional
`options` argument). **No new positional argument is added by M5.**

### Persisted / at-rest format impact

None. Nothing new is written to any provider. Metrics/spans are emitted in-process; `health()` is
computed on demand. `IQueueProvider.getQueueLength` reads, never writes.

## 6. Behavioural contract (numbered rules)

1. **Span wraps each `body.run`.** `WorkflowExecutor.execute` MUST start a span named
   `SPAN_NAMES.STEP_EXECUTE` (`"workflowes.step.execute"`) immediately before
   `await body.run(stepContext)` (`workflow-executor.ts:76`) and `end()` it in a `finally` that runs
   on both success and failure. The span MUST carry at least these initial attributes:
   `ATTR.WORKFLOW_ID = instance.id`, `ATTR.STEP_ID = String(step.id)`,
   `ATTR.WORKFLOW_DEFINITION_ID = instance.workflowDefinitionId`,
   `ATTR.WORKFLOW_VERSION = instance.version`, and `ATTR.STEP_NAME = step.name` when present. On the
   `catch` path it MUST call `span.recordError(error)` before `end()`. (Proves: §8 "records a span
   per step".)
2. **Step-duration histogram.** For each `body.run`, the executor MUST record
   `METRIC_NAMES.STEP_DURATION` (unit `ms`) as the wall-clock milliseconds from just before to just
   after `body.run`, with attributes `{ [ATTR.WORKFLOW_DEFINITION_ID]: ..., [ATTR.STEP_ID]: ... }`.
   Recorded on **both** success and failure (in the same `finally` that ends the span). (Proves: §8
   "records step duration".)
3. **Error counter.** On the executor's `catch (err)` path (`workflow-executor.ts:85`), it MUST
   `incrementCounter(METRIC_NAMES.STEP_ERRORS, 1, { definitionId, stepId })` exactly once per caught
   step error. (Proves: §8 "records an error metric on a failing step".)
4. **Retry counter.** When a step is retried — i.e. the result processor re-runs a pointer whose
   `pointer.retryCount > 0` — the executor MUST `incrementCounter(METRIC_NAMES.STEP_RETRIES, 1, ...)`
   once per retry attempt. Concretely: at the top of the per-pointer loop body in `execute`, if
   `pointer.retryCount && pointer.retryCount > 0`, increment the retry counter before running the
   step. M5 does NOT change retry *behaviour* (that is H5); it only counts the existing field.
   (Proves: §8 "records a retry metric when a step is retried".)
5. **Workflow-started counter.** `WorkflowHost.startWorkflow` MUST
   `incrementCounter(METRIC_NAMES.WORKFLOW_STARTED, 1, { [ATTR.WORKFLOW_DEFINITION_ID]: def.id })`
   exactly once per successful `createNewWorkflow`, after the instance is persisted. (Proves: §8
   "counts started workflows".)
6. **Event-published counter.** `WorkflowHost.publishEvent` MUST
   `incrementCounter(METRIC_NAMES.EVENT_PUBLISHED, 1, { event.name })` once per published event.
7. **Active-workflows gauge.** On each `WorkflowQueueWorker` poll cycle the worker MUST
   `recordGauge(METRIC_NAMES.WORKFLOW_ACTIVE, this.getActiveCount())`. This reads the H1 in-flight
   count; M5 introduces **no** new counter for this. (Proves: §8 "reports active workflow gauge".)
8. **Queue-depth gauge.** On each queue-worker poll cycle, IF the bound `IQueueProvider` implements
   `getQueueLength` (runtime `typeof queueProvider.getQueueLength === "function"`), the worker MUST
   `recordGauge(METRIC_NAMES.QUEUE_DEPTH, await getQueueLength(queue), { [ATTR.QUEUE]: "workflow"|"event" })`.
   If the provider does not implement it, the gauge is simply skipped (no error). (Proves: §8
   "reports queue depth when supported".)
9. **Poll heartbeat.** `PollWorker` MUST record the epoch-ms time at the **end** of each successful
   `process` tick into an instance field `lastPollAt: number`, and expose
   `getLastPollAt(): number | null` (null before the first tick). `health()` reads it. (Proves: §8
   "health reflects poll heartbeat".)
10. **`health()` probes each provider.** `WorkflowHost.health()` MUST, for each of persistence, lock,
    and queue providers: if the provider implements `IHealthProbe` (via `isHealthProbe`), `await`
    `ping()` (timing it for `latencyMs`); map `true → Healthy`, `false → Unhealthy`, a thrown/rejected
    probe `→ Unhealthy` with `detail = error.message`. If the provider does **not** implement
    `IHealthProbe`, report it `Healthy` with `detail = "probe not implemented"`. (Proves: §8
    "health reports per-component status".)
11. **`health()` aggregate is worst-of.** The top-level `HealthReport.status` MUST be the worst of all
    component statuses using ordering `Healthy < Degraded < Unhealthy`. If any required provider
    (persistence, lock, queue) is `Unhealthy`, the aggregate is `Unhealthy`. The poll component is
    `Degraded` (not `Unhealthy`) if `lastPollAt` is older than `3 ×` the poll interval (the poll
    interval default is 10000ms — see `poll-worker.ts:25` — so stale if `> 30000ms` old) or still
    null after the host has been started; a stale/missing poll alone yields aggregate `Degraded`, not
    `Unhealthy`. (Proves: §8 "health reflects an unreachable provider" + "degraded on stale poll".)
12. **`health()` never throws.** `health()` MUST always resolve to a `HealthReport`; any error while
    probing a single component is captured into that component's `ComponentHealth.detail` and status,
    never propagated. (Proves: §8 "health never throws".)
13. **Telemetry never breaks execution.** A throw from any `IMetrics`/`ITracer` call MUST NOT abort or
    alter workflow execution. Because `NoOpMetrics`/`NoOpTracer` cannot throw, the contract holds by
    default; adapters are documented to never throw. The executor SHOULD nonetheless call telemetry
    such that a metrics/tracer throw cannot escape the step (the `body.run` result is unaffected). At
    minimum, span `end()` is in a `finally`. (Proves: §8 "a throwing metrics impl does not fail the
    workflow".)
14. **Zero OTel in core.** `core` MUST NOT import, require, or declare any `@opentelemetry/*` package.
    Default-configured (`configureWorkflow()` with no telemetry setters) emits no-ops and pulls in no
    new runtime dependency. (Proves: §9 grep acceptance.)
15. **Attribute typing & null-safety.** Attribute values MUST be `string | number | boolean`;
    `step.id`/`instance.version` are coerced with `String(...)`/the numeric value as appropriate. A
    missing `step.name` MUST be omitted rather than set to `undefined`.

## 7. Provider parity

M5 changes **one** provider-facing interface, and only by **adding an optional member**:
`IQueueProvider.getQueueLength?(...)` (§5.4). Because it is optional (`?`), **no existing provider is
required to change and M5 can land without any provider PR.** The optional `IHealthProbe` (§5.3) is a
*new standalone* interface that providers MAY implement; it is **not** added to any existing required
provider interface, so again no provider is forced to change.

Decision (the §STEP-3 "decide" point): **add an OPTIONAL probe, do not make it mandatory, and do not
infer reachability from existing calls.** Rationale: making `ping()`/`getQueueLength()` mandatory
would force a same-PR change across all six providers (against the "land together" rule) for a
Medium-severity operability feature, and would break the constraint that M5 needs no provider PR.
Inferring health from the *last* `getWorkflowInstance`/`dequeue` call is unreliable (no recent call ⇒
unknown, and a cached success hides a now-down DB). An explicit optional probe is honest:
implemented ⇒ real signal; not implemented ⇒ reported `Healthy`/"probe not implemented".

**Impact statement:** only the in-core `SingleNodeQueueProvider` is updated in this PR (to implement
`getQueueLength`, trivially, from its in-memory arrays) so the single-process queue-depth metric
works out of the box. All external provider packages are untouched by M5 and continue to build. They
MAY add `IHealthProbe`/`getQueueLength` later (separate, optional follow-ups), gaining a real probe
signal; until then `health()` reports them `Healthy`/"probe not implemented".

| Provider | Change required (this PR) | Optional later |
|---|---|---|
| memory persistence (core) | none (MAY add `ping()` returning `true`) | `IHealthProbe.ping()` |
| SingleNodeQueueProvider (core) | **add `getQueueLength`** (in-memory array length) | `IHealthProbe.ping()` |
| SingleNodeLockProvider (core) | none | `IHealthProbe.ping()` |
| sqlite | none | `IHealthProbe.ping()` (`SELECT 1`) |
| postgres | none | `IHealthProbe.ping()` (`SELECT 1`), `getQueueLength` |
| mongodb | none | `IHealthProbe.ping()` (`db.admin().ping()`) |
| redis | none | `IHealthProbe.ping()` (`PING`), `getQueueLength` (`LLEN`) |
| azure | none | `IHealthProbe.ping()` |

> The new `providers/workflow-es-opentelemetry` package implements `IMetrics`/`ITracer`, **not** a
> persistence/lock/queue interface, so it is not part of provider-parity in the conformance sense; it
> is an additive adapter package depending on `@opentelemetry/api` (peer) and `@reactorynet/workflow-es`
> (peer).

## 8. Test plan (TDD)

Use Jasmine. Tests compile from `core/spec/**` → `build/spec/**` (see `core/spec/support/jasmine.json`)
and run via `yarn test` (`pretest` builds first). Follow the structure of
`core/spec/scenarios/external-events.spec.ts` and `delay.spec.ts`: build a host with
`configureWorkflow()`, `usePersistence(new MemoryPersistenceProvider())`, register a workflow,
`await host.start()`, drive it, `spinWait` on state, `afterAll(async () => { await host.stop(); })`.
Use `spinWait` from `core/spec/helpers/spin-wait.ts`.

### Test helpers — `core/spec/helpers/fake-telemetry.ts` (create)

```ts
// FakeMetrics: records every call so tests can assert.
export class FakeMetrics implements IMetrics {
    public counters: Array<{ name: string; value: number; attributes?: any }> = [];
    public gauges: Array<{ name: string; value: number; attributes?: any }> = [];
    public histograms: Array<{ name: string; value: number; attributes?: any }> = [];
    incrementCounter(name, value = 1, attributes?) { this.counters.push({ name, value, attributes }); }
    recordGauge(name, value, attributes?) { this.gauges.push({ name, value, attributes }); }
    recordHistogram(name, value, attributes?) { this.histograms.push({ name, value, attributes }); }
    countOf(name: string) { return this.counters.filter(c => c.name === name).reduce((a, c) => a + c.value, 0); }
}

// FakeSpan / FakeTracer: record spans + attributes + errors + end order.
export class FakeSpan implements ISpan {
    public attributes: any = {}; public errors: Error[] = []; public ended = false;
    setAttribute(k, v) { this.attributes[k] = v; }
    recordError(e) { this.errors.push(e); }
    end() { this.ended = true; }
}
export class FakeTracer implements ITracer {
    public spans: Array<{ name: string; span: FakeSpan }> = [];
    startSpan(name, attributes?) {
        const span = new FakeSpan();
        if (attributes) Object.assign(span.attributes, attributes);
        this.spans.push({ name, span });
        return span;
    }
}

// BrokenPersistenceProvider: extends MemoryPersistenceProvider, implements IHealthProbe.ping()
// returning false (or a togglable flag) — used to prove health() reports Unhealthy.
// ThrowingMetrics: every method throws — used to prove telemetry cannot break execution.
```

### Failing-test-first

- **`records a step-execute span per step`** — *arrange:* a two-step workflow (`startWith(Step1).then(Step2)`,
  ids `"obs-workflow"` v1); `const tracer = new FakeTracer(); config.useTracer(tracer);`
  `usePersistence(new MemoryPersistenceProvider())`; `await host.start()`. *act:* `startWorkflow`,
  then `await spinWait(async () => (await persistence.getWorkflowInstance(id)).status === WorkflowStatus.Complete)`.
  *assert:* `tracer.spans.filter(s => s.name === "workflowes.step.execute").length` ≥ 2; each such
  span's `attributes["workflow.id"] === id`, has a `"workflow.step.id"`, and `span.ended === true`.
  **Proves §6.1. Must FAIL before the fix** — pre-change `WorkflowExecutor` starts no span, so the
  array is empty.

### Coverage

- **`records step duration histogram`** — same fixture with `FakeMetrics`; after completion assert
  `metrics.histograms.some(h => h.name === "workflowes.step.duration" && h.value >= 0)` and there is
  one histogram sample per step run. Proves §6.2.
- **`records an error metric and span error on a failing step`** — *arrange:* a step whose `run`
  throws `new Error("boom")`; use a definition with no infinite retry (or assert after the first
  failure). *assert:* `metrics.countOf("workflowes.step.errors") >= 1` and the step span has
  `errors.length >= 1` and `ended === true`. Proves §6.1 (error path) + §6.3.
- **`records a retry metric when a step is retried`** — *arrange:* a step that fails once then succeeds
  with `onError(WorkflowErrorHandling.Retry, ...)` (follow `saga-compensation.spec.ts` /
  `core/spec/scenarios` retry usage); drive to completion. *assert:*
  `metrics.countOf("workflowes.step.retries") >= 1`. Proves §6.4.
- **`counts started workflows and published events`** — *assert:*
  `metrics.countOf("workflowes.workflow.started") === N` after starting N instances, and
  `workflowes.event.published` increments on `publishEvent`. Proves §6.5/§6.6.
- **`reports active workflow gauge and queue depth`** — *arrange:* `FakeMetrics`, the default
  `SingleNodeQueueProvider` (which now implements `getQueueLength`); a workflow with a step that
  blocks on a gate so executions stay in-flight. *act:* start a few instances; while gated,
  `spinWait` until `metrics.gauges.some(g => g.name === "workflowes.workflow.active" && g.value > 0)`.
  *assert:* a `"workflowes.queue.depth"` gauge with a `"workflow.queue"` attribute was recorded.
  Proves §6.7/§6.8.
- **`health reports per-component status (all healthy)`** — *arrange:* default host
  (memory persistence, single-node lock/queue), `await host.start()`. *act:* `const r = await host.health()`.
  *assert:* `r.status === HealthStatus.Healthy`, `r.components` has entries named
  `persistence`/`lock`/`queue`/`poll`, `typeof r.activeWorkflows === "number"`,
  `r.timestamp` parses as a Date. Proves §6.10.
- **`health reflects an unreachable provider`** — *arrange:* `usePersistence(new BrokenPersistenceProvider())`
  whose `ping()` resolves `false` (or throws); `await host.start()`. *act:* `const r = await host.health()`.
  *assert:* the `persistence` component is `HealthStatus.Unhealthy` and `r.status === HealthStatus.Unhealthy`.
  Proves §6.10/§6.11.
- **`health is degraded on a stale/missing poll heartbeat`** — *arrange:* a host where the poll worker
  has not run (probe `health()` immediately after `start()` before 10s elapses) OR stub
  `getLastPollAt()` to return a timestamp `> 30000ms` old. *assert:* `poll` component is
  `HealthStatus.Degraded` and, with all providers healthy, `r.status === HealthStatus.Degraded` (not
  Unhealthy). Proves §6.11.
- **`health never throws`** — *arrange:* a provider whose `ping()` throws synchronously. *act/assert:*
  `await expectAsync(host.health()).toBeResolved()` and the component is `Unhealthy` with `detail`
  containing the error message. Proves §6.12.
- **`a throwing metrics impl does not fail the workflow`** — *arrange:* `config.useMetrics(new ThrowingMetrics())`,
  a normal one-step workflow. *act:* run to completion. *assert:* the instance reaches
  `WorkflowStatus.Complete` despite metrics throwing. Proves §6.13.
- **`default host emits no-ops` (zero-dependency)** — *arrange:* `configureWorkflow()` with no
  telemetry setters; resolve `TYPES.IMetrics`/`TYPES.ITracer` from `config.getContainer()`. *assert:*
  they are `NoOpMetrics`/`NoOpTracer` instances and calling their methods does not throw. Proves §6.14
  (the import-grep part is an acceptance check, §9).

### How to run

```bash
cd core && yarn test                       # builds then runs all Jasmine specs
# single file after a build:
cd core && yarn build && npx jasmine build/spec/scenarios/observability.spec.js
# zero-OTel acceptance grep:
grep -rn "@opentelemetry" core/src core/package.json   # MUST return nothing
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds (no type errors from the new interfaces / `health()`).
- [ ] `cd core && yarn test` passes on Node 20 and 22, including `observability.spec.ts`.
- [ ] The failing-first test (`records a step-execute span per step`) is shown to fail on pre-change
      code and pass after.
- [ ] `grep -rn "@opentelemetry" core/src core/package.json` returns **nothing** (core is OTel-free).
- [ ] `grep -rn "from \"@opentelemetry/api\"" providers/workflow-es-opentelemetry/src` shows the adapter
      uses the SDK; `@opentelemetry/api` is a `peerDependency` (not a `dependency`) in that package.
- [ ] A default `configureWorkflow()` host resolves `NoOpMetrics`/`NoOpTracer` for
      `TYPES.IMetrics`/`TYPES.ITracer` — asserted by the "default host emits no-ops" test.
- [ ] `host.health()` returns `Unhealthy` when persistence's `ping()` is false/throws, and `Degraded`
      on a stale poll heartbeat — asserted by the health tests.
- [ ] No existing provider package required changes (per §7); only `SingleNodeQueueProvider` in core is
      modified (adds `getQueueLength`).
- [ ] `cd providers/workflow-es-opentelemetry && yarn build` (or `tsc`) succeeds with peer deps present.

## 10. Backward compatibility & migration

- **Public API:** *additive.* New exports: `IMetrics`, `ITracer`, `ISpan`, `METRIC_NAMES`,
  `METRIC_UNITS`, `ATTR`, `SPAN_NAMES`, `HealthStatus`, `HealthReport`, `ComponentHealth`,
  `IHealthProbe`, `isHealthProbe`, `NoOpMetrics`, `NoOpTracer`; new `WorkflowConfig.useMetrics` /
  `useTracer`; new `IWorkflowHost.health()`. `configureWorkflow()` signature unchanged by M5.
- **`IWorkflowHost` gains `health()` (source-level):** any third-party class that *implements*
  `IWorkflowHost` directly must add `health()`. The only implementer is core `WorkflowHost`, and the
  consumer (`reactory-express-server`) uses the host, it does not implement the interface — so no
  consumer break expected. `IQueueProvider.getQueueLength?` is optional, so no provider breaks.
- **At-rest/on-disk format:** no change.
- **New optional package:** `providers/workflow-es-opentelemetry` — opt-in; not installed by default;
  brings `@opentelemetry/api` only when the consumer adds it as a peer.
- **Version bump:** `2.3.6-reactory.N → 2.3.6-reactory.(N+1)` where N is whatever H1/H4 left it at
  (those specs target `…reactory.4`; M5 is the next increment). Additive + one optional-interface
  member; no breaking signature or format change. Add a CHANGELOG/README note: "optional
  OpenTelemetry metrics/tracing via `useMetrics`/`useTracer`; new `host.health()`."

## 11. Definition of Done

`core` exposes optional, no-op-by-default `IMetrics` and `ITracer` abstractions plus a `health()`
method on `IWorkflowHost`, and emits **nothing and depends on no OTel package** unless an adapter is
explicitly injected. The `WorkflowExecutor` wraps every `body.run` in a `workflowes.step.execute` span
carrying `workflow.id`/`workflow.step.id` (and definition/version) attributes and records step
duration, error, and retry metrics; the host/workers record workflow-started/active/queue-depth/event
metrics, reading H1's in-flight count rather than duplicating it. `host.health()` probes the
persistence, lock, and queue providers via the optional `IHealthProbe`, reports the poll heartbeat and
active count, computes a worst-of aggregate (Unhealthy on a down required provider, Degraded on a stale
poll), and never throws. A separate optional `providers/workflow-es-opentelemetry` package adapts these
abstractions onto `@opentelemetry/api` (peer dep), injected via `useMetrics`/`useTracer`. The
single-process / Electron path runs unchanged with zero external infrastructure and zero OTel
dependency; all existing scenario specs and the new `observability.spec.ts` (whose span assertion
failed before the fix) pass on the Node 20+22 CI matrix; no existing provider package required changes.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) create the three abstraction files + barrel + `TYPES` symbols; (2) create
  the two no-op services + barrel; (3) bind defaults + add the two `WorkflowConfig` setters; (4) wrap
  `body.run` in the executor (span + duration + error + retry); (5) add host `startWorkflow`/
  `publishEvent` counters and `health()`; (6) add the poll heartbeat + worker gauges +
  `SingleNodeQueueProvider.getQueueLength`; (7) write `fake-telemetry.ts` + `observability.spec.ts`;
  (8) scaffold the OTel adapter package; (9) version bump + status flip.
- For the executor span, capture `const t0 = Date.now()` before `body.run` and record the histogram
  in the same `finally` that calls `span.end()`, so success and failure both record duration.
- Resolve the worker instances for the active/queue gauges where they already run their poll cycle
  (the existing `processQueue` methods) — record the gauge once per cycle, not per item, to avoid
  high-cardinality churn.
- The OTel adapter's `OpenTelemetryTracer` should call
  `trace.getTracer("@reactorynet/workflow-es").startSpan(name)` and set attributes; map `recordError`
  to `span.recordException(err)` + `span.setStatus({ code: SpanStatusCode.ERROR })`;
  `OpenTelemetryMetrics` should lazily create instruments (counter/up-down-counter/histogram) keyed by
  name, registering units from `METRIC_UNITS`. Wrap every adapter method body in try/catch that logs
  and swallows, honouring §6.13 (telemetry never breaks execution).
- `@opentelemetry/api` is the right peer dep (it is the stable, SDK-agnostic facade); the consumer
  supplies the SDK/exporter. Do **not** depend on `@opentelemetry/sdk-*` in the adapter.
- `health()` should run the three provider probes concurrently (`Promise.all` of per-component
  `try/catch` wrappers) so a slow probe does not serialise the report; give each probe a short
  internal timeout if a provider's `ping()` could hang (optional — providers are documented to make
  `ping()` cheap).
