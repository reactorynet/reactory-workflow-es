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
    getRunnableInstances(): Promise<Array<string>>;

    createEventSubscription(subscription: EventSubscription): Promise<void>;
    getSubscriptions(eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>>;
    terminateSubscription(id: string): Promise<void>;

    createEvent(event: Event): Promise<string>;    
    getEvent(id: string): Promise<Event>;
    getRunnableEvents(): Promise<Array<string>>;
    
    markEventProcessed(id: string): Promise<void>;
    markEventUnprocessed(id: string): Promise<void>;

    getEvents(eventName: string, eventKey: any, asOf: Date): Promise<Array<string>>;

}