import { WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, configureWorkflow } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

describe("delay scenario", () => {

    let scope = { before: 0, after: 0 };

    class BeforeDelay extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.before++;
            return ExecutionResult.next();
        }
    }

    class AfterDelay extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.after++;
            return ExecutionResult.next();
        }
    }

    class Delay_Workflow implements WorkflowBase<any> {
        public id: string = "delay-scenario-workflow";
        public version: number = 1;

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(BeforeDelay)
                .delay(() => 1)
                .then(AfterDelay);
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
        host.registerWorkflow(Delay_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("delay-scenario-workflow", 1, {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(() => {
        host.stop();
    });

    it("should complete the workflow after the delay elapses", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    it("should run the step before and the step after the delay exactly once each", () => {
        expect(scope.before).toBe(1);
        expect(scope.after).toBe(1);
    });
});
