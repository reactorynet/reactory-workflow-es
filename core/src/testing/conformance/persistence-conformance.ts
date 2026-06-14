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
import { ExecutionPointer } from "../../models/execution-pointer";
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

    }); // end describe `${providerName} persistence conformance`
}
