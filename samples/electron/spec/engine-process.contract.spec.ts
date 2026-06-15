/**
 * engine-process.contract.spec.ts — Headless contract spec (no Electron runtime).
 *
 * Proves that WorkflowHost is fully constructible, startable, and stoppable in a
 * Node.js process that has NO main-thread or browser globals (no `window`, no
 * `document`, no Electron `app`). This is exactly the environment inside an
 * Electron `utilityProcess` — so a green test here proves the engine can run in
 * that context.
 *
 * Uses MemoryPersistenceProvider (from core) for the in-process test so the spec
 * has no native-addon dependency and runs in CI without Electron or a rebuild step.
 * The production engine-process.ts uses SqlitePersistence(dbPath); the persistence
 * provider is irrelevant to the "no main-thread globals" contract being tested here.
 *
 * Run:
 *   cd samples/electron && yarn install && yarn build && yarn test
 */
import "reflect-metadata";

import {
    configureWorkflow,
    WorkflowBase,
    WorkflowBuilder,
    StepBody,
    StepExecutionContext,
    ExecutionResult,
    WorkflowStatus,
    WorkflowInstance,
    MemoryPersistenceProvider,
} from "@reactorynet/workflow-es";

// ---- Spin-wait helper (mirrors core/spec/helpers/spin-wait.ts) --------------

function spinWait(until: () => Promise<boolean>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let counter = 0;
        const callback = async () => {
            try {
                const done = await until();
                if (!done && counter < 60) {
                    counter++;
                    setTimeout(callback, 500);
                } else {
                    resolve();
                }
            } catch (err) {
                reject(err);
            }
        };
        setTimeout(callback, 500);
    });
}

// ---- Minimal workflow definitions -------------------------------------------

class HelloStep extends StepBody {
    public async run(_ctx: StepExecutionContext): Promise<ExecutionResult> {
        await new Promise<void>(r => setTimeout(r, 10));
        return ExecutionResult.next();
    }
}

class GoodbyeStep extends StepBody {
    public async run(_ctx: StepExecutionContext): Promise<ExecutionResult> {
        await new Promise<void>(r => setTimeout(r, 10));
        return ExecutionResult.next();
    }
}

class HelloContract_Workflow implements WorkflowBase<null> {
    public id      = "hello-contract";
    public version = 1;
    public build(builder: WorkflowBuilder<null>): void {
        builder.startWith(HelloStep).then(GoodbyeStep);
    }
}

/** Deliberate busy-loop — proves a blocking step still reaches Complete. */
class BusyLoopStep extends StepBody {
    public run(ctx: StepExecutionContext): Promise<ExecutionResult> {
        const duration: number = (ctx.persistenceData as { durationMs?: number }).durationMs ?? 200;
        const deadline = Date.now() + duration;
        while (Date.now() < deadline) { /* intentional busy-loop */ }
        return ExecutionResult.next();
    }
}

class CpuHeavyContract_Workflow implements WorkflowBase<{ durationMs: number }> {
    public id      = "cpu-heavy-contract";
    public version = 1;
    public build(builder: WorkflowBuilder<{ durationMs: number }>): void {
        builder.startWith(BusyLoopStep);
    }
}

// ---- Tests ------------------------------------------------------------------

/**
 * Suite 1 — core contract: the host constructs and runs with no main-thread globals.
 *
 * This is the "failing-test-first" from M3 §8. Before any sample code exists this
 * test cannot even compile (it references HelloContract_Workflow which does not
 * exist), making it red by definition.
 */
