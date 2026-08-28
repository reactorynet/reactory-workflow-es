import { WorkflowHost, WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, configureWorkflow, ConsoleLogger, DEFAULT_TENANT } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

describe("multi-tenancy (M6)", () => {

    class TenantStep1 extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class TenantData {
        public myValue: string;
    }

    class TenantWorkflow implements WorkflowBase<TenantData> {
        public id: string = "tenant-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<TenantData>) {
            builder
                .startWith(TenantStep1)
                .waitFor("tenant-event", data => "shared-key")   // SAME key for both tenants
                    .output((step, data) => data.myValue = step.eventData);
        }
    }

    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.useLogger(new ConsoleLogger());
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;

    let idA: string;
    let idB: string;
    let instanceA: WorkflowInstance;
    let instanceB: WorkflowInstance;
    let subTenant: string;

    beforeAll(async () => {
        host.registerWorkflow(TenantWorkflow);
        await host.start();

        idA = await host.startWorkflow("tenant-workflow", "1.0.0", {}, "A");
        idB = await host.startWorkflow("tenant-workflow", "1.0.0", {}, "B");

        // Wait until BOTH tenants have an active subscription on the same (name, key).
        await spinWait(async () => {
            const subsA = await persistence.getSubscriptions("A", "tenant-event", "shared-key", new Date());
            const subsB = await persistence.getSubscriptions("B", "tenant-event", "shared-key", new Date());
            return subsA.length > 0 && subsB.length > 0;
        });

        // Capture the tenant the subscription inherited (proves §6.2).
        const subsA = await persistence.getSubscriptions("A", "tenant-event", "shared-key", new Date());
        subTenant = subsA[0].tenantId;

        // Publish an event for tenant A only.
        await host.publishEvent("tenant-event", "shared-key", "for-A", new Date(), "A");

        // Wait for tenant A's instance to leave Runnable.
        await spinWait(async () => {
            instanceA = await persistence.getWorkflowInstance(idA);
            return instanceA.status !== WorkflowStatus.Runnable;
        });

        instanceB = await persistence.getWorkflowInstance(idB);
    });

    afterAll(async () => {
        await host.stop();
    });

    // ── Headline failing-first test (§6.5) ───────────────────────────────────

    it("event published for tenant A must not wake tenant B", () => {
        expect(instanceA.status).toBe(WorkflowStatus.Complete);
        expect(instanceA.data.myValue).toBe("for-A");

        // Tenant B is still waiting and never saw tenant A's data.
        expect(instanceB.status).toBe(WorkflowStatus.Runnable);
        expect(instanceB.data.myValue).toBeUndefined();
    });

    // ── §6.2 tenant stamped through ──────────────────────────────────────────

    it("workflow inherits the tenant it was started with", async () => {
        expect(subTenant).toBe("A");
        const reloadedA = await persistence.getWorkflowInstance(idA);
        expect(reloadedA.tenantId).toBe("A");
    });

    // ── §6.5/§6.9 symmetric isolation: B wakes on its own event ──────────────

    it("tenant B woken by its own event", async () => {
        await host.publishEvent("tenant-event", "shared-key", "for-B", new Date(), "B");

        await spinWait(async () => {
            instanceB = await persistence.getWorkflowInstance(idB);
            return instanceB.status !== WorkflowStatus.Runnable;
        });

        expect(instanceB.status).toBe(WorkflowStatus.Complete);
        expect(instanceB.data.myValue).toBe("for-B");
    });
});

describe("multi-tenancy (M6) default-tenant regression", () => {

    class Step1 extends StepBody {
        public run(context: StepExecutionContext): Promise<ExecutionResult> {
            return ExecutionResult.next();
        }
    }

    class MyDataClass {
        public myValue: string;
    }

    class Event_Workflow implements WorkflowBase<MyDataClass> {
        public id: string = "default-tenant-workflow";
        public version: string = "1.0.0";

        public build(builder: WorkflowBuilder<MyDataClass>) {
            builder
                .startWith(Step1)
                .waitFor("my-event", data => "0")
                    .output((step, data) => data.myValue = step.eventData);
        }
    }

    let workflowId: string;
    let instance: WorkflowInstance;
    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.useLogger(new ConsoleLogger());
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;

    beforeAll(async () => {
        host.registerWorkflow(Event_Workflow);
        await host.start();

        // Zero-arg-style call: NO tenantId — must behave exactly as before.
        workflowId = await host.startWorkflow("default-tenant-workflow", "1.0.0", { value1: 2, value2: 3 });

        await spinWait(async () => {
            const subs = await persistence.getSubscriptions(DEFAULT_TENANT, "my-event", "0", new Date());
            return subs.length > 0;
        });

        // 4-arg publishEvent (no tenantId).
        await host.publishEvent("my-event", "0", "Pass", new Date());

        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return instance.status !== WorkflowStatus.Runnable;
        });
    });

    afterAll(async () => {
        await host.stop();
    });

    it("completes with 'Pass' under the default tenant", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
        expect(instance.data.myValue).toBe("Pass");
    });

    it("instance.tenantId is the default sentinel", () => {
        expect(instance.tenantId).toBe(DEFAULT_TENANT);
    });
});
