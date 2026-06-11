# Spec — M1 · Workflow-definition version-safety on load

| Field | Value |
|---|---|
| **Item ID** | M1 |
| **Title** | Workflow-definition version-safety on load |
| **Plan reference** | [`upgrade-plan.md` → M1](../upgrade-plan.md) |
| **Target** | Both (Cloud + Electron) |
| **Severity** | Medium |
| **Owner tag** | `[copilot+review]` |
| **Status** | spec |
| **Depends on** | H5 (dead-letter target) |
| **Author / reviewer** | copilot / wweber |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. A running workflow is a **persisted
`WorkflowInstance`** that carries a `workflowDefinitionId: string` and a `version: number`
(`core/src/models/workflow-instance.ts:6-7`). The *definition* — the actual graph of steps — is **not
persisted**; it lives only in an in-memory registry that the host process builds at startup when the
consumer calls `host.registerWorkflow(SomeWorkflowClass)`. Each registration stores one entry keyed by
`(id, version)`:

```ts
// core/src/services/workflow-registry.ts:10-25
public getDefinition(id: string, version: number): WorkflowDefinition {
    const item = this.registry.find(x => x.id === id && x.version === version);
    if (!item)
        throw new Error(`Workflow not registered: ${id}@${version}`);   // <-- generic throw
    return item.defintion;
}

public registerWorkflow<TData>(workflow: WorkflowBase<TData>): void {
    const entry = new RegistryEntry();
    entry.id = workflow.id;
    entry.version = workflow.version;
    const builder = new WorkflowBuilder<TData>();
    workflow.build(builder);
    entry.defintion = builder.build(workflow.id, workflow.version);
    this.registry.push(entry);
}
```

To execute a runnable instance, the queue worker loads it and hands it to the executor, which looks up
its definition by `(workflowDefinitionId, version)`:

```ts
// core/src/services/workflow-executor.ts:29-32
let def = this.registry.getDefinition(instance.workflowDefinitionId, instance.version);
if (!def) {
    throw new Error(`No workflow definition in registry for ${instance.workflowDefinitionId}:${instance.version}`);
}
```

### What is wrong

1. **The `if (!def)` guard in the executor is dead code.** `getDefinition` *throws* on a miss
   (`workflow-registry.ts:13`); it never returns a falsy value. So the executor's own
   `throw new Error("No workflow definition in registry for …")` is unreachable, and the error that
   actually propagates is the registry's `Workflow not registered: <id>@<version>`.

2. **The thrown error is swallowed and the instance loops forever.** The queue worker calls the
   executor inside a `try/catch` that only logs:

   ```ts
   // core/src/services/workflow-queue-worker.ts:55-98 (abridged)
   private async processWorkflow(self, workflowId): Promise<void> {
       try {
           const gotLock = await self.lockProvider.acquireLock(workflowId);
           if (gotLock) {
               let complete = false;
               try {
                   var instance = await self.persistence.getWorkflowInstance(workflowId);
                   if (instance.status == WorkflowStatus.Runnable) {
                       try {
                           var result = await self.executor.execute(instance);   // <-- throws here
                           complete = true;
                       }
                       finally {
                           await self.persistence.persistWorkflow(instance);     // status still Runnable
                       }
                   }
               }
               finally {
                   await self.lockProvider.releaseLock(workflowId);
                   // complete === false, so no subscribe / re-queue here
               }
           }
       }
       catch (err) {
           const error = toError(err);
           self.logger.error("Error processing workflow: " + error.message);     // <-- only logs
       }
   }
   ```

   When `execute` throws, `complete` stays `false`, the instance is persisted **still `Runnable`**, the
   lock is released, and the error is caught and logged. The instance is left `Runnable` with whatever
   `nextExecution` it had, so the **poll worker re-queues it every cycle** (`getRunnableInstances()`
   returns every `status === Runnable` instance — `memory-persistence-provider.ts`), and the loop
   repeats indefinitely with a generic, non-actionable log line.

3. **No actionable signal, no migration guidance.** The operator sees a repeating
   `Workflow not registered: foo@1` log and nothing else: no terminal state, no lifecycle event, no
   hint that the cause is "version `1` of `foo` is no longer registered in this deployment". There is
   no documented rule telling operators they must keep historical workflow versions registered across
   deploys.

### Why this happens in practice

