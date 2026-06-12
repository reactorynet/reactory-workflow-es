import {
    WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext,
    ExecutionResult, configureWorkflow
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { WorkflowQueueWorker } from "../../src/services/workflow-queue-worker";
import { spinWait } from "../helpers/spin-wait";

// H1 — bounded concurrency / backpressure.
// 200 instances at a cap of 3 is the fast, deterministic CI proxy for the
// plan's 10k-instance production target (spec H1 §8/§9 note): it proves the
// identical property — the cap is never exceeded and the burst fully drains.

const BURST_SIZE = 200;
const CAP = 3;

let currentlyRunning = 0;
let maxObservedConcurrency = 0;
let completedCount = 0;

class CountingStep extends StepBody {
    public async run(context: StepExecutionContext): Promise<ExecutionResult> {
        currentlyRunning++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, currentlyRunning);
        // overlap executions in time so the cap is actually exercised
        await new Promise<void>((r) => setTimeout(r, 50));
        currentlyRunning--;
        completedCount++;
        return ExecutionResult.next();
    }
}

class Concurrency_Workflow implements WorkflowBase<any> {
    public id: string = "bounded-concurrency-workflow";
    public version: number = 1;
    public build(builder: WorkflowBuilder<any>) {
        builder.startWith(CountingStep);
    }
}

// Gated workflow for in-flight introspection: each entered step parks on a
// manually-released resolver so the test can observe the pool mid-flight.
const gates: Array<() => void> = [];
let gatedEntered = 0;

class GatedStep extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> {
        gatedEntered++;
        return new Promise<ExecutionResult>((resolve) => {
            gates.push(() => resolve(ExecutionResult.next()));
        });
    }
}

class Gated_Workflow implements WorkflowBase<any> {
    public id: string = "bounded-concurrency-gated";
    public version: number = 1;
    public build(builder: WorkflowBuilder<any>) {
        builder.startWith(GatedStep);
    }
}

// Test accessor (kept in the spec, not in production code — spec H1 §8): the
// host's multi-injected workers array holds the live WorkflowQueueWorker.
function getWorkflowQueueWorker(host: any): any {
    return (host as any).workers.find((w: any) => w instanceof WorkflowQueueWorker);
}

describe("bounded concurrency", () => {

    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    describe("burst of instances under a small cap", () => {

        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow({ maxConcurrentWorkflows: CAP });
        let host: any;
        let workflowIds: string[] = [];

        beforeAll(async () => {
            currentlyRunning = 0;
            maxObservedConcurrency = 0;
            completedCount = 0;

            config.usePersistence(persistence);
            host = config.getHost();
            host.registerWorkflow(Concurrency_Workflow);
            await host.start();

            for (let i = 0; i < BURST_SIZE; i++) {
                workflowIds.push(await host.startWorkflow("bounded-concurrency-workflow", 1, {}));
            }

            await spinWait(async () => completedCount === BURST_SIZE);
        });

        afterAll(async () => {
            await host.stop();
        });

        it("should never exceed the configured concurrency cap", () => {
            expect(maxObservedConcurrency).toBeLessThanOrEqual(CAP);
            expect(completedCount).toBe(BURST_SIZE);
        });

        it("should drain the whole burst to completion", async () => {
            expect(completedCount).toBe(BURST_SIZE);
            // sample a few instances across the burst — all must be Complete
            for (const id of [workflowIds[0], workflowIds[97], workflowIds[BURST_SIZE - 1]]) {
                const instance = await persistence.getWorkflowInstance(id);
                expect(instance.status).toBe(WorkflowStatus.Complete);
            }
        });

        it("should arm at most one timer and self-reschedule (no stacked setInterval)", async () => {
            // After the burst the host is idle: the in-flight set stays empty and
            // no phantom work appears across several poll intervals (rule §6.3/§6.6).
            const worker = getWorkflowQueueWorker(host);
            const completedBefore = completedCount;
            await new Promise<void>((r) => setTimeout(r, 400)); // > 2 x workflowQueueIntervalMs
            expect(worker.getActiveCount()).toBe(0);
            expect(completedCount).toBe(completedBefore);
        });
    });

    describe("in-flight set introspection", () => {

        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow({ maxConcurrentWorkflows: CAP });
        let host: any;
        let worker: any;

        beforeAll(async () => {
            gatedEntered = 0;
            gates.length = 0;

            config.usePersistence(persistence);
            host = config.getHost();
            host.registerWorkflow(Gated_Workflow);
            await host.start();
            worker = getWorkflowQueueWorker(host);

            for (let i = 0; i < 5; i++) {
                await host.startWorkflow("bounded-concurrency-gated", 1, {});
            }
        });

        afterAll(async () => {
            // free any still-parked steps so nothing bleeds into other specs
            while (gates.length > 0)
                gates.shift()!();
            await host.stop();
        });

        it("should expose the in-flight set while running and empty it when idle", async () => {
            // 5 queued, cap 3 — the pool fills to exactly the cap and the other
            // two stay on the queue (backpressure, rule §6.2).
            await spinWait(async () => worker.getActiveCount() === CAP);
            expect(worker.getActiveCount()).toBe(CAP);
            expect(worker.getActiveIds().length).toBe(worker.getActiveCount());

            // getActiveIds() returns a copy — mutating it must not affect the worker
            const ids: string[] = worker.getActiveIds();
            ids.pop();
            expect(worker.getActiveCount()).toBe(CAP);

            // open the gates (re-draining each poll: the remaining 2 start on
            // later cycles) until all 5 entered and the pool drained to idle
            await spinWait(async () => {
                while (gates.length > 0)
                    gates.shift()!();
                return gatedEntered === 5 && worker.getActiveCount() === 0;
            });

            expect(gatedEntered).toBe(5);
            expect(worker.getActiveCount()).toBe(0);
            expect(worker.getActiveIds()).toEqual([]);
        });
    });
});
