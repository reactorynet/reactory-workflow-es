import { WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, configureWorkflow } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

describe("foreach scenario", () => {

    let scope = { hello: 0, display: 0, doSomething: 0, goodbye: 0 };
    let seenItems: any[] = [];

    class SayHello extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.hello++;
            return ExecutionResult.next();
        }
    }

    class DisplayContext extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.display++;
            seenItems.push(context.item);
            return ExecutionResult.next();
        }
    }

    class DoSomething extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.doSomething++;
            return ExecutionResult.next();
        }
    }

    class SayGoodbye extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.goodbye++;
            return ExecutionResult.next();
        }
    }

    class Foreach_Workflow implements WorkflowBase<any> {
        public id: string = "foreach-scenario-workflow";
        public version: number = 1;

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(SayHello)
                .foreach(() => ["one", "two", "three"]).do(then => then
                    .startWith(DisplayContext)
                    .then(DoSomething))
                .then(SayGoodbye);
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
        host.registerWorkflow(Foreach_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("foreach-scenario-workflow", 1, {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("should complete the workflow", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    it("should run the loop body once per collection item", () => {
        expect(scope.hello).toBe(1);
        expect(scope.display).toBe(3);
        expect(scope.doSomething).toBe(3);
        expect(scope.goodbye).toBe(1);
    });

    it("should expose each collection item as the branch context", () => {
        expect(seenItems.sort()).toEqual(["one", "three", "two"]);
    });
});