Workflow versions change when a developer edits a workflow's `build(...)` graph and bumps its
`version`. A deploy that registers **only the new version** orphans every in-flight instance still
referencing the old version. Because definitions are in-memory (never persisted), the old graph is
simply gone, and those instances hit the path above.

### User-visible impact

In-flight workflow instances "break" after a deploy: they neither complete nor surface a clear failure.
They silently churn the queue and the poll worker forever, holding a worker slot and a lock each cycle,
emitting an opaque log message, with no terminal state and no operator-facing event.

### Dependency on H5 (read this — it defines the target state)

This item **depends on H5** (`docs/specs/h5-dead-letter.md`, status `spec`), which introduces the
terminal dead-letter machinery this spec reuses. **Do not redefine any of it here.** After H5 is
`done`, the following exist in core (summarised; H5 is the source of truth):

- `WorkflowStatus.DeadLettered = 4` — terminal; never `Runnable`; excluded from
  `getRunnableInstances()`; the queue worker's `if (instance.status == WorkflowStatus.Runnable)` guard
  skips it; never re-queued (`h5-dead-letter.md` §5.1, §6.6).
- `PointerStatus.DeadLettered = 8` — marks the offending pointer (`h5-dead-letter.md` §5.1).
- A minimal in-process lifecycle hub `ILifecycleEventHub` (DI symbol `TYPES.ILifecycleEventHub`) with
  `emit(evt)` / `on(handler)`, the event payload type `WorkflowDeadLetteredEvent`, and the constant
  `WORKFLOW_DEAD_LETTERED = "workflow.dead-lettered"`, all declared in
  `core/src/abstractions/lifecycle-events.ts` and implemented in `core/src/services/lifecycle-events.ts`
  (`h5-dead-letter.md` §5.4). `emit` swallows handler errors.
- `WorkflowConfig.onLifecycleEvent(handler)` and `IWorkflowHost.onLifecycleEvent(handler)` for
  subscribing (`h5-dead-letter.md` §5.4 DI/config impact).
- `IRetryConfig` (DI symbol `TYPES.IRetryConfig`) is injected into `WorkflowExecutor` already
  (`h5-dead-letter.md` §5.3).

This spec adds **one new cause** of dead-lettering — "definition version not registered on load" — and
reuses that exact terminal transition and event. It does **not** add any new status, pointer status, or
event type.

---

## 2. Goal

After this change, when the engine loads a runnable instance whose `(workflowDefinitionId, version)`
pair is **not in the registry**, it does not throw a generic error deep in execution and it does not
loop forever. Instead it **dead-letters the instance cleanly** (reusing H5's
`WorkflowStatus.DeadLettered`, `PointerStatus.DeadLettered`, and the single
`workflow.dead-lettered` lifecycle event), with a **structured, actionable error message** naming the
missing `definitionId` and `version` and telling the operator to register all historical workflow
versions. A registered version continues to execute exactly as before. Separately, attempting to
**start** a workflow for an unknown version fails **fast at the `startWorkflow` call site** with a clear
error (so the caller learns immediately, rather than creating a doomed instance). The "never unregister
old workflow versions across deploys" rule is documented in the project README/guide.

---

## 3. Out of scope

- Do **not** define `WorkflowStatus.DeadLettered`, `PointerStatus.DeadLettered`, the lifecycle hub, the
  `WorkflowDeadLetteredEvent` payload, `IRetryConfig`, or `onLifecycleEvent`. These are **H5's**; depend
  on them, do not duplicate or modify them.
- Do **not** add a "definition migration" / upcasting mechanism, an instance-rewrite tool, or any
  automatic version-upgrade behaviour. This item only *detects* the missing version and dead-letters it
  with guidance.
- Do **not** persist workflow definitions or add any new persisted field.
- Do **not** change `IPersistenceProvider`, `IQueueProvider`, or `IDistributedLockProvider` signatures,
  and do **not** edit any package under `providers/*`.
- Do **not** change the retry/budget semantics from H5. A missing definition is **not** a retryable
  condition — it dead-letters on the **first** load attempt (no retry budget consumed), because
  re-registering a definition mid-instance is an operator action, not something a retry can fix.
- Do **not** change `getDefinition`'s behaviour for the *present-version* case (it still returns the
  definition).
- Do **not** rename or renumber any existing enum/status members.

## 4. Files to create / modify

