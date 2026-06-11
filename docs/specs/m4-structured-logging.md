# Spec — M4 · Structured logging + correlation IDs

| Field | Value |
|---|---|
| **Item ID** | M4 |
| **Title** | Structured logging + correlation IDs |
| **Plan reference** | [`upgrade-plan.md` → M4](../upgrade-plan.md) |
| **Target** | Both (Cloud + Electron) |
| **Severity** | Medium |
| **Owner tag** | `[copilot+review]` |
| **Status** | spec |
| **Depends on** | none (the `tenantId` field is shipped here as optional so that M6 multi-tenancy slots in without another interface change) |
| **Author / reviewer** | copilot / wweber |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. It logs through an injected logger,
bound in the DI container under the symbol `TYPES.ILogger`
(`core/src/abstractions/types.ts:5`). The current interface is **`printf`-style** and untyped:

```ts
// core/src/abstractions/logger.ts (current — the whole file)
export interface ILogger {
    error(message?: any, ...optionalParams: any[]): void;
    info(message?: any, ...optionalParams: any[]): void;
    log(message?: any, ...optionalParams: any[]): void;
}
```

There are two shipped implementations:

- `core/src/services/console-logger.ts` — `ConsoleLogger`, forwards verbatim to `console.error/info/log`.
- `core/src/services/null-logger.ts` — `NullLogger`, every method is an **empty body** (swallows everything).

**The default binding is `NullLogger`** (`core/src/config.ts:40`:
`bind<ILogger>(TYPES.ILogger).to(NullLogger);`). So out of the box the engine emits **nothing**, and a
consumer must call `config.useLogger(new ConsoleLogger())` to see any output (see
`core/spec/scenarios/basic-workflow.spec.ts:42`).

### Why this is insufficient

1. **No structure.** Log calls are `printf` format strings (`"%s"`, `"%o"`) interpolated by the console.
   There is no machine-parseable record, no severity level field, and no place to attach the
   identifiers an operator needs to correlate a line back to a workflow run.
2. **No correlation IDs.** A cloud runner interleaves many workflows and steps. Lines like
   `"Execute workflow: <id>"` cannot be filtered or joined by `workflowId` / `stepId` because those
   values are embedded in free text, inconsistently (some calls include the id, some do not).
3. **No level filtering / configuration.** There is no notion of a minimum level; `ConsoleLogger`
   prints everything, `NullLogger` prints nothing — there is no middle ground (e.g. "warn and above").
4. **Default swallows everything.** A new user sees no logs at all and no obvious way to discover that
   `NullLogger` is the cause.
5. **Not pluggable in practice.** The interface roughly matches `console`, but it does *not* cleanly map
   onto structured loggers (pino, winston), which take `(obj, msg)` or `(msg, meta)` and a level — so
   wiring those in today means writing a lossy shim per consumer.

### Exact current call sites (these must be migrated without losing information)

Every place the engine logs today, by file and line, with the information each call carries. The
implementer MUST preserve every datum below (message text intent + every interpolated value) when
migrating to the new structured API.

