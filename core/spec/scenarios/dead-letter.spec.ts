import { WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, ExecutionPointer, PointerStatus, WorkflowErrorHandling, configureWorkflow, WorkflowDeadLetteredEvent, IWorkflowRegistry, IWorkflowExecutor, TYPES } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

// --- Scenario 1: a permanently failing step dead-letters after exactly maxRetries ----------------
describe("dead letter scenario", () => {

    let scope = { counter: 0 };
    let events: Array<WorkflowDeadLetteredEvent> = [];

    class AlwaysFails extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.counter++;
            throw new Error("always fails");
        }
    }

    class DeadLetter_Workflow implements WorkflowBase<any> {
        public id: string = "dead-letter-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(AlwaysFails, step => step
                    .onError(WorkflowErrorHandling.Retry, 50, 2));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow({
        pollIntervalMs: 1000,
        retry: {
            defaultMaxRetries: 2,
            defaultRetryIntervalMs: 50,
            stepNotFoundRetryIntervalMs: 50
        }
    });
    config.usePersistence(persistence);
    config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeAll(async () => {
        host.registerWorkflow(DeadLetter_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("dead-letter-workflow", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status === WorkflowStatus.DeadLettered);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("permanently failing step dead-letters after exactly maxRetries and emits one event", () => {
        // maxRetries 2 => 3 total attempts (first attempt + 2 retries)
        expect(scope.counter).toBe(3);
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);

        let pointer: ExecutionPointer = instance.executionPointers[0];
        expect(pointer.status).toBe(PointerStatus.DeadLettered);
        expect(pointer.active).toBe(false);
        expect(pointer.endTime).toBeDefined();

        expect(events.length).toBe(1);
        expect(events[0].event).toBe("workflow.dead-lettered");
        expect(events[0].workflowId).toBe(workflowId);
        expect(events[0].workflowDefinitionId).toBe("dead-letter-workflow");
        expect(events[0].maxRetries).toBe(2);
        expect(events[0].retryCount).toBe(2);
        expect(events[0].errorMessage).toBe("always fails");
    });

    it("dead-lettered workflow stops consuming the queue", async () => {
        const countAtDeadLetter = scope.counter;
        // wait > 2 poll cycles and many retry intervals
        await new Promise<void>(resolve => setTimeout(resolve, 2500));
        expect(scope.counter).toBe(countAtDeadLetter);
        const runnables = await persistence.getRunnableInstances();
        expect(runnables).not.toContain(workflowId);
        instance = await persistence.getWorkflowInstance(workflowId);
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);
    });
});

// --- Scenario 2: step-not-found path dead-letters after the global budget ------------------------
describe("dead letter scenario - step not found", () => {

    let events: Array<WorkflowDeadLetteredEvent> = [];

    class NoOp extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class Empty_Workflow implements WorkflowBase<any> {
        public id: string = "step-not-found-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder.startWith(NoOp);
        }
    }

    let config = configureWorkflow({
        retry: {
            defaultMaxRetries: 1,
            defaultRetryIntervalMs: 50,
            stepNotFoundRetryIntervalMs: 50
        }
    });
    config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
    let container = config.getContainer();
    let registry = container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry);
    let executor = container.get<IWorkflowExecutor>(TYPES.IWorkflowExecutor);

    it("step-not-found path dead-letters after the global budget", async () => {
        registry.registerWorkflow(new Empty_Workflow());

        let instance = new WorkflowInstance();
        instance.id = "snf-instance-1";
        instance.workflowDefinitionId = "step-not-found-workflow";
        instance.version = "1.0.0";
        instance.status = WorkflowStatus.Runnable;
        instance.data = {};
        instance.createTime = new Date();

        let pointer = new ExecutionPointer();
        pointer.id = "snf-pointer-1";
        pointer.active = true;
        pointer.stepId = 999; // does not exist in the definition
        pointer.status = PointerStatus.Pending;
        instance.executionPointers.push(pointer);

        // attempt 1: budget not exhausted -> sleep + retryCount 1
        await executor.execute(instance);
        expect(instance.status).toBe(WorkflowStatus.Runnable);
        expect(pointer.retryCount).toBe(1);
        expect(pointer.sleepUntil).toBeGreaterThan(0);

        // attempt 2: retryCount (1) >= defaultMaxRetries (1) -> dead-letter
        await executor.execute(instance);
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);
        expect(pointer.status).toBe(PointerStatus.DeadLettered);
        expect(pointer.active).toBe(false);
        expect(instance.nextExecution).toBeNull();

        expect(events.length).toBe(1);
        expect(events[0].event).toBe("workflow.dead-lettered");
        expect(events[0].workflowId).toBe("snf-instance-1");
        expect(events[0].stepId).toBe(999);
        expect(events[0].maxRetries).toBe(1);
        expect(events[0].errorMessage).toBeNull();
    });
});