> Exhaustive. Every path.

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/workflow-registry.ts` | modify | Add a non-throwing `tryGetDefinition(id, version): WorkflowDefinition \| undefined` to `IWorkflowRegistry` (keep `getDefinition` throwing for fail-fast start path). |
| `core/src/services/workflow-registry.ts` | modify | Implement `tryGetDefinition` (returns `undefined` on miss, never throws); `getDefinition` unchanged. |
| `core/src/services/workflow-executor.ts` | modify | Replace the dead `getDefinition`/`if (!def)` pattern with `tryGetDefinition`; when missing, dead-letter the instance (reusing H5) instead of throwing; build the structured message. Inject `ILifecycleEventHub`. |
| `core/src/services/workflow-host.ts` | verify | `startWorkflow` already calls `registry.getDefinition(id, version)` (throws on miss) — confirm it fails fast at call time; no code change expected, but verify the throw is not swallowed (it is not — `startWorkflow` has no try/catch). |
| `core/spec/scenarios/version-safety.spec.ts` | create | New scenario: an instance whose `(definitionId, version)` is unregistered dead-letters cleanly with the actionable message + event; a registered version runs to completion (regression). |
| `core/README.md` | modify | Document the operational rule: "never unregister old workflow versions across deploys" + the dead-letter behaviour on a missing version. |
| `core/src/abstractions.ts` (barrel) | verify | `IWorkflowRegistry` is already re-exported via this barrel; the new method needs no new export. Confirm `from "../abstractions"` resolves `IWorkflowRegistry` (it does — see `workflow-executor.ts:1`). No edit expected. |

> The implementer MUST run `grep -rn "getDefinition" core/src` before editing to confirm the only two
> call sites are `workflow-executor.ts:29` and `workflow-host.ts:53`. If a third call site exists,
> apply the same load-time-vs-start-time distinction (§6) to it.

## 5. Interface & data-model changes

### 5.1 Registry: add a non-throwing lookup

The executor needs to *detect* a missing definition without an exception (so it can dead-letter rather
than throw). `startWorkflow` keeps the throwing variant for fail-fast behaviour. Add `tryGetDefinition`
alongside the existing `getDefinition`.

```ts
// BEFORE — core/src/abstractions/workflow-registry.ts
import { WorkflowDefinition } from "../models";
import { WorkflowBase } from "./workflow-base";

export interface IWorkflowRegistry {
    getDefinition(id: string, version: number) : WorkflowDefinition;
    registerWorkflow<TData>(workflow: WorkflowBase<TData>): void;
}

// AFTER
import { WorkflowDefinition } from "../models";
import { WorkflowBase } from "./workflow-base";

export interface IWorkflowRegistry {
    /** Returns the definition or THROWS if not registered. Use at start time (fail fast). */
    getDefinition(id: string, version: number) : WorkflowDefinition;
    /** Returns the definition or `undefined` if not registered. Never throws. Use at load time. */
    tryGetDefinition(id: string, version: number) : WorkflowDefinition | undefined;
    registerWorkflow<TData>(workflow: WorkflowBase<TData>): void;
}
```

```ts
// BEFORE — core/src/services/workflow-registry.ts (excerpt)
public getDefinition(id: string, version: number): WorkflowDefinition {
    const item = this.registry.find(x => x.id === id && x.version === version);
    if (!item)
        throw new Error(`Workflow not registered: ${id}@${version}`);
    return item.defintion;
}

// AFTER  (getDefinition delegates to tryGetDefinition; behaviour for the throw path unchanged)
public getDefinition(id: string, version: number): WorkflowDefinition {
    const def = this.tryGetDefinition(id, version);
    if (!def)
        throw new Error(`Workflow not registered: ${id}@${version}`);
    return def;
}

public tryGetDefinition(id: string, version: number): WorkflowDefinition | undefined {
    const item = this.registry.find(x => x.id === id && x.version === version);
    return item ? item.defintion : undefined;
}
```

> Note: `getDefinition`'s thrown message string (`Workflow not registered: <id>@<version>`) is
> **preserved verbatim** so the fail-fast start path's error text does not change.

### 5.2 Executor: detect-and-dead-letter instead of throw

```ts
// BEFORE — core/src/services/workflow-executor.ts:29-32
let def = this.registry.getDefinition(instance.workflowDefinitionId, instance.version);
if (!def) {
    throw new Error(`No workflow definition in registry for ${instance.workflowDefinitionId}:${instance.version}`);
}

