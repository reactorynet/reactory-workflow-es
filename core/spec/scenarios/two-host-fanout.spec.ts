import {
    WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext,
    ExecutionResult, configureWorkflow, IQueueProvider, QueueType, IDistributedLockProvider
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

// C1 — two hosts sharing one backend run a fan-out with zero duplicate executions
// and zero lost updates. The distributed backend is modelled with in-process doubles
// that enforce real cross-host semantics (one shared FIFO; one shared mutex set), so
// the test runs in CI without containers. The real Redis equivalent lives in the
// redis provider spec / M8.

// Shared mutex across both hosts.
class SharedLock implements IDistributedLockProvider {
    private held: Set<string> = new Set<string>();

    public async acquireLock(id: string): Promise<boolean> {
        if (this.held.has(id))
            return false;
        this.held.add(id);
        return true;
    }

    public async releaseLock(id: string): Promise<void> {
        this.held.delete(id);
    }
}

// Single shared FIFO across both hosts.
class SharedQueue implements IQueueProvider {
    private workflowQueue: string[] = [];
    private eventQueue: string[] = [];

    public async queueForProcessing(id: string, queue: QueueType): Promise<void> {
        if (queue === QueueType.Workflow)
            this.workflowQueue.push(id);
        else
            this.eventQueue.push(id);
    }

    public async dequeueForProcessing(queue: QueueType): Promise<string> {
        if (queue === QueueType.Workflow)
            return this.workflowQueue.shift();
        return this.eventQueue.shift();
    }
}

describe("two-host fan-out (shared backend)", () => {

    const INSTANCE_COUNT = 1000;
    const executionLog: Array<{ workflowId: string, pointerId: string }> = [];

    class RecordStep extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            executionLog.push({
                workflowId: context.workflow.id,
                pointerId: context.pointer.id
            });
            return ExecutionResult.next();
        }
    }

    class FanoutWorkflow implements WorkflowBase<any> {
        public id: string = "fanout";
        public version: number = 1;
        public build(builder: WorkflowBuilder<any>) {
            builder.startWith(RecordStep);
        }
    }

    const shared = new MemoryPersistenceProvider();
    const sharedLock = new SharedLock();
    const sharedQueue = new SharedQueue();

    const configA = configureWorkflow();
    configA.usePersistence(shared);
    configA.useLockManager(sharedLock);
    configA.useQueueManager(sharedQueue);
    const hostA = configA.getHost();

    const configB = configureWorkflow();
    configB.usePersistence(shared);
    configB.useLockManager(sharedLock);
    configB.useQueueManager(sharedQueue);
    const hostB = configB.getHost();

    const ids: string[] = [];

    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeAll(async () => {
        hostA.registerWorkflow(FanoutWorkflow);
        hostB.registerWorkflow(FanoutWorkflow);
        await hostA.start();
        await hostB.start();

        for (let i = 0; i < INSTANCE_COUNT; i++) {
            ids.push(await hostA.startWorkflow("fanout", 1, { i }));
        }

        await spinWait(async () => {
            let completed = 0;
            for (const id of ids) {
                const inst = await shared.getWorkflowInstance(id);
                if (inst && inst.status === WorkflowStatus.Complete)
                    completed++;
            }
            return completed === INSTANCE_COUNT;
        });
    });

    afterAll(() => {
        hostA.stop();
        hostB.stop();
    });

    it("two hosts run 1000 instances with zero duplicate executions", async () => {
        let completed = 0;
        for (const id of ids) {
            const inst = await shared.getWorkflowInstance(id);
            expect(inst.status).toBe(WorkflowStatus.Complete);
            // Zero lost updates: each instance was persisted at least once.
            expect(inst.concurrencyToken).toBeGreaterThanOrEqual(1);
            completed++;
        }
        expect(completed).toBe(INSTANCE_COUNT);

        expect(executionLog.length).toBe(INSTANCE_COUNT);
        expect(new Set(executionLog.map(e => e.workflowId)).size).toBe(INSTANCE_COUNT);
    });
});

describe("single-node providers fail loud", () => {

    // A non-memory persistence double whose constructor.name is not "MemoryPersistenceProvider".
    class FakeDurablePersistence extends MemoryPersistenceProvider {}

    it("throws when a non-memory persistence is configured with single-node defaults", async () => {
        const config = configureWorkflow();
        config.usePersistence(new FakeDurablePersistence());
        const host = config.getHost();
        host.registerWorkflow(class Wf implements WorkflowBase<any> {
            public id = "guard-wf-1";
            public version = 1;
            public build(builder: WorkflowBuilder<any>) {
                builder.startWith(class S extends StepBody {
                    public run(): Promise<ExecutionResult> { return ExecutionResult.next(); }
                });
            }
        });

        let caught: any = null;
        try {
            await host.start();
        }
        catch (err) {
            caught = err;
        }
        finally {
            host.stop();
        }

        expect(caught).not.toBeNull();
        expect(String(caught.message)).toContain("dev-only");
    });

    it("does not throw when allowSingleNodeProviders(true)", async () => {
        const config = configureWorkflow();
        config.usePersistence(new FakeDurablePersistence());
        config.allowSingleNodeProviders(true);
        const host = config.getHost();
        host.registerWorkflow(class Wf implements WorkflowBase<any> {
            public id = "guard-wf-2";
            public version = 1;
            public build(builder: WorkflowBuilder<any>) {
                builder.startWith(class S extends StepBody {
                    public run(): Promise<ExecutionResult> { return ExecutionResult.next(); }
                });
            }
        });

        let caught: any = null;
        try {
            await host.start();
        }
        catch (err) {
            caught = err;
        }
        finally {
            host.stop();
        }

        expect(caught).toBeNull();
    });
});
