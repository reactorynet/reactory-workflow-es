import {
    WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext,
    ExecutionResult, configureWorkflow, IQueueProvider, QueueType, TYPES,
    IBackgroundWorker, EventSubscription
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";
import { InstrumentedLockProvider } from "../helpers/instrumented-lock-provider";

// H2 — close the lock-release race: all state-derived post-processing
// (subscription creation, event seeding, re-queue decision) must run INSIDE
// the per-workflow lock, with releaseLock as the last action; subscription
// creation must be idempotent. See docs/specs/h2-lock-release-race.md §6/§8.

/** Queue double that mirrors SingleNodeQueueProvider and records a "requeue:<id>"
 *  marker in the shared lock order log for every workflow-queue enqueue. */
class InstrumentedQueueProvider implements IQueueProvider {
    private workflowQueue: string[] = [];
    private eventQueue: string[] = [];

    constructor(private lock: InstrumentedLockProvider) { }

    public async queueForProcessing(id: string, queue: QueueType): Promise<void> {
        if (queue === QueueType.Workflow) {
            this.lock.mark(`requeue:${id}`);
            this.workflowQueue.push(id);
        }
        else {
            this.eventQueue.push(id);
        }
    }

    public async dequeueForProcessing(queue: QueueType): Promise<string> {
        if (queue === QueueType.Workflow)
            return this.workflowQueue.shift();
        return this.eventQueue.shift();
    }
}

/** Records a "subscribe:<workflowId>" marker and a per-workflow call count for
 *  every persistence.createEventSubscription invocation. */
function spyOnSubscriptionCreate(persistence: MemoryPersistenceProvider, lock: InstrumentedLockProvider, counts: Map<string, number>) {
    const original = persistence.createEventSubscription.bind(persistence);
    persistence.createEventSubscription = async (sub: EventSubscription): Promise<void> => {
        lock.mark(`subscribe:${sub.workflowId}`);
        counts.set(sub.workflowId, (counts.get(sub.workflowId) || 0) + 1);
        return original(sub);
    };
}

describe("h2 lock-release race — ordering", () => {

    class Step1 extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class H2_Ordering_Workflow implements WorkflowBase<any> {
        public id: string = "h2-ordering";
        public version: number = 1;

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(Step1)
                .waitFor("h2-event", data => "k");
        }
    }

    const lock = new InstrumentedLockProvider();
    lock.recording = false;
    const persistence = new MemoryPersistenceProvider();
    const queue = new InstrumentedQueueProvider(lock);
    const createCounts = new Map<string, number>();
    spyOnSubscriptionCreate(persistence, lock, createCounts);

    const config = configureWorkflow();
    config.usePersistence(persistence);
    config.useLockManager(lock);
    config.useQueueManager(queue);
    const host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    let workflowId: string = null;
    let publishIndex = 0;

    beforeAll(async () => {
        host.registerWorkflow(H2_Ordering_Workflow);
        await host.start();

        workflowId = await host.startWorkflow("h2-ordering", 1, {});
        // The startWorkflow enqueue above is legitimately outside any lock;
        // record only from here (worker-driven activity).
        lock.recording = true;

        await spinWait(async () => {
            const subs = await persistence.getSubscriptions("h2-event", "k", new Date());
            return subs.some(s => s.workflowId === workflowId);
        });

        publishIndex = lock.order.length;
        await host.publishEvent("h2-event", "k", "Pass", new Date());

        await spinWait(async () => {
            const instance = await persistence.getWorkflowInstance(workflowId);
            return instance.status != WorkflowStatus.Runnable;
        });
        // Close the assertion window before the 10s poll-worker tick can add
        // unrelated (lock-free, legitimate) enqueues.
        lock.recording = false;
    });

    afterAll(async () => {
        await host.stop();
    });

    it("h2: post-processing must occur before lock release", () => {
        const subscribeMarkers = lock.order.filter(x => x === `subscribe:${workflowId}`);
        const requeueMarkers = lock.order.filter(x => x === `requeue:${workflowId}`);

        // Both kinds of post-processing happened for this workflow...
        expect(subscribeMarkers.length).toBeGreaterThanOrEqual(1);
        expect(requeueMarkers.length).toBeGreaterThanOrEqual(1);

        // ...and every one of them happened while the workflow lock was held,
        // i.e. before the releaseLock of its processing session (rules 1, 2).
        const offenders = lock.offendingMarkers(workflowId, ["subscribe", "requeue"]);
        expect(offenders)
            .withContext("subscribe/requeue recorded AFTER lock release; order = " + JSON.stringify(lock.forId(workflowId)))
            .toEqual([]);
    });

    it("h2: event worker re-queues before releasing the workflow lock", () => {
        // The markers recorded after publishEvent include seedSubscription's
        // re-queue of the woken workflow; it must precede that lock's release (rule 8).
        const tail = lock.order.slice(publishIndex);
        const requeueAfterPublish = tail.filter(x => x === `requeue:${workflowId}`);
        expect(requeueAfterPublish.length).toBeGreaterThanOrEqual(1);

        const offenders = lock.offendingMarkers(workflowId, ["requeue"], publishIndex);
        expect(offenders)
            .withContext("seedSubscription re-queued after releasing the workflow lock; order = " + JSON.stringify(lock.forId(workflowId)))
            .toEqual([]);
    });

    it("h2: workflow completes normally with the corrected ordering (regression)", async () => {
        const instance = await persistence.getWorkflowInstance(workflowId);
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });
});

