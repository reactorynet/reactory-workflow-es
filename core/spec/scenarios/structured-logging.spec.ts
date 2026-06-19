/**
 * Scenario tests for M4 — Structured logging + correlation IDs.
 * Uses FakeLogger to capture records and assert correlation context.
 *
 * Run with: cd core && yarn test
 */
import {
    configureWorkflow,
    WorkflowBuilder,
    WorkflowStatus,
    WorkflowBase,
    StepBody,
    StepExecutionContext,
    ExecutionResult,
    WorkflowInstance,
    LogLevel,
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";
import { FakeLogger } from "../helpers/fake-logger";

// ---------------------------------------------------------------------------
// Shared step/workflow definitions
// ---------------------------------------------------------------------------

class SimpleStep extends StepBody {
    public run(_context: StepExecutionContext): Promise<ExecutionResult> {
        return ExecutionResult.next();
    }
}

class ThrowingStep extends StepBody {
    private static _shouldThrow = true;

    public static reset() { ThrowingStep._shouldThrow = true; }

    public run(_context: StepExecutionContext): Promise<ExecutionResult> {
        if (ThrowingStep._shouldThrow) {
            ThrowingStep._shouldThrow = false;
            throw new Error("deliberate step failure");
        }
        return ExecutionResult.next();
    }
}

class SimpleWorkflow implements WorkflowBase<any> {
    public id   = "structured-log-simple";
    public version = 1;
    public build(builder: WorkflowBuilder<any>) {
        builder.startWith(SimpleStep);
    }
}

class ThrowingWorkflow implements WorkflowBase<any> {
    public id      = "structured-log-throwing";
    public version = 1;
    public build(builder: WorkflowBuilder<any>) {
        builder.startWith(ThrowingStep);
    }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("structured-logging", () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    // -----------------------------------------------------------------------
    // Suite 1: workflowId and stepId on step logs (the failing-first test)
    // -----------------------------------------------------------------------
    describe("captures workflowId and stepId on step logs", () => {
        let fake: FakeLogger;
        let workflowId: string;
        let persistence: MemoryPersistenceProvider;

        beforeAll(async () => {
            ThrowingStep.reset();
            fake = new FakeLogger();
            persistence = new MemoryPersistenceProvider();

            const config = configureWorkflow();
            config.useLogger(fake);
            config.usePersistence(persistence);
            const host = config.getHost();
            host.registerWorkflow(ThrowingWorkflow);
            await host.start();

            workflowId = await host.startWorkflow("structured-log-throwing", 1, {});
            // Spin until the workflow is no longer Runnable (completes or dead-letters).
            await spinWait(async () => {
                const inst = await persistence.getWorkflowInstance(workflowId);
                return inst.status !== WorkflowStatus.Runnable;
            });

            await host.stop();
        });

        it("records at least one log entry with the correct workflowId", () => {
            const hit = fake.records.some(r => r.context?.workflowId === workflowId);
            expect(hit).toBe(true);
        });

        it("records an Error-level entry with workflowId, stepId, and an err object when step throws", () => {
            const errorRecord = fake.records.find(r =>
                r.level === LogLevel.Error &&
                r.context?.workflowId === workflowId &&
                r.context?.stepId !== undefined &&
                r.context?.err instanceof Error
            );
            expect(errorRecord).toBeDefined();
        });
    });

    // -----------------------------------------------------------------------
    // Suite 2: Info-level lifecycle lines are emitted, not down-leveled to Debug
    // -----------------------------------------------------------------------
    describe("Info-level lifecycle lines are emitted, not down-leveled to Debug", () => {
        let fake: FakeLogger;
        let workflowId: string;
        let persistence: MemoryPersistenceProvider;

        beforeAll(async () => {
            fake = new FakeLogger();
            persistence = new MemoryPersistenceProvider();

            const config = configureWorkflow();
            config.useLogger(fake);
            config.usePersistence(persistence);
            const host = config.getHost();
            host.registerWorkflow(SimpleWorkflow);
            await host.start();

            workflowId = await host.startWorkflow("structured-log-simple", 1, {});
            await spinWait(async () => {
                const inst = await persistence.getWorkflowInstance(workflowId);
                return inst.status !== WorkflowStatus.Runnable;
            });

            await host.stop();
        });

        it("has an Info record whose context contains the workflow id (Execute workflow line)", () => {
            const hit = fake.records.some(r =>
                r.level === LogLevel.Info &&
                r.context?.workflowId === workflowId
            );
            expect(hit).toBe(true);
        });

        it("has no Debug records (all former .log() calls mapped to Info)", () => {
            const debugCount = fake.records.filter(r => r.level === LogLevel.Debug).length;
            expect(debugCount).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Suite 3: publishEvent log carries eventName and eventKey
    // -----------------------------------------------------------------------
    describe("publishEvent log carries eventName and eventKey", () => {
        let fake: FakeLogger;
        let persistence: MemoryPersistenceProvider;

        beforeAll(async () => {
            fake = new FakeLogger();
            persistence = new MemoryPersistenceProvider();

            const config = configureWorkflow();
            config.useLogger(fake);
            config.usePersistence(persistence);
            const host = config.getHost();
            await host.start();

            await host.publishEvent("evt", "key1", {}, new Date());
            await host.stop();
        });

        it("records an Info entry with eventName and eventKey in context", () => {
            const hit = fake.records.some(r =>
                r.context?.["eventName"] === "evt" &&
                r.context?.["eventKey"]  === "key1" &&
                r.level === LogLevel.Info
            );
            expect(hit).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Suite 4: useConsoleLogger convenience setter
    // -----------------------------------------------------------------------
    describe("useConsoleLogger convenience setter", () => {
        it("binds a ConsoleLogger at the given minimum level", () => {
            // Should not throw and the returned config compiles.
            const config = configureWorkflow();
            expect(() => config.useConsoleLogger(LogLevel.Warn)).not.toThrow();
        });
    });
});