| # | File:line | Current call | Information carried |
|---|---|---|---|
| 1 | `services/workflow-host.ts:35` | `this.logger.log("Starting workflow host...")` | lifecycle: host starting |
| 2 | `services/workflow-host.ts:44` | `this.logger.log("Stopping workflow host...")` | lifecycle: host stopping |
| 3 | `services/workflow-host.ts:80` | `this.logger.info("Publishing event %s %s", eventName, eventKey)` | `eventName`, `eventKey` |
| 4 | `services/workflow-host.ts:116` | `self.logger.error("Error suspending workflow: " + error.message)` | workflow id (in scope as `id`), error |
| 5 | `services/workflow-host.ts:144` | `self.logger.error("Error resuming workflow: " + error.message)` | workflow id (`id`), error |
| 6 | `services/workflow-host.ts:170` | `self.logger.error("Error terminating workflow: " + error.message)` | workflow id (`id`), error |
| 7 | `services/workflow-executor.ts:25` | `this.logger.log("Execute workflow: " + instance.id)` | `instance.id` (workflowId) |
| 8 | `services/workflow-executor.ts:87` | `this.logger.error("Error executing workflow %s on step %s - %o", instance.id, pointer.stepId, error)` | `workflowId`, `stepId`, error object |
| 9 | `services/workflow-executor.ts:110` | `this.logger.error("Could not find step on workflow %s %s", instance.id, pointer.stepId)` | `workflowId`, `stepId` |
| 10 | `services/poll-worker.ts:29` | `this.logger.log("Stopping poll worker...")` | lifecycle |
| 11 | `services/poll-worker.ts:35` | `self.logger.info("pollRunnables " + " - now = " + Date.now())` | poll heartbeat, timestamp |
| 12 | `services/poll-worker.ts:45` | `self.logger.error("Error running poll: " + error.message)` | error (runnable instances scan) |
| 13 | `services/poll-worker.ts:56` | `self.logger.error("Error running poll: " + error.message)` | error (runnable events scan) |
| 14 | `services/workflow-queue-worker.ts:32` | `this.logger.log("Stopping workflow queue worker...")` | lifecycle |
| 15 | `services/workflow-queue-worker.ts:41` | `self.logger.log("Dequeued workflow " + workflowId + " for processing")` | `workflowId` |
| 16 | `services/workflow-queue-worker.ts:44` | `self.logger.error("Error processing workflow", workflowId, err)` | `workflowId`, error |
| 17 | `services/workflow-queue-worker.ts:51` | `self.logger.error("Error processing workflow queue: " + error.message)` | error |
| 18 | `services/workflow-queue-worker.ts:92` | `self.logger.log("Workflow locked: " + workflowId)` | `workflowId` |
| 19 | `services/workflow-queue-worker.ts:97` | `self.logger.error("Error processing workflow: " + error.message)` | error |
| 20 | `services/event-queue-worker.ts:32` | `this.logger.log("Stopping event queue worker...")` | lifecycle |
| 21 | `services/event-queue-worker.ts:41` | `self.logger.log("Dequeued event " + eventId + " for processing")` | `eventId` |
| 22 | `services/event-queue-worker.ts:44` | `self.logger.error("Error processing event", eventId, err)` | `eventId`, error |
| 23 | `services/event-queue-worker.ts:51` | `self.logger.error("Error processing event queue: " + error.message)` | error |
| 24 | `services/event-queue-worker.ts:79` | `self.logger.log("Event locked: " + eventId)` | `eventId` |
| 25 | `services/event-queue-worker.ts:84` | `self.logger.error("Error processing event: " + error.message)` | error |
| 26 | `services/event-queue-worker.ts:106` | `self.logger.error(error)` | error object (in `seedSubscription`; `sub.workflowId` in scope) |
| 27 | `services/event-queue-worker.ts:115` | `self.logger.info("Workflow locked " + sub.workflowId)` | `sub.workflowId` |

> **Note on `ExecutionResultProcessor`.** `core/src/services/execution-result-processor.ts` injects
> `ILogger` (`:13-14`) but **never calls it**. Keep the injection (so the constructor metadata is
> unchanged) but do not add new log calls there in this item — that is out of scope.

`ILogger` is part of the **public surface**: it is re-exported from the barrel
`core/src/abstractions.ts:10` (`export * from "./abstractions/logger";`) and from `core/src/index.ts`,
and consumers pass their own implementation via `WorkflowConfig.useLogger(service: ILogger)`
(`core/src/config.ts:17-19`). The downstream consumer `reactory-express-server` integrates via a
`file:` tarball and may pass a custom logger — so this is a versioned, backward-compatibility-sensitive
change (see §10).

## 2. Goal

