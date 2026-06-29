import {
    IPersistenceProvider,
    WorkflowInstance,
    EventSubscription,
    Event,
    WorkflowStatus,
    WorkflowConcurrencyError,
    DEFAULT_TENANT,
    WorkflowInstanceQuery,
    WorkflowInstanceStats,
    WorkflowDefinitionRollup,
    WorkflowTimeSeriesQuery,
    WorkflowTimeSeriesPoint,
    PointerStatus
} from "@reactorynet/workflow-es";
import { MongoClient, ObjectId, Collection, Db, Filter } from "mongodb";

export class MongoDBPersistence implements IPersistenceProvider {

    public connect: Promise<void>;
    private client: MongoClient;
    private db: Db;
    private workflowCollection: Collection;
    private subscriptionCollection: Collection;
    private eventCollection: Collection;

    /**
     * @param connectionString  MongoDB connection URI, e.g.
     *   `mongodb://127.0.0.1:27017/workflow-es`
     * @param options  Optional MongoClientOptions forwarded to MongoClient.
     *   Driver v4+ removed `useNewUrlParser` / `useUnifiedTopology` (both are
     *   now the default and are ignored if supplied). Do not pass them.
     */
    constructor(connectionString: string, options: any = {}) {
        this.connect = (async () => {
            this.client = await MongoClient.connect(connectionString, options);
            this.db = this.client.db();
            this.workflowCollection  = this.db.collection("workflows");
            this.subscriptionCollection = this.db.collection("subscriptions");
            this.eventCollection = this.db.collection("events");

            // M2: create the four mandated access-pattern indexes idempotently.
            // createIndex with the same key spec is a no-op on MongoDB — safe to call on
            // every connect. tenantId leads each spec (equality-before-range, per M6).
            // Canonical stable names so operational tooling can detect them uniformly.

            // 1. getRunnableInstances: status===Runnable && nextExecution<now [&& tenantId==t]
            await this.workflowCollection.createIndex(
                { tenantId: 1, status: 1, nextExecution: 1 },
                { name: "idx_workflows_status_next_execution" }
            );

            // 2. getRunnableEvents: !isProcessed && eventTime<=now [&& tenantId==t]
            await this.eventCollection.createIndex(
                { tenantId: 1, isProcessed: 1, eventTime: 1 },
                { name: "idx_events_isprocessed_eventtime" }
            );

            // 3. getEvents: tenantId==t && eventName==n && eventKey==k && eventTime>=asOf
            await this.eventCollection.createIndex(
                { tenantId: 1, eventName: 1, eventKey: 1, eventTime: 1 },
                { name: "idx_events_name_key_eventtime" }
            );

            // 4. getSubscriptions: tenantId==t && eventName==n && eventKey==k && subscribeAsOf<=asOf
            await this.subscriptionCollection.createIndex(
                { tenantId: 1, eventName: 1, eventKey: 1, subscribeAsOf: 1 },
                { name: "idx_subscriptions_name_key_subscribeasof" }
            );
        })();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Parse `id` into an ObjectId, returning null for invalid/non-hex ids. */
    private toObjectId(id: string): ObjectId | null {
        try {
            return new ObjectId(id);
        } catch {
            return null;
        }
    }

    // ── Workflows ─────────────────────────────────────────────────────────────

    /**
     * Insert a new workflow instance.
     * C1: stamps concurrencyToken = 0 before the first write.
     * Resolves with the generated id string. Rejects on any insert error.
     */
    public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
        instance.concurrencyToken = 0;
        // Persist the domain `id` (= stringified _id) alongside _id, so consumers that
        // read/query by the string `id` field behave the same as the SQL providers
        // (which store id as a column). Without this, a Mongo doc has only `_id` and any
        // reader expecting a non-null string `id` (e.g. the Reactory execution-history
        // view) drops the row. persistWorkflow leaves this field intact (it deletes `id`
        // from its $set), so the value is stable for the life of the instance.
        const _id = new ObjectId();
        instance.id = _id.toString();
        // M6: MongoDB has no column defaults, so stamp the tenant sentinel here to
        // match the SQL providers (tenantId NOT NULL DEFAULT 'default'); otherwise a
        // doc with no tenantId is invisible to the tenant-scoped queries.
        await this.workflowCollection.insertOne({
            ...(instance as any),
            _id,
            tenantId: instance.tenantId ?? DEFAULT_TENANT,
        });
        return instance.id;
    }

