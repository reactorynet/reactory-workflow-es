import { inject, injectable } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event } from "../models";
import { WorkflowBase, IPersistenceProvider, IWorkflowHost, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger, TYPES, QueueType, IBackgroundWorker, toError, WorkflowOptions } from "../abstractions";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowExecutor } from "./workflow-executor";
import { drainWithTimeout } from "./drain";

@injectable()
export class EventQueueWorker implements IBackgroundWorker {

    @inject(TYPES.IWorkflowExecutor) 
    private  executor: IWorkflowExecutor;

    @inject(TYPES.IPersistenceProvider)
    private persistence: IPersistenceProvider;

    @inject(TYPES.IDistributedLockProvider)
    private lockProvider: IDistributedLockProvider;

    @inject(TYPES.IQueueProvider)
    private queueProvider:  IQueueProvider;

    @inject(TYPES.ILogger)
    private logger: ILogger;

    @inject(TYPES.WorkflowOptions)
    private options: WorkflowOptions;

    private processTimer: any;

    // H4 + H1: the single in-flight tracking structure. Keys are the tracked
    // processEvent promises H4's stop() drains (each self-removes in its
    // .finally); values are the event IDs H1 exposes via getActiveIds().
    // inFlight.size is the sole source of truth for the concurrency cap.
    private inFlight: Map<Promise<void>, string> = new Map();
    private shuttingDown: boolean = false;
    private started: boolean = false;
    private drainPromise: Promise<void> | null = null;

    public start() {
        // H1 (rule §6.6): idempotent — never arm a second timer chain.
        if (this.started)
            return;
        this.started = true;
        this.shuttingDown = false;
        this.drainPromise = null;
        this.scheduleNext();
    }

    /**
     * H4 graceful drain: stop intake first (clear the timer, gate the dequeue
     * loop), then await all in-flight executions for up to timeoutMs, then
     * force-resolve. Idempotent: repeated/concurrent calls share one drain.
     */
    public async stop(timeoutMs: number): Promise<void> {
        if (this.shuttingDown) {
            await (this.drainPromise ?? Promise.resolve());
            return;
        }
        this.shuttingDown = true;
        this.started = false;
        this.logger.log("Stopping event queue worker...");
        if (this.processTimer) {
            clearTimeout(this.processTimer);
            this.processTimer = null;
        }
        this.drainPromise = drainWithTimeout(this.inFlight.keys(), timeoutMs);
        await this.drainPromise;
    }

    /** H1 (rule §6.5): live in-flight count, backed by the H4 drain set. */
    public getActiveCount(): number {
        return this.inFlight.size;
    }

    /** H1 (rule §6.5): snapshot copy of the event IDs currently in flight. */
    public getActiveIds(): string[] {
        return Array.from(this.inFlight.values());
    }

    /** H1 (rule §6.3): exactly one self-rescheduling setTimeout — no stacking interval timer. */
    private scheduleNext() {
        if (this.shuttingDown)
            return;
        this.processTimer = setTimeout(() => { this.processQueue(this); }, this.options.eventQueueIntervalMs);
    }

    private async processQueue(self: EventQueueWorker): Promise<void> {
        try {
            // H1 backpressure (rules §6.1/§6.2): dequeue-and-start only while a
            // slot is free; at capacity, leave pending items on the queue for the
            // next cycle. The slot is reserved synchronously (inFlight.set) before
            // the next dequeue await so the cap can never be overshot.
            while (!self.shuttingDown && self.inFlight.size < self.options.maxConcurrentEvents) {
                const eventId = await self.queueProvider.dequeueForProcessing(QueueType.Event);
                if (!eventId)
                    break;
                self.logger.log("Dequeued event " + eventId + " for processing");
                const id = eventId;
                const p: Promise<void> = self.processEvent(self, id)
                    .catch((err) => {
                        self.logger.error("Error processing event", id, err);
                    })
                    .finally(() => {
                        self.inFlight.delete(p);
                    });
                self.inFlight.set(p, id);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error processing event queue: " + error.message);
        }
        finally {
            // H1 (rules §6.3/§6.8): re-arm after the dequeue-and-dispatch phase
            // (not after in-flight work settles); the worker self-heals after errors.
            self.scheduleNext();
        }
    }

    private async processEvent(self: EventQueueWorker, eventId: string): Promise<void> {
        try {
            const gotLock = await self.lockProvider.acquireLock(eventId);                
            if (gotLock) {
                try {
                    let evt = await self.persistence.getEvent(eventId);
                    if (evt.eventTime <= new Date())
                    {
                        let subs = await self.persistence.getSubscriptions(evt.eventName, evt.eventKey, evt.eventTime);
                        let success = true;

                        for (let sub of subs)
                            success = success && await self.seedSubscription(self, evt, sub);

                        if (success)
                            await self.persistence.markEventProcessed(eventId);
                    }
                                        
                }
                finally {
                    await self.lockProvider.releaseLock(eventId);                    
                }                
            }
            else {
                self.logger.log("Event locked: " + eventId);
            }   
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error processing event: " + error.message);
        }
    }

    private async seedSubscription(self: EventQueueWorker, evt: Event, sub: EventSubscription): Promise<boolean> {
        
        if (await self.lockProvider.acquireLock(sub.workflowId)) {
            try {
                let workflow = await self.persistence.getWorkflowInstance(sub.workflowId);
                let pointers = workflow.executionPointers.filter(p => p.eventName == sub.eventName && p.eventKey == sub.eventKey && !p.eventPublished);
                for (let p of pointers) {
                    p.eventData = evt.eventData;
                    p.eventPublished = true;
                    p.active = true;
                }
                workflow.nextExecution = 0;
                await self.persistence.persistWorkflow(workflow);
                await self.persistence.terminateSubscription(sub.id);
                // H2 (spec §6.8): re-queue while still holding the workflow lock,
                // so releaseLock (finally) is the last action; the re-queue occurs
                // exactly when seeding succeeded.
                await self.queueProvider.queueForProcessing(sub.workflowId, QueueType.Workflow);
                return true;
            }
            catch (err) {
                const error = toError(err);
                self.logger.error(error);
                return false;
            }
            finally {
                await self.lockProvider.releaseLock(sub.workflowId);
            }
        }
        else {
            self.logger.info("Workflow locked " + sub.workflowId);
            return false;
        }
    }
}