After this change, the engine logs **structured records**: each log call produces a record with an
explicit severity level, a human-readable message, and a typed **context object** that always carries
the relevant correlation identifiers (`workflowId`, `stepId`, and the optional `tenantId` reserved for
M6). The default binding still **swallows** logs (`NullLogger`) so the desktop/Electron and existing
embedded use is unchanged, but a structured `ConsoleLogger` is available and a real structured logger
(pino/winston) can be injected through a thin documented adapter with **no information lost** versus the
current call sites. A configurable **minimum level** filters output. The old `printf`-style
`log`/`info`/`error` methods remain callable as deprecated compatibility shims so existing consumer
loggers keep working without a code change.

## 3. Out of scope

Do **not** touch or change any of the following in this item:

- **OpenTelemetry / metrics / tracing (M5).** No spans, no metrics, no health endpoint. This is logging only.
- **Multi-tenancy wiring (M6).** Add the `tenantId` *field* to the context type as optional, but do
  **not** add any tenant resolution, tenant scoping, or populate `tenantId` from anywhere. No model
  changes (`WorkflowInstance`, `Event`, etc.) and no `IPersistenceProvider` changes.
- **Provider source files.** Do not modify any file under `providers/*`. In particular do **not** change
  `providers/workflow-es-mongodb/src/mongodb-provider.ts:78` (`console.error(...)`) — see §7.
- **`ExecutionResultProcessor` log behaviour.** Keep the existing (unused) `ILogger` injection; do not
  add new log calls in `core/src/services/execution-result-processor.ts`.
- **Worker scheduling, lock/queue logic, error-handling strategy.** Only the *logging statements* inside
  the workers change; their control flow, `try/finally`, lock acquisition and dequeue loops stay byte-for-byte
  the same apart from the replaced `this.logger.*` / `self.logger.*` calls.
- **Adding a runtime dependency on pino or winston.** Those stay as *consumer-supplied* adapters
  documented in §12; core must not import them and they must not appear in `core/package.json`.
- **Renaming `TYPES.ILogger`** or changing any other DI symbol.

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/logger.ts` | modify | Replace/extend `ILogger` with the structured interface + add `LogLevel` enum and `LogContext` type (full text in §5). |
| `core/src/services/console-logger.ts` | modify | Rewrite `ConsoleLogger` as a structured adapter that respects a minimum level and prints the message + context. |
| `core/src/services/null-logger.ts` | modify | Implement the new structured `log(level, message, context?)` method (still a no-op) plus the deprecated shims (also no-ops). |
| `core/src/services/workflow-host.ts` | modify | Migrate call sites #1–#6 to structured `log(...)` with context. |
| `core/src/services/workflow-executor.ts` | modify | Migrate call sites #7–#9. |
| `core/src/services/poll-worker.ts` | modify | Migrate call sites #10–#13. |
| `core/src/services/workflow-queue-worker.ts` | modify | Migrate call sites #14–#19. |
| `core/src/services/event-queue-worker.ts` | modify | Migrate call sites #20–#27. |
| `core/src/config.ts` | modify | Add optional `loggerLevel` config + plumb it into `ConsoleLogger`; keep `NullLogger` as the default binding. |
| `core/spec/services/logger.spec.ts` | create | Unit tests: `LogLevel` filtering, `ConsoleLogger` emits structured records, `NullLogger` swallows. |
| `core/spec/scenarios/structured-logging.spec.ts` | create | Scenario test with a `FakeLogger` capturing structured records; asserts workflow/step logs carry `workflowId`/`stepId`; uses `spinWait`. |
| `core/spec/helpers/fake-logger.ts` | create | Reusable `FakeLogger implements ILogger` that captures `{ level, message, context }[]`. |

No new files are added to the barrels beyond what is already exported. `ConsoleLogger`, `NullLogger`,
`ILogger`, `LogLevel`, `LogContext` are all reachable via the existing
`core/src/services.ts` / `core/src/abstractions.ts` re-exports (logger.ts and console-logger.ts /
null-logger.ts are already exported there — adding the new symbols to `logger.ts` makes them public
automatically). **Verify** `core/src/abstractions.ts:10` still re-exports `./abstractions/logger`
(it does) — no barrel edit needed.

## 5. Interface & data-model changes

### `core/src/abstractions/logger.ts`

```ts
// BEFORE (whole file)
export interface ILogger {
    error(message?: any, ...optionalParams: any[]): void;
    info(message?: any, ...optionalParams: any[]): void;
    log(message?: any, ...optionalParams: any[]): void;
}
```

```ts
// AFTER (whole file)

