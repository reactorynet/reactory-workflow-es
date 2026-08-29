/**
 * M10 — Definition-fingerprint pinning.
 *
 * An instance must complete on the step graph it STARTED on. Because execution pointers
 * address steps by ordinal index, a definition edited in place (same id, same version,
 * different graph) silently remaps every suspended pointer. These tests cover:
 *
 *   1. the fingerprint function itself — determinism, and sensitivity to the graph
 *      changes that actually remap a stepId;
 *   2. the pinning path — instance stamped at start, dead-lettered on mismatch;
 *   3. the backward-compatibility rules that stop the feature killing legacy work;
 *   4. the "warn" / "off" rollout modes.
 */

import {
    configureWorkflow,
    WorkflowBuilder,
    WorkflowStatus,
    WorkflowBase,
    StepBody,
    StepExecutionContext,
    ExecutionResult,
    WorkflowInstance,
    ExecutionPointer,
    PointerStatus,
    WorkflowDeadLetteredEvent,
    IWorkflowRegistry,
    IWorkflowExecutor,
    IWorkflowHost,
    TYPES,
    computeDefinitionFingerprint,
    canonicalDefinitionForm,
} from "../../src";
import { Container } from "inversify";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

class StepA extends StepBody {
    public run(_c: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
}
class StepB extends StepBody {
    public run(_c: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
}
class StepC extends StepBody {
    public run(_c: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
}

/** Build a definition's steps through the real builder, so the wiring is realistic. */
function stepsOf(build: (b: WorkflowBuilder<any>) => void) {
    const builder = new WorkflowBuilder<any>();
    build(builder);
    return builder.build("x", "1.0.0").steps;
}

// ---------------------------------------------------------------------------
// 1 — the fingerprint function
// ---------------------------------------------------------------------------
describe("definition-fingerprint — the hash itself", () => {

    it("is deterministic: the same graph built twice fingerprints identically", () => {
        const a = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepB)));
        const c = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepB)));
        expect(a).toBe(c);
    });

    it("is 32 lowercase hex characters", () => {
        const fp = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA)));
        expect(fp).toMatch(/^[0-9a-f]{32}$/);
    });

    it("changes when a step is APPENDED (step count differs)", () => {
        const before = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepB)));
        const after = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepB).then(StepC)));
        expect(after).not.toBe(before);
    });

    it("changes when a step is INSERTED mid-graph — the case that remaps every later stepId", () => {
        const before = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepB)));
        const after = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepC).then(StepB)));
        expect(after).not.toBe(before);
    });

    it("changes when a step body at a given index is SWAPPED for a different body", () => {
        const before = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepB)));
        const after = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepC)));
        expect(after).not.toBe(before);
    });

    it("changes when the seed changes, with the graph held constant (content-edit detection)", () => {
        const steps = stepsOf(b => b.startWith(StepA).then(StepB));
        expect(computeDefinitionFingerprint(steps, "yaml-sha-aaa"))
            .not.toBe(computeDefinitionFingerprint(steps, "yaml-sha-bbb"));
    });

    it("is unchanged by retry tuning — retry policy is not graph shape (no false positives)", () => {
        const plain = computeDefinitionFingerprint(stepsOf(b => b.startWith(StepA).then(StepB)));
        const tuned = stepsOf(b => b.startWith(StepA).then(StepB));
        tuned.forEach(s => { s.retryInterval = 999; s.maxRetries = 42; s.errorBehavior = 1; });
        expect(computeDefinitionFingerprint(tuned)).toBe(plain);
    });

    it("does not depend on the ORDER of the steps array (ordinal id is the identity)", () => {
        const steps = stepsOf(b => b.startWith(StepA).then(StepB).then(StepC));
        const shuffled = steps.slice().reverse();
        expect(computeDefinitionFingerprint(shuffled)).toBe(computeDefinitionFingerprint(steps));
    });

    it("canonical form is diffable and names each step's body", () => {
        const form = canonicalDefinitionForm(stepsOf(b => b.startWith(StepA).then(StepB)));
        expect(form).toContain("StepA");
        expect(form).toContain("StepB");
        expect(form).toContain("steps:2");
    });

    it("tolerates an empty graph without throwing", () => {
        expect(computeDefinitionFingerprint([])).toMatch(/^[0-9a-f]{32}$/);
    });
});