// AFTER  (illustrative; exact field names per H5)
let def = this.registry.tryGetDefinition(instance.workflowDefinitionId, instance.version);
if (!def) {
    this.deadLetterMissingDefinition(instance, result);   // §6.1 / §6.2 / §6.3
    return result;                                         // no further execution this pass
}
```

The new private method on `WorkflowExecutor` (illustrative — the implementer must reuse H5's exact
status values, payload field names, and `lifecycle.emit` call shape):

```ts
private deadLetterMissingDefinition(instance: WorkflowInstance, result: WorkflowExecutorResult): void {
    const message =
        `Workflow definition not registered on load: ` +
        `definitionId="${instance.workflowDefinitionId}", version=${instance.version}. ` +
        `The host process has no registered definition for this (id, version) pair, so the instance ` +
        `cannot be executed. This usually means an old workflow version was not re-registered after a ` +
        `deploy. Register all historical workflow versions on every host (never unregister old versions).`;

    this.logger.error(
        "Dead-lettering workflow %s: definition %s@%s not registered",
        instance.id, instance.workflowDefinitionId, instance.version);

    // record the error so it surfaces in the event payload and on the pointer
    const perr = new ExecutionError();
    perr.message = message;
    perr.errorTime = new Date();
    result.errors.push(perr);

    // mark the genesis / first active pointer as the offending pointer (defensive: instances always
    // have at least the genesis pointer; if there is no active pointer, fall back to the first)
    const pointer = instance.executionPointers.find(p => p.active) || instance.executionPointers[0];
    let stepId = -1;
    if (pointer) {
        pointer.active = false;
        pointer.status = PointerStatus.DeadLettered;     // 8  (H5)
        if (!pointer.endTime) pointer.endTime = new Date();
        if (!pointer.persistenceData) pointer.persistenceData = {};
        if (!Array.isArray(pointer.persistenceData._errors)) pointer.persistenceData._errors = [];
        pointer.persistenceData._errors.push({
            message, stack: null, errorTime: new Date().toISOString(), retryCount: pointer.retryCount || 0
        });
        stepId = pointer.stepId;
    }

    instance.status = WorkflowStatus.DeadLettered;       // 4  (H5)
    instance.nextExecution = null;                       // not runnable; never re-queued

    // exactly one lifecycle event, reusing H5's payload/hub (DO NOT redefine the type)
    this.lifecycle.emit({
        event: WORKFLOW_DEAD_LETTERED,                   // "workflow.dead-lettered" (H5)
        workflowId: instance.id,
        workflowDefinitionId: instance.workflowDefinitionId,
        version: instance.version,
        pointerId: pointer ? pointer.id : "",
        stepId,
        retryCount: pointer ? (pointer.retryCount || 0) : 0,
        maxRetries: 0,                                   // missing-definition is not retryable (§6.5)
        errorMessage: message,
        deadLetteredAt: new Date().toISOString()
    });
}
```

> The executor returns the `result` immediately and **does not** call `processAfterExecutionIteration`
> or `determineNextExecutionTime` for the missing-definition case (those need `def`, which is absent).
> `determineNextExecutionTime` is also guarded against resurrecting a dead-lettered instance by H5
> (`h5-dead-letter.md` §6.10), so even the normal path is safe — but here we return before reaching it.

### DI / config impact

`WorkflowExecutor` gains one injected dependency (the hub introduced by H5):

```ts
@inject(TYPES.ILifecycleEventHub) private lifecycle: ILifecycleEventHub;
```

`TYPES.ILifecycleEventHub` and its singleton binding are created by H5 (`h5-dead-letter.md` §5.4 DI/config
impact). **No new DI symbol, binding, or `WorkflowConfig` method is added by M1.** `IRetryConfig` is
already injected into the executor by H5 and is not needed by the missing-definition path
(`maxRetries: 0`).

### Persisted / at-rest format impact

None. `WorkflowInstance.status` may now hold `WorkflowStatus.DeadLettered` (`4`) and a pointer's
`status` may hold `PointerStatus.DeadLettered` (`8`) for the missing-definition cause — but those values
and their at-rest treatment are introduced by H5, which already establishes "no schema migration; new
status integers fit existing numeric fields" (`h5-dead-letter.md` §5 Persisted impact, §7). M1 adds no
new persisted shape.

## 6. Behavioural contract (numbered rules)

> "Load" = the queue worker dequeues a `Runnable` instance, acquires its lock, reads it from
> persistence, and passes it to `WorkflowExecutor.execute(instance)`.

1. **Missing version → dead-letter, not generic throw.** When `execute(instance)` is called and
   `registry.tryGetDefinition(instance.workflowDefinitionId, instance.version)` returns `undefined`, the
   executor MUST NOT throw. It MUST set `instance.status = WorkflowStatus.DeadLettered` (H5's value),
   mark the offending pointer `PointerStatus.DeadLettered` with `active = false` and an `endTime`,
   record the structured error on `pointer.persistenceData._errors` and in `result.errors`, set
   `instance.nextExecution = null`, emit exactly one `workflow.dead-lettered` lifecycle event, and
   `return` the `WorkflowExecutorResult` without executing any step.

2. **Actionable error detail.** The recorded error message and the event's `errorMessage` MUST include
   all three of: the `workflowDefinitionId`, the `version`, and the remediation phrase instructing the
   operator to **register all historical workflow versions** (never unregister old versions). The exact
   wording is the string in §5.2; tests assert on the presence of `definitionId="<id>"`,
   `version=<n>`, and the substring `register all historical workflow versions`.

3. **Dead-lettered instance stops consuming the queue (reuses H5 §6.6).** Because
   `instance.status` is no longer `Runnable`: the queue worker's
   `if (instance.status == WorkflowStatus.Runnable)` guard (`workflow-queue-worker.ts:65`) skips
   execution, its re-queue branch (`workflow-queue-worker.ts:83`, also gated on `Runnable`) is not
   taken, and `getRunnableInstances()` excludes it. The instance is executed **zero** further times and
   the poll worker never re-queues it.

4. **Present version behaves unchanged.** When `tryGetDefinition` returns a definition, execution
   proceeds exactly as today (no behavioural change to step execution, result processing,
   `processAfterExecutionIteration`, or `determineNextExecutionTime`). The only difference from the
   pre-change code is that the lookup now uses `tryGetDefinition` and the unreachable
   `throw new Error("No workflow definition in registry…")` is removed.

5. **Missing definition is NOT retryable.** Unlike H5's step-failure paths, the missing-definition path
   does **not** consume a retry budget and does **not** schedule a `sleepUntil` retry. It dead-letters on
   the **first** load that observes the miss. The event's `maxRetries` is `0` and `retryCount` reflects
   whatever the pointer already had (normally `0`). Rationale: re-registering a definition is an operator
   action; retrying cannot resolve it, and retrying would reproduce the original infinite-loop symptom.

6. **`startWorkflow` for an unknown version fails fast at call time (start-time vs load-time
   distinction).** `host.startWorkflow(id, version, data)` calls `registry.getDefinition(id, version)`
   **before** creating any instance (`workflow-host.ts:53`). `getDefinition` throws
   `Workflow not registered: <id>@<version>`. `startWorkflow` has no surrounding try/catch, so the
   rejection propagates to the caller's `await`. The caller therefore learns immediately and **no
   doomed instance is persisted or queued**. This is intentionally different from the load-time path
   (rule §1): at start time the caller is present to handle the error synchronously; at load time the
   instance already exists and the only sane outcome is a clean terminal dead-letter. M1 MUST NOT change
   `startWorkflow` to swallow this error or to dead-letter at start time.

7. **Idempotency / one-shot.** Dead-lettering for a missing definition is terminal (rule §3), so the
   `execute` pass that detects the miss runs once and emits exactly one event. A subsequent dequeue
   cannot re-trigger it because the instance is no longer `Runnable` (the queue worker's guard skips
   straight past `execute`).

8. **Lifecycle handler isolation (inherited from H5).** A subscribed handler that throws when the
   `workflow.dead-lettered` event fires MUST NOT affect engine state or persistence — `emit` swallows
   handler errors (H5 §5.4 / §6.12). M1 relies on this; it adds no new guarantee.

## 7. Provider parity

**No core interface change; no provider impact.**

- `IWorkflowRegistry` is **not** a provider interface (`IPersistenceProvider` /
  `IDistributedLockProvider` / `IQueueProvider`). It is an internal engine service with a single
  in-memory implementation (`core/src/services/workflow-registry.ts`). Adding `tryGetDefinition` to it
  does not touch any provider.
- The only at-rest values M1 can produce (`WorkflowStatus.DeadLettered = 4`,
  `PointerStatus.DeadLettered = 8`) are already established by H5 as fitting existing numeric fields
  with no schema change (H5 §7). M1 introduces nothing new at rest.

| Provider | Change required |
|---|---|
| memory | None. |
| sqlite | None (provider is C2; not affected). |
| postgres | None. |
| mongodb | None. |
| redis | None. |
| azure | None. |

> Providers MUST NOT be edited in this PR. `git status providers/` must show no M1 changes.

## 8. Test plan (TDD)

Tests follow the existing scenario style in `core/spec/scenarios/` (see `basic-workflow.spec.ts` and
the H5 `dead-letter.spec.ts`): configure a host with a `MemoryPersistenceProvider`, register a
workflow, drive it, then `spinWait` until the instance leaves `Runnable`. Use the promise helper
`spinWait` from `core/spec/helpers/spin-wait.ts`. Subscribe to lifecycle events via
`config.onLifecycleEvent(evt => events.push(evt))` (provided by H5).

**Producing the "unregistered version" condition.** A registered workflow always stores its
`(id, version)`. To get an instance whose version is *not* registered, the most robust approach in the
memory-provider harness is:

- Register the workflow (so `startWorkflow` succeeds and a real instance with a genesis pointer is
  created), `startWorkflow(...)` to get the `id`, then **immediately stop the host** (`host.stop()`)
  so the queue/poll workers do not race, fetch the instance via
  `persistence.getWorkflowInstance(id)`, **mutate `instance.version` to an unregistered number**
  (e.g. `999`), `await persistence.persistWorkflow(instance)`, set it back to `Runnable` /
  `nextExecution = 0` if needed, restart the host, and `queueProvider.queueForProcessing(id, …)` — OR,
  more simply and deterministically, drive `WorkflowExecutor.execute(instance)` **directly** against a
  hand-built `WorkflowInstance` (this is the recommended primary form; see the first test).

The two forms are both acceptable; the direct-`execute` unit-style test is the **failing-test-first**
because it is deterministic and does not depend on worker timing.

### Failing-test-first
- **`version-safety.spec.ts` › "executing an instance whose (definitionId, version) is unregistered
  dead-letters cleanly with an actionable message"** — *must fail before implementation* (today
  `execute` throws `Workflow not registered: …` and there is no `WorkflowStatus.DeadLettered`).
  - **arrange:** `configureWorkflow()` with `MemoryPersistenceProvider`; register a trivial workflow
    `version-safe-workflow` (single passing step) at `version: 1`; `config.onLifecycleEvent(evt =>
    events.push(evt))`. Obtain the engine's `WorkflowExecutor` (resolve it from the configured
    container, or build a real `WorkflowInstance` via the registry's genesis pointer). Construct a
    `WorkflowInstance` with `workflowDefinitionId = "version-safe-workflow"`, **`version = 999`**
    (unregistered), `status = WorkflowStatus.Runnable`, and at least one `active` execution pointer.
  - **act:** `const result = await executor.execute(instance);`
  - **assert:** does **not** throw; `instance.status === WorkflowStatus.DeadLettered`;
    the active/first pointer `.status === PointerStatus.DeadLettered` and `.active === false`;
    `instance.nextExecution === null`; `result.errors.length >= 1`;
    `events.length === 1` and `events[0].event === "workflow.dead-lettered"` with
    `events[0].version === 999`, `events[0].workflowDefinitionId === "version-safe-workflow"`,
    `events[0].maxRetries === 0`, and `events[0].errorMessage` contains `version=999`,
    `definitionId="version-safe-workflow"`, and the substring
    `register all historical workflow versions` (proves §6.1, §6.2, §6.5).

### Coverage
- **`version-safety.spec.ts` › "a registered version runs to completion (regression)"** — register
  `version-safe-workflow@1`, `host.start()`, `host.startWorkflow("version-safe-workflow", 1)`,
  `spinWait` until `status != Runnable`; assert `status === WorkflowStatus.Complete` and the step ran
  exactly once, and `events.length === 0` (no dead-letter event). Proves §6.4.
- **`version-safety.spec.ts` › "an unregistered version dead-letters end-to-end via the host and stops
  consuming the queue"** — drive through the real host using the "mutate the persisted instance's
  version to 999" technique above; `spinWait` until `status === WorkflowStatus.DeadLettered`; then
  record the dead-letter time, `spinWait` an additional `>= 3` poll cycles and assert the instance is
  still `DeadLettered`, the step body's invocation counter has **not** increased, exactly **one**
  `workflow.dead-lettered` event was emitted, and `persistence.getRunnableInstances()` does not include
  the id. Proves §6.1, §6.3, §6.7.
- **`version-safety.spec.ts` › "startWorkflow for an unknown version rejects at call time and creates
  no instance"** — register `version-safe-workflow@1`; `await expectAsync(host.startWorkflow(
  "version-safe-workflow", 2)).toBeRejectedWithError(/Workflow not registered/);` then assert no new
  instance was persisted for version 2 and no `workflow.dead-lettered` event was emitted (start-time
  failure is fail-fast, not dead-letter). Proves §6.6.
- **Regression — H5 scenarios.** `core/spec/scenarios/dead-letter.spec.ts` and `retry.spec.ts` (created
  by H5) must still pass unchanged: M1 reuses the H5 dead-letter transition and event and must not alter
  retry/step-failure dead-lettering.
- **Regression — existing scenarios.** `basic-workflow`, `if`, `while`, `foreach`, `parallel`,
  `outcome-fork`, `delay`, `schedule`, `external-events`, `data-io`, `saga-compensation` all still pass
  unchanged (proves the present-version path, §6.4, is untouched).

### How to run
```bash
cd core && yarn build
cd core && yarn test                              # full scenario suite, incl. version-safety.spec.ts
# single file, if the repo's jasmine config supports filtering:
cd core && yarn test --filter="version-safety*"   # otherwise run the full suite
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds with the new `tryGetDefinition` on the registry interface and
      implementation, and the executor's missing-definition dead-letter path.
