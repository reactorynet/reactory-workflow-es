import {
    WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext,
    ExecutionResult, WorkflowInstance, WorkflowErrorHandling, configureWorkflow,
    IWorkflowExecutor, TYPES
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

// P0.6 — Foreach body steps have no per-iteration data isolation.
// See docs/specs/p0.6-foreach-scope-isolation.md.
//
// Input/output mappers now receive the executing pointer's StepExecutionContext as an
// optional third argument, so a multi-step foreach body can key its writes by
// `context.item` (or `context.pointer.id`) instead of racing into one shared slot.

// --- Scenario 1: multi-step foreach body isolates data between iterations (failing-test-first) ---
describe("foreach scope isolation — multi-step body (fixed)", () => {

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = [1, 2, 3];
            context.workflow.data.seen = {};
            context.workflow.data.results = [];
            return ExecutionResult.next();
        }
    }

    class WriteSeen extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class ReadSeen extends StepBody {
        public value: number;
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.results.push(this.value);
            return ExecutionResult.next();
        }
    }

    class Isolation_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-isolation-fixed";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then
                    .startWith(WriteSeen)
                        .output((s: WriteSeen, d: any, ctx: StepExecutionContext) => {
                            d.seen = d.seen || {};
                            d.seen[ctx.item] = ctx.item * 10;
                        })
                    .then(ReadSeen)
                        .input((s: ReadSeen, d: any, ctx: StepExecutionContext) => {
                            s.value = d.seen[ctx.item];
                        })
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Isolation_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-isolation-fixed", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("completes the workflow", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    // Proves §6.1, §6.2: each iteration's output write and input read observed only its
    // own `context.item`, not another iteration's. Before this change this test could not
    // even be written — mappers had no third parameter to read `ctx.item` from.
    it("records exactly one distinct result per collection item, not the last writer's value", () => {
        expect(instance.data.results.slice().sort((a: number, b: number) => a - b)).toEqual([10, 20, 30]);
    });
});

// --- Regression witness: the pre-fix, two-parameter shared-sink corruption --------------------
// This documents the bug described in the spec (§1 "Where it breaks", consequence (b)): a
// two-parameter mapper cannot see `ctx.item`, so an author who wires a multi-step foreach body
// with only `(step, data)` mappers has no choice but to funnel every iteration through one
// shared `data` slot. Because the executor advances pointers in lockstep breadth-first
// (workflow-executor.ts:39), all three copies of step 1 finish writing before step 2 of item #1
// ever runs — so step 2 reads whichever item wrote last. This test intentionally asserts the
// CORRUPTED result. Delete it only if the shared-sink semantics change.
describe("foreach scope isolation — multi-step body (two-parameter regression witness)", () => {

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = [1, 2, 3];
            context.workflow.data.value = null;
            context.workflow.data.results = [];
            return ExecutionResult.next();
        }
    }

    class WriteShared extends StepBody {
        public computed: number;
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            // `run(context)` already sees `context.item` correctly — that part of the
            // engine was never broken (spec §1, "That part works"). The corruption is
            // specifically in the two-parameter mapper's inability to see it.
            this.computed = context.item * 10;
            return ExecutionResult.next();
        }
    }

    class ReadShared extends StepBody {
        public value: number;
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.results.push(this.value);
            return ExecutionResult.next();
        }
    }

    class Regression_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-isolation-regression-witness";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then
                    .startWith(WriteShared)
                        // two-parameter mapper: no ctx, so it can only write to the one
                        // shared `data.value` slot — every branch races into it.
                        .output((s: WriteShared, d: any) => { d.value = s.computed; })
                    .then(ReadShared)
                        .input((s: ReadShared, d: any) => { s.value = d.value; })
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Regression_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-isolation-regression-witness", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("documents the pre-fix corruption: all iterations read the last writer's value", () => {
        expect(instance.data.results).toEqual([30, 30, 30]);
    });
});

