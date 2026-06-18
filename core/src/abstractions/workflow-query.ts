/**
 * M9 — store-agnostic query / aggregation / time-series contract types.
 *
 * These types describe the read-layer surface added to {@link IPersistenceProvider}
 * (see persistence-provider.ts) so the express read layer can query workflow history,
 * statistics, and a daily time-series through the active provider rather than a
 * hard-wired mongoose model. Every non-deprecated provider (memory, sqlite, postgres,
 * mongo) implements the methods natively; the shared conformance suite is the arbiter
 * of equivalence (memory is the reference semantics).
 *
 * All behavioural rules are documented in docs/specs/m9-persistence-query-contract.md §6.
 */

/**
 * Filter / sort / paginate descriptor for {@link IPersistenceProvider.queryWorkflowInstances}.
 *
 * All provided fields are combined with AND. Omitted fields impose no constraint.
 */
export interface WorkflowInstanceQuery {
    /** Tenant / namespace to scope to. Omit (undefined) to match ALL tenants. */
    tenantId?: string;
    /**
     * Workflow definition id. Exact match, UNLESS the value contains a `*`
     * wildcard, in which case it is translated to a store-native anchored
     * pattern match (`*` → `%` for SQL `LIKE`, `*` → `.*` for a Mongo regex).
     */
    workflowDefinitionId?: string;
    /** WorkflowStatus value, or an any-of array of values. */
    status?: number | number[];
    /** Inclusive lower bound on `createTime`. */
    createdAfter?: Date;
    /** Inclusive upper bound on `createTime`. */
    createdBefore?: Date;
    /** Inclusive lower bound on `completeTime`. */
    completedAfter?: Date;
    /** Inclusive upper bound on `completeTime`. */
    completedBefore?: Date;
    /**
     * Case-insensitive substring match over `workflowDefinitionId`, `description`,
     * and `id` (any one matching qualifies the row).
     */
    searchTerm?: string;
    /** Sort field. Default `createTime`. */
    sortField?: "createTime" | "completeTime" | "workflowDefinitionId" | "status";
    /** Sort direction. Default `desc`. Ties are broken by `id` for stable pagination. */
    sortOrder?: "asc" | "desc";
    /** Rows to skip (offset). Default 0. */
    skip?: number;
    /** Maximum rows to return. Default 50; providers MUST cap at 500 to bound result size. */
    take?: number;
}

/** Per-definition rollup row inside {@link WorkflowInstanceStats.byDefinition}. */
export interface WorkflowDefinitionRollup {
    workflowDefinitionId: string;
    /** Total instances for this definition (within the stats scope). */
    total: number;
    /** Instances whose status === WorkflowStatus.Complete. */
    complete: number;
    /** Instances whose status === WorkflowStatus.Terminated. */
    terminated: number;
}

/** Aggregated statistics bundle returned by {@link IPersistenceProvider.getWorkflowInstanceStats}. */
export interface WorkflowInstanceStats {
    /** Total matching instances. Equals the sum of byStatus values. */
    total: number;
    /** WorkflowStatus value → count. Every present status maps to its count. */
    byStatus: Record<number, number>;
    /**
     * Mean of `(completeTime - createTime)` in milliseconds over instances with
     * `status === Complete` and a non-null `completeTime`; `null` when there are none.
     */
    averageCompletionTimeMs: number | null;
    /** Per-definition rollups sorted by `total` desc, capped to `topDefinitions` (default 20). */
    byDefinition: WorkflowDefinitionRollup[];
    /**
     * definitionId → count of NON-terminated instances (status !== Terminated) that have
     * at least one execution pointer with PointerStatus.Failed.
     */
    instancesWithFailedSteps: Record<string, number>;
}

/** Range descriptor for {@link IPersistenceProvider.getWorkflowInstanceTimeSeries}. */
export interface WorkflowTimeSeriesQuery {
    /** Tenant / namespace to scope to. Omit (undefined) to match ALL tenants. */
    tenantId?: string;
    /** Inclusive start of the day range (matched against `createTime`). */
    from: Date;
    /** Inclusive end of the day range (matched against `createTime`). */
    to: Date;
    // bucket is daily (UTC) for v1.
}

/** One daily bucket returned by {@link IPersistenceProvider.getWorkflowInstanceTimeSeries}. */
export interface WorkflowTimeSeriesPoint {
    /** ISO date "YYYY-MM-DD" (UTC) for the bucket. */
    date: string;
    /** Total instances created on this UTC day. */
    total: number;
    /** Instances created on this day whose status === Complete. */
    complete: number;
    /** Instances created on this day whose status === Terminated. */
    terminated: number;
}