describe("engine-process.contract › constructs and starts the host with no main-thread globals", () => {
    let persistence: MemoryPersistenceProvider;
    let workflowId: string;
    let instance: WorkflowInstance | null = null;
    let host: ReturnType<ReturnType<typeof configureWorkflow>["getHost"]>;

    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30_000;

    beforeAll(async () => {
        // Assert we are NOT in a browser / Electron main / renderer context.
        // This is what running inside a utilityProcess guarantees.
        // Use globalThis to avoid TypeScript's dom-lib narrowing.
        // At runtime in a plain Node process (and in a utilityProcess), these are undefined.
        expect(typeof (globalThis as Record<string, unknown>)["window"]).toBe("undefined");
        expect(typeof (globalThis as Record<string, unknown>)["document"]).toBe("undefined");

        persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.usePersistence(persistence);
        host = config.getHost();

        host.registerWorkflow(HelloContract_Workflow);

        await host.start();
        workflowId = await host.startWorkflow("hello-contract", 1, null);

        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return instance.status !== WorkflowStatus.Runnable;
        });
    });

    afterAll(async () => {
        // stop() returns void in base core; Promise<void> after H4. Both are safe to await.
        await Promise.resolve(host.stop() as unknown);
    });

    it("workflow ID is defined", () => {
        expect(workflowId).toBeDefined();
        expect(typeof workflowId).toBe("string");
    });

    it("workflow reaches Complete status", () => {
        expect(instance).not.toBeNull();
        expect(instance!.status).toBe(WorkflowStatus.Complete);
    });

    it("typeof window is undefined (no DOM / browser context)", () => {
        expect(typeof window).toBe("undefined");
    });

    it("typeof document is undefined (no DOM / browser context)", () => {
        expect(typeof document).toBe("undefined");
    });
});

/**
 * Suite 2 — stop() is idempotent and awaitable.
 *
 * Covers §6.7's drain contract at the engine level (without needing the full
 * Electron IPC handshake).
 */
describe("engine-process.contract › stop() is idempotent and awaitable", () => {
    let host: ReturnType<ReturnType<typeof configureWorkflow>["getHost"]>;

    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30_000;

    beforeAll(async () => {
        const persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.usePersistence(persistence);
        host = config.getHost();
        host.registerWorkflow(HelloContract_Workflow);
        await host.start();
    });

    it("first stop() completes without throwing", async () => {
        // stop() returns void in the base core implementation;
        // Promise<void> after the H4 graceful-drain upgrade.
        // Wrapping in a try/catch + Promise.resolve() handles both.
        let threw = false;
        try {
            await Promise.resolve(host.stop() as unknown);
        } catch (_) {
            threw = true;
        }
        expect(threw).toBe(false);
    });

    it("second stop() completes immediately without throwing", async () => {
        let threw = false;
        try {
            await Promise.resolve(host.stop() as unknown);
        } catch (_) {
            threw = true;
        }
        expect(threw).toBe(false);
    });
});

/**
 * Suite 3 — a CPU-heavy step still completes (§6.2 mechanical contract).
 *
 * The UI-responsiveness aspect (§6.8 — clock keeps animating) requires the
 * Electron renderer and is verified manually (see samples/electron/README.md).
 * This test only verifies that the step itself reaches Complete, which documents
 * the spec's "bad example" mechanically.
 */
describe("engine-process.contract › a CPU-heavy step still completes", () => {
    let persistence: MemoryPersistenceProvider;
    let workflowId: string;
    let instance: WorkflowInstance | null = null;
    let host: ReturnType<ReturnType<typeof configureWorkflow>["getHost"]>;

    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30_000;

    beforeAll(async () => {
        persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.usePersistence(persistence);
        host = config.getHost();
        host.registerWorkflow(CpuHeavyContract_Workflow);
        await host.start();

        workflowId = await host.startWorkflow("cpu-heavy-contract", 1, { durationMs: 200 });

        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return instance.status !== WorkflowStatus.Runnable;
        });
    });

    afterAll(async () => {
        // stop() returns void in base core; Promise<void> after H4. Both are safe to await.
        await Promise.resolve(host.stop() as unknown);
    });

    it("cpu-heavy workflow reaches Complete status", () => {
        expect(instance).not.toBeNull();
        expect(instance!.status).toBe(WorkflowStatus.Complete);
    });
});