// --- Scenario 2: context.item is undefined outside a container ---------------------------------
describe("foreach scope isolation — context.item outside a container", () => {

    const seenContexts: Array<StepExecutionContext | undefined> = [];

    class StepA extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class StepB extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class Flat_Workflow implements WorkflowBase<any> {
        public id: string = "flat-two-step-no-container";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(StepA)
                    .input((s: StepA, d: any, ctx: StepExecutionContext) => seenContexts.push(ctx))
                    .output((s: StepA, d: any, ctx: StepExecutionContext) => seenContexts.push(ctx))
                .then(StepB)
                    .input((s: StepB, d: any, ctx: StepExecutionContext) => seenContexts.push(ctx))
                    .output((s: StepB, d: any, ctx: StepExecutionContext) => seenContexts.push(ctx));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Flat_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("flat-two-step-no-container", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.3: outside any container, the third argument is a defined
    // StepExecutionContext whose `.item` is undefined.
    it("passes a defined context whose item is undefined for every mapper call", () => {
        expect(seenContexts.length).toBe(4);
        for (const ctx of seenContexts) {
            expect(ctx).toBeDefined();
            expect(ctx.item).toBeUndefined();
        }
    });
});

// --- Scenario 3: two-parameter mappers keep working (backward compatibility) --------------------
describe("foreach scope isolation — two-parameter mappers keep working", () => {

    class SetAmount extends StepBody {
        public amount: number;
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.charged = this.amount;
            return ExecutionResult.next();
        }
    }

    class BackCompat_Workflow implements WorkflowBase<any> {
        public id: string = "two-param-backcompat";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(SetAmount, step => step
                    // Deliberately old-style: only (step, data), no third parameter.
                    .input((s: SetAmount, d: any) => s.amount = d.total)
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(BackCompat_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("two-param-backcompat", "1.0.0", { total: 42 });
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.4.
    it("behaves identically to before the change", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(instance.data.charged).toBe(42);
    });
});

// --- Scenario 4: if inside foreach branches per item ---------------------------------------------
describe("foreach scope isolation — if inside foreach branches per item", () => {

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = [1, 2, 3, 4];
            context.workflow.data.recorded = [];
            return ExecutionResult.next();
        }
    }

    class RecordEven extends StepBody {
        public item: any;
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.recorded.push(this.item);
            return ExecutionResult.next();
        }
    }

    // `.if()`/`.while()`/`.foreach()`/`.saga()` attach to a StepBuilder, not the plain
    // WorkflowBuilder handed to `.do()` — so a foreach body that starts with one of them
    // needs a leading passthrough step to hang off of. It has no observable effect: it
    // just forwards `ctx.item` on to the next pointer via buildNextPointer, same as today.
    class NoOp extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class IfBranch_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-if-branches-per-item";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then
                    .startWith(NoOp)
                    // The `.if()` step's own pointer descends from the foreach branch (via
                    // NoOp), so `ctx.item` on ITS mappers is the enclosing item (§6.5).
                    .if((d: any, item: any) => item % 2 === 0)
                        .output((s: any, d: any, ctx: StepExecutionContext) => {
                            // A child pointer created under an `if` gets contextItem = null
                            // (see the documented limitation below), so the recording step
                            // inside `.do()` cannot read `ctx.item` directly. Correlate via
                            // the enclosing if-pointer's id instead (ctx.pointer is exposed
                            // on the context precisely for this reason — spec §5 design note).
                            d.itemByPointer = d.itemByPointer || {};
                            d.itemByPointer[ctx.pointer.id] = ctx.item;
                        })
                        .do(ifThen => ifThen
                            .startWith(RecordEven)
                                .input((s: RecordEven, d: any, ctx: StepExecutionContext) => {
                                    s.item = d.itemByPointer[ctx.pointer.predecessorId];
                                })
                        )
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(IfBranch_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-if-branches-per-item", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.5.
    it("only recorded the items for which the predicate returned true", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(instance.data.recorded.slice().sort((a: number, b: number) => a - b)).toEqual([2, 4]);
    });
});

// --- Scenario 4b: documented limitation — a step inside if.do() inside foreach ------------------
// From the spec's implementation notes (§12): `If` branches with
// `ExecutionResult.branch([null], containerData)`, so the child pointer created for its
// `.do()` body gets `contextItem = null`, not the outer foreach item. This is a pre-existing
// property of `buildChildPointer` (execution-pointer-factory.ts), which is explicitly out of
// scope for this change (§3: "Do not change ExecutionPointer... or anything written to a
// provider"). This test documents and locks in that behaviour rather than leaving it silently
// broken. Scenario 4 above shows the supported workaround (correlate via `ctx.pointer.id`).
describe("foreach scope isolation — documented limitation: if-body loses the outer item", () => {

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = [1, 2];
            return ExecutionResult.next();
        }
    }

    const observedItems: any[] = [];

    class Inspect extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            observedItems.push(context.item);
            return ExecutionResult.next();
        }
    }

    class NoOp extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class IfLosesItem_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-if-loses-item-documented";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then
                    .startWith(NoOp)
                    .if(() => true)
                        .do(ifThen => ifThen.startWith(Inspect))
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(IfLosesItem_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-if-loses-item-documented", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("documents that context.item is null (not the outer item) inside an if-body within a foreach", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(observedItems.length).toBe(2);
        for (const item of observedItems)
            expect(item).toBeNull();
    });
});