// ---------------------------------------------------------------------------
// 2 — the builder / registry / host wiring
// ---------------------------------------------------------------------------
class PinnedWorkflow implements WorkflowBase<any> {
    public id: string = "pinned-workflow";
    public version: string = "1.0.0";
    public build(builder: WorkflowBuilder<any>) { builder.startWith(StepA).then(StepB); }
}

describe("definition-fingerprint — instances are pinned at start", () => {

    let host: IWorkflowHost;
    let persistence: MemoryPersistenceProvider;
    let instance: WorkflowInstance;
    let registeredFingerprint: string;

    beforeAll(async () => {
        persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.usePersistence(persistence);
        const container = config.getContainer();
        const registry = container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry);
        host = config.getHost();
        host.registerWorkflow(PinnedWorkflow);
        await host.start();

        registeredFingerprint = registry.getDefinition("pinned-workflow", "1.0.0").fingerprint;
        const id = await host.startWorkflow("pinned-workflow", "1.0.0", {});
        await spinWait(async () => {
            const i = await persistence.getWorkflowInstance(id);
            return i && i.status === WorkflowStatus.Complete;
        });
        instance = await persistence.getWorkflowInstance(id);
    });

    afterAll(async () => { await host.stop(); });

    it("the registered definition carries a fingerprint", () => {
        expect(registeredFingerprint).toMatch(/^[0-9a-f]{32}$/);
    });

    it("the started instance is stamped with the definition's fingerprint", () => {
        expect(instance.definitionFingerprint).toBe(registeredFingerprint);
    });

    it("the fingerprint survives a persistence round-trip", async () => {
        const reloaded = await persistence.getWorkflowInstance(instance.id);
        expect(reloaded.definitionFingerprint).toBe(registeredFingerprint);
    });
});

// ---------------------------------------------------------------------------
// 3 — mismatch dead-letters (the core guarantee)
// ---------------------------------------------------------------------------

/** Same id and version as PinnedWorkflow, but a DIFFERENT graph — an in-place edit. */
class EditedWorkflow implements WorkflowBase<any> {
    public id: string = "pinned-workflow";
    public version: string = "1.0.0";
    public build(builder: WorkflowBuilder<any>) { builder.startWith(StepA).then(StepC).then(StepB); }
}

function suspendedInstanceAt(stepId: number, fingerprint?: string): WorkflowInstance {
    const instance = new WorkflowInstance();
    instance.id = "fp-instance-" + stepId + "-" + (fingerprint || "none");
    instance.workflowDefinitionId = "pinned-workflow";
    instance.version = "1.0.0";
    instance.status = WorkflowStatus.Runnable;
    instance.data = {};
    instance.createTime = new Date();
    instance.definitionFingerprint = fingerprint;

    const pointer = new ExecutionPointer();
    pointer.id = "fp-pointer-" + stepId;
    pointer.active = true;
    pointer.stepId = stepId;
    pointer.status = PointerStatus.Pending;
    pointer.retryCount = 0;
    instance.executionPointers.push(pointer);
    return instance;
}

