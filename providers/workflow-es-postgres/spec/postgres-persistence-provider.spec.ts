import { IPersistenceProvider, WorkflowInstance, ExecutionPointer, Event, EventSubscription, WorkflowStatus } from "@reactorynet/workflow-es";
import { PostgresPersistence } from "../src/postgres-provider";

// Override with WORKFLOW_ES_PG_TEST_URL to point at a different instance.
// Defaults match the Reactory develop docker-compose Postgres service.
const PG_TEST_URL = process.env.WORKFLOW_ES_PG_TEST_URL
    || "postgres://reactory:reactory@127.0.0.1:5432/reactory";

describe("postgres-provider", () => {

    let persistence: IPersistenceProvider;
    let wf1: WorkflowInstance;
    let ev1: Event;
    let ev2: Event;

    beforeAll(async () => {
        const provider = new PostgresPersistence(PG_TEST_URL);
        await provider.connect;
        // Start from a clean schema so the suite is repeatable against a
        // persistent test database.
        await provider.sequelize.sync({ force: true });
        persistence = provider;
    });

    describe("createNewWorkflow", () => {
        let returnedId: string;

        beforeEach(async () => {
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

    describe("getWorkflowInstance", () => {
        let wf2: WorkflowInstance;

        beforeEach(async () => {
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
    });

    describe("persistWorkflow", () => {
        let reloaded: WorkflowInstance;

        beforeEach(async () => {
            const modified: WorkflowInstance = await persistence.getWorkflowInstance(wf1.id);
            modified.nextExecution = 44;
            modified.data = { counter: 2 };

            const pointer = new ExecutionPointer();
            pointer.id = "11111111-1111-4111-8111-111111111111";
            pointer.stepId = 0;
            pointer.active = true;
            pointer.stepName = "Start";
            // Replace (not append) so the test is idempotent across beforeEach runs.
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

    describe("getRunnableInstances", () => {
        it("should contain the runnable workflow", async () => {
            const runnable = await persistence.getRunnableInstances();
            expect(runnable).toContain(wf1.id);
        });
    });

    describe("event subscriptions", () => {
        let sub: EventSubscription;

        beforeEach(async () => {
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
            const found = await persistence.getSubscriptions("test-event", "key-1", new Date());
            expect(found.map((s) => s.id)).toContain(sub.id);
        });

        it("should be removable", async () => {
            await persistence.terminateSubscription(sub.id);
            const found = await persistence.getSubscriptions("test-event", "key-1", new Date());
            expect(found.map((s) => s.id)).not.toContain(sub.id);
        });
    });

    describe("createEvent (unprocessed)", () => {
        let returnedId: string;

        beforeEach(async () => {
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
        beforeEach(async () => {
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
});
