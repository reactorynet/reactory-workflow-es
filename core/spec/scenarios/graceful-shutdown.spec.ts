import {
    WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext,
    ExecutionResult, configureWorkflow, IDistributedLockProvider, WorkflowOptions
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

// H4 — async graceful drain; SIGTERM + SIGINT handling; idempotent stop().
// A module-scoped "gate" lets a test hold a step mid-flight (lock held, state
// unpersisted) while stop() is called, then release (or fail) it on demand.

const gate = {
    entered: false,
    release: null as (() => void) | null,
    fail: null as ((err: any) => void) | null,
};

class BlockingStep extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> {
        gate.entered = true;
        return new Promise<ExecutionResult>((resolve, reject) => {
            gate.release = () => resolve(ExecutionResult.next());
            gate.fail = (err: any) => reject(err);
        });
    }
}

class BlockingWorkflow implements WorkflowBase<any> {
    public id: string = "graceful-shutdown-blocking";
    public version: number = 1;
    public build(builder: WorkflowBuilder<any>) {
        builder.startWith(BlockingStep);
    }
}

// In-process mutex double that lets the test observe lock state (spec H4 §8
// "no held lock after drain").
class TestLockProvider implements IDistributedLockProvider {
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

    public isHeld(id: string): boolean {
        return this.held.has(id);
    }
}

function buildHost(options?: Partial<WorkflowOptions>, lockProvider?: IDistributedLockProvider) {
    const persistence = new MemoryPersistenceProvider();
    const config = configureWorkflow(options);
    config.usePersistence(persistence);
    if (lockProvider)
        config.useLockManager(lockProvider);
    const host = config.getHost();
    host.registerWorkflow(BlockingWorkflow);
    return { host, persistence };
}

describe("graceful shutdown", () => {

    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeEach(() => {
        gate.entered = false;
        gate.release = null;
        gate.fail = null;
    });

    it("stop() awaits an in-flight execution before resolving", async () => {
        const { host, persistence } = buildHost();
        await host.start();
        const workflowId = await host.startWorkflow("graceful-shutdown-blocking", 1, {});
        await spinWait(async () => gate.entered);

        let stopResolved = false;
        const stopPromise = Promise.resolve(host.stop()).then(() => { stopResolved = true; });

        // While the step is still blocked, stop() must not have resolved.
        await new Promise<void>((r) => setTimeout(r, 500));
        expect(stopResolved).toBe(false);

        gate.release!();
        await stopPromise;
        expect(stopResolved).toBe(true);

        const instance = await persistence.getWorkflowInstance(workflowId);
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    it("SIGTERM mid-execution drains the active workflow to a consistent state within the timeout", async () => {
        const { host, persistence } = buildHost({ gracefulShutdownTimeoutMs: 5000 });
        await host.start();
        const workflowId = await host.startWorkflow("graceful-shutdown-blocking", 1, {});
        await spinWait(async () => gate.entered);

        // Fire the registered SIGTERM handler (does not signal the OS).
        (process.emit as any)('SIGTERM', 'SIGTERM');
        gate.release!();

        // stop() is idempotent: this returns the drain the SIGTERM handler started.
        await host.stop();

        const instance = await persistence.getWorkflowInstance(workflowId);
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    it("no held lock after drain", async () => {
        const lock = new TestLockProvider();
        const { host } = buildHost({ gracefulShutdownTimeoutMs: 5000 }, lock);
        await host.start();
        const workflowId = await host.startWorkflow("graceful-shutdown-blocking", 1, {});
        await spinWait(async () => gate.entered);

        // Mid-flight, the execution holds the workflow lock.
        expect(lock.isHeld(workflowId)).toBe(true);

        gate.release!();
        await host.stop();

        // The execution finished inside the timeout, so its own finally
        // released the lock — a fresh acquire must succeed.
        expect(await lock.acquireLock(workflowId)).toBe(true);
        await lock.releaseLock(workflowId);
    });

    it("force-stop after timeout resolves without hanging", async () => {
        const { host } = buildHost({ gracefulShutdownTimeoutMs: 300 });
        await host.start();
        await host.startWorkflow("graceful-shutdown-blocking", 1, {});
        await spinWait(async () => gate.entered);

        const t0 = Date.now();
        await host.stop(); // step is never released before the timeout
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(2000);

        // Let the abandoned execution finish so it does not bleed into other specs.
        gate.release!();
    });

    it("stop resolves even if an in-flight execution throws", async () => {
        const { host } = buildHost({ gracefulShutdownTimeoutMs: 5000 });
        await host.start();
        await host.startWorkflow("graceful-shutdown-blocking", 1, {});
        await spinWait(async () => gate.entered);

        const stopPromise = host.stop();
        gate.fail!(new Error("in-flight execution failed during drain"));
        await expectAsync(stopPromise).toBeResolved();
    });

    it("idempotent repeated stop", async () => {
        const { host } = buildHost();
        await host.start();

        const baselineTerm = process.listenerCount('SIGTERM');
        const baselineInt = process.listenerCount('SIGINT');

        await Promise.all([host.stop(), host.stop()]);
        await host.stop();

        // Teardown ran once: listeners removed exactly once, never negative.
        expect(process.listenerCount('SIGTERM')).toBe(baselineTerm - 1);
        expect(process.listenerCount('SIGINT')).toBe(baselineInt - 1);
    });

    it("removes signal listeners on stop", async () => {
        const beforeTerm = process.listenerCount('SIGTERM');
        const beforeInt = process.listenerCount('SIGINT');

        const { host } = buildHost();
        await host.start();
        await host.stop();

        expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
        expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    });

    it("registers signal handlers exactly once per start", async () => {
        const beforeTerm = process.listenerCount('SIGTERM');
        const beforeInt = process.listenerCount('SIGINT');

        const { host } = buildHost();
        await host.start();

        expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
        expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);

        await host.stop();
    });

    it("no orphaned timers after stop", async () => {
        const { host } = buildHost();
        await host.start();

        const workers: any[] = (host as any).workers;
        expect(workers.length).toBe(3);
        for (const worker of workers)
            expect(worker.processTimer).not.toBeNull();

        await host.stop();

        for (const worker of workers)
            expect(worker.processTimer).toBeNull();
    });
});
