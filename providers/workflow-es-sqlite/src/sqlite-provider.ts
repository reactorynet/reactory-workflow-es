import "reflect-metadata";
import {
    IPersistenceProvider,
    WorkflowInstance,
    ExecutionPointer as CoreExecutionPointer,
    EventSubscription,
    Event as CoreEvent,
    WorkflowStatus,
    WorkflowConcurrencyError,
    WorkflowInstanceQuery,
    WorkflowInstanceStats,
    WorkflowDefinitionRollup,
    WorkflowTimeSeriesQuery,
    WorkflowTimeSeriesPoint,
    PointerStatus
} from "@reactorynet/workflow-es";
import { Sequelize } from "sequelize-typescript";
import { Op, fn, col, cast, literal, where as sqlWhere, WhereOptions } from "sequelize";
import { Workflow } from "./models/workflow";
import { ExecutionPointer } from "./models/executionPointer";
import { Subscription } from "./models/subscription";
import { Event as EventModel } from "./models/event";

/** Extra Sequelize options merged over the defaults (logging, pool, etc.). */
export interface SqlitePersistenceOptions {
    [key: string]: any;
}

/**
 * SQLite persistence provider for Workflow ES, built on Sequelize 6 +
 * sequelize-typescript with the `sqlite3` driver. Mirrors the contract
 * of the in-memory provider: workflows own their execution pointers and are
 * persisted as a unit. Durability comes from WAL mode (enabled on connect).
 *
 * Usage:
 *   const persistence = new SqlitePersistence("/abs/path/workflow.db");
 *   await persistence.connect;
 *   config.usePersistence(persistence);
 *
 * Pass ":memory:" as the filename for an in-process ephemeral database (tests only).
 * The directory for a file-backed database must exist; this provider does NOT
 * create directories.
 */
export class SqlitePersistence implements IPersistenceProvider {
    public sequelize: Sequelize;
    public connect: Promise<void>;

