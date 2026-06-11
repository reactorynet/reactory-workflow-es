import { injectable, inject, multiInject } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event } from "../models";
import { WorkflowBase, IWorkflowRegistry, IPersistenceProvider, IWorkflowHost, IQueueProvider, QueueType, IDistributedLockProvider, IBackgroundWorker, TYPES, ILogger, IExecutionPointerFactory, toError, WorkflowConcurrencyError } from "../abstractions";
import { WorkflowQueueWorker } from "./workflow-queue-worker";

import { MemoryPersistenceProvider } from "./memory-persistence-provider";
import { SingleNodeLockProvider } from "./single-node-lock-provider";
import { SingleNodeQueueProvider } from "./single-node-queue-provider";
import { NullLogger } from "./null-logger";

@injectable()
export class WorkflowHost implements IWorkflowHost {

    @inject(TYPES.IWorkflowRegistry)
    private registry : IWorkflowRegistry;

    @multiInject(TYPES.IBackgroundWorker)
    private workers: IBackgroundWorker[];

    @inject(TYPES.IPersistenceProvider)
    private persistence: IPersistenceProvider;

    @inject(TYPES.IDistributedLockProvider)
    private lockProvider: IDistributedLockProvider;
    
    @inject(TYPES.IQueueProvider)
    private queueProvider:  IQueueProvider;

    @inject(TYPES.IExecutionPointerFactory)
    private pointerFactory : IExecutionPointerFactory;

    @inject(TYPES.ILogger)
    private logger: ILogger;

    private allowSingleNodeProviders: boolean = false;

    public setAllowSingleNodeProviders(allow: boolean): void {
        this.allowSingleNodeProviders = allow;
    }

    public async start(): Promise<void> {
        this.guardSingleNodeProviders();

        this.logger.log("Starting workflow host...");

        // Mark single-node providers as started so a second host start in the same
        // process can detect mistaken sharing of the dev-only in-memory providers.
        if (this.lockProvider instanceof SingleNodeLockProvider) {
            this.lockProvider.markStarted(this.allowSingleNodeProviders);
        }
        if (this.queueProvider instanceof SingleNodeQueueProvider) {
            this.queueProvider.markStarted(this.allowSingleNodeProviders);
        }

        for (let worker of this.workers) {
            worker.start();
        }
        this.registerCleanCallbacks();
    }

    private guardSingleNodeProviders(): void {
        const lockIsSingleNode = this.lockProvider instanceof SingleNodeLockProvider;
        const queueIsSingleNode = this.queueProvider instanceof SingleNodeQueueProvider;
        const persistenceIsMemory = this.persistence.constructor.name === "MemoryPersistenceProvider";

        if (!this.allowSingleNodeProviders && !persistenceIsMemory && (lockIsSingleNode || queueIsSingleNode)) {
            throw new Error(
                "SingleNodeLockProvider/SingleNodeQueueProvider are dev-only and cannot be shared by " +
                "multiple workflow hosts. Use a distributed provider (e.g. @reactorynet/workflow-es-redis) " +
                "or call configureWorkflow().allowSingleNodeProviders(true) to override.");
        }
    }

    public stop() {
        this.logger.log("Stopping workflow host...");

        for (let worker of this.workers) {
            worker.stop();
        }
    }
    
    public async startWorkflow(id: string, version: number, data: any = {}): Promise<string> {
        let self = this;
        let def = self.registry.getDefinition(id, version);
        let wf = new WorkflowInstance();
        wf.data = data;
        wf.description = def.description;
        wf.workflowDefinitionId = def.id;
        wf.version = def.version;
        wf.nextExecution = 0;
        wf.createTime = new Date();
        wf.status = WorkflowStatus.Runnable;
        
        let ep = this.pointerFactory.buildGenesisPointer(def);
        wf.executionPointers.push(ep);
        
        let workflowId = await self.persistence.createNewWorkflow(wf);
        self.queueProvider.queueForProcessing(workflowId, QueueType.Workflow);

        return workflowId;
    }
    
    
    public registerWorkflow<TData>(workflow: new () => WorkflowBase<TData>) {
        this.registry.registerWorkflow<TData>(new workflow());
    }

    public async publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void> {
        //todo: check host status        

        this.logger.info("Publishing event %s %s", eventName, eventKey);

        let evt = new Event();
        evt.eventData = eventData;
        evt.eventKey = eventKey;
        evt.eventName = eventName;
        evt.eventTime = eventTime;
        evt.isProcessed = false;
        let id = await this.persistence.createEvent(evt);
        this.queueProvider.queueForProcessing(id, QueueType.Event);        
    }

    
    public async suspendWorkflow(id: string): Promise<boolean> {
        return this.mutateWorkflowStatus("suspending", id, (wf) => {
            if (wf.status == WorkflowStatus.Runnable) {
                wf.status = WorkflowStatus.Suspended;
                return true;
            }
            return false;
        });
    }

    public async resumeWorkflow(id: string): Promise<boolean> {
        return this.mutateWorkflowStatus("resuming", id, (wf) => {
            if (wf.status == WorkflowStatus.Suspended) {
                wf.status = WorkflowStatus.Runnable;
                return true;
            }
            return false;
        });
    }

    public async terminateWorkflow(id: string): Promise<boolean> {
        return this.mutateWorkflowStatus("terminating", id, (wf) => {
            wf.status = WorkflowStatus.Terminated;
            return true;
        });
    }

    /**
     * Locked load → mutate → persist for the public control methods. On a
     * WorkflowConcurrencyError (another node persisted first) the whole
     * load-mutate-persist sequence is retried exactly once; a second conflict
     * returns false (spec C1 §6.8). These methods never throw out of the public
     * surface — any error is logged and surfaced as false.
     */
    private async mutateWorkflowStatus(verb: string, id: string, mutate: (wf: WorkflowInstance) => boolean): Promise<boolean> {
        let self = this;
        try {
            let gotLock = await self.lockProvider.acquireLock(id);
            if (!gotLock)
                return false;

            try {
                for (let attempt = 0; attempt < 2; attempt++) {
                    let wf = await self.persistence.getWorkflowInstance(id);
                    if (!mutate(wf))
                        return false;
                    try {
                        await self.persistence.persistWorkflow(wf);
                        return true;
                    }
                    catch (persistErr) {
                        if (persistErr instanceof WorkflowConcurrencyError) {
                            // Reload and retry the whole sequence once.
                            continue;
                        }
                        throw persistErr;
                    }
                }
                return false;
            }
            finally {
                self.lockProvider.releaseLock(id);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error " + verb + " workflow: " + error.message);
            return false;
        }
    }
    
    private registerCleanCallbacks() {
        let self = this;

        if (typeof process !== 'undefined' && process) {
            process.on('SIGINT', () => {
                self.stop();
            });
        }
    }

}