// --- Scenario 5: while inside foreach sees the enclosing item ------------------------------------
describe("foreach scope isolation — while inside foreach sees the item", () => {

    const whileItemsSeen: any[] = [];

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = [1, 2, 3];
            return ExecutionResult.next();
        }
    }

    class NoOp extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class While_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-while-sees-item";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then
                    .startWith(NoOp)
                    // The condition itself captures the item it was invoked with. Returning
                    // false keeps the loop from ever entering its body — this test is only
                    // about what the CONDITION observes (§6.6), not the body's contextItem.
                    .while((d: any, item: any) => { whileItemsSeen.push(item); return false; })
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(While_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-while-sees-item", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.6.
    it("evaluates the while condition once per enclosing item", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(whileItemsSeen.slice().sort((a: number, b: number) => a - b)).toEqual([1, 2, 3]);
    });
});

// --- Scenario 6: nested foreach iterates a collection derived from the outer item ----------------
describe("foreach scope isolation — nested foreach over the outer item's own collection", () => {

    const innerSeen: any[] = [];

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.orders = [
                { id: "a", lines: [1, 2] },
                { id: "b", lines: [3] }
            ];
            return ExecutionResult.next();
        }
    }

    class RecordInner extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            innerSeen.push(context.item);
            return ExecutionResult.next();
        }
    }

    class NoOp extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class Nested_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-nested-outer-item-collection";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.orders)
                .do(outer => outer
                    .startWith(NoOp)
                    .foreach((d: any, item: any) => item.lines)
                    .do(inner => inner.startWith(RecordInner))
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Nested_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-nested-outer-item-collection", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.7.
    it("the inner body observed every line from every order, keyed by the outer item's own collection", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(innerSeen.slice().sort((a: number, b: number) => a - b)).toEqual([1, 2, 3]);
    });
});

// --- Scenario 7: pointer counts are unchanged ----------------------------------------------------
describe("foreach scope isolation — pointer counts are unchanged", () => {

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = [1, 2];
            return ExecutionResult.next();
        }
    }

    class OneStep extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class PointerCount_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-pointer-count";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then.startWith(OneStep));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(PointerCount_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-pointer-count", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.8: 1 genesis + 1 foreach container + 2 body-step pointers (one per item) = 4.
    it("produces the expected fixed number of pointers", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(instance.executionPointers.length).toBe(4);
        expect(instance.executionPointers.every((p: any) => Boolean(p.endTime))).toBe(true);
    });
});

