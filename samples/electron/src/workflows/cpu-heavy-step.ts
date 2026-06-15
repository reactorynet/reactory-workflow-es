import "reflect-metadata";
import {
    WorkflowBase,
    WorkflowBuilder,
    StepBody,
    StepExecutionContext,
    ExecutionResult,
} from "@reactorynet/workflow-es";

/** Duration of the busy-loop in milliseconds. Can be overridden by workflow data. */
const DEFAULT_DURATION_MS = 3000;

/**
 * A deliberately CPU-heavy step body: a synchronous busy-loop that blocks
 * the event loop for `durationMs` milliseconds.
 *
 * This is the BAD example from docs/electron-integration.md §1.2. In the
 * sample app it is used to *demonstrate* that, because the engine runs in a
 * utilityProcess, the renderer's clock keeps animating while this step burns
 * CPU — proving the UI is unaffected.
 *
 * Never write production step bodies like this. See docs/electron-integration.md
 * for the correct offloading patterns (worker_threads / Piscina / setImmediate
 * chunking).
 */
class CpuHeavyBusyLoopStep extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> {
        // BAD (intentional demo): synchronous busy-loop blocks the event loop.
        // In the utilityProcess this only blocks the engine process — not the
        // main process or renderer. Try running this in the main process to
        // see the UI freeze.
        const durationMs: number =
            (context.persistenceData as { durationMs?: number }).durationMs ??
            DEFAULT_DURATION_MS;

        console.log(
            `[cpu-heavy-workflow] Starting ${durationMs}ms busy-loop ` +
            `(engine process only — renderer should stay responsive)`
        );

        const deadline = Date.now() + durationMs;
        while (Date.now() < deadline) { /* intentional busy-loop — do not copy */ }

        console.log("[cpu-heavy-workflow] Busy-loop complete");
        return ExecutionResult.next();
    }
}

/** Data shape for the cpu-heavy workflow. */
export interface CpuHeavyData {
    /** Duration of the synchronous busy-loop in ms. Default: 3000. */
    durationMs?: number;
}

export class CpuHeavyWorkflow implements WorkflowBase<CpuHeavyData> {
    public id      = "cpu-heavy";
    public version = 1;

    public build(builder: WorkflowBuilder<CpuHeavyData>): void {
        builder.startWith(CpuHeavyBusyLoopStep);
    }
}
