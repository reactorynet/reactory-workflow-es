
export enum QueueType {
    Workflow = 0,
    Event = 1,
}

export interface IQueueProvider {
    queueForProcessing(id: string, queue: QueueType): Promise<void>;
    dequeueForProcessing(queue: QueueType): Promise<string>;
}
