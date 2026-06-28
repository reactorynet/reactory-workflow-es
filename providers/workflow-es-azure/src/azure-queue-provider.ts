import { injectable, inject } from "inversify";
import { QueueService, createQueueService, ErrorOrResult, ErrorOrResponse, ServiceResponse } from "azure-storage";
import { IQueueProvider, QueueType, TYPES, ILogger } from '@reactorynet/workflow-es';

@injectable()
export class AzureQueueProvider implements IQueueProvider {

    private queueService: QueueService;
    private workflowQueue: string = 'workflows';
    private eventQueue: string = 'events';

    constructor(connectionString: string) {
        this.queueService = createQueueService(connectionString);
        this.queueService.createQueueIfNotExists(this.workflowQueue, (error: Error, result: QueueService.QueueResult, response: ServiceResponse): void => {
            //TODO: log
        });
        this.queueService.createQueueIfNotExists(this.eventQueue, (error: Error, result: QueueService.QueueResult, response: ServiceResponse): void => {
            //TODO: log
        });
    }

    public queueForProcessing(id: string, queue: any): Promise<void> {
        var self = this;
        let queueName = this.getQueueName(queue);
        
        return new Promise<void>((resolve, reject) => {
            self.queueService.createMessage(queueName, id, (error: Error, result: QueueService.QueueMessageResult, response: ServiceResponse): void => {
                resolve();
            });
        });
    }

    // P1.5: this deletes the message immediately on receipt, so a crash mid-processing drops the
    // dequeued id from the queue. This is NOT silently fixed here on purpose: a correct
    // delete-after-success requires an ack/complete step on IQueueProvider (a cross-provider contract
    // change — the Redis provider has the same gap: its RPOPLPUSH "processing" list is never drained
    // back by a reaper). In practice the PollWorker is the durability backstop — getRunnableInstances()
    // / getRunnableEvents() re-discover and re-queue work that was lost from the queue, since the
    // underlying instance/event is still Runnable/unprocessed in persistence. Tracked as P1.5 (deferred,
    // pending an IQueueProvider ack contract).
    public dequeueForProcessing(queue: any): Promise<string> {
        let queueName = this.getQueueName(queue);
        var self = this;

        return new Promise<string>((resolve, reject) => {
            self.queueService.getMessage(queueName, (error: Error, result: QueueService.QueueMessageResult, response: ServiceResponse): void => {
                
                if (!response.isSuccessful) {
                    reject(error.message);
                }
                
                if (!result) {
                    resolve(null);
                }
                else {
                    self.queueService.deleteMessage(queueName, result.messageId, result.popReceipt, (error: Error, response: ServiceResponse): void => {
                        //TODO: log
                    });
                    resolve(result.messageText);
                }
            });
        });
    }

    private getQueueName(queue: any): string {
        switch (queue) {
            case QueueType.Workflow:
                return this.workflowQueue;
            case QueueType.Event:
                return this.eventQueue;
            default:
                // P2.5: fail loudly on an unknown QueueType instead of returning '' (which would
                // silently send to / read from a non-existent queue). Matches the Redis provider's
                // having an explicit default branch.
                throw new Error(`AzureQueueProvider: unknown QueueType '${String(queue)}'`);
        }
    }
}