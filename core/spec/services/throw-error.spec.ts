import { WorkflowBuilder, StepBody, StepExecutionContext, ExecutionResult } from "../../src";

describe("StepBuilder.end() throws Error instance", () => {

    class DummyStep extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    it("should throw an Error (not a string) when the named parent step does not exist", () => {
        const builder = new WorkflowBuilder<any>();
        const stepBuilder = builder.startWith(DummyStep);

        expect(() => stepBuilder.end("does-not-exist")).toThrowError("Parent step of name does-not-exist not found");
    });

});
