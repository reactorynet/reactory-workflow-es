# AGENT.md — reactory-workflow-es

## What This Project Is

A Reactory-maintained fork of [`danielgerlag/workflow-es`](https://github.com/danielgerlag/workflow-es)
(last upstream release: v2.3.5, ~2019). The upstream project is stale and unmaintained. This fork
exists to:

- Apply critical bug fixes that unblock Node.js 22+ compatibility
- Modernise the toolchain (TypeScript 5, inversify 6, GitHub Actions CI)
- Extend the engine to integrate natively with the Reactory platform (service adapter, telemetry, event bus)

Package name: `@reactorynet/workflow-es`  
Current version: `2.3.6-reactory.2`  
Branch: `chore/reactory-fork-init` (merge to `master` when stable)

This is a **monorepo** containing:
- `core/` — The `@reactorynet/workflow-es` npm package (the engine)
- `providers/workflow-es-mongodb/` — MongoDB persistence provider
- `providers/workflow-es-redis/` — Redis queue and lock provider
- `providers/workflow-es-azure/` — Azure Service Bus queue and lock provider
- `providers/workflow-es-mysql/` — MySQL persistence provider
- `samples/` — Usage examples

The consuming project is `reactory-express-server`, which uses this package via the `reactory-queue`
module. The server's `bin/install.sh` clones this repo, builds it, and wires the `file:` reference
in `package.json` automatically.

---

## Repository Layout

```
reactory-workflow-es/
  core/
    src/
      index.ts                    # Public API surface
      config.ts                   # configureWorkflow() factory + WorkflowConfig
      abstractions/               # Interfaces + TYPES symbol map (IoC tokens)
        types.ts
        step-body.ts
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
        workflow-instance.ts
        execution-pointer.ts
        execution-result.ts       # ExecutionResult static factory methods
        workflow-definition.ts
        workflow-step.ts
        step-outcome.ts
        step-execution-context.ts
        execution-error.ts
        event.ts / event-subscription.ts
        workflow-error-handling.ts # WorkflowErrorHandling enum
        workflow-executor-result.ts
        saga-container.ts
      services/                   # Concrete implementations
        workflow-host.ts
        workflow-executor.ts
        execution-result-processor.ts
        execution-pointer-factory.ts
        workflow-registry.ts
        memory-persistence-provider.ts
        single-node-queue-provider.ts
        single-node-lock-provider.ts
        workflow-queue-worker.ts
        event-queue-worker.ts
        poll-worker.ts
        console-logger.ts / null-logger.ts
      fluent-builders/
        workflow-builder.ts
        step-builder.ts
        outcome-builder.ts
        parallel-step-builder.ts
      primitives/                 # Built-in step bodies
        foreach.ts / while.ts / if.ts / delay.ts / schedule.ts / waitFor.ts
    spec/
      scenarios/                  # Jasmine integration test scenarios
      helpers/spin-wait.ts
    package.json
    tsconfig.json
  providers/
    workflow-es-mongodb/
    workflow-es-redis/
    workflow-es-azure/
    workflow-es-mysql/
  patches/
    workflow-es+2.3.5.orig.patch  # Original upstream patch (archived — already applied to source)
  .github/workflows/ci.yml        # GitHub Actions CI (Node 20 + 22)
```

---

## Technology Stack

| Concern | Upstream (v2.3.5) | Current fork | Target |
|---|---|---|---|
| Package name | `workflow-es` | `@reactorynet/workflow-es` | same |
| Version | `2.3.5` | `2.3.6-reactory.2` | semver with `-reactory.N` pre-release |
| TypeScript | `^2.2.1` | `^5.0.0` | `^5.x` (keep current) |
| TS target | `ES5` | `ES2020` | `ES2022` eventually |
| `noImplicitAny` | `false` | `true` | `strict: true` (next) |
| inversify | `^4.1.0` | `^6.0.0` | same |
| reflect-metadata | `^0.1.10` | `^0.2.0` | same |
| Test framework | Jasmine `^2.5.2` | Jasmine `^5.0.0` | Jest (planned) |
| CI | Travis CI (broken) | GitHub Actions | same |

---

## Completed Improvements (v2.3.6-reactory.2)

### Bug Fixes Applied to Source

1. **`util.isNullOrUndefined` removed** (`execution-result-processor.ts`)  
   Replaced `import { isNullOrUndefined } from "util"` with an inline helper. The `util` API
   was removed in Node.js 22.

2. **Error details persisted on execution pointer** (`workflow-executor.ts`)  
   Step exceptions now write a structured record to `pointer.persistenceData._errors[]`:
   `{ message, stack, errorTime, retryCount }`. Previously only `result.errors` was populated.

3. **Instance-isolated state** (4 service files)  
   `MemoryPersistenceProvider`, `SingleNodeLockProvider`, `SingleNodeQueueProvider`, and
   `WorkflowRegistry` all used module-level `var` arrays — shared across every instance in the
   same Node.js process. All replaced with `private` instance fields. This was a correctness
   bug (state leaking between test runs and between container instances).

4. **Secure ID generation** (`memory-persistence-provider.ts`, `execution-pointer-factory.ts`)  
   `(Math.random() * 0x10000000000000).toString(16)` replaced with `crypto.randomUUID()`.

5. **`acquireLock` typo** fixed  
   `IDistributedLockProvider.aquireLock` → `acquireLock` across the interface, both single-node
   implementations, and all call sites in `workflow-host.ts` (×3), `workflow-queue-worker.ts`,
   `event-queue-worker.ts`. Provider stubs (Redis, Azure) updated to match.

### Modernisation Applied

6. **TypeScript upgraded** `^2.2.1` → `^5.0.0`; tsconfig target `ES5` → `ES2020`
7. **inversify upgraded** `^4.1.0` → `^6.0.0`; reflect-metadata `^0.1.10` → `^0.2.0`
8. **Jasmine upgraded** `^2.5.2` → `^5.0.0`
9. **`noImplicitAny: true`** enabled; all interface methods given explicit return types;
   spec helper variables typed; `QueueType` converted from a plain object to a TypeScript `enum`
10. **GitHub Actions CI** added: build + test on Node 20 and 22 for every push/PR
11. **Package renamed** to `@reactorynet/workflow-es`, version `2.3.6-reactory.2`
12. **Repository URL** updated to `reactorynet/reactory-workflow-es`
13. **`build:pack` script** added: `npm run build && npm pack` → emits `.tgz` artifact

---

## Planned Improvements

### Short-term (next release)

- **Full `strict: true`** — currently only `noImplicitAny` is enabled; enabling the full strict
  flag will surface additional issues around `strictNullChecks`, `strictPropertyInitialization`, etc.
- **`ExecutionPointer.persistenceData` typing** — replace `any` with a typed interface:
  ```typescript
  interface PointerPersistenceData {
    _errors?: Array<{ message: string; stack: string | null; errorTime: string; retryCount: number }>;
    [key: string]: unknown;
  }
  ```
- **Jest migration** — replace Jasmine with Jest to align with the rest of the Reactory platform
  and gain watch mode, coverage reporting, and snapshot testing
- **Provider dependency updates** — MongoDB, Redis, and Azure providers reference outdated driver
  versions; update `package.json` and resolve any API changes

### Medium-term (Reactory integration)

- **Reactory service adapter** — wrap `WorkflowHost` as a `@reactorynet/reactory-core`
  `IReactoryService` so it participates in the express server's IoC container and lifecycle
  (start/stop hooks, health checks)
- **Reactory Queue event emission** — publish Reactory Queue events on workflow lifecycle
  transitions: `workflow.started`, `workflow.completed`, `workflow.failed`, `workflow.suspended`
  so other modules can react without polling
- **OpenTelemetry instrumentation** — emit spans for step execution and integrate with
  `reactory-telemetry`; expose workflow metrics (active instances, step durations, error rates)
- **Dead-letter queue** — route permanently failed steps (max retries exhausted) to a
  configurable dead-letter handler rather than silently suspending

### Longer-term

- **Publish to npm** — once the Reactory service adapter is stable, consider publishing
  `@reactorynet/workflow-es` publicly so it can be used outside the `file:` dependency model
- **ESM output** — add an ESM build target alongside the current CommonJS output
- **Browser bundle** — the upstream claimed browser support; validate and restore with a
  separate bundle target

---

## Key Concepts

### IoC Container (inversify)
All services are resolved via an inversify `Container`. The `TYPES` map provides symbols for each
interface. `configureWorkflow()` builds the container with default bindings; consumers call
`.usePersistence()`, `.useQueueManager()`, etc. to swap implementations.

### Execution Flow
1. `WorkflowHost.startWorkflow()` creates a `WorkflowInstance`, adds a genesis `ExecutionPointer`,
   persists it, and queues the workflow ID.
2. `WorkflowQueueWorker` dequeues IDs and calls `WorkflowExecutor.execute()`.
3. `WorkflowExecutor` iterates over active pointers, resolves the step body from the container,
   runs inputs, calls `body.run()`, runs outputs, then delegates to `ExecutionResultProcessor`.
4. `ExecutionResultProcessor.processExecutionResult()` handles routing: advance to next step,
   branch, sleep, or wait for an event.
5. `ExecutionResultProcessor.handleStepException()` applies the error strategy
   (Retry / Suspend / Terminate / Compensate).
6. `PollWorker` re-queues runnable instances every 10 seconds (wakes sleeping steps).
7. `EventQueueWorker` processes published events and wakes waiting pointers.

### Error Handling Strategies (`WorkflowErrorHandling`)
- `Retry` — sleep and retry after `step.retryInterval`
- `Suspend` — set workflow status to Suspended
- `Terminate` — set workflow status to Terminated
- `Compensate` — walk the scope stack running compensation steps (Saga pattern)

---

## Build & Test

```bash
cd core

yarn install
yarn build       # compile TypeScript → build/
yarn test        # run Jasmine scenarios
yarn build:pack  # build + emit .tgz for local integration with the server
```

The `bin/install.sh` in `reactory-express-server` automates this: it clones this repo, runs
`yarn install && yarn build:pack` in `core/`, and updates the server's `package.json` `file:`
reference to point at the fresh artifact before running `yarn install` on the server.

---

## Integration with Reactory Express Server

All `import ... from 'workflow-es'` statements across 30 TypeScript files have been updated to
`import ... from '@reactorynet/workflow-es'`. The affected modules are:

- `src/modules/reactory-core/workflow/`
- `src/modules/reactory-kyc/workflows/`
- `src/modules/reactory-communicator/workflows/`
- `src/modules/reactory-kb/workflows/`
- `src/modules/reactory-reactor/workflow/`

The server `package.json` dependency:
```json
"@reactorynet/workflow-es": "file:../reactory-workflow-es/core/reactorynet-workflow-es-2.3.6-reactory.2.tgz"
```

---

## Conventions

- All source lives in `core/src/` — do **not** edit files under `core/build/` (compiled output)
- One class per file, filename matches class name in kebab-case
- `@injectable()` on every service class; `@inject(TYPES.X)` on every injected constructor parameter
- No business logic in models — plain data classes only
- `ExecutionResult` uses static factory methods (`next()`, `persist()`, `branch()`,
  `waitForEvent()`) — do not construct directly
- Test scenarios live in `core/spec/scenarios/` using Jasmine `describe`/`beforeAll`/`it`
  with the `spinWaitCallback` helper for async completion
- Provider stubs in `providers/` must implement the same interface as the single-node built-ins;
  when `acquireLock`/`releaseLock` naming changes are made in the core interface, update all
  provider implementations to match

## Files NOT to Edit

- `core/build/` — generated; overwritten on every `yarn build`
- `node_modules/` — dependencies
- `providers/*/build/` — generated output for each provider


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
