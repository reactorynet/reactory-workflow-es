import { injectable, inject } from "inversify";
import {
    IPersistenceProvider,
    WorkflowConcurrencyError,
    DEFAULT_TENANT,
    WorkflowInstanceQuery,
    WorkflowInstanceStats,
    WorkflowDefinitionRollup,
    WorkflowTimeSeriesQuery,
    WorkflowTimeSeriesPoint
} from "../abstractions";
import { WorkflowInstance, WorkflowStatus, EventSubscription, Event, PointerStatus } from "../models";

@injectable()
export class MemoryPersistenceProvider implements IPersistenceProvider {
    private instances: WorkflowInstance[] = [];
    private subscriptions: EventSubscription[] = [];
    private events: Event[] = [];
    
    public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
        instance.id = this.generateUID();
        instance.concurrencyToken = 0;
        // M6: mirror the SQL providers' @Default("default") — an instance created
        // without a tenant (e.g. directly in the conformance suite) reads as "default".
        if (instance.tenantId === undefined || instance.tenantId === null)
            instance.tenantId = DEFAULT_TENANT;
        this.instances.push(this.clone(instance));
        return instance.id;
    }

    public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
        const expected = instance.concurrencyToken ?? 0;
        const idx = this.instances.findIndex(x => x.id === instance.id);
        const stored = idx > -1 ? this.instances[idx] : undefined;
        const storedToken = stored ? (stored.concurrencyToken ?? 0) : undefined;

        // Compare-and-set: only succeed when the stored token matches the
        // token on the in-memory instance being written. A mismatch means
        // another node persisted this instance first — reject the stale write.
        if (storedToken !== expected) {
            throw new WorkflowConcurrencyError(instance.id, expected);
        }

        const next = expected + 1;
        const copy = this.clone(instance);
        copy.concurrencyToken = next;
        this.instances[idx] = copy;
        // Refresh the caller's in-memory token so it can persist again without reload.
        instance.concurrencyToken = next;
    }

    public async getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
        const found = this.instances.find(x => x.id === workflowId);
        // Return an independent copy so callers cannot mutate the stored record
        // out-of-band, which would defeat the compare-and-set check.
        return found ? this.clone(found) : found;
    }

    public async getRunnableInstances(tenantId?: string): Promise<string[]> {
        return this.instances
            .filter(x => x.status === WorkflowStatus.Runnable && x.nextExecution < Date.now()
                && (tenantId === undefined || x.tenantId === tenantId))
            .map(x => x.id);
    }

    public async createEventSubscription(subscription: EventSubscription): Promise<void> {
        subscription.id = this.generateUID();
        if (subscription.tenantId === undefined || subscription.tenantId === null)
            subscription.tenantId = DEFAULT_TENANT;
        this.subscriptions.push(subscription);
    }

    public async getSubscriptions(tenantId: string, eventName: string, eventKey: string, asOf: Date): Promise<EventSubscription[]> {
        return this.subscriptions.filter(x => x.tenantId === tenantId && x.eventName === eventName && x.eventKey === eventKey && x.subscribeAsOf <= asOf);
    }

    public async terminateSubscription(id: string): Promise<void> {
        const idx = this.subscriptions.findIndex(x => x.id === id);
        if (idx > -1)
            this.subscriptions.splice(idx, 1);
    }

    public async createEvent(event: Event): Promise<string> {
        event.id = this.generateUID();
        if (event.tenantId === undefined || event.tenantId === null)
            event.tenantId = DEFAULT_TENANT;
        this.events.push(event);
        return event.id;
    }

    public async getEvent(id: string): Promise<Event> {
        return this.events.find(x => x.id === id);
    }

    public async getRunnableEvents(tenantId?: string): Promise<string[]> {
        return this.events
            .filter(x => !x.isProcessed && x.eventTime <= new Date()
                && (tenantId === undefined || x.tenantId === tenantId))
            .map(x => x.id);
    }

    public async markEventProcessed(id: string): Promise<void> {
        const evt = this.events.find(x => x.id === id);
        if (evt)
            evt.isProcessed = true;
    }

    public async markEventUnprocessed(id: string): Promise<void> {
        const evt = this.events.find(x => x.id === id);
        if (evt)
            evt.isProcessed = false;
    }

    // P3.2 — `eventKey` is matched with `===`. Event keys are expected to be primitives
    // (string/number); two distinct OBJECT instances with identical contents will NOT match here,
    // whereas the SQL/Mongo providers compare serialized forms. Consumers needing structured keys
    // should stringify them (e.g. JSON.stringify) before publishing/subscribing so all providers agree.
    public async getEvents(tenantId: string, eventName: string, eventKey: unknown, asOf: Date): Promise<string[]> {
        return this.events
            .filter(x => x.tenantId === tenantId && x.eventName === eventName && x.eventKey === eventKey && x.eventTime >= asOf)
            .map(x => x.id);
    }

    // ── M9 — query / stats / time-series / delete (reference semantics) ────────
    // In-array filter/sort/slice; reduce for stats; group by UTC day for the
    // time-series. Read/delete-only: never touches concurrencyToken or events.

    public async queryWorkflowInstances(query: WorkflowInstanceQuery): Promise<{ instances: WorkflowInstance[]; total: number }> {
        const matched = this.instances.filter(x => this.matchesQuery(x, query));
        const sorted = this.sortInstances(matched, query.sortField ?? "createTime", query.sortOrder ?? "desc");
        const skip = Math.max(0, query.skip ?? 0);
        const take = Math.min(query.take ?? 50, 500);
        const page = sorted.slice(skip, skip + take);
        return { instances: page.map(x => this.clone(x)), total: matched.length };
    }

    public async getWorkflowInstanceStats(query: WorkflowInstanceQuery & { topDefinitions?: number } = {}): Promise<WorkflowInstanceStats> {
        const matched = this.instances.filter(x => this.matchesQuery(x, query));

        const byStatus: Record<number, number> = {};
        let completionSum = 0;
        let completionCount = 0;
        const defAgg: Record<string, WorkflowDefinitionRollup> = {};
        const failedSteps: Record<string, number> = {};

        for (const inst of matched) {
            byStatus[inst.status] = (byStatus[inst.status] ?? 0) + 1;

            if (inst.status === WorkflowStatus.Complete && inst.completeTime != null && inst.createTime != null) {
                completionSum += new Date(inst.completeTime).getTime() - new Date(inst.createTime).getTime();
                completionCount++;
            }

            const def = inst.workflowDefinitionId;
            const rollup = defAgg[def] ?? (defAgg[def] = { workflowDefinitionId: def, total: 0, complete: 0, terminated: 0 });
            rollup.total++;
            if (inst.status === WorkflowStatus.Complete) rollup.complete++;
            if (inst.status === WorkflowStatus.Terminated) rollup.terminated++;

            const hasFailed = (inst.executionPointers || []).some(p => p.status === PointerStatus.Failed);
            if (hasFailed && inst.status !== WorkflowStatus.Terminated) {
                failedSteps[def] = (failedSteps[def] ?? 0) + 1;
            }
        }

        const topDefinitions = query.topDefinitions ?? 20;
        const byDefinition = Object.values(defAgg)
            .sort((a, b) => b.total - a.total || (a.workflowDefinitionId < b.workflowDefinitionId ? -1 : 1))
            .slice(0, topDefinitions);

        return {
            total: matched.length,
            byStatus,
            averageCompletionTimeMs: completionCount > 0 ? completionSum / completionCount : null,
            byDefinition,
            instancesWithFailedSteps: failedSteps
        };
    }

    public async getWorkflowInstanceTimeSeries(query: WorkflowTimeSeriesQuery): Promise<WorkflowTimeSeriesPoint[]> {
        const from = query.from.getTime();
        const to = query.to.getTime();
        const buckets: Record<string, WorkflowTimeSeriesPoint> = {};

        for (const inst of this.instances) {
            if (query.tenantId !== undefined && inst.tenantId !== query.tenantId) continue;
            if (inst.createTime == null) continue;
            const t = new Date(inst.createTime).getTime();
            if (t < from || t > to) continue;

            const date = new Date(inst.createTime).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
            const point = buckets[date] ?? (buckets[date] = { date, total: 0, complete: 0, terminated: 0 });
            point.total++;
            if (inst.status === WorkflowStatus.Complete) point.complete++;
            if (inst.status === WorkflowStatus.Terminated) point.terminated++;
        }

        return Object.values(buckets).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }

    public async deleteWorkflowInstance(id: string): Promise<boolean> {
        const idx = this.instances.findIndex(x => x.id === id);
        if (idx === -1) return false;
        this.instances.splice(idx, 1);
        return true;
    }

    public async deleteWorkflowInstances(ids: string[]): Promise<number> {
        const idSet = new Set(ids);
        let removed = 0;
        this.instances = this.instances.filter(x => {
            if (idSet.has(x.id)) { removed++; return false; }
            return true;
        });
        return removed;
    }

    public async deleteWorkflowInstancesByDefinitionId(workflowDefinitionId: string, tenantId?: string): Promise<number> {
        let removed = 0;
        this.instances = this.instances.filter(x => {
            const match = x.workflowDefinitionId === workflowDefinitionId
                && (tenantId === undefined || x.tenantId === tenantId);
            if (match) { removed++; return false; }
            return true;
        });
        return removed;
    }

    // ── M9 internal helpers ────────────────────────────────────────────────────

    private matchesQuery(inst: WorkflowInstance, query: WorkflowInstanceQuery): boolean {
        if (query.tenantId !== undefined && inst.tenantId !== query.tenantId) return false;

        if (query.workflowDefinitionId !== undefined) {
            if (query.workflowDefinitionId.indexOf("*") >= 0) {
                if (!this.wildcardMatch(inst.workflowDefinitionId ?? "", query.workflowDefinitionId)) return false;
            } else if (inst.workflowDefinitionId !== query.workflowDefinitionId) {
                return false;
            }
        }

        if (query.status !== undefined) {
            const statuses = Array.isArray(query.status) ? query.status : [query.status];
            if (!statuses.includes(inst.status)) return false;
        }

        const createMs = inst.createTime != null ? new Date(inst.createTime).getTime() : null;
        if (query.createdAfter !== undefined && (createMs === null || createMs < query.createdAfter.getTime())) return false;
        if (query.createdBefore !== undefined && (createMs === null || createMs > query.createdBefore.getTime())) return false;

        const completeMs = inst.completeTime != null ? new Date(inst.completeTime).getTime() : null;
        if (query.completedAfter !== undefined && (completeMs === null || completeMs < query.completedAfter.getTime())) return false;
        if (query.completedBefore !== undefined && (completeMs === null || completeMs > query.completedBefore.getTime())) return false;

        if (query.searchTerm !== undefined && query.searchTerm !== "") {
            const term = query.searchTerm.toLowerCase();
            const haystacks = [inst.workflowDefinitionId, inst.description, inst.id];
            const hit = haystacks.some(h => typeof h === "string" && h.toLowerCase().indexOf(term) >= 0);
            if (!hit) return false;
        }

        return true;
    }

    /** Anchored wildcard match: '*' matches any run of characters; all else literal. */
    private wildcardMatch(value: string, pattern: string): boolean {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`, "i").test(value);
    }

    private sortInstances(list: WorkflowInstance[], field: string, order: "asc" | "desc"): WorkflowInstance[] {
        const dir = order === "asc" ? 1 : -1;
        const keyOf = (inst: WorkflowInstance): number | string => {
            switch (field) {
                case "completeTime": return inst.completeTime != null ? new Date(inst.completeTime).getTime() : -Infinity;
                case "workflowDefinitionId": return inst.workflowDefinitionId ?? "";
                case "status": return inst.status ?? -Infinity;
                case "createTime":
                default: return inst.createTime != null ? new Date(inst.createTime).getTime() : -Infinity;
            }
        };
        return [...list].sort((a, b) => {
            const ka = keyOf(a);
            const kb = keyOf(b);
            if (ka < kb) return -1 * dir;
            if (ka > kb) return 1 * dir;
            // Stable tie-break by id (ascending, independent of sort order).
            const ida = a.id ?? "";
            const idb = b.id ?? "";
            return ida < idb ? -1 : ida > idb ? 1 : 0;
        });
    }

    /**
     * Test helper — clear all in-memory state. Mirrors `sequelize.sync({force:true})`
     * / Mongo collection drop used by the SQL/document providers' conformance reset.
     * Not part of IPersistenceProvider; intended for test harnesses only.
     */
    public reset(): void {
        this.instances = [];
        this.subscriptions = [];
        this.events = [];
    }

    private generateUID(): string {
        return crypto.randomUUID();
    }

    // Deep copy so the stored record and the caller's in-memory instance are
    // independent. structuredClone preserves Date instances (unlike JSON round-trip)
    // and keeps the concurrency token comparison honest.
    private clone(instance: WorkflowInstance): WorkflowInstance {
        return structuredClone(instance);
    }

}