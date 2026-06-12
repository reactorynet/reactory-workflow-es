import { inject, injectable } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event } from "../models";
import { WorkflowBase, IPersistenceProvider, IWorkflowHost, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger, TYPES, QueueType, IBackgroundWorker, toError } from "../abstractions";
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

    private processTimer: any;

    // H4: tracked set of in-flight processEvent promises. stop() drains this
    // set; H1 builds its concurrency cap on the same set (single source of truth).
    private inFlight: Set<Promise<void>> = new Set();
    private shuttingDown: boolean = false;
    private drainPromise: Promise<void> | null = null;

    public start() {
        this.shuttingDown = false;
        this.drainPromise = null;
        this.processTimer = setInterval(this.processQueue, 500, this);
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
        this.logger.log("Stopping event queue worker...");
        if (this.processTimer) {
            clearInterval(this.processTimer);
            this.processTimer = null;
        }
        this.drainPromise = drainWithTimeout(this.inFlight, timeoutMs);
        await this.drainPromise;
    }

    private async processQueue(self: EventQueueWorker): Promise<void> {
        try {
            if (self.shuttingDown)
                return;
            let eventId = await self.queueProvider.dequeueForProcessing(QueueType.Event);
            while (eventId) {
                if (self.shuttingDown)
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
                self.inFlight.add(p);
                eventId = await self.queueProvider.dequeueForProcessing(QueueType.Event);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error processing event queue: " + error.message);
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