/**
 * Severity levels, ordered ascending. A logger configured with a minimum level
 * emits a record only when record.level >= minLevel. `Silent` disables all output.
 */
export enum LogLevel {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
    Silent = 100,
}

/**
 * Structured correlation context attached to every engine log record.
 * All fields are optional so call sites only set what they know.
 * `tenantId` is reserved for M6 (multi-tenancy) and is always undefined until then.
 * The index signature allows adapters/consumers to attach arbitrary extra fields.
 */
export interface LogContext {
    workflowId?: string;
    stepId?: string;
    eventId?: string;
    /** Reserved for M6 multi-tenancy. Optional now; not populated by the engine in M4. */
    tenantId?: string;
    /** Attached when the record describes an error. */
    err?: Error;
    [key: string]: unknown;
}

export interface ILogger {
    /**
     * Primary structured entry point. Implementations MUST honour level filtering
     * (drop the record when `level` is below the configured minimum).
     */
    log(level: LogLevel, message: string, context?: LogContext): void;

    /**
     * @deprecated printf-style compatibility shims kept for consumers that
     * implemented the pre-M4 `ILogger`. New engine code MUST NOT call these.
     * Default implementations are provided on the shipped loggers; custom
     * consumer loggers that only implement the old three methods continue to work
     * because the engine never calls them (see §10 / §12 compatibility note).
     */
    info?(message?: any, ...optionalParams: any[]): void;
    error?(message?: any, ...optionalParams: any[]): void;
}
```

**Back-compat strategy — decision: migrate all internal call sites to the new `log(level, message, context)`
and keep the old methods as OPTIONAL deprecated shims (`info?`/`error?`).** Justification:

- The engine's own call sites are the only callers we control; migrating them (per §6) is mechanical and
  removes the lossy `printf` formatting and the missing-correlation-id problem at the source.
- We **cannot** safely drop the old methods entirely: a consumer (e.g. `reactory-express-server`) may
  have implemented `ILogger` with exactly `{ log, info, error }` and pass it to `useLogger`. The old
  `log(message?, ...params)` signature is structurally a subset of the new `log(level, message, context?)`
  only if the consumer ignores the first argument — which would be wrong. Therefore: the **new `log` is
  the required method**; `info`/`error` become **optional** (`?`) and deprecated so old code still
  type-checks, while the engine itself never invokes them. Consumers get a compile-time deprecation
  signal but no runtime break. See §10 for the migration note shipped to consumers.

> Note: the old three-method interface had `log(message?, ...params)`. The new required `log` takes a
> `LogLevel` first. A pre-M4 consumer logger whose `log` ignored its first arg would now receive a
> numeric level as the first positional value — harmless for a `console`-style passthrough (it just
> prints the number) but semantically wrong. The migration note (§10) instructs consumers to update to
> the structured signature; the optional shims exist only to avoid a hard *compile* break during the
> transition.

### New `ConsoleLogger` (structured adapter)

`core/src/services/console-logger.ts` — full intended shape (the implementer writes the body to match):

```ts
import { injectable, inject, optional } from "inversify";
import { ILogger, LogLevel, LogContext, TYPES } from "../abstractions";

@injectable()
export class ConsoleLogger implements ILogger {
    private minLevel: LogLevel;

    constructor(minLevel: LogLevel = LogLevel.Info) {
        this.minLevel = minLevel;
    }