- [ ] `cd core && yarn test` passes on Node 20 and 22, including the new `version-safety.spec.ts`.
- [ ] The failing-first test ("executing an instance whose (definitionId, version) is unregistered
      dead-letters cleanly with an actionable message") is shown to fail on the pre-change tree (it
      throws `Workflow not registered: …`) and pass after.
- [ ] Loading/executing an instance for an unregistered `(definitionId, version)` ends in
      `WorkflowStatus.DeadLettered`, emits exactly one `workflow.dead-lettered` event whose
      `errorMessage` names the `definitionId`, the `version`, and instructs to register all historical
      versions, and is executed **zero** further times (queue + poll), verified by the coverage tests.
- [ ] `host.startWorkflow(id, version)` for an unregistered version rejects at the `await` with
      `Workflow not registered: <id>@<version>` and persists no instance.
- [ ] `grep -n "No workflow definition in registry" core/src/services/workflow-executor.ts` returns no
      matches (the dead throw is removed).
- [ ] All H5 scenarios and all pre-existing scenario specs pass unchanged.
- [ ] No provider package is modified; `git status providers/` shows no changes from this PR.

## 10. Backward compatibility & migration

- **Public API:** additive — one new method `tryGetDefinition` on `IWorkflowRegistry` (and its
  implementation). `getDefinition` keeps its exact signature and its exact thrown message text. No
  member is renamed or renumbered. `startWorkflow`'s observable contract for an unknown version is
  unchanged (it already throws `Workflow not registered: …`).
