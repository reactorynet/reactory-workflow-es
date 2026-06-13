
export enum QueueType {
    Workflow = 0,
    Event = 1,
}

export interface IQueueProvider {
    queueForProcessing(id: string, queue: QueueType): Promise<void>;
    dequeueForProcessing(queue: QueueType): Promise<string>;
    /**
     * OPTIONAL. Current number of items waiting in the given queue. Used only for the
     * workflowes.queue.depth gauge. Optional so existing providers need not implement it;
     * when absent, the depth gauge is simply not recorded.
     */
    getQueueLength?(queue: QueueType): Promise<number>;
}