    /**
     * @param filename Absolute path to the SQLite database file, or ":memory:".
     *                 The directory must already exist (this class does NOT create it).
     * @param options  Extra Sequelize options merged over the defaults.
     */
    constructor(filename: string, options: SqlitePersistenceOptions = {}) {
        // Sequelize 6's SQLite dialect uses the `sqlite3` npm package as its connection driver.
        // `sqlite3` is a native module: an Electron app must rebuild it for the target ABI
        // (e.g. via electron-rebuild) — see README § Electron packaging.
        this.sequelize = new Sequelize({
            dialect: "sqlite",
            storage: filename,  // ":memory:" or an absolute file path
            logging: false,
            models: [Workflow, ExecutionPointer, Subscription, EventModel],
            ...options
        } as any);

        this.connect = new Promise<void>(async (resolve, reject) => {
            try {
                await this.sequelize.authenticate();
                // WAL mode: durability + concurrent readers during a write.
                // This pragma persists in the file header — safe to set on every open.
                // P3.4 — SQLite is SINGLE-HOST only. WAL allows concurrent readers but still a single
                // writer; multiple workflow hosts sharing one SQLite file serialize writes at the OS
                // level and will surface "database is locked" under load. For multi-host deployments
                // use PostgreSQL/MySQL with a distributed lock provider (Redis/Azure). SQLite has no
                // cross-process distributed lock and must not be shared across hosts.
                await this.sequelize.query("PRAGMA journal_mode=WAL;");
                await this.sequelize.query("PRAGMA foreign_keys=ON;");
                await this.sequelize.sync();
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
        instance.concurrencyToken = 0;
        const workflow = await Workflow.create(instance as any, { include: [ExecutionPointer] });
        instance.id = workflow.id.toString();
        return instance.id;
    }

    public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
        const expected = instance.concurrencyToken ?? 0;
        await this.sequelize.transaction(async (transaction) => {
            // Compare-and-set on the concurrency token. The update only matches when the
            // stored token equals the expected token; 0 affected rows means another node
            // wrote first, so reject (the transaction rolls back the pointer changes too).
            const [affectedCount] = await Workflow.update(
                {
                    workflowDefinitionId: instance.workflowDefinitionId,
                    version: instance.version,
                    description: instance.description,
                    nextExecution: instance.nextExecution,
                    status: instance.status,
                    data: instance.data,
                    createTime: instance.createTime,
                    completeTime: instance.completeTime,
                    concurrencyToken: expected + 1
                } as any,
                { where: { id: instance.id, concurrencyToken: expected }, transaction }
            );

            if (affectedCount === 0) {
                throw new WorkflowConcurrencyError(instance.id, expected);
            }

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

        // Transaction committed: refresh the in-memory token so the caller can persist
        // the same instance again without reloading.
        instance.concurrencyToken = expected + 1;
    }

    public async getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
        const workflow = await Workflow.findByPk(workflowId, { include: [ExecutionPointer] });
        if (!workflow) {
            return undefined;
        }
        return this.toWorkflowInstance(workflow);
    }

    public async getRunnableInstances(tenantId?: string): Promise<Array<string>> {
        const instances = await Workflow.findAll({
            where: {
                status: WorkflowStatus.Runnable,
                nextExecution: { [Op.lt]: Date.now() },
                ...(tenantId !== undefined ? { tenantId } : {})
            },
            attributes: ["id"]
        });
        return instances.map((instance) => instance.id.toString());
    }

    public async createEventSubscription(subscription: EventSubscription): Promise<void> {
        const created = await Subscription.create(subscription as any);
        subscription.id = created.id.toString();
    }

    public async getSubscriptions(tenantId: string, eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>> {
        const subscriptions = await Subscription.findAll({
            where: {
                tenantId: tenantId,
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

    public async getRunnableEvents(tenantId?: string): Promise<Array<string>> {
        const events = await EventModel.findAll({
            where: {
                isProcessed: false,
                eventTime: { [Op.lte]: new Date() },
                ...(tenantId !== undefined ? { tenantId } : {})
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

    public async getEvents(tenantId: string, eventName: string, eventKey: any, asOf: Date): Promise<Array<string>> {
        const events = await EventModel.findAll({
            where: {
                tenantId: tenantId,
                eventName: eventName,
                eventKey: eventKey,
                eventTime: { [Op.gte]: asOf }
            },
            attributes: ["id"]
        });
        return events.map((event) => event.id.toString());
    }

    // ── M9 — query / stats / time-series / delete ─────────────────────────────
    // Same shape as the Postgres provider via the sqlite dialect: findAndCountAll
    // for the filtered query; GROUP BY aggregations via fn/col/literal; day bucket
    // via strftime('%Y-%m-%d', createTime); average over julianday() diff (×86400000
    // → ms). destroy for hard deletes (owned pointers removed in the same txn).
    // Read/delete-only: never touches concurrencyToken or events/subscriptions.

    public async queryWorkflowInstances(query: WorkflowInstanceQuery): Promise<{ instances: WorkflowInstance[]; total: number }> {
        const where = this.buildWhere(query);
        const sortField = query.sortField ?? "createTime";
        const sortOrder = (query.sortOrder ?? "desc").toUpperCase() as "ASC" | "DESC";
        const skip = Math.max(0, query.skip ?? 0);
        const take = Math.min(query.take ?? 50, 500);

        const { rows, count } = await Workflow.findAndCountAll({
            where,
            include: [ExecutionPointer],
            order: [[sortField, sortOrder], ["id", "ASC"]],
            offset: skip,
            limit: take,
            distinct: true
        });

        return {
            instances: rows.map((model) => this.toWorkflowInstance(model)),
            total: count
        };
    }

    public async getWorkflowInstanceStats(query: WorkflowInstanceQuery & { topDefinitions?: number } = {}): Promise<WorkflowInstanceStats> {
        const where = this.buildWhere(query);
        const topDefinitions = query.topDefinitions ?? 20;

        const statusRows: any[] = await Workflow.findAll({
            where,
            attributes: ["status", [fn("COUNT", col("id")), "cnt"]],
            group: ["status"],
            raw: true
        });
        const byStatus: Record<number, number> = {};
        let total = 0;
        for (const r of statusRows) {
            const n = Number(r.cnt);
            byStatus[Number(r.status)] = n;
            total += n;
        }

        // averageCompletionTimeMs over Complete instances. SQLite julianday() yields
        // fractional days; ×86400000 converts the difference to milliseconds.
        const avgRow: any = await Workflow.findOne({
            where: { ...where, status: WorkflowStatus.Complete, completeTime: { [Op.ne]: null } } as WhereOptions,
            attributes: [[fn("AVG", literal('(julianday(completeTime) - julianday(createTime)) * 86400000')), "avgMs"]],
            raw: true
        });
        const averageCompletionTimeMs = avgRow && avgRow.avgMs != null ? Number(avgRow.avgMs) : null;

        const defRows: any[] = await Workflow.findAll({
            where,
            attributes: [
                "workflowDefinitionId",
                [fn("COUNT", col("id")), "total"],
                [fn("SUM", literal(`CASE WHEN status = ${WorkflowStatus.Complete} THEN 1 ELSE 0 END`)), "complete"],
                [fn("SUM", literal(`CASE WHEN status = ${WorkflowStatus.Terminated} THEN 1 ELSE 0 END`)), "terminated"]
            ],
            group: ["workflowDefinitionId"],
            order: [[literal("total"), "DESC"], ["workflowDefinitionId", "ASC"]],
            limit: topDefinitions,
            raw: true
        });
        const byDefinition: WorkflowDefinitionRollup[] = defRows.map((r) => ({
            workflowDefinitionId: r.workflowDefinitionId,
            total: Number(r.total),
            complete: Number(r.complete),
            terminated: Number(r.terminated)
        }));

        const failedRows: any[] = await Workflow.findAll({
            where: { ...where, status: { [Op.ne]: WorkflowStatus.Terminated } } as WhereOptions,
            include: [{
                model: ExecutionPointer,
                attributes: [],
                where: { status: PointerStatus.Failed },
                required: true
            }],
            attributes: [
                "workflowDefinitionId",
                [fn("COUNT", fn("DISTINCT", col("Workflow.id"))), "cnt"]
            ],
            group: ["workflowDefinitionId"],
            raw: true
        });
        const instancesWithFailedSteps: Record<string, number> = {};
        for (const r of failedRows) {
            instancesWithFailedSteps[r.workflowDefinitionId] = Number(r.cnt);
        }

        return { total, byStatus, averageCompletionTimeMs, byDefinition, instancesWithFailedSteps };
    }

    public async getWorkflowInstanceTimeSeries(query: WorkflowTimeSeriesQuery): Promise<WorkflowTimeSeriesPoint[]> {
        const where: WhereOptions = {
            createTime: { [Op.gte]: query.from, [Op.lte]: query.to },
            ...(query.tenantId !== undefined ? { tenantId: query.tenantId } : {})
        };
        // Sequelize stores DATE as a UTC ISO-8601 string in SQLite, so strftime over
        // the raw column yields the correct UTC day bucket.
        const dayExpr = literal("strftime('%Y-%m-%d', createTime)");
        const rows: any[] = await Workflow.findAll({
            where,
            attributes: [
                [dayExpr, "day"],
                [fn("COUNT", col("id")), "total"],
                [fn("SUM", literal(`CASE WHEN status = ${WorkflowStatus.Complete} THEN 1 ELSE 0 END`)), "complete"],
                [fn("SUM", literal(`CASE WHEN status = ${WorkflowStatus.Terminated} THEN 1 ELSE 0 END`)), "terminated"]
            ],
            group: [dayExpr as any],
            order: [[literal("day"), "ASC"]],
            raw: true
        });
        return rows.map((r) => ({
            date: r.day,
            total: Number(r.total),
            complete: Number(r.complete),
            terminated: Number(r.terminated)
        }));
    }

    public async deleteWorkflowInstance(id: string): Promise<boolean> {
        return this.sequelize.transaction(async (transaction) => {
            await ExecutionPointer.destroy({ where: { workflowId: id }, transaction });
            const removed = await Workflow.destroy({ where: { id }, transaction });
            return removed > 0;
        });
    }

    public async deleteWorkflowInstances(ids: string[]): Promise<number> {
        if (!ids || ids.length === 0) return 0;
        return this.sequelize.transaction(async (transaction) => {
            await ExecutionPointer.destroy({ where: { workflowId: { [Op.in]: ids } }, transaction });
            return Workflow.destroy({ where: { id: { [Op.in]: ids } }, transaction });
        });
    }

    public async deleteWorkflowInstancesByDefinitionId(workflowDefinitionId: string, tenantId?: string): Promise<number> {
        return this.sequelize.transaction(async (transaction) => {
            const wfWhere: WhereOptions = {
                workflowDefinitionId,
                ...(tenantId !== undefined ? { tenantId } : {})
            };
            const matching = await Workflow.findAll({ where: wfWhere, attributes: ["id"], transaction });
            const matchingIds = matching.map((m) => m.id);
            if (matchingIds.length > 0) {
                await ExecutionPointer.destroy({ where: { workflowId: { [Op.in]: matchingIds } }, transaction });
            }
            return Workflow.destroy({ where: wfWhere, transaction });
        });
    }

    /** Translate a WorkflowInstanceQuery into a Sequelize where clause (AND of all provided filters). */
    private buildWhere(query: WorkflowInstanceQuery): WhereOptions {
        const where: any = {};

        if (query.tenantId !== undefined) where.tenantId = query.tenantId;

        if (query.workflowDefinitionId !== undefined) {
            if (query.workflowDefinitionId.indexOf("*") >= 0) {
                where.workflowDefinitionId = { [Op.like]: query.workflowDefinitionId.replace(/\*/g, "%") };
            } else {
                where.workflowDefinitionId = query.workflowDefinitionId;
            }
        }

        if (query.status !== undefined) {
            where.status = Array.isArray(query.status) ? { [Op.in]: query.status } : query.status;
        }

        const createTime: any = {};
        if (query.createdAfter !== undefined) createTime[Op.gte] = query.createdAfter;
        if (query.createdBefore !== undefined) createTime[Op.lte] = query.createdBefore;
        if (Object.getOwnPropertySymbols(createTime).length > 0) where.createTime = createTime;

        const completeTime: any = {};
        if (query.completedAfter !== undefined) completeTime[Op.gte] = query.completedAfter;
        if (query.completedBefore !== undefined) completeTime[Op.lte] = query.completedBefore;
        if (Object.getOwnPropertySymbols(completeTime).length > 0) where.completeTime = completeTime;

        if (query.searchTerm !== undefined && query.searchTerm !== "") {
            const term = `%${query.searchTerm}%`;
            // SQLite LIKE is case-insensitive for ASCII by default — matches the
            // case-insensitive contract. id is a UUID; CAST to TEXT before matching.
            // Qualify with the model alias so the reference is unambiguous when joined.
            where[Op.or] = [
                { workflowDefinitionId: { [Op.like]: term } },
                { description: { [Op.like]: term } },
                sqlWhere(cast(col("Workflow.id"), "TEXT"), { [Op.like]: term })
            ];
        }

        return where as WhereOptions;
    }

    // ── Model → domain mappers ────────────────────────────────────────────────
    // Copied verbatim from the Postgres provider (dialect-independent).

    private toWorkflowInstance(model: Workflow): WorkflowInstance {
        const instance = new WorkflowInstance();
        instance.id = model.id;
        instance.tenantId = model.tenantId;
        instance.workflowDefinitionId = model.workflowDefinitionId;
        instance.version = model.version;
        instance.description = model.description;
        instance.nextExecution = model.nextExecution;
        instance.status = model.status;
        instance.data = model.data;
        instance.createTime = model.createTime;
        instance.completeTime = model.completeTime;
        instance.concurrencyToken = model.concurrencyToken ?? 0;
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
        subscription.tenantId = model.tenantId;
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
        event.tenantId = model.tenantId;
        event.eventName = model.eventName;
        event.eventKey = model.eventKey;
        event.eventData = model.eventData;
        event.eventTime = model.eventTime;
        event.isProcessed = model.isProcessed;
        return event;
    }
}
