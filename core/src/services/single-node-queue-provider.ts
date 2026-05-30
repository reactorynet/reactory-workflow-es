import { injectable } from "inversify";
import { IQueueProvider, QueueType } from "../abstractions";

@injectable()
export class SingleNodeQueueProvider implements IQueueProvider {
    private workflowQueue: string[] = [];
    private eventQueue: string[] = [];

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