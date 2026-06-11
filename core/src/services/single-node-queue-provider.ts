import { injectable } from "inversify";
import { IQueueProvider, QueueType } from "../abstractions";

@injectable()
export class SingleNodeQueueProvider implements IQueueProvider {
    private workflowQueue: string[] = [];
    private eventQueue: string[] = [];
    private started: boolean = false;

    /**
     * Dev-only fail-loud guard. The first WorkflowHost.start() on this singleton marks it
     * started. A second host starting on the same singleton instance (the realistic
     * in-process multi-host case) throws unless single-node providers were explicitly
     * allowed. See spec C1 §6.9.
     */
    public markStarted(allowSingleNodeProviders: boolean): void {
        if (this.started && !allowSingleNodeProviders) {
            throw new Error(
                "SingleNodeLockProvider/SingleNodeQueueProvider are dev-only and cannot be shared by " +
                "multiple workflow hosts. Use a distributed provider (e.g. @reactorynet/workflow-es-redis) " +
                "or call configureWorkflow().allowSingleNodeProviders(true) to override.");
        }
        this.started = true;
    }

    public async queueForProcessing(id: string, queue: QueueType): Promise<void> {
        switch (queue) {
            case QueueType.Workflow:
                this.workflowQueue.push(id);
                break;
            case QueueType.Event:
                this.eventQueue.push(id);
                break;
        }
    }

    public async dequeueForProcessing(queue: QueueType): Promise<string> {
        switch (queue) {
            case QueueType.Workflow:
                return this.workflowQueue.shift();
            case QueueType.Event:
                return this.eventQueue.shift();
        }
    }
}