    public log(level: LogLevel, message: string, context?: LogContext): void {
        if (level < this.minLevel) return;                 // level filtering (rule §6.2)
        const record = { level: LogLevel[level], message, ...(context ?? {}) };
        if (level >= LogLevel.Error) console.error(record);
        else if (level >= LogLevel.Warn) console.warn(record);
        else if (level >= LogLevel.Info) console.info(record);
        else console.debug(record);
    }

    // Deprecated shims — forward to structured log so old call patterns still produce output.
    public info(message?: any, ...optionalParams: any[]): void {
        this.log(LogLevel.Info, String(message), optionalParams.length ? { params: optionalParams } : undefined);
    }
    public error(message?: any, ...optionalParams: any[]): void {
        this.log(LogLevel.Error, String(message), optionalParams.length ? { params: optionalParams } : undefined);
    }
}
```

`NullLogger` (`null-logger.ts`) implements `log(level, message, context?)` as an **empty body** and
keeps `info`/`error` as empty bodies too. It MUST remain the default binding so the engine is silent
out of the box (rule §6.3).

### How pino / winston inject

No core dependency. A consumer writes a ~10-line adapter implementing `ILogger.log` and passes it via
`config.useLogger(...)`. Worked examples (pino and winston) live in §12; they map `LogLevel` →
the library's level and pass `context` as the structured-fields object. This is the *only* supported
integration path; core never imports pino/winston.

### DI / config impact

`configureWorkflow()` keeps `bind<ILogger>(TYPES.ILogger).to(NullLogger);` as the **default**
(unchanged — desktop stays silent). Add an **optional** logger level so a consumer who calls
`useLogger(new ConsoleLogger())` can also set a minimum level without hand-constructing the level. Add
to `WorkflowConfig`:

```ts
// core/src/config.ts — added to WorkflowConfig
/**
 * Convenience: bind a ConsoleLogger at the given minimum level.
 * Equivalent to useLogger(new ConsoleLogger(level)).
 */
