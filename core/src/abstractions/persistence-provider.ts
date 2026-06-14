import { WorkflowInstance, EventSubscription, Event } from "../models";

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