- **Behavioural change (intentional, documented):** a runnable instance referencing an unregistered
  version previously looped forever emitting a generic log; it now dead-letters once with an actionable
  message and event. Operators who relied on "the instance will recover if I re-register the old version
  later" must instead **keep historical versions registered** (see §12 doc rule) — once an instance has
  dead-lettered it stays terminal (no redrive API is in scope, per §3 and H5).
- **At-rest:** no new schema or migration; the only persisted values are H5's `DeadLettered` status
  integers, which already fit existing numeric fields (H5 §7).
- **Consumer `reactory-express-server`:** integrates via a `file:` tarball. It already must handle
  `WorkflowStatus.DeadLettered` from H5; M1 adds a new *cause* but no new value or signature. It may
  subscribe via `onLifecycleEvent` (already available from H5) and branch on `errorMessage` if it wants
  version-specific alerting. No breaking change.
- **Version bump:** if M1 lands after H5's `2.3.6-reactory.4`, bump to `2.3.6-reactory.5` (additive
  feature, no breaking API). Update `core/package.json` and the consumer tarball reference if it lands
  standalone.
- **Operational migration (the rule):** see §12 — document and adopt "never unregister old workflow
  versions across deploys; register every historical version on every host."

## 11. Definition of Done

When the engine loads a runnable instance whose `(workflowDefinitionId, version)` is not in the
registry, it no longer throws a generic error deep in execution and no longer loops forever. It detects
the miss with the new non-throwing `IWorkflowRegistry.tryGetDefinition`, and — reusing H5's
`WorkflowStatus.DeadLettered`, `PointerStatus.DeadLettered`, and single `workflow.dead-lettered`
lifecycle event — transitions the instance to the terminal dead-letter state with a structured,
actionable error naming the `definitionId`, the `version`, and the instruction to register all
historical workflow versions, then stops the instance consuming the queue (executed zero further times,
never re-queued). The missing-definition path is not retryable (dead-letters on first load). A
registered version executes exactly as before, and `startWorkflow` for an unknown version still fails
fast at the call site without creating an instance. The "never unregister old workflow versions across
deploys" rule is documented in `core/README.md`. The new `version-safety.spec.ts` passes (its
failing-first test was demonstrably red before the change), every H5 and pre-existing scenario still
passes, no provider package is touched, and `core` builds and tests green on Node 20 + 22.

