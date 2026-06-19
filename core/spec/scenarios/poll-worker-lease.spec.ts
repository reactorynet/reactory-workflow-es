/**
 * H3 — Poll worker lease / election spec
 *
 * Tests that the distributed lease gates the poll-worker scan so that across N
 * concurrent pollers sharing one lock provider, each runnable id is queued by
 * exactly one poller per cycle.
 *
 * Test organisation follows the existing scenario style (basic-workflow, schedule, etc.):
 * top-level describe → plain it() blocks, doubles wired via configureWorkflow() or by
 * directly injecting into PollWorker.
 *
 * We test the elected-scan semantics by calling the private `process` method via a
 * type-cast shim (avoids spinning up real setInterval timers). This isolates the
 * lease / scan logic without any timer machinery.
 */

import "reflect-metadata";
import { configureWorkflow, TYPES, WorkflowOptions, DEFAULT_POLL_INTERVAL_MS, POLL_LEASE_KEY } from "../../src";
import { PollWorker } from "../../src/services/poll-worker";
import { SingleNodeLockProvider } from "../../src/services/single-node-lock-provider";
import { IDistributedLockProvider, IQueueProvider, IPersistenceProvider, QueueType } from "../../src/abstractions";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Capturing queue double — records every queueForProcessing call. */
class CapturingQueueProvider implements IQueueProvider {
    public calls: Array<{ id: string; type: QueueType }> = [];

    async queueForProcessing(id: string, type: QueueType): Promise<void> {
        this.calls.push({ id, type });
    }

    async dequeueForProcessing(_type: QueueType): Promise<string> {
        return undefined as unknown as string;
    }
}

/** Persistence double — returns a fixed set of runnable instance ids and optionally event ids. */
class StubPersistence implements Partial<IPersistenceProvider> {
    constructor(
        private runnableIds: string[] = [],
        private eventIds: string[] = [],
        private throwOnInstances = false,
    ) {}

    async getRunnableInstances(): Promise<string[]> {
        if (this.throwOnInstances) throw new Error("Stubbed instance scan failure");
        return [...this.runnableIds];
    }

    async getRunnableEvents(): Promise<string[]> {
        return [...this.eventIds];
    }

    // remaining IPersistenceProvider methods — not called by PollWorker
    async addNewWorkflow(): Promise<string> { return ""; }
    async getWorkflowInstance(): Promise<any> { return null; }
    async persistWorkflow(): Promise<void> {}
    async terminateWorkflow(): Promise<void> {}
    async createEventSubscription(): Promise<void> {}
    async getSubscriptions(): Promise<any[]> { return []; }
    async markEventUnprocessed(): Promise<void> {}
    async persistEvent(): Promise<void> {}
    async getEvents(): Promise<string[]> { return []; }
    async getEvent(): Promise<any> { return null; }
    async markEventProcessed(): Promise<void> {}
    async deleteEventSubscription(): Promise<void> {}
    async createUnpublishedEvent(): Promise<void> {}
    async getUnpublishedEvents(): Promise<any[]> { return []; }
    async markUnpublishedEventProcessed(): Promise<void> {}
    async deleteUnpublishedEvent(): Promise<void> {}
}

/** Null logger double — discards all output. */
const nullLogger = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

// ---------------------------------------------------------------------------
// Helper: build a PollWorker with doubles injected
// ---------------------------------------------------------------------------

/**
 * Build a PollWorker using the DI container from configureWorkflow(), then replace
 * the injected providers with the supplied test doubles.  This keeps the inversify
 * metadata plumbing intact while giving us full control of every collaborator.
 */
function buildWorker(
    lockProvider: IDistributedLockProvider,
    queueProvider: IQueueProvider,
    persistence: Partial<IPersistenceProvider>,
): PollWorker {
    const config = configureWorkflow();
    const container = config.getContainer();

    // Rebind collaborators with the test doubles
    container.rebind(TYPES.IDistributedLockProvider).toConstantValue(lockProvider);
    container.rebind(TYPES.IQueueProvider).toConstantValue(queueProvider);
    container.rebind(TYPES.IPersistenceProvider).toConstantValue(persistence as IPersistenceProvider);
    container.rebind(TYPES.ILogger).toConstantValue(nullLogger);

    return container.resolve(PollWorker);
}