public useConsoleLogger(level: LogLevel = LogLevel.Info) {
    this.container.rebind<ILogger>(TYPES.ILogger).toConstantValue(new ConsoleLogger(level));
}
```

`useLogger(service: ILogger)` is **unchanged** in signature (still `rebind(...).toConstantValue(service)`).
No new `TYPES` symbol. No change to any `bind` other than the additions above. Default behaviour
(silent `NullLogger`) is preserved.

### Persisted / at-rest format impact

None. Logging touches no persisted shape, no provider write path. `LogContext` is never serialized to a
provider.

## 6. Behavioural contract (numbered rules)

1. **Structured entry point.** `ILogger.log(level, message, context?)` is the required method on the
   interface. Every internal engine log call in §1's table is migrated to call `this.logger.log(...)` /
   `self.logger.log(...)` with the appropriate `LogLevel` and a `LogContext`.
2. **Level filtering.** A logger configured with a minimum level emits a record **iff**
   `record.level >= minLevel`. `ConsoleLogger(LogLevel.Warn)` drops `Debug`/`Info` records and emits
   `Warn`/`Error`. `LogLevel.Silent` drops everything.
3. **NullLogger still swallows.** The default binding remains `NullLogger`; with no `useLogger`/
   `useConsoleLogger` call, the engine produces **zero** output for any level (`NullLogger.log` is a
   no-op).
4. **Correlation context on workflow/step logs.** Every record emitted while processing a specific
   workflow carries `context.workflowId`; every record tied to a specific step additionally carries
   `context.stepId`; every record tied to a specific event carries `context.eventId`. Specifically:
   - Call site #7 (`Execute workflow`): `{ workflowId: instance.id }`.
   - Call site #8 (error executing step): `{ workflowId: instance.id, stepId: pointer.stepId, err: error }`.
   - Call site #9 (step not found): `{ workflowId: instance.id, stepId: pointer.stepId }`.
   - Call sites #15, #16, #18, #19 (workflow queue worker): `{ workflowId }` (and `err` on error lines).
   - Call sites #21, #22, #24, #25, #26, #27 (event queue worker): `{ eventId }` or `{ workflowId: sub.workflowId }`
     as appropriate (and `err` on error lines).
   - Call sites #4, #5, #6 (host suspend/resume/terminate errors): `{ workflowId: id, err: error }`.
   - Call site #3 (publishing event): `{ eventName, eventKey }`.
5. **No information lost.** For every row in §1's table, the migrated call MUST preserve the message
   intent and every interpolated value. `printf` placeholders (`%s`, `%o`) are removed; the values move
   into `context`. The error *object* (not just `error.message`) is attached as `context.err` wherever
   an error was previously logged. `tenantId` is left unset.
6. **Level assignment.** Map current methods to levels: every current `.log(...)` →
   `LogLevel.Info` for lifecycle/dequeue/"locked" lines (these are informational), every current
   `.info(...)` → `LogLevel.Info`, every current `.error(...)` → `LogLevel.Error`. (Rationale: `.log`
   today is used for normal operational lines, so `Info` preserves visibility under the default
   `ConsoleLogger` level; do **not** down-level them to `Debug`, which would hide them and *lose
   information* relative to the prior `ConsoleLogger` that printed everything.)
7. **Deprecated shims are inert in the engine.** The engine MUST NOT call `logger.info(...)` or
   `logger.error(...)` anywhere after migration. The optional shims exist only for consumer
   back-compat. (Grep assertion in §9.)
8. **Order & idempotency.** Logging is side-effect-free with respect to workflow state; migrating the
   calls must not change control flow, ordering, lock scope, or the number of times any branch runs.
   The only diff in each worker/host/executor file is the replaced logging statements.
9. **Error path.** A logger implementation throwing inside `log(...)` must not be introduced as a new
   failure mode by the engine, but the engine is **not** required to wrap logger calls in try/catch
   (it does not today). Implementers MUST NOT add defensive try/catch around log calls — keep behaviour
   equivalent to current code.

## 7. Provider parity

**No core interface that providers implement changes.** `ILogger` is a core-internal abstraction
injected into the host/executor/workers; it is **not** part of `IPersistenceProvider`,
`IDistributedLockProvider`, or `IQueueProvider`. Therefore **no provider source change is required by
this item**, and there is **no same-PR provider obligation**.

| Provider | Change required |
|---|---|
| memory (core) | none |
| sqlite | none |
| postgres | none (note: the postgres provider has no logger wiring today; out of scope) |
| mongodb | none — `mongodb-provider.ts:78` uses a raw `console.error`; leave it. Out of scope (see below). |
| redis | none |
| azure | none |

**Note (deliberately out of scope):** providers log directly via `console.*` (e.g.
`providers/workflow-es-mongodb/src/mongodb-provider.ts:78`,
`console.error("workflow-es-mongodb: getRunnableInstances query failed", err)`). Routing provider
logs through the structured `ILogger` would require threading a logger into each provider's
constructor — a separate, larger change. It is **explicitly not** part of M4 and must not be attempted
here.

## 8. Test plan (TDD)

Tests use Jasmine (the existing harness) and the `spinWait` helper from
`core/spec/helpers/spin-wait.ts`. Follow the structure of `core/spec/scenarios/basic-workflow.spec.ts`
(builds a workflow, starts the host, `await spinWait(...)` until complete) and
`core/spec/services/execution-result-processor.spec.ts` for unit-style tests.

### Failing-test-first

- **`structured-logging.spec.ts › captures workflowId and stepId on step logs`** — *must fail before the
  fix* (today `ILogger.log` takes `(message, ...params)`, there is no `LogContext`, so the assertion
  that a captured record has `context.workflowId` cannot compile/pass).
  - **arrange:** create `FakeLogger` (see helper below); `let config = configureWorkflow();
    config.useLogger(fake);` register a one-step workflow whose step throws once then logs (or simply a
    one-step workflow that runs to completion — the executor emits `Execute workflow` at
    `workflow-executor.ts:25`); `let host = config.getHost(); host.registerWorkflow(MyWorkflow);
    await host.start();`
  - **act:** `let id = await host.startWorkflow("my-flow", 1, {});` then
    `await spinWait(async () => (await host.persistence?...))` — follow basic-workflow.spec.ts: spin
    until the instance is `Complete`.
  - **assert:** `fake.records.some(r => r.context?.workflowId === id)` is true; for the error path
    variant (step throws), `fake.records.some(r => r.context?.workflowId === id && r.context?.stepId &&
    r.context?.err instanceof Error && r.level === LogLevel.Error)` is true.

### Coverage

- **`logger.spec.ts › ConsoleLogger respects minimum level`** — arrange: spy on `console.info` and
  `console.error`; `const l = new ConsoleLogger(LogLevel.Warn);` · act: `l.log(LogLevel.Info, "hidden");
  l.log(LogLevel.Error, "shown", { workflowId: "w1" });` · assert: `console.info` not called,
  `console.error` called once with a record containing `workflowId: "w1"`. (proves §6.2, §6.4)
- **`logger.spec.ts › ConsoleLogger emits structured record with level name and context`** — act:
  `l.log(LogLevel.Info, "msg", { workflowId: "w1", stepId: "s1" })` with `new ConsoleLogger(LogLevel.Debug)`
  · assert: the object passed to `console.info` has `{ level: "Info", message: "msg", workflowId: "w1",
  stepId: "s1" }`. (proves §6.1, §6.4)
- **`logger.spec.ts › NullLogger swallows everything`** — arrange: spy on all `console` methods;
  `const l = new NullLogger();` · act: call `l.log(LogLevel.Error, "x", { workflowId: "w" })` and the
  deprecated `l.info("y")`, `l.error("z")` · assert: no `console.*` method was called. (proves §6.3)
- **`logger.spec.ts › default binding is NullLogger (silent)`** — arrange: spy on `console.*`;
  `const config = configureWorkflow();` (no `useLogger`) build + run a trivial workflow via the host ·
  assert: zero `console.*` calls attributable to the engine. (proves §6.3)
- **`structured-logging.spec.ts › Info-level lifecycle lines are emitted, not down-leveled to Debug`** —
  arrange: `FakeLogger`; run a workflow to completion · assert: a record exists with
  `level === LogLevel.Info` and `message` containing the workflow id context for the "Execute workflow"
  line — i.e. the line previously logged via `.log(...)` is still visible at `Info`. (proves §6.6, §6.5)
- **`structured-logging.spec.ts › publishEvent log carries eventName and eventKey`** — act:
  `await host.publishEvent("evt", "key1", {}, new Date())` · assert: `fake.records.some(r =>
  r.context?.eventName === "evt" && r.context?.eventKey === "key1" && r.level === LogLevel.Info)`.
  (proves §6.4 for call site #3)

### Fake logger helper (`core/spec/helpers/fake-logger.ts`)

```ts
import { ILogger, LogLevel, LogContext } from "../../src";

