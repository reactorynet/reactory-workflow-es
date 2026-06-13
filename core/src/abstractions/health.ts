export enum HealthStatus {
    Healthy = "healthy",
    Degraded = "degraded",     // host runs, but at least one component is unreachable/unknown-bad
    Unhealthy = "unhealthy",   // a required component is down
}

/** Per-component health detail. */
export interface ComponentHealth {
    /** Logical component name: "persistence" | "lock" | "queue" | "poll". */
    name: string;
    status: HealthStatus;
    /** Optional human-readable detail (e.g. an error message). */
    detail?: string;
    /** Optional measured latency of the probe, in ms. */
    latencyMs?: number;
}

/** Aggregate host health report returned by IWorkflowHost.health(). */
export interface HealthReport {
    /** Worst-of the component statuses. */
    status: HealthStatus;
    /** ISO-8601 timestamp the report was produced. */
    timestamp: string;
    /** Number of workflow executions currently in flight (from worker getActiveCount). */
    activeWorkflows: number;
    /** Epoch ms of the last completed poll cycle, or null if the poll worker has not yet run. */
    lastPollAt: number | null;
    components: ComponentHealth[];
}

/**
 * OPTIONAL provider health probe. Persistence/lock/queue providers MAY implement
 * this to give health() a real reachability signal. Providers that do not
 * implement it are reported with HealthStatus.Healthy and detail "probe not implemented"
 * (i.e. health is inferred, never assumed broken). MUST resolve quickly and MUST NOT throw
 * for "unhealthy" — throwing/rejecting is treated as Unhealthy with the error message.
 */
export interface IHealthProbe {
    /** Cheap reachability check (e.g. SELECT 1 / PING). Resolve true if reachable. */
    ping(): Promise<boolean>;
}

/** Runtime type-guard: does a provider implement the optional IHealthProbe? */
export function isHealthProbe(x: unknown): x is IHealthProbe {
    return !!x && typeof (x as IHealthProbe).ping === "function";
}
