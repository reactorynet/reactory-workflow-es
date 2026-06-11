import {
    IPersistenceProvider,
    WorkflowInstance,
    ExecutionPointer as CoreExecutionPointer,
    EventSubscription,
    Event as CoreEvent,
    WorkflowStatus
} from "@reactorynet/workflow-es";
import { Sequelize } from "sequelize-typescript";
import { Op } from "sequelize";
import { Workflow } from "./models/workflow";
import { ExecutionPointer } from "./models/executionPointer";
import { Subscription } from "./models/subscription";
import { Event as EventModel } from "./models/event";

/**
 * PostgreSQL persistence provider for Workflow ES, built on Sequelize 6 +
 * sequelize-typescript. Mirrors the contract of the in-memory provider:
 * workflows own their execution pointers and are persisted as a unit.
 */
export class PostgresPersistence implements IPersistenceProvider {
    public sequelize: Sequelize;
    public connect: Promise<void>;

    /**
     * @param connectionString a postgres connection URI, e.g.
     *   `postgres://user:password@host:5432/database`
     * @param options additional Sequelize options (pool, schema, logging, ...)
     */
    constructor(connectionString: string, options: any = {}) {
        this.sequelize = new Sequelize(connectionString, {
            dialect: "postgres",
            logging: false,
            models: [Workflow, ExecutionPointer, Subscription, EventModel],
            ...options
        });

        this.connect = new Promise<void>(async (resolve, reject) => {
            try {
                await this.sequelize.authenticate();
                await this.sequelize.sync();
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
        const workflow = await Workflow.create(instance as any, { include: [ExecutionPointer] });
        instance.id = workflow.id.toString();
        return instance.id;
    }

    public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
        await this.sequelize.transaction(async (transaction) => {
            await Workflow.update(
                {
                    workflowDefinitionId: instance.workflowDefinitionId,
                    version: instance.version,
                    description: instance.description,
                    nextExecution: instance.nextExecution,
                    status: instance.status,
                    data: instance.data,
                    createTime: instance.createTime,
                    completeTime: instance.completeTime
                } as any,
                { where: { id: instance.id }, transaction }
            );

            // Execution pointers are owned by the workflow; replace them wholesale
            // so removed/added/mutated pointers are all reflected. Pointer ids are
            // assigned by the core factory (crypto.randomUUID) and preserved here.
            await ExecutionPointer.destroy({ where: { workflowId: instance.id }, transaction });

            const pointers = (instance.executionPointers || []).map(
                (pointer) => ({ ...pointer, workflowId: instance.id })
            );
            if (pointers.length > 0) {
                await ExecutionPointer.bulkCreate(pointers as any, { transaction });
            }
        });
    }

    public async getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
        const workflow = await Workflow.findByPk(workflowId, { include: [ExecutionPointer] });
        if (!workflow) {
            return undefined;
        }
        return this.toWorkflowInstance(workflow);
    }

    public async getRunnableInstances(): Promise<Array<string>> {
        const instances = await Workflow.findAll({
            where: {
                status: WorkflowStatus.Runnable,
                nextExecution: { [Op.lt]: Date.now() }
            },
            attributes: ["id"]
        });
        return instances.map((instance) => instance.id.toString());
    }

    public async createEventSubscription(subscription: EventSubscription): Promise<void> {
        const created = await Subscription.create(subscription as any);
        subscription.id = created.id.toString();
    }

    public async getSubscriptions(eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>> {
        const subscriptions = await Subscription.findAll({
            where: {
                eventName: eventName,
                eventKey: eventKey,
                subscribeAsOf: { [Op.lte]: asOf }
            }
        });
        return subscriptions.map((model) => this.toEventSubscription(model));
    }

    public async terminateSubscription(id: string): Promise<void> {
        await Subscription.destroy({ where: { id: id } });
    }

    public async createEvent(event: CoreEvent): Promise<string> {
        const created = await EventModel.create(event as any);
        event.id = created.id.toString();
        return event.id;
    }

    public async getEvent(id: string): Promise<CoreEvent> {
        const event = await EventModel.findByPk(id);
        if (!event) {
            return undefined;
        }
        return this.toEvent(event);
    }

    public async getRunnableEvents(): Promise<Array<string>> {
        const events = await EventModel.findAll({
            where: {
                isProcessed: false,
                eventTime: { [Op.lte]: new Date() }
            },
            attributes: ["id"]
        });
        return events.map((event) => event.id.toString());
    }

    public async markEventProcessed(id: string): Promise<void> {
        await EventModel.update({ isProcessed: true }, { where: { id: id } });
    }

    public async markEventUnprocessed(id: string): Promise<void> {
        await EventModel.update({ isProcessed: false }, { where: { id: id } });
    }

    public async getEvents(eventName: string, eventKey: any, asOf: Date): Promise<Array<string>> {
        const events = await EventModel.findAll({
            where: {
                eventName: eventName,
                eventKey: eventKey,
                eventTime: { [Op.gte]: asOf }
            },
            attributes: ["id"]
        });
        return events.map((event) => event.id.toString());
    }

    // ── Model → domain mappers ────────────────────────────────────────────────

    private toWorkflowInstance(model: Workflow): WorkflowInstance {
        const instance = new WorkflowInstance();
        instance.id = model.id;
        instance.workflowDefinitionId = model.workflowDefinitionId;
        instance.version = model.version;
        instance.description = model.description;
        instance.nextExecution = model.nextExecution;
        instance.status = model.status;
        instance.data = model.data;
        instance.createTime = model.createTime;
        instance.completeTime = model.completeTime;
        instance.executionPointers = (model.executionPointers || []).map(
            (pointer) => this.toExecutionPointer(pointer)
        );
        return instance;
    }

    private toExecutionPointer(model: ExecutionPointer): CoreExecutionPointer {
        const pointer = new CoreExecutionPointer();
        pointer.id = model.id;
        pointer.stepId = model.stepId;
        pointer.active = model.active;
        pointer.sleepUntil = model.sleepUntil;
        pointer.persistenceData = model.persistenceData;
        pointer.startTime = model.startTime;
        pointer.endTime = model.endTime;
        pointer.eventName = model.eventName;
        pointer.eventKey = model.eventKey;
        pointer.eventPublished = model.eventPublished;
        pointer.eventData = model.eventData;
        pointer.outcome = model.outcome;
        pointer.stepName = model.stepName;
        pointer.retryCount = model.retryCount;
        pointer.children = model.children;
        pointer.contextItem = model.contextItem;
        pointer.predecessorId = model.predecessorId;
        pointer.scope = model.scope;
        pointer.status = model.status;
        return pointer;
    }

    private toEventSubscription(model: Subscription): EventSubscription {
        const subscription = new EventSubscription();
        subscription.id = model.id;
        subscription.workflowId = model.workflowId;
        subscription.stepId = model.stepId;
        subscription.eventName = model.eventName;
        subscription.eventKey = model.eventKey;
        subscription.subscribeAsOf = model.subscribeAsOf;
        return subscription;
    }

    private toEvent(model: EventModel): CoreEvent {
        const event = new CoreEvent();
        event.id = model.id;
        event.eventName = model.eventName;
        event.eventKey = model.eventKey;
        event.eventData = model.eventData;
        event.eventTime = model.eventTime;
        event.isProcessed = model.isProcessed;
        return event;
    }
}