export interface CapturedRecord {
    level: LogLevel;
    message: string;
    context?: LogContext;
}

export class FakeLogger implements ILogger {
    public records: CapturedRecord[] = [];
    public log(level: LogLevel, message: string, context?: LogContext): void {
        this.records.push({ level, message, context });
    }
}
```

### How to run

```bash
cd core && yarn build
cd core && yarn test                 # full Jasmine suite (config in core/spec/support/jasmine.json)
# or a single file once jasmine is configured to take a filter; otherwise run the whole suite.
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd core && yarn test` passes on Node 20 and 22 (existing scenario specs still green — they call
      `config.useLogger(new ConsoleLogger())` and must continue to work).
- [ ] The failing-first test `structured-logging.spec.ts › captures workflowId and stepId on step logs`
      fails on the pre-change tree and passes after.
- [ ] `grep -rn "this.logger.info\|this.logger.error\|self.logger.info\|self.logger.error" core/src/services/`
      returns **zero** matches (engine no longer calls the deprecated shims — proves §6.7).
- [ ] `grep -rn "%s\|%o" core/src/services/` returns **zero** matches inside logging calls
      (printf format strings removed — proves §6.5).
- [ ] No new dependency added: `pino`/`winston` do **not** appear in `core/package.json`.
- [ ] No file under `providers/*` is modified by this change.

## 10. Backward compatibility & migration

`ILogger` is public API (exported from `core/src/index.ts` via `abstractions.ts`) and a consumer
(`reactory-express-server`) may pass a custom logger to `WorkflowConfig.useLogger`. This is a
**breaking-ish but soft** change:

- **What breaks:** the *required* method is now `log(level: LogLevel, message: string, context?)` instead
  of the old `log(message?, ...params)`. A consumer logger that implemented only the old three methods
  will still satisfy the interface **at compile time** because `info`/`error` are now optional and `log`
  is structurally compatible (it accepts more arguments), but the consumer's `log` will now receive a
  numeric `LogLevel` as its first argument. If that consumer's `log` blindly forwarded its first arg to
  `console.log`, output now begins with a number instead of the message.
- **Migration step for `reactory-express-server`:** update any custom `ILogger` implementation to the
  structured signature — read `level`/`message`/`context` and route accordingly (a 10-line adapter; see
  §12 pino/winston examples). Until they do, they can switch to `config.useConsoleLogger()` or
  `config.useLogger(new ConsoleLogger())` for correct output with no custom code.
- **What does not break:** the default behaviour (silent `NullLogger`) is unchanged; `useLogger`'s
  signature is unchanged; existing tests that pass `new ConsoleLogger()` keep compiling because
  `ConsoleLogger`'s constructor argument is optional.
- **Version bump:** `core/package.json` `2.3.6-reactory.3` → `2.3.6-reactory.4`. Add a CHANGELOG /
  migration note pointing consumers at the structured `ILogger` and the `useConsoleLogger` helper.

## 11. Definition of Done

The engine logs structured records through a redesigned `ILogger.log(level, message, context?)`: every
internal log call from §1 has been migrated to carry the correct `LogLevel` and a `LogContext` with the
relevant `workflowId`/`stepId`/`eventId` (and the optional, currently-unset `tenantId` reserved for M6),
losing no information versus the prior `printf` calls and attaching the full error object on error
lines. A structured `ConsoleLogger` honours a configurable minimum level; the default binding is still
`NullLogger` and the engine is silent out of the box; pino/winston are injectable via a documented
consumer adapter with no core dependency added. The deprecated `info`/`error` shims keep old consumer
loggers compiling but are never called by the engine. `core` builds and `yarn test` passes on Node 20 +
22, the failing-first test demonstrates the gap, the grep acceptance checks pass, and no provider file
is touched. The reviewer signs off against §2 + §9.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) `logger.ts` interface + enum; (2) `null-logger.ts` and `console-logger.ts`;
  (3) add `fake-logger.ts` helper and write the failing test; (4) migrate the five service files; (5)
  `config.ts` `useConsoleLogger`; (6) remaining tests; (7) version bump + migration note.
- **pino adapter** a consumer would write (do not add to core):
  ```ts
  import pino from "pino";
  import { ILogger, LogLevel, LogContext } from "@reactorynet/workflow-es";
  const p = pino();
  const levelName = (l: LogLevel) =>
      l >= LogLevel.Error ? "error" : l >= LogLevel.Warn ? "warn" : l >= LogLevel.Info ? "info" : "debug";
  export const pinoAdapter: ILogger = {
      log: (level, message, context) => (p as any)[levelName(level)](context ?? {}, message),
  };
  ```
- **winston adapter** is analogous: `logger.log({ level: levelName(level), message, ...context })`.
- Keep the `console.debug/info/warn/error` fan-out in `ConsoleLogger` so existing visual output is
  comparable to today's `ConsoleLogger` (which used `console.log/info/error`).
- The upstream `danielgerlag/workflow-es` has no structured logger; this is a Reactory-specific
  enhancement — do not look there for a reference implementation.