describe("h2 lock-release race — contention and idempotency", () => {

    const scope = { runs: 0 };

    class CountStep extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            scope.runs++;
            return ExecutionResult.next();
        }
    }

    class H2_Contention_Workflow implements WorkflowBase<any> {
        public id: string = "h2-contention";
        public version: number = 1;

        public build(builder: WorkflowBuilder<any>) {
            builder
                .startWith(CountStep)
                .waitFor("h2-event-2", data => "k2");
        }
    }

    const lock = new InstrumentedLockProvider();
    const persistence = new MemoryPersistenceProvider();
    const queue = new InstrumentedQueueProvider(lock);
    const createCounts = new Map<string, number>();
    spyOnSubscriptionCreate(persistence, lock, createCounts);

    const config = configureWorkflow();
    config.usePersistence(persistence);
    config.useLockManager(lock);
    config.useQueueManager(queue);
    const host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    let workflowId: string = null;
    let stalled = false;

    beforeAll(async () => {
        // Deterministic contention: stall the first holder of the workflow lock
        // so the duplicate enqueue below is dequeued and attempts acquisition
        // while the lock is still held.
        lock.onAcquired = async (id: string) => {
            if (id === workflowId && !stalled) {
                stalled = true;
                await new Promise<void>(resolve => setTimeout(resolve, 400));
            }
        };

        host.registerWorkflow(H2_Contention_Workflow);
        await host.start();

        workflowId = await host.startWorkflow("h2-contention", 1, {});
        // Duplicate enqueue of the same id — two overlapping processWorkflow
        // attempts for the same pre-event state.
        await queue.queueForProcessing(workflowId, QueueType.Workflow);

        await spinWait(async () => {
            const subs = await persistence.getSubscriptions("h2-event-2", "k2", new Date());
            return subs.some(s => s.workflowId === workflowId);
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("h2: a re-queued + subscribing workflow is never processed twice for the same pointer under contention", () => {
        // The duplicate attempt really contended for the lock...
        expect(lock.order.filter(x => x === `acquire-denied:${workflowId}`).length)
            .withContext("expected the duplicate attempt to be denied while the first holder held the lock")
            .toBeGreaterThanOrEqual(1);
        // ...and the runnable step body executed exactly once (rules 6, 9).
        expect(scope.runs).toBe(1);
    });

    it("h2: subscriptions are created exactly once under duplicate processing", async () => {
        expect(createCounts.get(workflowId) || 0).toBe(1);
        const subs = await persistence.getSubscriptions("h2-event-2", "k2", new Date());
        expect(subs.filter(s => s.workflowId === workflowId).length).toBe(1);
    });
});

describe("h2 subscription idempotency guard (rule 5)", () => {

    it("h2: subscribeEvent creates a subscription at most once per (workflowId, eventName, eventKey, subscribeAsOf)", async () => {
        const persistence = new MemoryPersistenceProvider();
        let createCalls = 0;
        const originalCreate = persistence.createEventSubscription.bind(persistence);
        persistence.createEventSubscription = async (sub: EventSubscription): Promise<void> => {
            createCalls++;
            return originalCreate(sub);
        };

        const config = configureWorkflow();
        config.usePersistence(persistence);
        const workers = config.getContainer().getAll<IBackgroundWorker>(TYPES.IBackgroundWorker);
        const worker: any = workers.find(w => w.constructor.name === "WorkflowQueueWorker");
        expect(worker).toBeDefined();

        const asOf = new Date();
        const makeSub = () => {
            const sub = new EventSubscription();
            sub.workflowId = "h2-guard-wf";
            sub.stepId = 1;
            sub.eventName = "h2-guard-event";
            sub.eventKey = "gk";
            sub.subscribeAsOf = asOf;
            return sub;
        };

        // A duplicate emission of the same subscription tuple (e.g. a re-run
        // step under a duplicate acquisition) must be guarded out.
        await worker.subscribeEvent(worker, makeSub());
        await worker.subscribeEvent(worker, makeSub());

        expect(createCalls).toBe(1);
        const stored = await persistence.getSubscriptions("h2-guard-event", "gk", asOf);
        expect(stored.filter(s => s.workflowId === "h2-guard-wf").length).toBe(1);
    });
});

describe("h2 error path — lock released exactly once, no post-processing", () => {

    class BoomStep extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            throw new Error("h2 boom");
        }
    }

    class H2_Error_Workflow implements WorkflowBase<any> {
        public id: string = "h2-error";
        public version: number = 1;

        public build(builder: WorkflowBuilder<any>) {
            builder.startWith(BoomStep);
        }
    }

    const lock = new InstrumentedLockProvider();
    lock.recording = false;
    const persistence = new MemoryPersistenceProvider();
    const queue = new InstrumentedQueueProvider(lock);
    const createCounts = new Map<string, number>();
    spyOnSubscriptionCreate(persistence, lock, createCounts);

    const config = configureWorkflow();
    config.usePersistence(persistence);
    config.useLockManager(lock);
    config.useQueueManager(queue);
    const host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    let workflowId: string = null;
    const missingId = "h2-no-such-workflow";

    beforeAll(async () => {
        host.registerWorkflow(H2_Error_Workflow);
        await host.start();

        workflowId = await host.startWorkflow("h2-error", 1, {});
        // A dequeue for an id with no stored instance (getWorkflowInstance -> falsy).
        await queue.queueForProcessing(missingId, QueueType.Workflow);
        lock.recording = true;

        // Fixed settle: both ids are dequeued on the next 100ms ticks; the failed
        // step retries 60s later, well outside this window.
        await new Promise<void>(resolve => setTimeout(resolve, 2000));
        lock.recording = false;
    });

    afterAll(async () => {
        await host.stop();
    });

    it("h2: error in step still releases lock exactly once and skips post-processing", () => {
        expect(lock.forId(workflowId)).toEqual([`acquire:${workflowId}`, `release:${workflowId}`]);
        expect(createCounts.get(workflowId)).toBeUndefined();
    });

    it("h2: a missing instance still releases the lock exactly once and skips post-processing", () => {
        expect(lock.forId(missingId)).toEqual([`acquire:${missingId}`, `release:${missingId}`]);
        expect(createCounts.get(missingId)).toBeUndefined();
    });
});

describe("h2 two-host integration (live Redis lock + Postgres)", () => {

    it("h2: two hosts on a shared Redis lock + Postgres execute a subscribing+re-queue workflow once, with one subscription", () => {
        // Per h2 spec §8, the live two-host variant (shared Redis distributed
        // lock + Postgres persistence) belongs to the C1/M8 integration harness
        // and requires reachable services; it is not executed in the core suite.
        pending("Requires live Redis + Postgres; tracked under the C1/M8 integration harness (h2 spec §8).");
    });
});
