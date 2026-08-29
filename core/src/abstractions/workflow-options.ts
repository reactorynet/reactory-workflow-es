/**
 * Default poll-worker interval in milliseconds.
 * Used as the default value for WorkflowOptions.pollIntervalMs.
 */
export const DEFAULT_POLL_INTERVAL_MS = 10000;

/**
 * Default graceful-shutdown drain timeout in milliseconds.
 * Used as the default value for WorkflowOptions.gracefulShutdownTimeoutMs.
 */
export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30000;

/**
 * Well-known lease key used by the poll worker to elect a single active poller
 * per cycle via IDistributedLockProvider. Namespaced to avoid colliding with
 * per-workflow lock ids (which are workflow instance UUIDs).
 */
export const POLL_LEASE_KEY = "workflow-es:poll-lease";

/**
 * Scalar / behavioural tunables for the workflow engine.
 * Passed to configureWorkflow(options?) and bound once as TYPES.WorkflowOptions.
 * All fields are optional in Partial<WorkflowOptions>; defaults are applied by resolveOptions().
 *
 * Fields owned by items not yet implemented carry their defaults here so the
 * interface is stable for downstream items (H1, H4, H5, H6) to consume without
 * a signature change.
 */
export interface WorkflowOptions {
    /** H3 — Interval between poll-worker scan cycles, in ms. Default 10000. */
    pollIntervalMs: number;

    /** H1 — Interval between workflow-queue-worker dequeue ticks, in ms. Default 100. */
    workflowQueueIntervalMs: number;

    /** H1 — Interval between event-queue-worker dequeue ticks, in ms. Default 500. */
    eventQueueIntervalMs: number;

    /** H1 — Maximum concurrent workflow step executions. Default 10. */
    maxConcurrentWorkflows: number;

    /** H1 — Maximum concurrent event step executions. Default 20. */
    maxConcurrentEvents: number;

    /** H4 — Maximum time to wait for in-flight executions to drain on stop(), in ms. Default 30000. */
    gracefulShutdownTimeoutMs: number;

    /** H5 — Retry configuration for failed steps. */
    retry: {
        /** Default number of retries after the first attempt. Default 3. */
        defaultMaxRetries: number;
        /** Default interval between retries, in ms. Default 60000. */
        defaultRetryIntervalMs: number;
        /** Retry interval when a step body is not found in the registry, in ms. Default 60000. */
        stepNotFoundRetryIntervalMs: number;
    };

    /** H6 — Maximum serialized byte size for workflow data fields. 0 = unlimited. Default 0. */
    dataCodecMaxBytes: number;

    /**
     * M10 — What to do when a loaded instance's `definitionFingerprint` does not match
     * the fingerprint of the currently registered definition (i.e. the step graph was
     * edited without a version bump).
     *
     *  - `"enforce"` (default) — dead-letter the instance. Correct for production: the
     *    ordinal `stepId` on its pointers no longer refers to the step it suspended at,
     *    so executing it runs the WRONG step body.
     *  - `"warn"` — log at Error and execute anyway. A rollout escape hatch: deploy,
     *    measure how many instances would be affected, then move to `"enforce"`.
     *    Leaves the silent-deviation hazard open while it is set.
     *  - `"off"` — skip the check entirely.
     *
     * Instances started before fingerprinting existed carry no fingerprint and are
     * exempt under every mode — an absent value is never a mismatch.
     */
    definitionFingerprintMode: "enforce" | "warn" | "off";
}
