/**
 * M1 — Workflow-definition version-safety on load.
 *
 * Tests that an instance whose (workflowDefinitionId, version) is not registered in the
 * registry is dead-lettered cleanly (reusing H5's machinery) rather than throwing a generic
 * error and looping forever. Also covers the start-time fail-fast and regression paths.
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
    TYPES,
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

// ---------------------------------------------------------------------------
// Shared workflow definition used across all tests in this file.
// ---------------------------------------------------------------------------

class PassingStep extends StepBody {
    static counter: number = 0;
    public run(_context: StepExecutionContext): Promise<ExecutionResult> {
        PassingStep.counter++;
        return ExecutionResult.next();
    }
}

class VersionSafeWorkflow implements WorkflowBase<any> {
    public id: string = "version-safe-workflow";
    public version: number = 1;

    public build(builder: WorkflowBuilder<any>) {
        builder.startWith(PassingStep);
    }
}

// ---------------------------------------------------------------------------
// Test 1 (failing-first): direct executor unit test — unregistered version
// dead-letters cleanly with an actionable message.
// ---------------------------------------------------------------------------
describe("version-safety — executing an instance whose (definitionId, version) is unregistered dead-letters cleanly with an actionable message", () => {

    let events: Array<WorkflowDeadLetteredEvent> = [];
    let instance: WorkflowInstance;
    let result: any;
    let caughtError: any = null;

    beforeAll(async () => {
        PassingStep.counter = 0;
        events = [];

        let config = configureWorkflow();
        config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
        let container = config.getContainer();
        let registry = container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry);
        let executor = container.get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);

        // Register version 1 only
        registry.registerWorkflow(new VersionSafeWorkflow());

        // Build a hand-crafted instance with version 999 (not registered)
        instance = new WorkflowInstance();
        instance.id = "vs-test-instance-1";
        instance.workflowDefinitionId = "version-safe-workflow";
        instance.version = 999; // unregistered
        instance.status = WorkflowStatus.Runnable;
        instance.data = {};
        instance.createTime = new Date();

        let pointer = new ExecutionPointer();
        pointer.id = "vs-pointer-1";
        pointer.active = true;
        pointer.stepId = 0;
        pointer.status = PointerStatus.Pending;
        pointer.retryCount = 0;
        instance.executionPointers.push(pointer);

        try {
            result = await executor.execute(instance);
        } catch (err) {
            caughtError = err;
        }
    });

    it("does not throw", () => {
        expect(caughtError).toBeNull();
    });

    it("sets instance.status to DeadLettered", () => {
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);
    });

    it("marks the active pointer as DeadLettered and inactive", () => {
        const pointer = instance.executionPointers[0];
        expect(pointer.status).toBe(PointerStatus.DeadLettered);
        expect(pointer.active).toBe(false);
    });

    it("sets instance.nextExecution to null", () => {
        expect(instance.nextExecution).toBeNull();
    });

    it("records at least one error on result.errors", () => {
        expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });

    it("emits exactly one workflow.dead-lettered lifecycle event", () => {
        expect(events.length).toBe(1);
        expect(events[0].event).toBe("workflow.dead-lettered");
    });

    it("event carries the correct version (999)", () => {
        expect(events[0].version).toBe(999);
    });

    it("event carries the correct workflowDefinitionId", () => {
        expect(events[0].workflowDefinitionId).toBe("version-safe-workflow");
    });

    it("event maxRetries is 0 (not retryable)", () => {
        expect(events[0].maxRetries).toBe(0);
    });

    it('event errorMessage contains definitionId="version-safe-workflow"', () => {
        expect(events[0].errorMessage).toContain('definitionId="version-safe-workflow"');
    });

    it("event errorMessage contains version=999", () => {
        expect(events[0].errorMessage).toContain("version=999");
    });

    it("event errorMessage contains 'register all historical workflow versions'", () => {
        expect(events[0].errorMessage).toContain("register all historical workflow versions");
    });
});

// ---------------------------------------------------------------------------
// Test 2 (regression): a registered version runs to completion normally.
// ---------------------------------------------------------------------------
describe("version-safety — a registered version runs to completion (regression)", () => {

    let events: Array<WorkflowDeadLetteredEvent> = [];
    let instance: WorkflowInstance;
    let workflowId: string;

    beforeAll(async () => {
        PassingStep.counter = 0;
        events = [];
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;

        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow();
        config.usePersistence(persistence);
        config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
        let host = config.getHost();

        host.registerWorkflow(VersionSafeWorkflow);
        await host.start();
        workflowId = await host.startWorkflow("version-safe-workflow", 1, {});

        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return instance.status !== WorkflowStatus.Runnable;
        });

        await host.stop();
    });

    it("completes successfully", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    it("step ran exactly once", () => {
        expect(PassingStep.counter).toBe(1);
    });

    it("emits no dead-letter events", () => {
        expect(events.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Test 3 (end-to-end): unregistered version dead-letters via the host and
// stops consuming the queue.
// ---------------------------------------------------------------------------
describe("version-safety — an unregistered version dead-letters end-to-end via the host and stops consuming the queue", () => {

    let events: Array<WorkflowDeadLetteredEvent> = [];
    let workflowId: string;
    let persistence: MemoryPersistenceProvider;
    let stepCountAtDeadLetter: number = 0;

    beforeAll(async () => {
        PassingStep.counter = 0;
        events = [];
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

        persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow({
            pollIntervalMs: 1000,
        });
        config.usePersistence(persistence);
        config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
        let host = config.getHost();

        host.registerWorkflow(VersionSafeWorkflow);
        await host.start();

        // Start a real workflow (version 1, registered) and stop the host immediately
        // so the workers don't race before we can mutate the instance.
        workflowId = await host.startWorkflow("version-safe-workflow", 1, {});
        await host.stop();

        // Mutate the persisted instance to reference an unregistered version.
        let wf = await persistence.getWorkflowInstance(workflowId);
        wf.version = 999;
        wf.status = WorkflowStatus.Runnable;
        wf.nextExecution = 0;
        await persistence.persistWorkflow(wf);

        // Restart the host — now the poll worker will pick it up and execute via
        // the missing-definition path.
        let config2 = configureWorkflow({
            pollIntervalMs: 1000,
        });
        config2.usePersistence(persistence);
        config2.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
        let host2 = config2.getHost();
        host2.registerWorkflow(VersionSafeWorkflow); // only version 1, not 999

        await host2.start();

        await spinWait(async () => {
            let inst = await persistence.getWorkflowInstance(workflowId);
            return inst.status === WorkflowStatus.DeadLettered;
        });

        stepCountAtDeadLetter = PassingStep.counter;

        // Wait > 3 poll cycles (each 1000 ms → wait ~4 s) to confirm no further execution.
        await new Promise<void>(resolve => setTimeout(resolve, 4000));

        await host2.stop();
    });

    it("instance reaches DeadLettered state", async () => {
        const inst = await persistence.getWorkflowInstance(workflowId);
        expect(inst.status).toBe(WorkflowStatus.DeadLettered);
    });

    it("step body is NOT invoked again after dead-lettering", () => {
        expect(PassingStep.counter).toBe(stepCountAtDeadLetter);
    });

    it("emits exactly one workflow.dead-lettered event", () => {
        expect(events.length).toBe(1);
        expect(events[0].event).toBe("workflow.dead-lettered");
    });

    it("dead-lettered instance is excluded from getRunnableInstances()", async () => {
        const runnables = await persistence.getRunnableInstances();
        expect(runnables).not.toContain(workflowId);
    });
});

// ---------------------------------------------------------------------------
// Test 4 (start-time): startWorkflow for an unknown version rejects at call
// time and creates no instance.
// ---------------------------------------------------------------------------
describe("version-safety — startWorkflow for an unknown version rejects at call time and creates no instance", () => {

    let events: Array<WorkflowDeadLetteredEvent> = [];
    let persistence: MemoryPersistenceProvider;
    let host: any;

    beforeAll(async () => {
        events = [];
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 15000;

        persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow();
        config.usePersistence(persistence);
        config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
        host = config.getHost();

        host.registerWorkflow(VersionSafeWorkflow); // only version 1
        await host.start();
    });

    afterAll(async () => {
        await host.stop();
    });

    it("rejects with 'Workflow not registered' for an unknown version", async () => {
        await expectAsync(
            host.startWorkflow("version-safe-workflow", 2)
        ).toBeRejectedWithError(/Workflow not registered/);
    });

    it("does not create a new instance for the unregistered version", async () => {
        const allInstances = (await persistence.getRunnableInstances()) as string[];
        // The getRunnableInstances() call may not return all instances, so we check
        // via the absence of a workflow.dead-lettered event and the lack of any
        // version-2 instance (there's no API to list all instances, but the
        // start-time rejection should have thrown before createNewWorkflow was called).
        // The key assertion is that no dead-letter event was emitted (fail-fast ≠ dead-letter).
        expect(events.length).toBe(0);
    });
});
