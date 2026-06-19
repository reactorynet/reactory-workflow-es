import { WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, configureWorkflow } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

// --- Scenario 1: a saga whose body throws runs its compensation step -----------------------------
describe("saga compensation scenario", () => {

    let scope = { begin: 0, doSomething: 0, doBad: 0, undo: 0, goodbye: 0 };

    class Begin extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.begin++;
            return ExecutionResult.next();
        }
    }

    class DoSomething extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.doSomething++;
            return ExecutionResult.next();
        }
    }

    class DoSomethingBad extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.doBad++;
            throw new Error("Explode");
        }
    }

    class UndoSomething extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.undo++;
            return ExecutionResult.next();
        }
    }

    class SayGoodbye extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.goodbye++;
            return ExecutionResult.next();
        }
    }

    class Saga_Workflow implements WorkflowBase<any> {
        public id: string = "saga-compensation-workflow";
        public version: number = 1;

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Begin)
                .saga(saga => saga
                    .startWith(DoSomething)
                    .then(DoSomethingBad)
                )
                .compensateWith(UndoSomething)
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
        host.registerWorkflow(Saga_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("saga-compensation-workflow", 1, {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("should have run the saga body up to and including the failing step", () => {
        expect(scope.doSomething).toBe(1);
        expect(scope.doBad).toBe(1);
    });

    it("should have run the compensation step exactly once", () => {
        expect(scope.undo).toBe(1);
    });

    // The step after a compensated saga must resume exactly once (matches the canonical workflow-es
    // saga sample, where "Bye" prints a single time). Regression guard for UPGRADES P2.5, where it
    // previously ran twice (the compensated Sequence container also re-emitted its outcome).
    it("should resume into the post-saga step exactly once after compensation", () => {
        expect(scope.goodbye).toBe(1);
    });

    it("should complete the workflow after compensation", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });
});

// --- Scenario 2: revert — completed siblings in the saga scope are compensated too ---------------
describe("saga revert scenario", () => {

    let scope = { begin: 0, a: 0, undoA: 0, b: 0, undoB: 0, bad: 0 };

    class Begin extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.begin++;
            return ExecutionResult.next();
        }
    }

    class StepA extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.a++;
            return ExecutionResult.next();
        }
    }
    class UndoA extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.undoA++;
            return ExecutionResult.next();
        }
    }
    class StepB extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.b++;
            return ExecutionResult.next();
        }
    }
    class UndoB extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.undoB++;
            return ExecutionResult.next();
        }
    }
    class BadStep extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.bad++;
            throw new Error("Boom");
        }
    }

    class Revert_Workflow implements WorkflowBase<any> {
        public id: string = "saga-revert-workflow";
        public version: number = 1;

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Begin)
                .saga(saga => saga
                    .startWith(StepA).compensateWith(UndoA)
                    .then(StepB).compensateWith(UndoB)
                    .then(BadStep)
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
        host.registerWorkflow(Revert_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("saga-revert-workflow", 1, {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return (instance.status != WorkflowStatus.Runnable);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("should have executed both successful siblings and the failing step", () => {
        expect(scope.a).toBe(1);
        expect(scope.b).toBe(1);
        expect(scope.bad).toBe(1);
    });

    it("should have reverted the completed siblings via their compensation steps", () => {
        expect(scope.undoA).toBe(1);
        expect(scope.undoB).toBe(1);
    });

    it("should complete the workflow after compensation", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });
});
