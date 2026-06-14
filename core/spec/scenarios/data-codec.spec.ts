import { WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, configureWorkflow, DEFAULT_TENANT } from "../../src";
import { IDataCodec, DataCodecContext } from "../../src/abstractions";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { DataCodecRunner } from "../../src/services/data-codec-runner";
import { spinWait } from "../helpers/spin-wait";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

/**
 * H6 — a fake reversible codec (NO real crypto). Returns a distinct envelope object so a test
 * can assert the persisted value is transformed, and decode is verifiably the inverse.
 */
class FakeReversibleCodec implements IDataCodec {
    public async encode(value: any, _ctx: DataCodecContext): Promise<any> {
        if (value === undefined || value === null) return value;
        return { __fake_enc: true, payload: Buffer.from(JSON.stringify(value)).toString("base64") };
    }
    public async decode(value: any, _ctx: DataCodecContext): Promise<any> {
        if (value && value.__fake_enc) return JSON.parse(Buffer.from(value.payload, "base64").toString("utf8"));
        return value; // tolerate legacy plaintext
    }
}

class ThrowingEncodeCodec implements IDataCodec {
    public async encode(_value: any, _ctx: DataCodecContext): Promise<any> {
        throw new Error("encode boom");
    }
    public async decode(value: any, _ctx: DataCodecContext): Promise<any> {
        return value;
    }
}

class SetSecretStep extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> {
        (context.workflow.data as any).secret = "topsecret";
        return ExecutionResult.next();
    }
}

class SecretWorkflow implements WorkflowBase<any> {
    public id: string = "data-codec-secret-workflow";
    public version: number = 1;
    public build(builder: WorkflowBuilder<any>) {
        builder.startWith(SetSecretStep);
    }
}

class WaitStep extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> {
        return ExecutionResult.next();
    }
}

class WaitWorkflow implements WorkflowBase<any> {
    public id: string = "data-codec-wait-workflow";
    public version: number = 1;
    public build(builder: WorkflowBuilder<any>) {
        builder
            .startWith(WaitStep)
            .waitFor("dc-event", () => "0")
            .output((step, data) => data.token = step.eventData ? step.eventData.token : undefined);
    }
}