/** Invoke the private `process` static method via cast. */
async function runCycle(worker: PollWorker): Promise<void> {
    return (worker as any).process(worker);
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe("poll worker lease", () => {

    // -----------------------------------------------------------------------
    // §8 failing-test-first: N pollers sharing one lock → exactly one queues
    // -----------------------------------------------------------------------

    it("only one of N pollers queues each runnable id per cycle", async () => {
        const N = 5;
        const ID_COUNT = 50;
        const instanceIds = Array.from({ length: ID_COUNT }, (_, i) => `wf-${i}`);

        const sharedLock = new SingleNodeLockProvider();
        const sharedQueue = new CapturingQueueProvider();
        const persistence = new StubPersistence(instanceIds, []);

        // Build N workers all sharing the same lock provider and queue
        const workers = Array.from({ length: N }, () =>
            buildWorker(sharedLock, sharedQueue, persistence)
        );

        // Act: run one poll cycle on all N workers concurrently
        await Promise.all(workers.map(w => runCycle(w)));

        // Assert: each id queued exactly once (one winner, four losers)
        const workflowCalls = sharedQueue.calls.filter(c => c.type === QueueType.Workflow);
        expect(workflowCalls.length).toBe(ID_COUNT);

        const seen = new Set<string>();
        for (const call of workflowCalls) {
            expect(seen.has(call.id)).toBe(false); // no duplicates
            seen.add(call.id);
        }
        expect(seen.size).toBe(ID_COUNT);
    });

    // -----------------------------------------------------------------------
    // Single process always wins and polls every cycle (rule §6.8)
    // -----------------------------------------------------------------------

    it("single process always wins and polls every cycle", async () => {
        const instanceIds = ["a", "b", "c"];
        const sharedLock = new SingleNodeLockProvider();
        const sharedQueue = new CapturingQueueProvider();
        const persistence = new StubPersistence(instanceIds, []);

        const worker = buildWorker(sharedLock, sharedQueue, persistence);

        // Two consecutive cycles
        await runCycle(worker);
        await runCycle(worker);

        // Both cycles should have enqueued the full set
        const workflowCalls = sharedQueue.calls.filter(c => c.type === QueueType.Workflow);
        expect(workflowCalls.length).toBe(instanceIds.length * 2);
    });

    // -----------------------------------------------------------------------
    // Lease is released after a cycle that throws (rule §6.5, §6.6)
    // -----------------------------------------------------------------------

    it("lease is released after a cycle that throws", async () => {
        const sharedLock = new SingleNodeLockProvider();
        const sharedQueue = new CapturingQueueProvider();
        const persistence = new StubPersistence([], [], /* throwOnInstances */ true);

        const worker = buildWorker(sharedLock, sharedQueue, persistence);

        await runCycle(worker); // throws internally; lease should still be released

        // Lease must be acquirable again by a fresh call
        const reacquired = await sharedLock.acquireLock(POLL_LEASE_KEY);
        expect(reacquired).toBe(true);
        await sharedLock.releaseLock(POLL_LEASE_KEY); // clean up
    });

    // -----------------------------------------------------------------------
    // Event scan still runs when instance scan throws (rule §6.6)
    // -----------------------------------------------------------------------

    it("event scan still runs when instance scan throws", async () => {
        const eventIds = ["evt-1", "evt-2", "evt-3"];
        const sharedLock = new SingleNodeLockProvider();
        const sharedQueue = new CapturingQueueProvider();
        const persistence = new StubPersistence([], eventIds, /* throwOnInstances */ true);

        const worker = buildWorker(sharedLock, sharedQueue, persistence);
        await runCycle(worker);

        const eventCalls = sharedQueue.calls.filter(c => c.type === QueueType.Event);
        expect(eventCalls.length).toBe(eventIds.length);
        expect(eventCalls.map(c => c.id).sort()).toEqual([...eventIds].sort());

        // Lease must be released despite the instance scan throwing
        const reacquired = await sharedLock.acquireLock(POLL_LEASE_KEY);
        expect(reacquired).toBe(true);
        await sharedLock.releaseLock(POLL_LEASE_KEY);
    });

    // -----------------------------------------------------------------------
    // Acquire error skips cycle without releasing (rule §6.7)
    // -----------------------------------------------------------------------

    it("acquire error skips cycle without calling releaseLock", async () => {
        let releaseCalled = false;

        const failingLock: IDistributedLockProvider = {
            acquireLock: async (_id: string) => { throw new Error("lock provider unreachable"); },
            releaseLock: async (_id: string) => { releaseCalled = true; },
        };

        const sharedQueue = new CapturingQueueProvider();
        const instanceIds = ["x1", "x2"];
        const persistence = new StubPersistence(instanceIds, []);

        const worker = buildWorker(failingLock, sharedQueue, persistence);
        await runCycle(worker); // should not throw externally; logs and returns

        expect(sharedQueue.calls.length).toBe(0); // nothing queued
        expect(releaseCalled).toBe(false);        // releaseLock never called
    });

});

// ---------------------------------------------------------------------------
// Config surface tests
// ---------------------------------------------------------------------------

describe("config — WorkflowOptions", () => {

    it("default poll interval is 10000", () => {
        const config = configureWorkflow(); // no args
        const container = config.getContainer();
        const opts = container.get<WorkflowOptions>(TYPES.WorkflowOptions);
        expect(opts.pollIntervalMs).toBe(10000);
    });

    it("accepts a valid custom poll interval", () => {
        const config = configureWorkflow({ pollIntervalMs: 5000 });
        const container = config.getContainer();
        const opts = container.get<WorkflowOptions>(TYPES.WorkflowOptions);
        expect(opts.pollIntervalMs).toBe(5000);
    });

    it("throws when pollIntervalMs is below 1000", () => {
        expect(() => configureWorkflow({ pollIntervalMs: 100 })).toThrow();
    });

    it("throws when pollIntervalMs is a non-integer", () => {
        expect(() => configureWorkflow({ pollIntervalMs: 1.5 })).toThrow();
    });

    it("DEFAULT_POLL_INTERVAL_MS constant equals 10000", () => {
        expect(DEFAULT_POLL_INTERVAL_MS).toBe(10000);
    });

    it("POLL_LEASE_KEY is the expected namespaced constant", () => {
        expect(POLL_LEASE_KEY).toBe("workflow-es:poll-lease");
    });
});
