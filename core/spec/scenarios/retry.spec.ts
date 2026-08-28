import { WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, WorkflowErrorHandling, configureWorkflow } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

// --- Scenario 1: Retry strategy is bounded — exhausting the budget dead-letters ------------------
describe("retry budget scenario - exhausted budget dead-letters", () => {

    let scope = { counter: 0 };

    class FailsTwice extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.counter++;
            if (scope.counter <= 2)
                throw new Error("transient failure");
            return ExecutionResult.next();
        }
    }

    class BoundedRetry_Workflow implements WorkflowBase<any> {
        public id: string = "bounded-retry-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(FailsTwice, step => step
                    .onError(WorkflowErrorHandling.Retry, 50, 1));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow({ pollIntervalMs: 1000 });
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeAll(async () => {
        host.registerWorkflow(BoundedRetry_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("bounded-retry-workflow", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status !== WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("Retry strategy retries up to the budget then dead-letters", () => {
        // maxRetries 1 => 2 total attempts; the step would succeed on attempt 3 but never gets there
        expect(scope.counter).toBe(2);
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);
    });
});

// --- Scenario 2: a step that recovers within its budget completes normally -----------------------
describe("retry budget scenario - recovery within budget", () => {

    let scope = { counter: 0 };

    class FailsOnce extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.counter++;
            if (scope.counter <= 1)
                throw new Error("transient failure");
            return ExecutionResult.next();
        }
    }

    class RecoveringRetry_Workflow implements WorkflowBase<any> {
        public id: string = "recovering-retry-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(FailsOnce, step => step
                    .onError(WorkflowErrorHandling.Retry, 50, 3));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow({ pollIntervalMs: 1000 });
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeAll(async () => {
        host.registerWorkflow(RecoveringRetry_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("recovering-retry-workflow", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status !== WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("a step that succeeds on a retry within its budget completes the workflow", () => {
        expect(scope.counter).toBe(2);
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });
});

// --- Scenario 3: Suspend strategy is unchanged ----------------------------------------------------
describe("retry budget scenario - suspend strategy unchanged", () => {

    let scope = { counter: 0 };

    class AlwaysFails extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.counter++;
            throw new Error("always fails");
        }
    }

    class Suspend_Workflow implements WorkflowBase<any> {
        public id: string = "suspend-on-error-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(AlwaysFails, step => step
                    .onError(WorkflowErrorHandling.Suspend));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow({ pollIntervalMs: 1000 });
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeAll(async () => {
        host.registerWorkflow(Suspend_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("suspend-on-error-workflow", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status !== WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("a failing step with the Suspend strategy suspends the workflow (not dead-letter)", () => {
        expect(scope.counter).toBe(1);
        expect(instance.status).toBe(WorkflowStatus.Suspended);
    });
});

// --- Scenario 4: Terminate strategy is unchanged --------------------------------------------------
describe("retry budget scenario - terminate strategy unchanged", () => {

    let scope = { counter: 0 };

    class AlwaysFails extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.counter++;
            throw new Error("always fails");
        }
    }

    class Terminate_Workflow implements WorkflowBase<any> {
        public id: string = "terminate-on-error-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(AlwaysFails, step => step
                    .onError(WorkflowErrorHandling.Terminate));
        }
    }

    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow({ pollIntervalMs: 1000 });
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeAll(async () => {
        host.registerWorkflow(Terminate_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("terminate-on-error-workflow", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status !== WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("a failing step with the Terminate strategy terminates the workflow (not dead-letter)", () => {
        expect(scope.counter).toBe(1);
        expect(instance.status).toBe(WorkflowStatus.Terminated);
    });
});