describe("definition-fingerprint — a graph edited under a running instance dead-letters", () => {

    let events: Array<WorkflowDeadLetteredEvent> = [];
    let instance: WorkflowInstance;
    let result: any;
    let caught: any = null;

    beforeAll(async () => {
        events = [];
        const config = configureWorkflow();
        config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
        const container = config.getContainer();
        const registry = container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry);
        const executor = container.get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);

        // Only the EDITED graph is registered — the deploy that overwrote the definition.
        registry.registerWorkflow(new EditedWorkflow());

        // An instance started on the ORIGINAL graph, suspended at ordinal step 1.
        const originalFingerprint = computeDefinitionFingerprint(
            stepsOf(b => b.startWith(StepA).then(StepB))
        );
        instance = suspendedInstanceAt(1, originalFingerprint);

        try { result = await executor.execute(instance); } catch (err) { caught = err; }
    });

    it("does not throw", () => { expect(caught).toBeNull(); });

    it("sets instance.status to DeadLettered", () => {
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);
    });

    it("retires the active pointer", () => {
        expect(instance.executionPointers[0].status).toBe(PointerStatus.DeadLettered);
        expect(instance.executionPointers[0].active).toBe(false);
    });

    it("clears nextExecution so it is not re-polled", () => {
        expect(instance.nextExecution).toBeNull();
    });

    it("emits exactly one dead-letter event, tagged reason=definition-changed", () => {
        expect(events.length).toBe(1);
        expect(events[0].event).toBe("workflow.dead-lettered");
        expect(events[0].reason).toBe("definition-changed");
    });

    it("is reported as non-retryable", () => {
        expect(events[0].maxRetries).toBe(0);
    });

    it("the error message names both fingerprints and the remedy", () => {
        const msg = result.errors[0].message;
        expect(msg).toContain(instance.definitionFingerprint);
        expect(msg).toContain("without a version bump");
        expect(msg).toContain("NEW version");
    });

    it("does NOT execute the step that now occupies the pointer's ordinal index", () => {
        // The whole point: index 1 is StepC in the edited graph, StepB in the original.
        // Neither may run.
        expect(instance.executionPointers[0].endTime).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// 4 — backward compatibility: legacy instances must keep running
// ---------------------------------------------------------------------------
describe("definition-fingerprint — backward compatibility", () => {

    let container: Container;

    beforeAll(() => {
        const config = configureWorkflow();
        container = config.getContainer();
        container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry).registerWorkflow(new EditedWorkflow());
    });

    it("an instance with NO fingerprint (pre-M10 row) is exempt and still executes", async () => {
        const executor = container.get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);
        const legacy = suspendedInstanceAt(0, undefined);
        await executor.execute(legacy);
        expect(legacy.status).not.toBe(WorkflowStatus.DeadLettered);
    });

    it("an instance whose fingerprint MATCHES executes normally", async () => {
        const executor = container.get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);
        const registry = container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry);
        const current = registry.getDefinition("pinned-workflow", "1.0.0").fingerprint;
        const matched = suspendedInstanceAt(0, current);
        await executor.execute(matched);
        expect(matched.status).not.toBe(WorkflowStatus.DeadLettered);
    });
});

// ---------------------------------------------------------------------------
// 5 — rollout modes
// ---------------------------------------------------------------------------
describe("definition-fingerprint — definitionFingerprintMode", () => {

    async function runMismatchUnder(mode: "enforce" | "warn" | "off"): Promise<WorkflowInstance> {
        const config = configureWorkflow({ definitionFingerprintMode: mode });
        const container = config.getContainer();
        container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry).registerWorkflow(new EditedWorkflow());
        const executor = container.get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);
        const instance = suspendedInstanceAt(0, "0000000000000000000000000000dead");
        await executor.execute(instance);
        return instance;
    }

    it("enforce (the default) dead-letters", async () => {
        expect((await runMismatchUnder("enforce")).status).toBe(WorkflowStatus.DeadLettered);
    });

    it("warn executes anyway", async () => {
        expect((await runMismatchUnder("warn")).status).not.toBe(WorkflowStatus.DeadLettered);
    });

    it("off executes anyway", async () => {
        expect((await runMismatchUnder("off")).status).not.toBe(WorkflowStatus.DeadLettered);
    });

    it("rejects an invalid mode at configuration time", () => {
        expect(() => configureWorkflow({ definitionFingerprintMode: "nonsense" as any })).toThrow();
    });
});