    /**
     * Compare-and-set persist.
     * Filters on { _id, concurrencyToken: expected }, increments the token.
     * If no document matched (concurrent writer advanced the token), throws
     * WorkflowConcurrencyError (C1 contract).
     * On success, advances the in-memory token so the same instance can be
     * persisted again without a re-read.
     *
     * P3.3 — Atomicity of execution pointers: pointers are stored as an EMBEDDED array on the
     * workflow document (not a separate collection). The single `$set` of the whole instance below
     * therefore updates the workflow row and ALL its pointers atomically in one document write.
     * Do NOT refactor pointer updates into a separate operation — that would break this atomicity
     * and the optimistic-concurrency guarantee.
     */
    public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
        const id = new ObjectId(instance.id);
        const expected = instance.concurrencyToken ?? 0;
        const next = expected + 1;

        const update = { ...instance } as any;
        delete update._id;   // never $set _id
        delete update.id;    // domain id is the stringified _id
        update.concurrencyToken = next;

        const result = await this.workflowCollection.findOneAndUpdate(
            { _id: id, concurrencyToken: expected },   // compare-and-set
            { $set: update },
            { returnDocument: "after" }
        );

        if (!result) {
            // No document matched the (id, expectedToken) filter — a concurrent
            // writer advanced the token first, or the row is gone.
            throw new WorkflowConcurrencyError(instance.id, expected);
        }

