import { WorkflowInstance, EventSubscription, Event } from "../models";

/**
 * Persistence contract for the workflow engine.
 *
 * REQUIRED INDEXES (provider contract — M2).
 * A conforming durable provider (SQL, document, etc.) MUST back the following
 * poll/lookup queries with an index so they are O(matching rows), not
 * O(table size). The in-memory provider is exempt (array filtering). Index
 * names below are the canonical, stable names; SQL providers create them via
 * the model `@Table({ indexes })` option, document providers via `createIndex`
 * at connect time. All index creation MUST be idempotent.
 *
 * M6 tenantId note: where `tenantId` is an equality filter in the query
 * (getSubscriptions, getEvents always; getRunnableInstances / getRunnableEvents
 * when called with a tenant), tenantId is the leading column of the composite
 * index (equality-before-range ordering).
 *
 *   1. getRunnableInstances()  filters status === Runnable && nextExecution < now
 *      -> index on (tenantId, status, nextExecution)  name: idx_workflows_status_next_execution
 *         (tenantId leads; when omitted the planner uses the status sub-index)
 *
 *   2. getRunnableEvents()     filters !isProcessed && eventTime <= now
 *      -> index on (tenantId, isProcessed, eventTime) name: idx_events_isprocessed_eventtime
 *
 *   3. getEvents(name,key,asOf) filters tenantId == && eventName == && eventKey == && eventTime >= asOf
 *      -> index on (tenantId, eventName, eventKey, eventTime)    name: idx_events_name_key_eventtime
 *
 *   4. getSubscriptions(name,key,asOf) filters tenantId == && eventName == && eventKey == && subscribeAsOf <= asOf
 *      -> index on (tenantId, eventName, eventKey, subscribeAsOf) name: idx_subscriptions_name_key_subscribeasof
 *
 * See CONTRIBUTING.md → "Persistence provider index requirement".
 */
export interface IPersistenceProvider {

    createNewWorkflow(instance: WorkflowInstance): Promise<string>;

    /**
     * Persist a mutated workflow instance using optimistic concurrency.
     *
     * Compare-and-set semantics (REQUIRED of every provider):
     *  - Let `expected = instance.concurrencyToken ?? 0`.
     *  - Atomically update the stored row ONLY where the stored token === `expected`.
     *  - On success: set the stored token to `expected + 1`, and mutate the passed
     *    `instance.concurrencyToken = expected + 1` in place (so the same in-memory
     *    instance can be persisted again without reload).
     *  - On no-match (stored token !== expected, i.e. another node wrote first):
     *    reject with `WorkflowConcurrencyError` and DO NOT write.
     *
     * `createNewWorkflow` MUST seed the stored token and `instance.concurrencyToken` to 0.
     */
    persistWorkflow(instance: WorkflowInstance): Promise<void>;
    getWorkflowInstance(workflowId: string): Promise<WorkflowInstance>;

    /**
     * M6 — return ids of runnable instances. When `tenantId` is supplied, only
     * that tenant's instances are returned; when omitted/undefined, instances
     * across ALL tenants are returned (used by the tenant-agnostic poll worker,
     * which only queues ids — the later getWorkflowInstance(id) load is
     * tenant-correct because the row carries its own tenantId).
     */
    getRunnableInstances(tenantId?: string): Promise<Array<string>>;

    createEventSubscription(subscription: EventSubscription): Promise<void>;
    /**
     * M6 — return subscriptions matching (eventName, eventKey, subscribeAsOf<=asOf)
     * AND tenantId === `tenantId`. The tenant parameter is REQUIRED: it is the
     * sole runtime enforcement point of cross-tenant isolation (the event→
     * subscription wake path passes evt.tenantId here).
     */
    getSubscriptions(tenantId: string, eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>>;
    terminateSubscription(id: string): Promise<void>;

    createEvent(event: Event): Promise<string>;
    getEvent(id: string): Promise<Event>;
    /**
     * M6 — return ids of runnable events. Tenant semantics identical to
     * getRunnableInstances: optional/undefined => all tenants (poll worker).
     */
    getRunnableEvents(tenantId?: string): Promise<Array<string>>;

    markEventProcessed(id: string): Promise<void>;
    markEventUnprocessed(id: string): Promise<void>;

    /**
     * M6 — return ids of events matching (eventName, eventKey, asOf) AND
     * tenantId === `tenantId` (required).
     */
    getEvents(tenantId: string, eventName: string, eventKey: any, asOf: Date): Promise<Array<string>>;

}