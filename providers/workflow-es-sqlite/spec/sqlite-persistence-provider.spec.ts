import "reflect-metadata";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
    IPersistenceProvider,
    WorkflowInstance,
    ExecutionPointer,
    Event,
    EventSubscription,
    WorkflowStatus,
    WorkflowConcurrencyError,
    DEFAULT_TENANT
} from "@reactorynet/workflow-es";
import { SqlitePersistence } from "../src/sqlite-provider";

describe("sqlite-provider conformance", () => {

    let persistence: SqlitePersistence;
    let wf1: WorkflowInstance;
    let ev1: Event;
    let ev2: Event;

    beforeAll(async () => {
        // Use :memory: for fast conformance tests — no disk I/O needed here.
        // The durability/restart test lives in sqlite-restart.spec.ts.
        persistence = new SqlitePersistence(":memory:");
        await persistence.connect;
    });

    afterAll(async () => {
        if (persistence && persistence.sequelize) {
            await persistence.sequelize.close();
        }
    });

    // ── createNewWorkflow ──────────────────────────────────────────────────────

    describe("createNewWorkflow", () => {
        let returnedId: string;

        beforeAll(async () => {
            wf1 = new WorkflowInstance();
            wf1.workflowDefinitionId = "test-workflow";
            wf1.version = 1;
            wf1.status = WorkflowStatus.Runnable;
            wf1.nextExecution = 0;
            wf1.data = { counter: 1 };
            returnedId = await persistence.createNewWorkflow(wf1);
        });

        it("should return a generated id", () => {
            expect(returnedId).toBeDefined();
        });

        it("should update the original object with the id", () => {
            expect(wf1.id).toBeDefined();
            expect(wf1.id).toEqual(returnedId);
        });
    });

    // ── getWorkflowInstance ───────────────────────────────────────────────────

    describe("getWorkflowInstance", () => {
        let wf2: WorkflowInstance;

        beforeAll(async () => {
            wf2 = await persistence.getWorkflowInstance(wf1.id);
        });

        it("should round-trip the persisted fields", () => {
            expect(wf2.id).toEqual(wf1.id);
            expect(wf2.workflowDefinitionId).toEqual("test-workflow");
            expect(wf2.version).toEqual(1);
            expect(wf2.status).toEqual(WorkflowStatus.Runnable);
            expect(wf2.nextExecution).toEqual(0);
            expect(wf2.data).toEqual({ counter: 1 });
        });

        it("should return undefined for an unknown id", async () => {
            const unknown = await persistence.getWorkflowInstance("00000000-0000-0000-0000-000000000000");
            expect(unknown).toBeUndefined();
        });
    });

    // ── persistWorkflow ───────────────────────────────────────────────────────

    describe("persistWorkflow", () => {
        let reloaded: WorkflowInstance;

        beforeAll(async () => {
            const modified: WorkflowInstance = await persistence.getWorkflowInstance(wf1.id);
            modified.nextExecution = 44;
            modified.data = { counter: 2 };

            const pointer = new ExecutionPointer();
            pointer.id = "11111111-1111-4111-8111-111111111111";
            pointer.stepId = 0;
            pointer.active = true;
            pointer.stepName = "Start";
            modified.executionPointers = [pointer];

            await persistence.persistWorkflow(modified);
            reloaded = await persistence.getWorkflowInstance(wf1.id);
        });

        it("should persist scalar changes", () => {
            expect(reloaded.nextExecution).toEqual(44);
            expect(reloaded.data).toEqual({ counter: 2 });
        });

        it("should persist the execution pointer", () => {
            expect(reloaded.executionPointers.length).toEqual(1);
            expect(reloaded.executionPointers[0].id).toEqual("11111111-1111-4111-8111-111111111111");
            expect(reloaded.executionPointers[0].stepName).toEqual("Start");
            expect(reloaded.executionPointers[0].active).toEqual(true);
        });
    });

    // ── pointer replacement ───────────────────────────────────────────────────

    describe("persistWorkflow removes a pointer that is no longer present", () => {
        it("should have exactly 1 pointer after removing one", async () => {
            const wf = new WorkflowInstance();
            wf.workflowDefinitionId = "ptr-replace";
            wf.version = 1;
            wf.status = WorkflowStatus.Runnable;
            wf.nextExecution = 0;
            wf.data = {};
            await persistence.createNewWorkflow(wf);

            // Load and add 2 pointers
            const loaded1 = await persistence.getWorkflowInstance(wf.id);
            const p1 = new ExecutionPointer();
            p1.id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
            p1.stepId = 0; p1.active = true; p1.stepName = "A";
            const p2 = new ExecutionPointer();
            p2.id = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
            p2.stepId = 1; p2.active = false; p2.stepName = "B";
            loaded1.executionPointers = [p1, p2];
            await persistence.persistWorkflow(loaded1);

            // Load and reduce to 1 pointer
            const loaded2 = await persistence.getWorkflowInstance(wf.id);
            loaded2.executionPointers = loaded2.executionPointers.filter(x => x.id === p1.id);
            await persistence.persistWorkflow(loaded2);

            const final = await persistence.getWorkflowInstance(wf.id);
            expect(final.executionPointers.length).toEqual(1);
            expect(final.executionPointers[0].id).toEqual(p1.id);
        });
    });

    // ── getRunnableInstances ──────────────────────────────────────────────────

    describe("getRunnableInstances", () => {
        it("should contain the runnable workflow", async () => {
            const runnable = await persistence.getRunnableInstances();
            expect(runnable).toContain(wf1.id);
        });

        it("should respect status and nextExecution — not return a future-scheduled instance", async () => {
            const wf = new WorkflowInstance();
            wf.workflowDefinitionId = "future-workflow";
            wf.version = 1;
            wf.status = WorkflowStatus.Runnable;
            wf.nextExecution = Date.now() + 60_000; // 1 minute in the future
            wf.data = {};
            await persistence.createNewWorkflow(wf);

            const runnable = await persistence.getRunnableInstances();
            expect(runnable).not.toContain(wf.id);
        });
    });

    // ── event subscriptions ───────────────────────────────────────────────────

    describe("event subscriptions", () => {
        let sub: EventSubscription;

        beforeAll(async () => {
            sub = new EventSubscription();
            sub.workflowId = wf1.id;
            sub.stepId = 0;
            sub.eventName = "test-event";
            sub.eventKey = "key-1";
            sub.subscribeAsOf = new Date(0);
            await persistence.createEventSubscription(sub);
        });

        it("should assign an id", () => {
            expect(sub.id).toBeDefined();
        });

        it("should be retrievable by name/key/asOf", async () => {
            const found = await persistence.getSubscriptions(DEFAULT_TENANT, "test-event", "key-1", new Date());
            expect(found.map((s) => s.id)).toContain(sub.id);
        });

        it("should be removable", async () => {
            await persistence.terminateSubscription(sub.id);
            const found = await persistence.getSubscriptions(DEFAULT_TENANT, "test-event", "key-1", new Date());
            expect(found.map((s) => s.id)).not.toContain(sub.id);
        });

        it("terminateSubscription on unknown id is a no-op", async () => {
            await expectAsync(
                persistence.terminateSubscription("00000000-0000-0000-0000-000000000000")
            ).toBeResolved();
        });
    });

    // ── createEvent ───────────────────────────────────────────────────────────

    describe("createEvent (unprocessed)", () => {
        let returnedId: string;

        beforeAll(async () => {
            ev1 = new Event();
            ev1.eventName = "test-event";
            ev1.eventKey = "1";
            ev1.eventData = null;
            ev1.eventTime = new Date();
            ev1.isProcessed = false;
            returnedId = await persistence.createEvent(ev1);
        });

        it("should return a generated id", () => {
            expect(returnedId).toBeDefined();
            expect(ev1.id).toEqual(returnedId);
        });
    });

    describe("createEvent (processed)", () => {
        beforeAll(async () => {
            ev2 = new Event();
            ev2.eventName = "test-event";
            ev2.eventKey = "1";
            ev2.eventData = null;
            ev2.eventTime = new Date();
            ev2.isProcessed = true;
            await persistence.createEvent(ev2);
        });

        it("should return a generated id", () => {
            expect(ev2.id).toBeDefined();
        });
    });

    // ── getRunnableEvents ─────────────────────────────────────────────────────

    describe("getRunnableEvents", () => {
        it("should contain the unprocessed event", async () => {
            const events = await persistence.getRunnableEvents();
            expect(events).toContain(ev1.id);
        });

        it("should not contain the processed event", async () => {
            const events = await persistence.getRunnableEvents();
            expect(events).not.toContain(ev2.id);
        });
    });

    // ── markEventProcessed / markEventUnprocessed ─────────────────────────────

    describe("markEventProcessed", () => {
        it("should mark the event processed", async () => {
            await persistence.markEventProcessed(ev1.id);
            const event = await persistence.getEvent(ev1.id);
            expect(event.isProcessed).toEqual(true);
        });
    });

    describe("markEventUnprocessed", () => {
        it("should mark the event unprocessed", async () => {
            await persistence.markEventUnprocessed(ev2.id);
            const event = await persistence.getEvent(ev2.id);
            expect(event.isProcessed).toEqual(false);
        });
    });

    it("markEventProcessed on unknown id is a no-op", async () => {
        await expectAsync(
            persistence.markEventProcessed("00000000-0000-0000-0000-000000000000")
        ).toBeResolved();
    });

    // ── JSON fidelity ─────────────────────────────────────────────────────────

    describe("JSON fields round-trip nested structures", () => {
        it("should round-trip complex data", async () => {
            const nested = { a: [1, { b: null }], c: "x" };
            const wf = new WorkflowInstance();
            wf.workflowDefinitionId = "json-test";
            wf.version = 1;
            wf.status = WorkflowStatus.Runnable;
            wf.nextExecution = 0;
            wf.data = nested;
            await persistence.createNewWorkflow(wf);

            const loaded = await persistence.getWorkflowInstance(wf.id);
            expect(loaded.data).toEqual(nested);
        });
    });

    // ── Optimistic concurrency (C1) ───────────────────────────────────────────

    describe("optimistic concurrency", () => {

        async function newWorkflow(): Promise<WorkflowInstance> {
            const wf = new WorkflowInstance();
            wf.workflowDefinitionId = "cas-workflow";
            wf.version = 1;
            wf.status = WorkflowStatus.Runnable;
            wf.nextExecution = 0;
            wf.data = { n: 0 };
            await persistence.createNewWorkflow(wf);
            return wf;
        }

        it("seeds the concurrency token to 0", async () => {
            const wf = await newWorkflow();
            expect(wf.concurrencyToken).toEqual(0);
            const stored = await persistence.getWorkflowInstance(wf.id);
            expect(stored.concurrencyToken).toEqual(0);
        });

        it("increments the token on each successful persist", async () => {
            const wf = await newWorkflow();
            await persistence.persistWorkflow(wf);
            expect(wf.concurrencyToken).toEqual(1);
            await persistence.persistWorkflow(wf);
            expect(wf.concurrencyToken).toEqual(2);
            const stored = await persistence.getWorkflowInstance(wf.id);
            expect(stored.concurrencyToken).toEqual(2);
        });

        it("persistWorkflow with a stale concurrency token throws and writes nothing", async () => {
            const wf = await newWorkflow();
            const a = await persistence.getWorkflowInstance(wf.id);
            const b = await persistence.getWorkflowInstance(wf.id);

            // First writer wins
            a.data = { winner: "a" };
            await persistence.persistWorkflow(a);
            expect(a.concurrencyToken).toEqual(1);

            // Second writer has stale token — must fail
            b.data = { winner: "b" };
            let caught: any = null;
            try {
                await persistence.persistWorkflow(b);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof WorkflowConcurrencyError).toBe(true);
            expect(caught.workflowId).toEqual(wf.id);
            expect(caught.expectedToken).toEqual(0);

            // State must reflect copy-a, not copy-b
            const stored = await persistence.getWorkflowInstance(wf.id);
            expect(stored.concurrencyToken).toEqual(1);
            expect(stored.data).toEqual({ winner: "a" });
        });
    });

    // ── Durable round-trip across a fresh provider instance ───────────────────

    describe("durable round-trip across a fresh provider instance", () => {
        const dbFile = path.join(os.tmpdir(), `wf-es-sqlite-roundtrip-${Date.now()}.db`);
        let persistence2: SqlitePersistence;
        let wfId: string;
        let evId: string;
        let subId: string;

        beforeAll(async () => {
            // Write via first provider instance
            persistence2 = new SqlitePersistence(dbFile);
            await persistence2.connect;

            const wf = new WorkflowInstance();
            wf.workflowDefinitionId = "durable-wf";
            wf.version = 2;
            wf.status = WorkflowStatus.Runnable;
            wf.nextExecution = 0;
            wf.data = { value: "persisted" };
            wfId = await persistence2.createNewWorkflow(wf);

            const ev = new Event();
            ev.eventName = "durable-event";
            ev.eventKey = "dk";
            ev.eventData = { payload: 42 };
            ev.eventTime = new Date(0);
            ev.isProcessed = false;
            evId = await persistence2.createEvent(ev);

            const sub = new EventSubscription();
            sub.workflowId = wfId;
            sub.stepId = 0;
            sub.eventName = "durable-event";
            sub.eventKey = "dk";
            sub.subscribeAsOf = new Date(0);
            await persistence2.createEventSubscription(sub);
            subId = sub.id;

            // Close (simulating process exit)
            await persistence2.sequelize.close();
        });

        afterAll(async () => {
            try { fs.unlinkSync(dbFile); } catch (_) {}
            try { fs.unlinkSync(dbFile + "-wal"); } catch (_) {}
            try { fs.unlinkSync(dbFile + "-shm"); } catch (_) {}
        });

        it("reads back the workflow from a new provider instance", async () => {
            const fresh = new SqlitePersistence(dbFile);
            await fresh.connect;
            try {
                const loaded = await fresh.getWorkflowInstance(wfId);
                expect(loaded).toBeDefined();
                expect(loaded.workflowDefinitionId).toEqual("durable-wf");
                expect(loaded.data).toEqual({ value: "persisted" });
            } finally {
                await fresh.sequelize.close();
            }
        });

        it("reads back the event from a new provider instance", async () => {
            const fresh = new SqlitePersistence(dbFile);
            await fresh.connect;
            try {
                const loaded = await fresh.getEvent(evId);
                expect(loaded).toBeDefined();
                expect(loaded.eventName).toEqual("durable-event");
                expect(loaded.eventData).toEqual({ payload: 42 });
            } finally {
                await fresh.sequelize.close();
            }
        });

        it("reads back the subscription from a new provider instance", async () => {
            const fresh = new SqlitePersistence(dbFile);
            await fresh.connect;
            try {
                const subs = await fresh.getSubscriptions(DEFAULT_TENANT, "durable-event", "dk", new Date());
                expect(subs.map(s => s.id)).toContain(subId);
            } finally {
                await fresh.sequelize.close();
            }
        });
    });
});