## 12. Implementation notes (optional, non-binding)

- **Suggested edit order:** (1) `abstractions/workflow-registry.ts` + `services/workflow-registry.ts`
  (`tryGetDefinition`); (2) `workflow-executor.ts` (inject `ILifecycleEventHub`, swap to
  `tryGetDefinition`, add `deadLetterMissingDefinition`, remove the dead throw); (3)
  `version-safety.spec.ts`; (4) `core/README.md` doc rule. Land **after** H5 is `done`.
- **Where the H5 symbols come from:** `WorkflowStatus`, `PointerStatus`, `ExecutionError` are in
  `core/src/models` (re-exported from the `core/src/models.ts` barrel). `ILifecycleEventHub`,
  `WORKFLOW_DEAD_LETTERED`, the event payload type, and `TYPES.ILifecycleEventHub` come from
  `core/src/abstractions` (added by H5). Import them the same way the executor already imports from
  `"../abstractions"` and `"../models"`.
- **Pointer selection:** every instance created by `startWorkflow` has a genesis pointer
  (`pointerFactory.buildGenesisPointer` — `workflow-host.ts:63`), so `instance.executionPointers` is
  non-empty in practice. The `find(p => p.active) || executionPointers[0]` fallback in §5.2 is purely
  defensive for hand-built test instances; do not over-engineer it.
