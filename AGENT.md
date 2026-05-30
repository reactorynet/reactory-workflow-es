# AGENT.md — reactory-workflow-es

## What This Project Is

A Reactory-maintained fork of [`danielgerlag/workflow-es`](https://github.com/danielgerlag/workflow-es) (last upstream release: v2.3.5, ~2019). The upstream project is stale and unmaintained. This fork exists to apply critical bug fixes, modernize the toolchain, and extend the library to fit the Reactory platform's operational needs.

This is a **monorepo** containing:
- `core/` — The `workflow-es` npm package itself (the engine)
- `providers/workflow-es-mongodb/` — MongoDB persistence provider
- `providers/workflow-es-redis/` — Redis queue and lock provider
- `providers/workflow-es-azure/` — Azure Service Bus queue and lock provider
- `providers/workflow-es-mysql/` — MySQL persistence provider
- `samples/` — Usage examples

The consuming project is `reactory-express-server`, which uses `workflow-es` via the `reactory-queue` module.

---

## Repository Layout

```
reactory-workflow-es/
  core/
    src/
      index.ts                    # Public API surface
      config.ts                   # configureWorkflow() factory + WorkflowConfig
      abstractions/               # Interfaces + TYPES symbol map (IoC tokens)
        types.ts                  # TYPES symbol map
        step-body.ts              # Abstract StepBody base class
        workflow-base.ts          # Abstract WorkflowBase<TData>
        persistence-provider.ts   # IPersistenceProvider interface
        queue-provider.ts         # IQueueProvider + QueueType enum
        distributed-lock-provider.ts
        execution-result-processor.ts
        execution-pointer-factory.ts
        workflow-executor.ts
        workflow-host.ts
        workflow-registry.ts
        logger.ts
        background-worker.ts
        inline-step-body.ts
      models/                     # Plain data classes
        workflow-instance.ts      # WorkflowInstance, WorkflowStatus
        execution-pointer.ts      # ExecutionPointer, PointerStatus
        execution-result.ts       # ExecutionResult (static factory methods)
        workflow-definition.ts
        workflow-step.ts          # WorkflowStepBase, WorkflowStep<T>
        step-outcome.ts
        step-execution-context.ts
        execution-error.ts
        event.ts / event-subscription.ts
        workflow-error-handling.ts # WorkflowErrorHandling enum
        workflow-executor-result.ts
        saga-container.ts
        container-data.ts
        schedule-persistence-data.ts
        execution-pipeline-directive.ts
      services/                   # Concrete implementations
        workflow-host.ts          # IWorkflowHost — start/stop/startWorkflow/publishEvent
        workflow-executor.ts      # IWorkflowExecutor — per-step execution loop
        execution-result-processor.ts # IExecutionResultProcessor — outcome routing
        execution-pointer-factory.ts  # Pointer creation (genesis, next, child, compensation)
        workflow-registry.ts      # In-memory workflow definition registry
        memory-persistence-provider.ts
        single-node-queue-provider.ts
        single-node-lock-provider.ts
        workflow-queue-worker.ts  # Background: dequeues workflow IDs, calls executor
        event-queue-worker.ts     # Background: processes published events
        poll-worker.ts            # Background: polls persistence for runnable instances (10s)
        console-logger.ts
        null-logger.ts
      fluent-builders/
        workflow-builder.ts       # WorkflowBuilder<TData>
        step-builder.ts           # StepBuilder<TBody, TData> (fluent DSL)
        outcome-builder.ts        # OutcomeBuilder
        parallel-step-builder.ts
        return-step-builder.ts
      primitives/                 # Built-in step bodies
        foreach.ts                # Branching over a collection
        while.ts                  # Loop while condition
        if.ts                     # Conditional branch
        delay.ts                  # Sleep until date
        schedule.ts               # Recurring schedule
        waitFor.ts                # Wait for external event
        sequence.ts               # Sequential sub-steps
        container-step-body.ts    # Base for branching primitives
    spec/                         # Jasmine test scenarios
      scenarios/                  # basic-workflow, data-io, external-events, if, outcome-fork,
                                  # parallel, while
      helpers/spin-wait.ts
    package.json                  # name: "workflow-es", version: 2.3.5
    tsconfig.json                 # target: ES5, module: commonjs, outDir: ./build
  providers/
    workflow-es-mongodb/
    workflow-es-redis/
    workflow-es-azure/
    workflow-es-mysql/
  samples/
  release-notes/
    2.1.md / 2.2.md / 2.3.md
```

---

## Technology Stack (Current / Pre-Modernization)

| Concern | Current version | Issue |
|---|---|---|
| TypeScript | `^2.2.1` | Ancient — missing many modern features |
| Node.js target | ES5 | Should be at least ES2017 |
| inversify (IoC) | `^4.1.0` | Current stable is 6.x |
| reflect-metadata | `^0.1.10` | Should be `^0.2.x` for inversify 6 |
| Test framework | jasmine `^2.5.2` | Should migrate to Jest |
| CI | Travis CI | Travis free tier gone; migrate to GitHub Actions |
| `util.isNullOrUndefined` | Used in source | Deprecated in Node 12, removed in Node 22 — **breaking** |

---

## Applied Patches (from `reactory-express-server/patches/workflow-es+2.3.5.patch`)

These patches were previously applied at runtime to the installed `node_modules`. They must now be applied directly to the fork's TypeScript source:

### Patch 1 — Remove `util.isNullOrUndefined`
**File**: `core/src/services/execution-result-processor.ts`  
**Problem**: `import { isNullOrUndefined } from "util"` — this API was deprecated in Node.js 12 and removed in Node.js 22, causing a runtime crash.  
**Fix**: Replace with an inline helper:
```typescript
const isNullOrUndefined = (val: any): val is null | undefined => val === null || val === undefined;
```

### Patch 2 — Persist error details on execution pointer
**File**: `core/src/services/workflow-executor.ts`  
**Problem**: When a step throws, the error message is pushed to `result.errors` but nothing is stored on `pointer.persistenceData`, making it impossible to inspect error history after the fact.  
**Fix**: In the `catch` block, push a structured error record into `pointer.persistenceData._errors[]`:
```typescript
{
  message: err.message || String(err),
  stack: err.stack || null,
  errorTime: new Date().toISOString(),
  retryCount: pointer.retryCount || 0
}
```

---

## Key Concepts

### IoC Container (inversify)
All services are resolved via an inversify `Container`. The `TYPES` map provides symbols for each interface. `configureWorkflow()` builds the container with default bindings; consumers call `.usePersistence()`, `.useQueueManager()`, etc. to swap implementations.

### Execution Flow
1. `WorkflowHost.startWorkflow()` creates a `WorkflowInstance`, adds a genesis `ExecutionPointer`, persists it, and queues the workflow ID.
2. `WorkflowQueueWorker` dequeues IDs and calls `WorkflowExecutor.execute()`.
3. `WorkflowExecutor` iterates over active pointers, resolves the step body from the container, runs inputs, calls `body.run()`, runs outputs, then delegates to `ExecutionResultProcessor`.
4. `ExecutionResultProcessor.processExecutionResult()` handles routing: advance to next step, branch, sleep, or wait for an event.
5. `ExecutionResultProcessor.handleStepException()` applies the error strategy (Retry / Suspend / Terminate / Compensate).
6. `PollWorker` re-queues runnable instances every 10 seconds (catches sleeping steps that have woken).
7. `EventQueueWorker` processes published events and wakes waiting pointers.

### Error Handling Strategies (`WorkflowErrorHandling`)
- `Retry` — sleep and retry after `step.retryInterval`
- `Suspend` — set workflow status to Suspended
- `Terminate` — set workflow status to Terminated
- `Compensate` — walk the scope stack running compensation steps (Saga pattern)

### Persistence Interface (`IPersistenceProvider`)
Any persistence layer must implement:
- `createNewWorkflow` / `persistWorkflow` / `getWorkflowInstance` / `getRunnableInstances`
- `createEventSubscription` / `getSubscriptions` / `terminateSubscription`
- `createEvent` / `getEvent` / `getRunnableEvents` / `markEventProcessed` / `markEventUnprocessed` / `getEvents`

---

## Build & Test

```bash
cd core

# Install dependencies
npm install   # or yarn

# Build (compiles TypeScript → build/)
npm run build

# Build + run Jasmine tests
npm test

# After modernization, build and pack for local use
npm pack      # creates workflow-es-<version>.tgz
```

---

## Planned Improvements

Priority order for modernization:

1. **Apply source patches** (Patches 1 & 2 above) — unblock Node.js 22 compatibility
2. **Rename package** — `"name": "@reactorynet/workflow-es"` to distinguish from upstream
3. **Bump version** — e.g. `2.3.6-reactory.1` to signal the fork
4. **Upgrade TypeScript** — `^2.2.1` → `^5.x`, update `tsconfig.json` target to `ES2020` or `ES2022`
5. **Upgrade inversify** — `^4.1.0` → `^6.x`, update `reflect-metadata` to `^0.2.x`
6. **Switch test framework** — Jasmine → Jest (align with the rest of the Reactory platform)
7. **Replace Travis CI** — add `.github/workflows/ci.yml`
8. **Add a `build:local` script** — `npm pack` outputting to `$REACTORY_SERVER/node_modules` or `artifacts/` for easy integration testing
9. **Strict TypeScript** — enable `strict: true`, eliminate `noImplicitAny: false`
10. **Improve `ExecutionPointer` typing** — replace `persistenceData: any` with a generic or discriminated union

---

## Integration with Reactory Express Server

The `reactory-queue` module (`src/modules/reactory-queue`) consumes `workflow-es`.  
Current dependency in `reactory-express-server/package.json`:
```json
"workflow-es": "2.3.5"
```

After publishing the fork locally, this should become:
```json
"@reactorynet/workflow-es": "file:../path/to/tgz"
```
or via a local `file:` reference. Update all `import ... from "workflow-es"` statements in `reactory-queue` and any other server modules to `"@reactorynet/workflow-es"`.

---

## Conventions

- All source lives in `core/src/` — do **not** edit files under `core/build/` (compiled output)
- One class per file, filename matches class name in kebab-case
- `@injectable()` on every service class; `@inject(TYPES.X)` on every injected property
- No business logic in models — they are plain data classes only
- `ExecutionResult` uses static factory methods (`next()`, `persist()`, `branch()`, `waitForEvent()`, etc.) — do not construct directly
- Test scenarios live in `core/spec/scenarios/` and use Jasmine `describe`/`beforeAll`/`it` blocks with the `spinWaitCallback` helper for async completion

---

## Files NOT to Edit

- `core/build/` — generated; overwritten on every `npm run build`
- `node_modules/` — dependencies; changes here are discarded on `npm install`
- `providers/*/build/` — generated output for each provider
