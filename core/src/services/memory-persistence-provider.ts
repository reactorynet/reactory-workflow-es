import { injectable, inject } from "inversify";
import { IPersistenceProvider, WorkflowConcurrencyError } from "../abstractions";
import { WorkflowInstance, WorkflowStatus, EventSubscription, Event } from "../models";

@injectable()
export class MemoryPersistenceProvider implements IPersistenceProvider {
    private instances: WorkflowInstance[] = [];
    private subscriptions: EventSubscription[] = [];
    private events: Event[] = [];
    
    public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
        instance.id = this.generateUID();
        instance.concurrencyToken = 0;
        this.instances.push(this.clone(instance));
        return instance.id;
    }

    public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
        const expected = instance.concurrencyToken ?? 0;
        const idx = this.instances.findIndex(x => x.id === instance.id);
        const stored = idx > -1 ? this.instances[idx] : undefined;
        const storedToken = stored ? (stored.concurrencyToken ?? 0) : undefined;

        // Compare-and-set: only succeed when the stored token matches the
        // token on the in-memory instance being written. A mismatch means
        // another node persisted this instance first — reject the stale write.
        if (storedToken !== expected) {
            throw new WorkflowConcurrencyError(instance.id, expected);
        }

        const next = expected + 1;
        const copy = this.clone(instance);
        copy.concurrencyToken = next;
        this.instances[idx] = copy;
        // Refresh the caller's in-memory token so it can persist again without reload.
        instance.concurrencyToken = next;
    }

    public async getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
        const found = this.instances.find(x => x.id === workflowId);
        // Return an independent copy so callers cannot mutate the stored record
        // out-of-band, which would defeat the compare-and-set check.
        return found ? this.clone(found) : found;
    }

    public async getRunnableInstances(): Promise<string[]> {
        return this.instances
            .filter(x => x.status === WorkflowStatus.Runnable && x.nextExecution < Date.now())
            .map(x => x.id);
    }

    public async createEventSubscription(subscription: EventSubscription): Promise<void> {
        subscription.id = this.generateUID();
        this.subscriptions.push(subscription);
    }

    public async getSubscriptions(eventName: string, eventKey: string, asOf: Date): Promise<EventSubscription[]> {
        return this.subscriptions.filter(x => x.eventName === eventName && x.eventKey === eventKey && x.subscribeAsOf <= asOf);
    }

    public async terminateSubscription(id: string): Promise<void> {
        const idx = this.subscriptions.findIndex(x => x.id === id);
        if (idx > -1)
            this.subscriptions.splice(idx, 1);
    }

    public async createEvent(event: Event): Promise<string> {
        event.id = this.generateUID();
        this.events.push(event);
        return event.id;
    }

    public async getEvent(id: string): Promise<Event> {
        return this.events.find(x => x.id === id);
    }

    public async getRunnableEvents(): Promise<string[]> {
        return this.events
            .filter(x => !x.isProcessed && x.eventTime <= new Date())
            .map(x => x.id);
    }

    public async markEventProcessed(id: string): Promise<void> {
        const evt = this.events.find(x => x.id === id);
        if (evt)
            evt.isProcessed = true;
    }

    public async markEventUnprocessed(id: string): Promise<void> {
        const evt = this.events.find(x => x.id === id);
        if (evt)
            evt.isProcessed = false;
    }

    public async getEvents(eventName: string, eventKey: unknown, asOf: Date): Promise<string[]> {
        return this.events
            .filter(x => x.eventName === eventName && x.eventKey === eventKey && x.eventTime >= asOf)
            .map(x => x.id);
    }

    private generateUID(): string {
        return crypto.randomUUID();
    }

    // Deep copy so the stored record and the caller's in-memory instance are
    // independent. structuredClone preserves Date instances (unlike JSON round-trip)
    // and keeps the concurrency token comparison honest.
    private clone(instance: WorkflowInstance): WorkflowInstance {
        return structuredClone(instance);
    }

}