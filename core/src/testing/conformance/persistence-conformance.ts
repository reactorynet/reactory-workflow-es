/**
 * Shared persistence provider conformance suite — M8.
 *
 * Call `runPersistenceProviderConformanceTests(options)` at the TOP LEVEL of a
 * Jasmine spec file (not inside a describe) to register the full
 * IPersistenceProvider conformance suite for any provider.
 *
 * The suite depends ONLY on Jasmine ambient globals (describe / it / expect /
 * beforeAll / beforeEach / afterAll). Do NOT import jasmine as a value.
 *
 * Covers:
 *   §6.1  Create round-trip
 *   §6.2  Persist scalars
 *   §6.3  Persist execution pointers (replace semantics)
 *   §6.4  Runnable instances
 *   §6.5  Create subscription
 *   §6.6  Get subscriptions by name/key/asOf
 *   §6.7  Terminate subscription
 *   §6.8  Create + get event
 *   §6.9  Runnable events
 *   §6.10 Mark processed / unprocessed
 *   §6.11 getEvents by name/key/asOf
 *   §6.12 Missing reads
 *   §6.13 Concurrency token round-trip (C1) — happy path + conflict rejection
 */

import { IPersistenceProvider } from "../../abstractions/persistence-provider";
import { WorkflowInstance } from "../../models/workflow-instance";
import { ExecutionPointer, PointerStatus } from "../../models/execution-pointer";
import { EventSubscription } from "../../models/event-subscription";
import { Event } from "../../models/event";
import { WorkflowStatus } from "../../models/workflow-status";
import { WorkflowConcurrencyError } from "../../abstractions/errors";
import { DEFAULT_TENANT } from "../../abstractions/types";

export interface PersistenceConformanceOptions {
    /**
     * Human-readable provider name used as the root describe() label,
     * e.g. "postgres" or "sqlite".
     */
    providerName: string;

    /**
     * Construct (or return) a connected IPersistenceProvider ready for use.
     * Called once in beforeAll. Implementations should await any internal
     * connect promise before resolving.
     */
    createProvider: () => Promise<IPersistenceProvider>;

    /**
     * Reset the backing store to an empty, known-good schema. Called once in
     * beforeAll after createProvider, and MUST be safe to call on a populated DB.
     * For SQL: sequelize.sync({ force: true }); for Mongo: drop collections.
     */
    reset: (provider: IPersistenceProvider) => Promise<void>;

    /**
     * Optional teardown (close connections / pools). Called in afterAll.
     */
    dispose?: (provider: IPersistenceProvider) => Promise<void>;
}

/**
 * Registers the full IPersistenceProvider conformance test suite as Jasmine
 * describe/it blocks. MUST be called at module top level (not inside another
 * describe), exactly as a normal Jasmine spec file would call describe().
 */