- **Doc rule — exact placement (§10 operational migration):** add a short section to `core/README.md`
  titled **"Workflow versioning & deploys"** stating:
  > Workflow *definitions* are held in an in-memory registry, keyed by `(id, version)`; they are not
  > persisted. In-flight instances store only `(workflowDefinitionId, version)` and look the definition
  > up at execution time. **Never unregister an old workflow version while instances created against it
  > may still be running.** When you bump a workflow's `version`, keep registering all historical
  > versions on every host. If a host loads an instance whose version is not registered, the engine
  > dead-letters that instance (terminal `WorkflowStatus.DeadLettered`) and emits a
  > `workflow.dead-lettered` lifecycle event naming the missing `(definitionId, version)` — it does
  > **not** retry, and there is no automatic recovery.
  Place it near the existing "Persistence" / "Multi-node clusters" sections so operators see it with the
  other deployment guidance. (The top-level `README.md` is the upstream `danielgerlag` readme; prefer
  `core/README.md` for Reactory-specific operational rules, consistent with where this engine's package
  lives.)
- **Distinguishing start-time vs load-time, restated for the implementer:** `startWorkflow` →
  `getDefinition` (throws, caller awaits, fail fast, no instance). `execute` (load time) →
  `tryGetDefinition` (no throw, dead-letter). Do not unify these into one behaviour.
- **Upstream reference:** `danielgerlag/workflow-es` throws the same generic registry error and has no
  dead-letter concept; this version-safety behaviour is a Reactory enhancement layered on H5.
```