// --- Scenario 8: contextItem survives a host restart mid-body ------------------------------------
// Drives the executor pass-by-pass (bypassing the timer-driven queue worker entirely) so the
// "restart" can be inserted deterministically between pass 3 (step 1 of every item) and pass 4
// (step 2 of every item), instead of racing a real setTimeout-driven background worker. A second,
// independently-configured host/executor is then pointed at the SAME persistence provider and
// finishes the run — modelling a process that reloads persisted instance state from scratch.
describe("foreach scope isolation — contextItem survives a host restart mid-body", () => {

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = [1, 2, 3];
            context.workflow.data.seen = {};
            context.workflow.data.results = [];
            return ExecutionResult.next();
        }
    }

    class WriteSeen extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class ReadSeen extends StepBody {
        public value: number;
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.results.push(this.value);
            return ExecutionResult.next();
        }
    }

    class Restart_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-restart-mid-body";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then
                    .startWith(WriteSeen)
                        .output((s: WriteSeen, d: any, ctx: StepExecutionContext) => {
                            d.seen = d.seen || {};
                            d.seen[ctx.item] = ctx.item * 10;
                        })
                    .then(ReadSeen)
                        .input((s: ReadSeen, d: any, ctx: StepExecutionContext) => {
                            s.value = d.seen[ctx.item];
                        })
                );
        }
    }

    let workflowId: string;
    let finalInstance: WorkflowInstance;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        const persistence = new MemoryPersistenceProvider();

        const config1 = configureWorkflow();
        config1.usePersistence(persistence);
        const host1 = config1.getHost();
        host1.registerWorkflow(Restart_Workflow);
        workflowId = await host1.startWorkflow("foreach-restart-mid-body", "1.0.0", {});
        const executor1 = config1.getContainer().get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);

        // Pass 1: genesis pointer runs Init, fans out to the foreach step.
        // Pass 2: the foreach step branches into 3 child pointers (one per item).
        // Pass 3: all 3 WriteSeen pointers run, each creating a pending ReadSeen pointer.
        for (let i = 0; i < 3; i++) {
            let instance = await persistence.getWorkflowInstance(workflowId);
            await executor1.execute(instance);
            await persistence.persistWorkflow(instance);
        }

        // --- "host restart" here: a fresh config/container/executor bound to the same
        // persistence provider, before any ReadSeen pointer has executed. ---
        const config2 = configureWorkflow();
        config2.usePersistence(persistence);
        const host2 = config2.getHost();
        host2.registerWorkflow(Restart_Workflow);
        const executor2 = config2.getContainer().get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);

        // Drive to completion: pass 4 runs the 3 ReadSeen pointers; pass 5 lets the foreach
        // container observe its branches are complete and finish the workflow.
        let instance = await persistence.getWorkflowInstance(workflowId);
        for (let i = 0; i < 10 && instance.status === WorkflowStatus.Runnable; i++) {
            await executor2.execute(instance);
            await persistence.persistWorkflow(instance);
            instance = await persistence.getWorkflowInstance(workflowId);
        }
        finalInstance = instance;
    });

    // Proves §6.9: `context.item` is read from the persisted `pointer.contextItem`, so a
    // pointer resumed by a brand-new executor/host still observes only its own item.
    it("each iteration's result survives the restart, keyed by its own item, none corrupted", () => {
        expect(finalInstance.status).toBe(WorkflowStatus.Complete);
        expect(finalInstance.data.results.slice().sort((a: number, b: number) => a - b)).toEqual([10, 20, 30]);
    });
});

// --- Scenario 9: mapper exceptions still route to handleStepException ---------------------------
describe("foreach scope isolation — mapper exceptions still route to handleStepException", () => {

    class ThrowsInInput extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class MapperThrows_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-mapper-throws";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(ThrowsInInput, step => step
                    .input((s: ThrowsInInput, d: any, ctx: StepExecutionContext) => {
                        throw new Error("mapper boom");
                    })
                    .onError(WorkflowErrorHandling.Retry, 50, 1));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(MapperThrows_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-mapper-throws", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.11: an input mapper's exception is neither swallowed nor newly wrapped —
    // it still exhausts the existing retry budget and dead-letters exactly as before.
    it("a throwing input mapper still exhausts the retry budget and dead-letters", () => {
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);
    });
});

// --- Scenario 10: saga compensation inside foreach sees its own item -----------------------------
describe("foreach scope isolation — saga compensation inside foreach sees its own item", () => {

    class Init extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.items = ["a", "b"];
            context.workflow.data.compensated = [];
            return ExecutionResult.next();
        }
    }

    class DoWork extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class FailStep extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            throw new Error("boom");
        }
    }

    class Undo extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            context.workflow.data.compensated.push(context.item);
            return ExecutionResult.next();
        }
    }

    class NoOp extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class SagaForeach_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-saga-compensation";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Init)
                .foreach(d => d.items)
                .do(then => then
                    .startWith(NoOp)
                    .saga(saga => saga
                        .startWith(DoWork)
                        .then(FailStep))
                    .compensateWith(Undo)
                );
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(SagaForeach_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-saga-compensation", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    // Proves §6.1 on the compensation path: buildCompensationPointer already propagates the
    // compensated pointer's own contextItem (execution-pointer-factory.ts:57), and the saga
    // container's own pointer IS the foreach's branch pointer, so it holds the real item
    // (not null — unlike the If/While `.do()` case documented above).
    it("each compensation observed its own element, not another's", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(instance.data.compensated.slice().sort()).toEqual(["a", "b"]);
    });
});
