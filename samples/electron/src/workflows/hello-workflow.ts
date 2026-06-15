import "reflect-metadata";
import {
    WorkflowBase,
    WorkflowBuilder,
    StepBody,
    StepExecutionContext,
    ExecutionResult,
} from "@reactorynet/workflow-es";

/**
 * A simple two-step IO-bound workflow used to demonstrate normal, non-blocking
 * execution. Both steps are async and return quickly — they model IO operations
 * such as a network call or a database read.
 *
 * This is the "good" example from the execution-model contract: each step's
 * run() returns a Promise and yields the event loop immediately.
 */

class HelloStep extends StepBody {
    public async run(_context: StepExecutionContext): Promise<ExecutionResult> {
        // Simulate a short async IO operation (e.g. a DB read or API call).
        await new Promise<void>(resolve => setTimeout(resolve, 50));
        console.log("[hello-workflow] Step 1: Hello from the engine process");
        return ExecutionResult.next();
    }
}

class GoodbyeStep extends StepBody {
    public async run(_context: StepExecutionContext): Promise<ExecutionResult> {
        await new Promise<void>(resolve => setTimeout(resolve, 50));
        console.log("[hello-workflow] Step 2: Goodbye from the engine process");
        return ExecutionResult.next();
    }
}

export class HelloWorkflow implements WorkflowBase<null> {
    public id   = "hello";
    public version = 1;

    public build(builder: WorkflowBuilder<null>): void {
        builder
            .startWith(HelloStep)
            .then(GoodbyeStep);
    }
}