        // Reflect the new token in memory so the caller can persist again.
        instance.concurrencyToken = next;
    }

    /**
     * Load a workflow instance by id.
     * Returns undefined (not throws) for an unknown id, including invalid
     * ObjectId strings (conformance §6.12).
     */
    public async getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
        const oid = this.toObjectId(workflowId);
        if (!oid) return undefined;

        const doc = await this.workflowCollection.findOne({ _id: oid });
        if (!doc) return undefined;

        (doc as any).id = doc._id.toString();
        return doc as any;
    }

    /** Return ids of Runnable workflows whose nextExecution is in the past. */
    public async getRunnableInstances(tenantId?: string): Promise<Array<string>> {
        const data = await this.workflowCollection
            .find({
                status: WorkflowStatus.Runnable,
                nextExecution: { $lt: Date.now() },
                ...(tenantId !== undefined ? { tenantId } : {})
            })
            .project({ _id: 1 })
            .toArray();
        return data.map((item) => item._id.toString());
    }

    // ── Event subscriptions ───────────────────────────────────────────────────

    public async createEventSubscription(subscription: EventSubscription): Promise<void> {
        // M6: default the tenant sentinel on write (see createNewWorkflow).
        const result = await this.subscriptionCollection.insertOne({
            ...(subscription as any),
            tenantId: subscription.tenantId ?? DEFAULT_TENANT,
        });
        subscription.id = result.insertedId.toString();
    }

    public async getSubscriptions(
        tenantId: string,
        eventName: string,
        eventKey: string,
        asOf: Date
    ): Promise<Array<EventSubscription>> {
        const data = await this.subscriptionCollection
            .find({ tenantId, eventName, eventKey, subscribeAsOf: { $lte: asOf } })
            .toArray();
        return data.map((item) => {
            (item as any).id = item._id.toString();
            return item as any;
        });
    }

    /** Delete one subscription by id. Idempotent — no error on missing id. */
    public async terminateSubscription(id: string): Promise<void> {
        const oid = this.toObjectId(id);
        if (!oid) return;
        await this.subscriptionCollection.deleteOne({ _id: oid });
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public async createEvent(event: Event): Promise<string> {
        // M6: default the tenant sentinel on write (see createNewWorkflow).
        const result = await this.eventCollection.insertOne({
            ...(event as any),
            tenantId: event.tenantId ?? DEFAULT_TENANT,
        });
        event.id = result.insertedId.toString();
        return event.id;
    }

    /**
     * Load an event by id.
     * Returns undefined (not throws) for an unknown or invalid id.
     */
    public async getEvent(id: string): Promise<Event> {
        const oid = this.toObjectId(id);
        if (!oid) return undefined;

        const doc = await this.eventCollection.findOne({ _id: oid });
        if (!doc) return undefined;

        (doc as any).id = doc._id.toString();
        return doc as any;
    }

    /** Return ids of unprocessed events whose eventTime is in the past. */
    public async getRunnableEvents(tenantId?: string): Promise<Array<string>> {
        const data = await this.eventCollection
            .find({
                isProcessed: false,
                eventTime: { $lt: new Date() },
                ...(tenantId !== undefined ? { tenantId } : {})
            })
            .project({ _id: 1 })
            .toArray();
        return data.map((item) => item._id.toString());
    }

    public async markEventProcessed(id: string): Promise<void> {
        const oid = this.toObjectId(id);
        if (!oid) return;
        await this.eventCollection.findOneAndUpdate(
            { _id: oid },
            { $set: { isProcessed: true } },
            { returnDocument: "after" }
        );
    }

    public async markEventUnprocessed(id: string): Promise<void> {
        const oid = this.toObjectId(id);
        if (!oid) return;
        await this.eventCollection.findOneAndUpdate(
            { _id: oid },
            { $set: { isProcessed: false } },
            { returnDocument: "after" }
        );
    }

    public async getEvents(tenantId: string, eventName: string, eventKey: any, asOf: Date): Promise<Array<string>> {
        const data = await this.eventCollection
            .find({ tenantId, eventName, eventKey, eventTime: { $gte: asOf } })
            .project({ _id: 1 })
            .toArray();
        return data.map((item) => item._id.toString());
    }

    // ── M9 — query / stats / time-series / delete ─────────────────────────────
    // find/countDocuments for the filtered query; aggregation pipelines for stats
    // ($group/$cond/$avg of $subtract), failed-steps ($match on
    // executionPointers.status), and the daily time-series ($dateToString on
    // createTime); deleteMany/deleteOne for hard deletes. Honours the tenantId
    // default. Read/delete-only: never touches concurrencyToken or events/subs.

    public async queryWorkflowInstances(query: WorkflowInstanceQuery): Promise<{ instances: WorkflowInstance[]; total: number }> {
        const filter = this.buildFilter(query);
        const sortField = query.sortField ?? "createTime";
        const sortOrder = (query.sortOrder ?? "desc") === "asc" ? 1 : -1;
        const skip = Math.max(0, query.skip ?? 0);
        const take = Math.min(query.take ?? 50, 500);

        const total = await this.workflowCollection.countDocuments(filter);
        const docs = await this.workflowCollection
            .find(filter)
            // id tie-break (_id is monotonic with insertion) for stable pagination.
            .sort({ [sortField]: sortOrder, _id: 1 })
            .skip(skip)
            .limit(take)
            .toArray();

        const instances = docs.map((doc) => {
            (doc as any).id = doc._id.toString();
            return doc as any as WorkflowInstance;
        });
        return { instances, total };
    }

    public async getWorkflowInstanceStats(query: WorkflowInstanceQuery & { topDefinitions?: number } = {}): Promise<WorkflowInstanceStats> {
        const filter = this.buildFilter(query);
        const topDefinitions = query.topDefinitions ?? 20;

        // byStatus + total.
        const statusAgg = await this.workflowCollection.aggregate([
            { $match: filter },
            { $group: { _id: "$status", cnt: { $sum: 1 } } }
        ]).toArray();
        const byStatus: Record<number, number> = {};
        let total = 0;
        for (const r of statusAgg) {
            const n = Number(r.cnt);
            byStatus[Number(r._id)] = n;
            total += n;
        }

        // averageCompletionTimeMs over Complete instances with a completeTime.
        const avgAgg = await this.workflowCollection.aggregate([
            { $match: { ...filter, status: WorkflowStatus.Complete, completeTime: { $ne: null } } },
            { $group: { _id: null, avgMs: { $avg: { $subtract: ["$completeTime", "$createTime"] } } } }
        ]).toArray();
        const averageCompletionTimeMs = avgAgg.length > 0 && avgAgg[0].avgMs != null ? Number(avgAgg[0].avgMs) : null;

        // byDefinition rollup sorted by total desc, capped to topDefinitions.
        const defAgg = await this.workflowCollection.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$workflowDefinitionId",
                    total: { $sum: 1 },
                    complete: { $sum: { $cond: [{ $eq: ["$status", WorkflowStatus.Complete] }, 1, 0] } },
                    terminated: { $sum: { $cond: [{ $eq: ["$status", WorkflowStatus.Terminated] }, 1, 0] } }
                }
            },
            { $sort: { total: -1, _id: 1 } },
            { $limit: topDefinitions }
        ]).toArray();
        const byDefinition: WorkflowDefinitionRollup[] = defAgg.map((r) => ({
            workflowDefinitionId: r._id,
            total: Number(r.total),
            complete: Number(r.complete),
            terminated: Number(r.terminated)
        }));

        // instancesWithFailedSteps: NON-terminated docs with >=1 Failed pointer.
        const failedAgg = await this.workflowCollection.aggregate([
            {
                $match: {
                    ...filter,
                    status: { $ne: WorkflowStatus.Terminated },
                    "executionPointers.status": PointerStatus.Failed
                }
            },
            { $group: { _id: "$workflowDefinitionId", cnt: { $sum: 1 } } }
        ]).toArray();
        const instancesWithFailedSteps: Record<string, number> = {};
        for (const r of failedAgg) {
            instancesWithFailedSteps[r._id] = Number(r.cnt);
        }

        return { total, byStatus, averageCompletionTimeMs, byDefinition, instancesWithFailedSteps };
    }

    public async getWorkflowInstanceTimeSeries(query: WorkflowTimeSeriesQuery): Promise<WorkflowTimeSeriesPoint[]> {
        const match: Filter<any> = {
            createTime: { $gte: query.from, $lte: query.to },
            ...(query.tenantId !== undefined ? { tenantId: query.tenantId } : {})
        };
        const rows = await this.workflowCollection.aggregate([
            { $match: match },
            {
                $group: {
                    // UTC day bucket.
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createTime", timezone: "UTC" } },
                    total: { $sum: 1 },
                    complete: { $sum: { $cond: [{ $eq: ["$status", WorkflowStatus.Complete] }, 1, 0] } },
                    terminated: { $sum: { $cond: [{ $eq: ["$status", WorkflowStatus.Terminated] }, 1, 0] } }
                }
            },
            { $sort: { _id: 1 } }
        ]).toArray();
        return rows.map((r) => ({
            date: r._id,
            total: Number(r.total),
            complete: Number(r.complete),
            terminated: Number(r.terminated)
        }));
    }

    public async deleteWorkflowInstance(id: string): Promise<boolean> {
        const oid = this.toObjectId(id);
        if (!oid) return false;
        const result = await this.workflowCollection.deleteOne({ _id: oid });
        return result.deletedCount > 0;
    }

    public async deleteWorkflowInstances(ids: string[]): Promise<number> {
        if (!ids || ids.length === 0) return 0;
        const oids = ids.map((id) => this.toObjectId(id)).filter((o): o is ObjectId => o !== null);
        if (oids.length === 0) return 0;
        const result = await this.workflowCollection.deleteMany({ _id: { $in: oids } });
        return result.deletedCount;
    }

    public async deleteWorkflowInstancesByDefinitionId(workflowDefinitionId: string, tenantId?: string): Promise<number> {
        const filter: Filter<any> = {
            workflowDefinitionId,
            ...(tenantId !== undefined ? { tenantId } : {})
        };
        const result = await this.workflowCollection.deleteMany(filter);
        return result.deletedCount;
    }

    /** Translate a WorkflowInstanceQuery into a Mongo filter (AND of all provided filters). */
    private buildFilter(query: WorkflowInstanceQuery): Filter<any> {
        const filter: any = {};

        if (query.tenantId !== undefined) filter.tenantId = query.tenantId;

        if (query.workflowDefinitionId !== undefined) {
            if (query.workflowDefinitionId.indexOf("*") >= 0) {
                // Anchored wildcard: '*' -> '.*', everything else literal. Escape each
                // segment between wildcards so regex metacharacters stay literal.
                const pattern = "^" + query.workflowDefinitionId
                    .split("*")
                    .map((seg) => this.escapeRegex(seg))
                    .join(".*") + "$";
                filter.workflowDefinitionId = { $regex: new RegExp(pattern) };
            } else {
                filter.workflowDefinitionId = query.workflowDefinitionId;
            }
        }

        if (query.status !== undefined) {
            filter.status = Array.isArray(query.status) ? { $in: query.status } : query.status;
        }

        const createTime: any = {};
        if (query.createdAfter !== undefined) createTime.$gte = query.createdAfter;
        if (query.createdBefore !== undefined) createTime.$lte = query.createdBefore;
        if (Object.keys(createTime).length > 0) filter.createTime = createTime;

        const completeTime: any = {};
        if (query.completedAfter !== undefined) completeTime.$gte = query.completedAfter;
        if (query.completedBefore !== undefined) completeTime.$lte = query.completedBefore;
        if (Object.keys(completeTime).length > 0) filter.completeTime = completeTime;

        if (query.searchTerm !== undefined && query.searchTerm !== "") {
            // Case-insensitive substring over workflowDefinitionId | description | id.
            const rx = new RegExp(this.escapeRegex(query.searchTerm), "i");
            filter.$or = [
                { workflowDefinitionId: { $regex: rx } },
                { description: { $regex: rx } },
                { id: { $regex: rx } }
            ];
        }

        return filter as Filter<any>;
    }

    /** Escape regex metacharacters (leaving '*' to be handled by the caller). */
    private escapeRegex(value: string): string {
        return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }

    /** Close the underlying MongoClient. */
    public async close(): Promise<void> {
        if (this.client) {
            await this.client.close();
        }
    }
}
