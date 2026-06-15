import {
    IPersistenceProvider,
    WorkflowInstance,
    EventSubscription,
    Event,
    WorkflowStatus,
    WorkflowConcurrencyError
} from "@reactorynet/workflow-es";
import { MongoClient, ObjectId, Collection, Db } from "mongodb";

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
        const result = await this.workflowCollection.insertOne(instance as any);
        instance.id = result.insertedId.toString();
        return instance.id;
    }

    /**
     * Compare-and-set persist.
     * Filters on { _id, concurrencyToken: expected }, increments the token.
     * If no document matched (concurrent writer advanced the token), throws
     * WorkflowConcurrencyError (C1 contract).
     * On success, advances the in-memory token so the same instance can be
     * persisted again without a re-read.
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
        const result = await this.subscriptionCollection.insertOne(subscription as any);
        subscription.id = result.insertedId.toString();
    }

    public async getSubscriptions(
        tenantId: string,
        eventName: string,
        eventKey: string,
        asOf: Date
    ): Promise<Array<EventSubscription>> {
        const data = await this.subscriptionCollection
            .find({ tenantId, eventName, eventKey, subscribeAsOf: { $lt: asOf } })
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
        const result = await this.eventCollection.insertOne(event as any);
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
            .find({ tenantId, eventName, eventKey, eventTime: { $gt: asOf } })
            .project({ _id: 1 })
            .toArray();
        return data.map((item) => item._id.toString());
    }

    /** Close the underlying MongoClient. */
    public async close(): Promise<void> {
        if (this.client) {
            await this.client.close();
        }
    }
}
