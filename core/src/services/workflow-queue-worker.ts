import { inject, injectable } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event, WorkflowExecutorResult } from "../models";
import { WorkflowBase, IPersistenceProvider, IWorkflowHost, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger, TYPES, QueueType, IBackgroundWorker, toError, WorkflowConcurrencyError } from "../abstractions";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowExecutor } from "./workflow-executor";

@injectable()
export class WorkflowQueueWorker implements IBackgroundWorker {

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

    public start() {        
        this.processTimer = setInterval(this.processQueue, 100, this);
    }

    public stop() {
        this.logger.log("Stopping workflow queue worker...");        
        if (this.processTimer)
            clearInterval(this.processTimer);
    }

    private async processQueue(self: WorkflowQueueWorker): Promise<void> {                
        try {
            let workflowId = await self.queueProvider.dequeueForProcessing(QueueType.Workflow);
            while (workflowId) {
                self.logger.log("Dequeued workflow " + workflowId + " for processing");
                self.processWorkflow(self, workflowId)
                    .catch((err) => {
                        self.logger.error("Error processing workflow", workflowId, err);
                    });
                workflowId = await self.queueProvider.dequeueForProcessing(QueueType.Workflow);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error processing workflow queue: " + error.message);
        }            
    }

    private async processWorkflow(self: WorkflowQueueWorker, workflowId: string): Promise<void> {
        try {
            const gotLock = await self.lockProvider.acquireLock(workflowId);
            if (gotLock) {
                // H2 (spec §6.1/.2): everything state-derived — load, execute, persist,
                // subscription creation, event seeding, and the re-queue decision —
                // happens INSIDE the lock; releaseLock is the sole finally and the
                // last action on every acquired path.
                try {
                    let instance: WorkflowInstance = await self.persistence.getWorkflowInstance(workflowId);
                    if (!instance)
                        throw new Error(`Workflow ${workflowId} not found`);

                    if (instance.status == WorkflowStatus.Runnable) {
                        let complete = false;
                        let result: WorkflowExecutorResult;
                        try {
                            result = await self.executor.execute(instance);
                            complete = true;
                        }
                        finally {
                            try {
                                await self.persistence.persistWorkflow(instance);
                            }
                            catch (persistErr) {
                                if (persistErr instanceof WorkflowConcurrencyError) {
                                    // Another node persisted this instance first. Discard our
                                    // in-memory state, skip post-processing, and re-queue —
                                    // still inside the lock — for a fresh load-execute-persist
                                    // cycle (specs C1 §6.7, H2 §6.2).
                                    complete = false;
                                    self.logger.info("Concurrency conflict persisting workflow %s; re-queueing", workflowId);
                                    await self.queueProvider.queueForProcessing(workflowId, QueueType.Workflow);
                                }
                                else {
                                    throw persistErr;
                                }
                            }
                        }

                        if (complete) {
                            //TODO: cleanup
                            for (let sub of result.subscriptions) {
                                await self.subscribeEvent(self, sub);
                            }

                            if ((instance.status == WorkflowStatus.Runnable) && (instance.nextExecution !== null)) {
                                if (instance.nextExecution < Date.now()) {
                                    await self.queueProvider.queueForProcessing(workflowId, QueueType.Workflow);
                                }
                            }
                        }
                    }
                }
                finally {
                    await self.lockProvider.releaseLock(workflowId);
                }
            }
            else {
                self.logger.log("Workflow locked: " + workflowId);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error processing workflow: " + error.message);
        }
    }

    private async subscribeEvent(self: WorkflowQueueWorker, subscription: EventSubscription) {
        //TODO: move to own class

        // H2 (spec §6.5): at-most-once per (workflowId, eventName, eventKey,
        // subscribeAsOf). If the subscription already exists, the event-seeding
        // below already ran when it was first created — skip both.
        const existing = await self.persistence.getSubscriptions(subscription.eventName, subscription.eventKey, subscription.subscribeAsOf);
        if (existing.some(s => s.workflowId === subscription.workflowId))
            return;

        await self.persistence.createEventSubscription(subscription);
        let events = await self.persistence.getEvents(subscription.eventName, subscription.eventKey, subscription.subscribeAsOf);
        for (let evt of events) {
            await self.persistence.markEventUnprocessed(evt);
            await self.queueProvider.queueForProcessing(evt, QueueType.Event);
        }
    }
}