export function runPersistenceProviderConformanceTests(options: PersistenceConformanceOptions): void {

    describe(`${options.providerName} persistence conformance`, () => {

        let provider: IPersistenceProvider;

        // ── Setup / teardown ──────────────────────────────────────────────────

        beforeAll(async () => {
            provider = await options.createProvider();
            await options.reset(provider);
        });

        afterAll(async () => {
            if (options.dispose) {
                await options.dispose(provider);
            }
        });

        // ── §6.1 Create round-trip ────────────────────────────────────────────

        describe("§6.1 creates and round-trips a workflow", () => {
            let instance: WorkflowInstance;
            let returnedId: string;

            beforeAll(async () => {
                instance = new WorkflowInstance();
                instance.workflowDefinitionId = "conf-wf-1";
                instance.version = 1;
                instance.status = WorkflowStatus.Runnable;
                instance.nextExecution = 0;
                instance.data = { step: "init" };
                returnedId = await provider.createNewWorkflow(instance);
            });

            it("returns a defined id", () => {
                expect(returnedId).toBeDefined();
                expect(typeof returnedId).toBe("string");
            });

            it("sets instance.id to the returned id", () => {
                expect(instance.id).toEqual(returnedId);
            });

            it("round-trips workflowDefinitionId, version, status, nextExecution, and data", async () => {
                const loaded = await provider.getWorkflowInstance(returnedId);
                expect(loaded).toBeDefined();
                expect(loaded.workflowDefinitionId).toEqual("conf-wf-1");
                expect(loaded.version).toEqual(1);
                expect(loaded.status).toEqual(WorkflowStatus.Runnable);
                expect(loaded.nextExecution).toEqual(0);
                expect(loaded.data).toEqual({ step: "init" });
            });
        });

        // ── §6.2 Persist scalars ──────────────────────────────────────────────

        describe("§6.2 persists scalar changes", () => {
            let wfId: string;

            beforeAll(async () => {
                const wf = new WorkflowInstance();
                wf.workflowDefinitionId = "conf-wf-scalars";
                wf.version = 1;
                wf.status = WorkflowStatus.Runnable;
                wf.nextExecution = 0;
                wf.data = { v: 1 };
                await provider.createNewWorkflow(wf);
                wfId = wf.id;

                const loaded = await provider.getWorkflowInstance(wfId);
                loaded.nextExecution = 99;
                loaded.data = { v: 2 };
                await provider.persistWorkflow(loaded);
            });

            it("reflects mutated nextExecution after reload", async () => {
                const reloaded = await provider.getWorkflowInstance(wfId);
                expect(reloaded.nextExecution).toEqual(99);
            });

            it("reflects mutated data after reload", async () => {
                const reloaded = await provider.getWorkflowInstance(wfId);
                expect(reloaded.data).toEqual({ v: 2 });
            });
        });

        // ── §6.3 Persist execution pointers (replace semantics) ───────────────

        describe("§6.3 persists execution pointers with replace semantics", () => {
            let wfId: string;

            beforeAll(async () => {
                const wf = new WorkflowInstance();
                wf.workflowDefinitionId = "conf-wf-ptrs";
                wf.version = 1;
                wf.status = WorkflowStatus.Runnable;
                wf.nextExecution = 0;
                wf.data = {};
                await provider.createNewWorkflow(wf);
                wfId = wf.id;

                // Write with two pointers, then replace with just one
                const load1 = await provider.getWorkflowInstance(wfId);
                const pA = new ExecutionPointer();
                pA.id = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
                pA.stepId = 0; pA.active = true; pA.stepName = "A";
                const pB = new ExecutionPointer();
                pB.id = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
                pB.stepId = 1; pB.active = false; pB.stepName = "B";
                load1.executionPointers = [pA, pB];
                await provider.persistWorkflow(load1);

                // Now replace with only pA to test remove semantics
                const load2 = await provider.getWorkflowInstance(wfId);
                load2.executionPointers = load2.executionPointers.filter(p => p.id === pA.id);
                await provider.persistWorkflow(load2);
            });

            it("round-trips pointer id, stepId, stepName, and active", async () => {
                const loaded = await provider.getWorkflowInstance(wfId);
                expect(loaded.executionPointers.length).toEqual(1);
                expect(loaded.executionPointers[0].id).toEqual("cccccccc-cccc-4ccc-cccc-cccccccccccc");
                expect(loaded.executionPointers[0].stepName).toEqual("A");
                expect(loaded.executionPointers[0].active).toEqual(true);
            });

            it("removed pointer is no longer present (replace, not append)", async () => {
                const loaded = await provider.getWorkflowInstance(wfId);
                const ids = loaded.executionPointers.map(p => p.id);
                expect(ids).not.toContain("dddddddd-dddd-4ddd-dddd-dddddddddddd");
            });
        });

        // ── §6.4 Runnable instances ───────────────────────────────────────────

        describe("§6.4 runnable instances", () => {
            let runnableId: string;
            let futureId: string;
            let completeId: string;

            beforeAll(async () => {
                // Runnable with past nextExecution
                const runnable = new WorkflowInstance();
                runnable.workflowDefinitionId = "conf-runnable";
                runnable.version = 1;
                runnable.status = WorkflowStatus.Runnable;
                runnable.nextExecution = 0; // epoch — definitely in the past
                runnable.data = {};
                await provider.createNewWorkflow(runnable);
                runnableId = runnable.id;

                // Runnable but future nextExecution — should NOT appear
                const future = new WorkflowInstance();
                future.workflowDefinitionId = "conf-future";
                future.version = 1;
                future.status = WorkflowStatus.Runnable;
                future.nextExecution = Date.now() + 60_000;
                future.data = {};
                await provider.createNewWorkflow(future);
                futureId = future.id;

                // Complete — should NOT appear
                const complete = new WorkflowInstance();
                complete.workflowDefinitionId = "conf-complete";
                complete.version = 1;
                complete.status = WorkflowStatus.Complete;
                complete.nextExecution = 0;
                complete.data = {};
                await provider.createNewWorkflow(complete);
                completeId = complete.id;
            });

            it("includes Runnable instances with nextExecution in the past", async () => {
                const ids = await provider.getRunnableInstances();
                expect(ids).toContain(runnableId);
            });

            it("excludes Runnable instances with nextExecution in the future", async () => {
                const ids = await provider.getRunnableInstances();
                expect(ids).not.toContain(futureId);
            });

            it("excludes Complete instances", async () => {
                const ids = await provider.getRunnableInstances();
                expect(ids).not.toContain(completeId);
            });
        });

        // ── §6.5–6.7 Subscriptions ────────────────────────────────────────────

        describe("§6.5–6.7 event subscriptions", () => {
            let sub: EventSubscription;
            let wfBase: WorkflowInstance;

            beforeAll(async () => {
                wfBase = new WorkflowInstance();
                wfBase.workflowDefinitionId = "conf-sub-base";
                wfBase.version = 1;
                wfBase.status = WorkflowStatus.Runnable;
                wfBase.nextExecution = 0;
                wfBase.data = {};
                await provider.createNewWorkflow(wfBase);

                sub = new EventSubscription();
                sub.workflowId = wfBase.id;
                sub.stepId = 0;
                sub.eventName = "conf-event";
                sub.eventKey = "conf-key";
                sub.subscribeAsOf = new Date(0);
                await provider.createEventSubscription(sub);
            });

            it("§6.5 assigns sub.id after createEventSubscription", () => {
                expect(sub.id).toBeDefined();
            });

            it("§6.6 getSubscriptions returns sub for matching name/key with asOf <= subscribeAsOf", async () => {
                const found = await provider.getSubscriptions(DEFAULT_TENANT, "conf-event", "conf-key", new Date());
                expect(found.map(s => s.id)).toContain(sub.id);
            });

            it("§6.6 getSubscriptions excludes subs with non-matching eventName", async () => {
                const found = await provider.getSubscriptions(DEFAULT_TENANT, "other-event", "conf-key", new Date());
                expect(found.map(s => s.id)).not.toContain(sub.id);
            });

            it("§6.6 getSubscriptions excludes subs with non-matching eventKey", async () => {
                const found = await provider.getSubscriptions(DEFAULT_TENANT, "conf-event", "other-key", new Date());
                expect(found.map(s => s.id)).not.toContain(sub.id);
            });

            it("§6.7 terminateSubscription removes the sub from future queries", async () => {
                await provider.terminateSubscription(sub.id);
                const found = await provider.getSubscriptions(DEFAULT_TENANT, "conf-event", "conf-key", new Date());
                expect(found.map(s => s.id)).not.toContain(sub.id);
            });
        });

        // ── §6.8 Create + get event ───────────────────────────────────────────

        describe("§6.8 creates and round-trips an event", () => {
            let ev: Event;
            let returnedId: string;

            beforeAll(async () => {
                ev = new Event();
                ev.eventName = "conf-ev-name";
                ev.eventKey = "conf-ev-key";
                ev.eventData = { payload: 42 };
                ev.eventTime = new Date(1000); // a fixed past time
                ev.isProcessed = false;
                returnedId = await provider.createEvent(ev);
            });

            it("returns a defined id and sets ev.id", () => {
                expect(returnedId).toBeDefined();
                expect(ev.id).toEqual(returnedId);
            });

            it("round-trips eventName, eventKey, eventData, eventTime, isProcessed", async () => {
                const loaded = await provider.getEvent(returnedId);
                expect(loaded).toBeDefined();
                expect(loaded.eventName).toEqual("conf-ev-name");
                expect(loaded.eventKey).toEqual("conf-ev-key");
                expect(loaded.eventData).toEqual({ payload: 42 });
                expect(loaded.isProcessed).toEqual(false);
            });
        });

        // ── §6.9 Runnable events ──────────────────────────────────────────────

        describe("§6.9 runnable events", () => {
            let unprocessedId: string;
            let processedId: string;

            beforeAll(async () => {
                const unprocessed = new Event();
                unprocessed.eventName = "conf-runnable-ev";
                unprocessed.eventKey = "k";
                unprocessed.eventData = null;
                unprocessed.eventTime = new Date(0); // definitely in the past
                unprocessed.isProcessed = false;
                unprocessedId = await provider.createEvent(unprocessed);

                const processed = new Event();
                processed.eventName = "conf-processed-ev";
                processed.eventKey = "k";
                processed.eventData = null;
                processed.eventTime = new Date(0);
                processed.isProcessed = true;
                processedId = await provider.createEvent(processed);
            });

            it("includes unprocessed events with eventTime in the past", async () => {
                const ids = await provider.getRunnableEvents();
                expect(ids).toContain(unprocessedId);
            });

            it("excludes already-processed events", async () => {
                const ids = await provider.getRunnableEvents();
                expect(ids).not.toContain(processedId);
            });
        });

        // ── §6.10 Mark processed / unprocessed ───────────────────────────────

        describe("§6.10 marks events processed and unprocessed", () => {
            let evId: string;

            beforeAll(async () => {
                const ev = new Event();
                ev.eventName = "conf-mark-ev";
                ev.eventKey = "m";
                ev.eventData = null;
                ev.eventTime = new Date(0);
                ev.isProcessed = false;
                evId = await provider.createEvent(ev);
            });

            it("markEventProcessed → isProcessed === true", async () => {
                await provider.markEventProcessed(evId);
                const loaded = await provider.getEvent(evId);
                expect(loaded.isProcessed).toEqual(true);
            });

            it("markEventUnprocessed → isProcessed === false", async () => {
                await provider.markEventUnprocessed(evId);
                const loaded = await provider.getEvent(evId);
                expect(loaded.isProcessed).toEqual(false);
            });
        });

        // ── §6.11 getEvents by name/key/asOf ─────────────────────────────────

        describe("§6.11 getEvents filters by name/key/asOf", () => {
            let evId: string;
            const evTime = new Date(5000);

            beforeAll(async () => {
                const ev = new Event();
                ev.eventName = "conf-filter-ev";
                ev.eventKey = "fk";
                ev.eventData = null;
                ev.eventTime = evTime;
                ev.isProcessed = false;
                evId = await provider.createEvent(ev);
            });

            it("returns the id for matching name/key with asOf <= eventTime", async () => {
                const ids = await provider.getEvents(DEFAULT_TENANT, "conf-filter-ev", "fk", new Date(0));
                expect(ids).toContain(evId);
            });

            it("excludes events whose eventTime is before asOf", async () => {
                const ids = await provider.getEvents(DEFAULT_TENANT, "conf-filter-ev", "fk", new Date(evTime.getTime() + 1));
                expect(ids).not.toContain(evId);
            });

            it("excludes events with non-matching eventName", async () => {
                const ids = await provider.getEvents(DEFAULT_TENANT, "other-name", "fk", new Date(0));
                expect(ids).not.toContain(evId);
            });

            it("excludes events with non-matching eventKey", async () => {
                const ids = await provider.getEvents(DEFAULT_TENANT, "conf-filter-ev", "other-key", new Date(0));
                expect(ids).not.toContain(evId);
            });
        });

        // ── §6.12 Missing reads ───────────────────────────────────────────────

        describe("§6.12 returns undefined for unknown ids", () => {
            const unknownId = "00000000-0000-0000-0000-000000000000";

            it("getWorkflowInstance(unknownId) resolves to undefined, not throw", async () => {
                const result = await provider.getWorkflowInstance(unknownId);
                expect(result).toBeUndefined();
            });

            it("getEvent(unknownId) resolves to undefined, not throw", async () => {
                const result = await provider.getEvent(unknownId);
                expect(result).toBeUndefined();
            });
        });

        // ── §6.13 Concurrency token round-trip (C1) ───────────────────────────

        describe("§6.13 concurrency token (C1)", () => {

            async function makeWorkflow(): Promise<WorkflowInstance> {
                const wf = new WorkflowInstance();
                wf.workflowDefinitionId = "conf-cas";
                wf.version = 1;
                wf.status = WorkflowStatus.Runnable;
                wf.nextExecution = 0;
                wf.data = { n: 0 };
                await provider.createNewWorkflow(wf);
                return wf;
            }

            it("createNewWorkflow seeds concurrencyToken to 0 (in-memory)", async () => {
                const wf = await makeWorkflow();
                expect(wf.concurrencyToken).toEqual(0);
            });

            it("createNewWorkflow seeds concurrencyToken to 0 (stored)", async () => {
                const wf = await makeWorkflow();
                const stored = await provider.getWorkflowInstance(wf.id);
                expect(stored.concurrencyToken).toEqual(0);
            });

            it("increments the in-memory token to 1 after first persistWorkflow", async () => {
                const wf = await makeWorkflow();
                await provider.persistWorkflow(wf);
                expect(wf.concurrencyToken).toEqual(1);
            });

            it("increments the stored token to 2 after two successive persists", async () => {
                const wf = await makeWorkflow();
                await provider.persistWorkflow(wf);
                await provider.persistWorkflow(wf);
                expect(wf.concurrencyToken).toEqual(2);
                const stored = await provider.getWorkflowInstance(wf.id);
                expect(stored.concurrencyToken).toEqual(2);
            });

            it("rejects a stale write with WorkflowConcurrencyError", async () => {
                const wf = await makeWorkflow();
                const copyA = await provider.getWorkflowInstance(wf.id);
                const copyB = await provider.getWorkflowInstance(wf.id);

                // First writer wins
                copyA.data = { winner: "a" };
                await provider.persistWorkflow(copyA);
                expect(copyA.concurrencyToken).toEqual(1);

                // Second writer is stale (token still 0)
                copyB.data = { winner: "b" };
                let caught: unknown = null;
                try {
                    await provider.persistWorkflow(copyB);
                } catch (err) {
                    caught = err;
                }

                expect(caught).not.toBeNull();
                expect(caught instanceof WorkflowConcurrencyError).toBe(true);
                expect((caught as WorkflowConcurrencyError).workflowId).toEqual(wf.id);
                expect((caught as WorkflowConcurrencyError).expectedToken).toEqual(0);
            });

            it("stored data reflects copyA, not copyB, after the conflict", async () => {
                const wf = await makeWorkflow();
                const copyA = await provider.getWorkflowInstance(wf.id);
                const copyB = await provider.getWorkflowInstance(wf.id);

                copyA.data = { winner: "a" };
                await provider.persistWorkflow(copyA);

                copyB.data = { winner: "b" };
                try { await provider.persistWorkflow(copyB); } catch { /* expected */ }

                const stored = await provider.getWorkflowInstance(wf.id);
                expect(stored.concurrencyToken).toEqual(1);
                expect(stored.data).toEqual({ winner: "a" });
            });
        });

        // ── M6 Tenant isolation ───────────────────────────────────────────────
        // Every provider must prove it scopes the multi-row query methods by tenant.

        describe("M6 tenant isolation", () => {
            const asOf = new Date();
            let subA: EventSubscription;
            let subB: EventSubscription;

            beforeAll(async () => {
                // Two subscriptions with IDENTICAL (eventName, eventKey) in different tenants.
                subA = new EventSubscription();
                subA.tenantId = "tenant-A";
                subA.workflowId = "00000000-0000-4000-8000-00000000000a";
                subA.stepId = 0;
                subA.eventName = "m6-shared-event";
                subA.eventKey = "m6-shared-key";
                subA.subscribeAsOf = new Date(0);
                await provider.createEventSubscription(subA);

                subB = new EventSubscription();
                subB.tenantId = "tenant-B";
                subB.workflowId = "00000000-0000-4000-8000-00000000000b";
                subB.stepId = 0;
                subB.eventName = "m6-shared-event";
                subB.eventKey = "m6-shared-key";
                subB.subscribeAsOf = new Date(0);
                await provider.createEventSubscription(subB);

                // Two events with the SAME (eventName, eventKey) in different tenants.
                const evA = new Event();
                evA.tenantId = "tenant-A";
                evA.eventName = "m6-shared-event";
                evA.eventKey = "m6-shared-key";
                evA.eventData = { for: "A" };
                evA.eventTime = new Date(0);
                evA.isProcessed = false;
                await provider.createEvent(evA);

                const evB = new Event();
                evB.tenantId = "tenant-B";
                evB.eventName = "m6-shared-event";
                evB.eventKey = "m6-shared-key";
                evB.eventData = { for: "B" };
                evB.eventTime = new Date(0);
                evB.isProcessed = false;
                await provider.createEvent(evB);
            });

            it("getSubscriptions(tenant-A, ...) returns ONLY tenant-A's subscription", async () => {
                const found = await provider.getSubscriptions("tenant-A", "m6-shared-event", "m6-shared-key", asOf);
                const ids = found.map(s => s.id);
                expect(ids).toContain(subA.id);
                expect(ids).not.toContain(subB.id);
            });

            it("getSubscriptions(tenant-B, ...) returns ONLY tenant-B's subscription", async () => {
                const found = await provider.getSubscriptions("tenant-B", "m6-shared-event", "m6-shared-key", asOf);
                const ids = found.map(s => s.id);
                expect(ids).toContain(subB.id);
                expect(ids).not.toContain(subA.id);
            });

            it("getSubscriptions for an unrelated tenant returns neither", async () => {
                const found = await provider.getSubscriptions("tenant-Z", "m6-shared-event", "m6-shared-key", asOf);
                const ids = found.map(s => s.id);
                expect(ids).not.toContain(subA.id);
                expect(ids).not.toContain(subB.id);
            });

            it("getEvents(tenant-A, ...) and (tenant-B, ...) each return only their own event", async () => {
                const aIds = await provider.getEvents("tenant-A", "m6-shared-event", "m6-shared-key", new Date(0));
                const bIds = await provider.getEvents("tenant-B", "m6-shared-event", "m6-shared-key", new Date(0));
                // Each tenant sees exactly one matching event, and the two id sets are disjoint.
                expect(aIds.length).toBeGreaterThan(0);
                expect(bIds.length).toBeGreaterThan(0);
                for (const id of aIds)
                    expect(bIds).not.toContain(id);
            });

            it("getRunnableInstances(tenant) scopes by tenant; undefined returns across tenants", async () => {
                const wfA = new WorkflowInstance();
                wfA.tenantId = "tenant-A";
                wfA.workflowDefinitionId = "m6-runnable";
                wfA.version = 1;
                wfA.status = WorkflowStatus.Runnable;
                wfA.nextExecution = 0;
                wfA.data = {};
                await provider.createNewWorkflow(wfA);

                const wfB = new WorkflowInstance();
                wfB.tenantId = "tenant-B";
                wfB.workflowDefinitionId = "m6-runnable";
                wfB.version = 1;
                wfB.status = WorkflowStatus.Runnable;
                wfB.nextExecution = 0;
                wfB.data = {};
                await provider.createNewWorkflow(wfB);

                const scopedA = await provider.getRunnableInstances("tenant-A");
                expect(scopedA).toContain(wfA.id);
                expect(scopedA).not.toContain(wfB.id);

                const all = await provider.getRunnableInstances();
                expect(all).toContain(wfA.id);
                expect(all).toContain(wfB.id);
            });
        });

        // ── M9 query / stats / time-series / delete ───────────────────────────
        // Store-agnostic read layer. Seeds a known fixture set (several instances
        // across 2 definitions, 2 tenants, mixed statuses, known create/complete
        // times, some with a Failed pointer) and asserts every §6 rule. Memory is
        // the reference semantics; all providers MUST produce equivalent results.
        //
        // Fixtures are created on a FRESH store: the suite resets here so prior
        // blocks' rows do not pollute store-wide stats/time-series counts.

        describe("M9 query / stats / time-series / delete", () => {

            // Fixed UTC timestamps so date-bucketing is deterministic regardless of
            // the machine's local timezone.
            const D1 = "2024-01-10";
            const D2 = "2024-01-11";
            const D3 = "2024-01-12";
            const at = (isoDate: string, hh = 12): Date => new Date(`${isoDate}T${String(hh).padStart(2, "0")}:00:00.000Z`);

            // Map of fixture label -> persisted id (ids are provider-generated).
            const ids: Record<string, string> = {};

            // Helper: create a fully-specified instance and remember its id.
            async function seed(label: string, spec: {
                tenantId?: string;
                workflowDefinitionId: string;
                description?: string;
                status: number;
                createTime: Date;
                completeTime?: Date;
                failedPointer?: boolean;
            }): Promise<void> {
                const wf = new WorkflowInstance();
                if (spec.tenantId !== undefined) wf.tenantId = spec.tenantId;
                wf.workflowDefinitionId = spec.workflowDefinitionId;
                wf.version = 1;
                wf.description = spec.description;
                wf.status = spec.status;
                wf.nextExecution = 0;
                wf.data = { label };
                wf.createTime = spec.createTime;
                wf.completeTime = spec.completeTime;
                await provider.createNewWorkflow(wf);
                ids[label] = wf.id;

                // createNewWorkflow does not persist createTime/completeTime/status
                // changes made after construction in every provider's create path
                // uniformly, so persist them via the normal update path. This also
                // attaches the Failed pointer when requested.
                const loaded = await provider.getWorkflowInstance(wf.id);
                loaded.status = spec.status;
                loaded.createTime = spec.createTime;
                loaded.completeTime = spec.completeTime;
                loaded.description = spec.description;
                if (spec.failedPointer) {
                    const p = new ExecutionPointer();
                    // UUID-format id: the SQL providers store pointer ids in a UUID column.
                    p.id = crypto.randomUUID();
                    p.stepId = 0;
                    p.active = false;
                    p.stepName = "failing-step";
                    p.status = PointerStatus.Failed;
                    loaded.executionPointers = [p];
                }
                await provider.persistWorkflow(loaded);
            }

            beforeAll(async () => {
                // Start from a clean store so store-wide stats are predictable.
                await options.reset(provider);

                // Tenant alpha, definition "order" — 4 instances.
                //   alpha-order-complete-1: Complete, create D1, complete D1+5min  (duration 300000ms)
                //   alpha-order-complete-2: Complete, create D2, complete D2+15min (duration 900000ms)
                //   alpha-order-runnable:   Runnable, create D2 (no completeTime)
                //   alpha-order-terminated: Terminated, create D3, has a Failed pointer (terminated => NOT counted in failed-steps)
                await seed("alpha-order-complete-1", {
                    tenantId: "alpha", workflowDefinitionId: "order-workflow", description: "First order",
                    status: WorkflowStatus.Complete, createTime: at(D1), completeTime: new Date(at(D1).getTime() + 300_000)
                });
                await seed("alpha-order-complete-2", {
                    tenantId: "alpha", workflowDefinitionId: "order-workflow", description: "Second order",
                    status: WorkflowStatus.Complete, createTime: at(D2), completeTime: new Date(at(D2).getTime() + 900_000)
                });
                await seed("alpha-order-runnable", {
                    tenantId: "alpha", workflowDefinitionId: "order-workflow", description: "Pending order",
                    status: WorkflowStatus.Runnable, createTime: at(D2)
                });
                await seed("alpha-order-terminated", {
                    tenantId: "alpha", workflowDefinitionId: "order-workflow", description: "Cancelled order",
                    status: WorkflowStatus.Terminated, createTime: at(D3), failedPointer: true
                });

                // Tenant alpha, definition "invoice" — 2 instances, one Runnable with a Failed pointer.
                await seed("alpha-invoice-runnable-failed", {
                    tenantId: "alpha", workflowDefinitionId: "invoice-workflow", description: "Invoice with error",
                    status: WorkflowStatus.Runnable, createTime: at(D1), failedPointer: true
                });
                await seed("alpha-invoice-complete", {
                    tenantId: "alpha", workflowDefinitionId: "invoice-workflow", description: "Paid invoice",
                    status: WorkflowStatus.Complete, createTime: at(D3), completeTime: new Date(at(D3).getTime() + 600_000)
                });

                // Tenant beta, definition "order" — 1 instance (tenant isolation).
                await seed("beta-order-runnable", {
                    tenantId: "beta", workflowDefinitionId: "order-workflow", description: "Beta order",
                    status: WorkflowStatus.Runnable, createTime: at(D2)
                });
            });

            // ── §8 Failing-first ──────────────────────────────────────────────

            it("queryWorkflowInstances filters by workflowDefinitionId + status and paginates", async () => {
                const result = await provider.queryWorkflowInstances({
                    tenantId: "alpha",
                    workflowDefinitionId: "order-workflow",
                    status: WorkflowStatus.Complete
                });
                expect(result.total).toEqual(2);
                expect(result.instances.length).toEqual(2);
                const labels = result.instances.map(i => i.data.label).sort();
                expect(labels).toEqual(["alpha-order-complete-1", "alpha-order-complete-2"]);
            });

            // ── Filtering ─────────────────────────────────────────────────────

            it("returns full WorkflowInstance objects (id, data, executionPointers, tenantId, concurrencyToken)", async () => {
                const result = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "invoice-workflow", status: WorkflowStatus.Runnable });
                expect(result.instances.length).toEqual(1);
                const inst = result.instances[0];
                expect(inst.id).toEqual(ids["alpha-invoice-runnable-failed"]);
                expect(inst.tenantId).toEqual("alpha");
                expect(inst.data).toEqual({ label: "alpha-invoice-runnable-failed" });
                expect(inst.concurrencyToken).toBeGreaterThanOrEqual(0);
                expect(inst.executionPointers.length).toEqual(1);
                expect(inst.executionPointers[0].status).toEqual(PointerStatus.Failed);
            });

            it("wildcard workflowDefinitionId matches via '*'", async () => {
                const result = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order*" });
                expect(result.total).toEqual(4);
                const ok = result.instances.every(i => i.workflowDefinitionId === "order-workflow");
                expect(ok).toBe(true);
            });

            it("status array matches any-of", async () => {
                const result = await provider.queryWorkflowInstances({
                    tenantId: "alpha",
                    workflowDefinitionId: "order-workflow",
                    status: [WorkflowStatus.Complete, WorkflowStatus.Terminated]
                });
                expect(result.total).toEqual(3);
            });

            it("date range filters by createTime (createdAfter/createdBefore)", async () => {
                const result = await provider.queryWorkflowInstances({
                    tenantId: "alpha",
                    createdAfter: at(D2, 0),
                    createdBefore: at(D2, 23)
                });
                // alpha rows on D2: order-complete-2, order-runnable
                expect(result.total).toEqual(2);
                const labels = result.instances.map(i => i.data.label).sort();
                expect(labels).toEqual(["alpha-order-complete-2", "alpha-order-runnable"]);
            });

            it("completedAfter/Before filters by completeTime", async () => {
                const result = await provider.queryWorkflowInstances({
                    tenantId: "alpha",
                    completedAfter: at(D3, 0)
                });
                // only alpha-invoice-complete completes on D3
                expect(result.total).toEqual(1);
                expect(result.instances[0].data.label).toEqual("alpha-invoice-complete");
            });

            it("searchTerm matches workflowDefinitionId | description | id (case-insensitive)", async () => {
                const byDesc = await provider.queryWorkflowInstances({ tenantId: "alpha", searchTerm: "CANCELLED" });
                expect(byDesc.total).toEqual(1);
                expect(byDesc.instances[0].data.label).toEqual("alpha-order-terminated");

                const byDef = await provider.queryWorkflowInstances({ tenantId: "alpha", searchTerm: "invoice" });
                expect(byDef.total).toEqual(2);

                const byId = await provider.queryWorkflowInstances({ tenantId: "alpha", searchTerm: ids["alpha-order-runnable"] });
                expect(byId.total).toEqual(1);
                expect(byId.instances[0].id).toEqual(ids["alpha-order-runnable"]);
            });

            // ── Sorting & pagination ──────────────────────────────────────────

            it("sorts by createTime desc by default; asc honoured", async () => {
                const desc = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow" });
                const descTimes = desc.instances.map(i => new Date(i.createTime).getTime());
                for (let k = 1; k < descTimes.length; k++) expect(descTimes[k - 1]).toBeGreaterThanOrEqual(descTimes[k]);

                const asc = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow", sortOrder: "asc" });
                const ascTimes = asc.instances.map(i => new Date(i.createTime).getTime());
                for (let k = 1; k < ascTimes.length; k++) expect(ascTimes[k - 1]).toBeLessThanOrEqual(ascTimes[k]);
            });

            it("breaks ties by id for stable pagination", async () => {
                // alpha-order-complete-2 and alpha-order-runnable share createTime D2.
                const sortField = "createTime";
                const page1 = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow", sortField, sortOrder: "asc", skip: 0, take: 100 });
                const page2 = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow", sortField, sortOrder: "asc", skip: 0, take: 100 });
                // Deterministic ordering across identical queries.
                expect(page1.instances.map(i => i.id)).toEqual(page2.instances.map(i => i.id));
                // Among the two D2 rows, id order is the tie-break.
                const d2 = page1.instances.filter(i => i.data.label === "alpha-order-complete-2" || i.data.label === "alpha-order-runnable");
                expect(d2.length).toEqual(2);
                expect(d2[0].id <= d2[1].id).toBe(true);
            });

            it("paginates via skip/take and reports unpaged total", async () => {
                const all = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow", sortOrder: "asc", take: 100 });
                const pageA = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow", sortOrder: "asc", skip: 0, take: 2 });
                const pageB = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow", sortOrder: "asc", skip: 2, take: 2 });
                expect(pageA.total).toEqual(4);
                expect(pageB.total).toEqual(4);
                expect(pageA.instances.length).toEqual(2);
                expect(pageB.instances.length).toEqual(2);
                expect(pageA.instances.map(i => i.id)).toEqual(all.instances.slice(0, 2).map(i => i.id));
                expect(pageB.instances.map(i => i.id)).toEqual(all.instances.slice(2, 4).map(i => i.id));
            });

            it("caps take at 500", async () => {
                const result = await provider.queryWorkflowInstances({ tenantId: "alpha", take: 100000 });
                // We cannot exceed 500 rows here, but the request must not throw and
                // must return at most 500. Total is the true unpaged count.
                expect(result.instances.length).toBeLessThanOrEqual(500);
                expect(result.total).toEqual(6);
            });

            // ── Tenant scoping ────────────────────────────────────────────────

            it("query scopes by tenant; omit = all tenants", async () => {
                const beta = await provider.queryWorkflowInstances({ tenantId: "beta", workflowDefinitionId: "order-workflow" });
                expect(beta.total).toEqual(1);
                expect(beta.instances[0].data.label).toEqual("beta-order-runnable");

                const all = await provider.queryWorkflowInstances({ workflowDefinitionId: "order-workflow" });
                expect(all.total).toEqual(5); // 4 alpha + 1 beta
            });

            // ── Stats ─────────────────────────────────────────────────────────

            it("stats byStatus sums to total (tenant-scoped)", async () => {
                const stats = await provider.getWorkflowInstanceStats({ tenantId: "alpha" });
                expect(stats.total).toEqual(6);
                const sum = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
                expect(sum).toEqual(stats.total);
                expect(stats.byStatus[WorkflowStatus.Complete]).toEqual(3);
                expect(stats.byStatus[WorkflowStatus.Runnable]).toEqual(2);
                expect(stats.byStatus[WorkflowStatus.Terminated]).toEqual(1);
            });

            it("averageCompletionTimeMs is the mean over Complete instances", async () => {
                // alpha Complete durations: 300000, 900000, 600000 -> mean 600000
                const stats = await provider.getWorkflowInstanceStats({ tenantId: "alpha" });
                expect(stats.averageCompletionTimeMs).toBeCloseTo(600_000, 0);
            });

            it("averageCompletionTimeMs is null when there are no Complete instances", async () => {
                const stats = await provider.getWorkflowInstanceStats({ tenantId: "beta" });
                expect(stats.averageCompletionTimeMs).toBeNull();
            });

            it("byDefinition rolls up total/complete/terminated sorted by total desc", async () => {
                const stats = await provider.getWorkflowInstanceStats({ tenantId: "alpha" });
                expect(stats.byDefinition.length).toEqual(2);
                // order-workflow has 4 (more than invoice's 2) so it leads.
                expect(stats.byDefinition[0].workflowDefinitionId).toEqual("order-workflow");
                expect(stats.byDefinition[0].total).toEqual(4);
                expect(stats.byDefinition[0].complete).toEqual(2);
                expect(stats.byDefinition[0].terminated).toEqual(1);
                expect(stats.byDefinition[1].workflowDefinitionId).toEqual("invoice-workflow");
                expect(stats.byDefinition[1].total).toEqual(2);
                expect(stats.byDefinition[1].complete).toEqual(1);
                expect(stats.byDefinition[1].terminated).toEqual(0);
            });

            it("byDefinition respects topDefinitions cap", async () => {
                const stats = await provider.getWorkflowInstanceStats({ tenantId: "alpha", topDefinitions: 1 });
                expect(stats.byDefinition.length).toEqual(1);
                expect(stats.byDefinition[0].workflowDefinitionId).toEqual("order-workflow");
            });

            it("instancesWithFailedSteps counts non-terminated instances with a Failed pointer", async () => {
                const stats = await provider.getWorkflowInstanceStats({ tenantId: "alpha" });
                // alpha-invoice-runnable-failed: Runnable + Failed pointer -> counted under invoice-workflow.
                // alpha-order-terminated: Terminated + Failed pointer -> NOT counted.
                expect(stats.instancesWithFailedSteps["invoice-workflow"]).toEqual(1);
                expect(stats.instancesWithFailedSteps["order-workflow"]).toBeUndefined();
            });

            it("stats with no query scope the whole store", async () => {
                const stats = await provider.getWorkflowInstanceStats();
                expect(stats.total).toEqual(7); // 6 alpha + 1 beta
            });

            // ── Time series ───────────────────────────────────────────────────

            it("time series buckets by UTC day, ordered asc, with total/complete/terminated", async () => {
                const points = await provider.getWorkflowInstanceTimeSeries({ tenantId: "alpha", from: at(D1, 0), to: at(D3, 23) });
                // Days present for alpha: D1 (2 created), D2 (2 created), D3 (2 created).
                const byDate: Record<string, WorkflowTimeSeriesPointShape> = {};
                for (const p of points) byDate[p.date] = p;
                const dates = points.map(p => p.date);
                // ordered ascending
                expect(dates).toEqual([...dates].sort());
                expect(byDate[D1]).toBeDefined();
                expect(byDate[D1].total).toEqual(2);   // order-complete-1 + invoice-runnable-failed
                expect(byDate[D1].complete).toEqual(1);
                expect(byDate[D2].total).toEqual(2);   // order-complete-2 + order-runnable
                expect(byDate[D2].complete).toEqual(1);
                expect(byDate[D3].total).toEqual(2);   // order-terminated + invoice-complete
                expect(byDate[D3].complete).toEqual(1);
                expect(byDate[D3].terminated).toEqual(1);
            });

            it("time series scopes by tenant", async () => {
                const points = await provider.getWorkflowInstanceTimeSeries({ tenantId: "beta", from: at(D1, 0), to: at(D3, 23) });
                const totals = points.reduce((a, p) => a + p.total, 0);
                expect(totals).toEqual(1);
            });

            // ── Deletes ───────────────────────────────────────────────────────

            it("deleteWorkflowInstance returns true and removes the row (and its pointers)", async () => {
                const id = ids["alpha-invoice-runnable-failed"];
                const removed = await provider.deleteWorkflowInstance(id);
                expect(removed).toBe(true);
                const reloaded = await provider.getWorkflowInstance(id);
                expect(reloaded).toBeUndefined();
                const q = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "invoice-workflow" });
                expect(q.instances.map(i => i.id)).not.toContain(id);
                // Failed-steps rollup no longer counts the deleted instance.
                const stats = await provider.getWorkflowInstanceStats({ tenantId: "alpha" });
                expect(stats.instancesWithFailedSteps["invoice-workflow"]).toBeUndefined();
            });

            it("deleteWorkflowInstance returns false for an unknown id", async () => {
                const removed = await provider.deleteWorkflowInstance("00000000-0000-4000-8000-000000000099");
                expect(removed).toBe(false);
            });

            it("deleteWorkflowInstances returns the count removed and is idempotent on missing ids", async () => {
                const present = ids["alpha-order-runnable"];
                const missing = "00000000-0000-4000-8000-0000000000aa";
                const count = await provider.deleteWorkflowInstances([present, missing]);
                expect(count).toEqual(1);
                expect(await provider.getWorkflowInstance(present)).toBeUndefined();
                // second call removes nothing.
                const again = await provider.deleteWorkflowInstances([present, missing]);
                expect(again).toEqual(0);
            });

            it("deleteWorkflowInstancesByDefinitionId removes all matching, tenant-scoped", async () => {
                // beta order should NOT be touched when deleting alpha order-workflow.
                const count = await provider.deleteWorkflowInstancesByDefinitionId("order-workflow", "alpha");
                // Remaining alpha order rows: complete-1, complete-2, terminated (runnable was deleted above) = 3.
                expect(count).toEqual(3);
                const remainingAlpha = await provider.queryWorkflowInstances({ tenantId: "alpha", workflowDefinitionId: "order-workflow" });
                expect(remainingAlpha.total).toEqual(0);
                const beta = await provider.queryWorkflowInstances({ tenantId: "beta", workflowDefinitionId: "order-workflow" });
                expect(beta.total).toEqual(1);
            });
        });

    }); // end describe `${providerName} persistence conformance`
}

// Local structural alias so the suite does not import value-less type-only names
// across moduleResolution settings; mirrors WorkflowTimeSeriesPoint.
interface WorkflowTimeSeriesPointShape {
    date: string;
    total: number;
    complete: number;
    terminated: number;
}
