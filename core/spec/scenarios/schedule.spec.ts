import { WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, configureWorkflow } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

describe("schedule scenario", () => {

    let scope = { before: 0, scheduled: 0, after: 0 };

    class BeforeSchedule extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.before++;
            return ExecutionResult.next();
        }
    }

    class ScheduledWork extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.scheduled++;
            return ExecutionResult.next();
        }
    }

    class AfterSchedule extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.after++;
            return ExecutionResult.next();
        }
    }

    class Schedule_Workflow implements WorkflowBase<any> {
        public id: string = "schedule-scenario-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(BeforeSchedule)
                .schedule(() => 1).do(then => then
                    .startWith(ScheduledWork))
                .then(AfterSchedule);
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
        host.registerWorkflow(Schedule_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("schedule-scenario-workflow", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("should complete the workflow after the scheduled interval elapses", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    it("should run the before step, the scheduled work, and the after step", () => {
        expect(scope.before).toBe(1);
        expect(scope.scheduled).toBe(1);
        expect(scope.after).toBe(1);
    });
});
