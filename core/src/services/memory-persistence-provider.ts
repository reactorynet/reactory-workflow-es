import { injectable, inject } from "inversify";
import { IPersistenceProvider } from "../abstractions";
import { WorkflowInstance, WorkflowStatus, EventSubscription, Event } from "../models";

@injectable()
export class MemoryPersistenceProvider implements IPersistenceProvider {
    private instances: WorkflowInstance[] = [];
    private subscriptions: EventSubscription[] = [];
    private events: Event[] = [];
    
    public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
        instance.id = this.generateUID();
        this.instances.push(instance);
        return instance.id;
    }

    public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
        const idx = this.instances.findIndex(x => x.id === instance.id);
        this.instances[idx] = instance;
    }

    public async getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
        return this.instances.find(x => x.id === workflowId);
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

}