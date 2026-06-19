import { injectable } from "inversify";
import { IQueueProvider, QueueType } from "@reactorynet/workflow-es";
import { Redis } from "ioredis";

/**
 * Queue provider backed by Redis lists.
 *
 * - queueForProcessing LPUSHes the id onto the head of the queue list.
 * - dequeueForProcessing RPOPs the tail (FIFO) and atomically pushes it onto a
 *   per-queue processing list (RPOPLPUSH) so an id that is dequeued but not yet
 *   completed survives a node crash (a reaper that drains the processing list back
 *   is out of scope for C1 — documented here). Returns null when the queue is empty.
 */
@injectable()
export class RedisQueueProvider implements IQueueProvider {

    private workflowQueue: string = "wes:queue:workflow";
    private eventQueue: string = "wes:queue:event";
    private workflowProcessing: string = "wes:processing:workflow";
    private eventProcessing: string = "wes:processing:event";
    private redis: Redis;

    constructor(connection: Redis) {
        this.redis = connection;
    }

    public async queueForProcessing(id: string, queue: QueueType): Promise<void> {
        await this.redis.lpush(this.getQueueName(queue), id);
    }

    public async dequeueForProcessing(queue: QueueType): Promise<string> {
        // Reliable pop: move the tail of the queue onto the processing list atomically.
        const result = await this.redis.rpoplpush(this.getQueueName(queue), this.getProcessingName(queue));
        return result === null ? null : result;
    }

    private getQueueName(queue: QueueType): string {
        switch (queue) {
            case QueueType.Workflow: return this.workflowQueue;
            case QueueType.Event: return this.eventQueue;
            default: return this.workflowQueue;
        }
    }

    private getProcessingName(queue: QueueType): string {
        switch (queue) {
            case QueueType.Workflow: return this.workflowProcessing;
            case QueueType.Event: return this.eventProcessing;
            default: return this.workflowProcessing;
        }
    }
}