describe("H6 at-rest data codec", () => {

    describe("persisted instance.data is transformed at rest (failing-test-first)", () => {
        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow();
        config.usePersistence(persistence);
        config.useDataCodec(new FakeReversibleCodec());
        let host = config.getHost();
        let workflowId: string;

        beforeAll(async () => {
            host.registerWorkflow(SecretWorkflow);
            await host.start();
            workflowId = await host.startWorkflow("data-codec-secret-workflow", 1, {});
            await spinWait(async () => {
                let i = await persistence.getWorkflowInstance(workflowId);
                return i && i.status !== WorkflowStatus.Runnable;
            });
        });

        afterAll(async () => { await host.stop(); });

        it("stores an envelope, not the plaintext object", async () => {
            // Reach into the live store: provider read returns the stored (encoded) value.
            const stored = await persistence.getWorkflowInstance(workflowId);
            expect(stored.data.__fake_enc).toBe(true);
            expect(stored.data.secret).toBeUndefined();
        });

        it("round-trips to plaintext for callers (decode wrap)", async () => {
            const stored = await persistence.getWorkflowInstance(workflowId);
            const runner = new DataCodecRunner();
            (runner as any).codec = new FakeReversibleCodec();
            await runner.decodeInstance(stored);
            expect(stored.data.secret).toBe("topsecret");
        });

        it("is idempotent across repeated persist/read", async () => {
            const runner = new DataCodecRunner();
            (runner as any).codec = new FakeReversibleCodec();
            for (let n = 0; n < 2; n++) {
                const stored = await persistence.getWorkflowInstance(workflowId);
                await runner.decodeInstance(stored);
                expect(stored.data.secret).toBe("topsecret");
            }
        });
    });

    describe("eventName/eventKey stay plaintext and still wake subscriptions", () => {
        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow();
        config.usePersistence(persistence);
        config.useDataCodec(new FakeReversibleCodec());
        let host = config.getHost();
        let workflowId: string;
        let instance: WorkflowInstance;

        beforeAll(async () => {
            host.registerWorkflow(WaitWorkflow);
            await host.start();
            workflowId = await host.startWorkflow("data-codec-wait-workflow", 1, {});
            await spinWait(async () => {
                let subs = await persistence.getSubscriptions(DEFAULT_TENANT, "dc-event", "0", new Date());
                return subs.length > 0;
            });
            await host.publishEvent("dc-event", "0", { token: "abc" }, new Date());
            await spinWait(async () => {
                instance = await persistence.getWorkflowInstance(workflowId);
                return instance && instance.status !== WorkflowStatus.Runnable;
            });
        });

        afterAll(async () => { await host.stop(); });

        it("matches the subscription by plaintext eventName/eventKey", async () => {
            // getEvents matches on plaintext eventName/eventKey with a codec configured.
            const eventIds = await persistence.getEvents(DEFAULT_TENANT, "dc-event", "0", new Date(Date.now() - 60000));
            expect(eventIds.length).toBeGreaterThan(0);
        });

        it("stores eventName plaintext but eventData encoded", async () => {
            const eventIds = await persistence.getEvents(DEFAULT_TENANT, "dc-event", "0", new Date(Date.now() - 60000));
            const evt = await persistence.getEvent(eventIds[0]);
            expect(evt.eventName).toBe("dc-event");
            expect(evt.eventData.__fake_enc).toBe(true);
        });

        it("resumes and the step sees decoded eventData", async () => {
            const runner = new DataCodecRunner();
            (runner as any).codec = new FakeReversibleCodec();
            const stored = await persistence.getWorkflowInstance(workflowId);
            await runner.decodeInstance(stored);
            expect(stored.status).toBe(WorkflowStatus.Complete);
            expect(stored.data.token).toBe("abc");
        });
    });

    describe("no-op default leaves data untouched", () => {
        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow();
        config.usePersistence(persistence);
        // NO useDataCodec
        let host = config.getHost();
        let workflowId: string;

        beforeAll(async () => {
            host.registerWorkflow(SecretWorkflow);
            await host.start();
            workflowId = await host.startWorkflow("data-codec-secret-workflow", 1, {});
            await spinWait(async () => {
                let i = await persistence.getWorkflowInstance(workflowId);
                return i && i.status !== WorkflowStatus.Runnable;
            });
        });

        afterAll(async () => { await host.stop(); });

        it("stores the plaintext object", async () => {
            const stored = await persistence.getWorkflowInstance(workflowId);
            expect(stored.data.secret).toBe("topsecret");
            expect(stored.data.__fake_enc).toBeUndefined();
        });
    });

    describe("size guard rejects oversized payload", () => {
        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow();
        config.usePersistence(persistence);
        config.useDataCodec(new FakeReversibleCodec());
        config.useDataCodecSizeLimit(50);
        let host = config.getHost();

        beforeAll(async () => {
            host.registerWorkflow(SecretWorkflow);
            await host.start();
        });

        afterAll(async () => { await host.stop(); });

        it("throws an error containing 'exceeds configured limit'", async () => {
            const big = { blob: "x".repeat(500) };
            let error: any = null;
            try {
                await host.startWorkflow("data-codec-secret-workflow", 1, big);
            }
            catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(String(error.message)).toContain("exceeds configured limit");
        });
    });

    describe("codec failure propagates", () => {
        let persistence = new MemoryPersistenceProvider();
        let config = configureWorkflow();
        config.usePersistence(persistence);
        config.useDataCodec(new ThrowingEncodeCodec());
        let host = config.getHost();

        beforeAll(async () => {
            host.registerWorkflow(SecretWorkflow);
            await host.start();
        });

        afterAll(async () => { await host.stop(); });

        it("surfaces the encode error to startWorkflow", async () => {
            let error: any = null;
            try {
                await host.startWorkflow("data-codec-secret-workflow", 1, {});
            }
            catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(String(error.message)).toContain("encode boom");
        });
    });
});
