/**
 * Kill-and-restart durability integration test (spec §8 "failing-test-first").
 *
 * Proves §6.3: after the provider and host are torn down and rebuilt against the
 * same .db file, in-flight workflows resume to completion.
 *
 * Pattern mirrors core/spec/scenarios/external-events.spec.ts + spinWait helper.
 */
import "reflect-metadata";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
    WorkflowInstance,
    WorkflowStatus,
    WorkflowBase,
    WorkflowBuilder,
    StepBody,
    StepExecutionContext,
    ExecutionResult,
    configureWorkflow,
    DEFAULT_TENANT
} from "@reactorynet/workflow-es";
import { SqlitePersistence } from "../src/sqlite-provider";

// ── Workflow definition ───────────────────────────────────────────────────────

class PassThroughStep extends StepBody {
    public run(_context: StepExecutionContext): Promise<ExecutionResult> {
        return ExecutionResult.next();
    }
}

class MyData {
    public result: string;
}

/**
 * A 2-step workflow:
 *   step 1 → PassThroughStep (runs immediately)
 *   step 2 → waitFor("resume-event", key "0") → capture eventData into data.result
 *
 * After step 1 completes the instance parks in a waiting/Runnable state until the
 * external event is published.  This is the state we want to survive a restart.
 */
class RestartWorkflow implements WorkflowBase<MyData> {
    public id: string = "restart-workflow";
    public version: number = 1;

    public build(builder: WorkflowBuilder<MyData>): void {
        builder
            .startWith(PassThroughStep)
            .waitFor("resume-event", (_data) => "0")
                .output((step, data) => { data.result = step.eventData; });
    }
}

// ── spinWait helper (inline copy — no direct dep on core spec helpers) ─────────

function spinWait(until: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = async () => {
            try {
                const done = await until();
                if (done) {
                    resolve();
                } else if (Date.now() > deadline) {
                    reject(new Error("spinWait timed out"));
                } else {
                    setTimeout(tick, 300);
                }
            } catch (err) {
                reject(err);
            }
        };
        setTimeout(tick, 300);
    });
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe("sqlite-restart", () => {
    const dbFile = path.join(os.tmpdir(), `wf-es-sqlite-restart-${Date.now()}.db`);
    let workflowId: string;

    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60_000;

    afterAll(() => {
        // Clean up sidecar WAL files; .db may already be gone on failure — ignore errors.
        for (const suffix of ["", "-wal", "-shm"]) {
            try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
        }
    });

    it("resumes an in-flight workflow after a simulated process restart", async () => {

        // ── PHASE 1: start a workflow, let it park at waitFor ─────────────────

        const persistence1 = new SqlitePersistence(dbFile);
        await persistence1.connect;

        const config1 = configureWorkflow();
        config1.usePersistence(persistence1);
        config1.allowSingleNodeProviders(true); // single-process test — no distributed lock/queue
        const host1 = config1.getHost();

        host1.registerWorkflow(RestartWorkflow);
        await host1.start();

        workflowId = await host1.startWorkflow("restart-workflow", 1, new MyData());

        // Wait until the subscription for "resume-event" exists on disk — proves state hit disk.
        await spinWait(async () => {
            const subs = await persistence1.getSubscriptions(DEFAULT_TENANT, "resume-event", "0", new Date());
            return subs.length > 0;
        });

        // Simulate process exit: stop the host and drop all references.
        await host1.stop();
        // (persistence1 goes out of scope — file remains on disk)

        // ── PHASE 2: rebuild host against the same file ───────────────────────

        const persistence2 = new SqlitePersistence(dbFile);
        await persistence2.connect;

        const config2 = configureWorkflow();
        config2.usePersistence(persistence2);
        config2.allowSingleNodeProviders(true); // single-process test — no distributed lock/queue
        const host2 = config2.getHost();

        host2.registerWorkflow(RestartWorkflow);
        await host2.start();

        // Publish the external event that unblocks the workflow.
        await host2.publishEvent("resume-event", "0", "Pass", new Date());

        // Wait for the workflow to reach a terminal state.
        let finalInstance: WorkflowInstance;
        await spinWait(async () => {
            finalInstance = await persistence2.getWorkflowInstance(workflowId);
            return finalInstance && finalInstance.status !== WorkflowStatus.Runnable;
        });

        await host2.stop();

        // ── Assert ────────────────────────────────────────────────────────────

        expect(finalInstance.status).toBe(WorkflowStatus.Complete);
        expect(finalInstance.data.result).toBe("Pass");
    });
});
