/** Key/value labels attached to a metric sample. Values stringified by the adapter. */
export type MetricAttributes = { [key: string]: string | number | boolean };

/**
 * Minimal metrics facade. The default binding (NoOpMetrics) discards everything,
 * so core has zero metrics dependency. An optional adapter (e.g. the
 * workflow-es-opentelemetry package) maps these calls onto a real SDK.
 *
 * Implementations MUST NOT throw — a failing metrics backend must never break
 * workflow execution. Adapters swallow/log their own errors internally.
 */
export interface IMetrics {
    /** Monotonic counter increment (default delta = 1). e.g. workflows started, errors, retries. */
    incrementCounter(name: string, value?: number, attributes?: MetricAttributes): void;
    /** Set an absolute gauge value. e.g. active instances, queue depth. */
    recordGauge(name: string, value: number, attributes?: MetricAttributes): void;
    /** Record a value into a distribution. e.g. step duration in milliseconds. */
    recordHistogram(name: string, value: number, attributes?: MetricAttributes): void;
}

/** Canonical metric names. Exported so adapters and tests share one source of truth. */
export const METRIC_NAMES = {
    WORKFLOW_STARTED: "workflowes.workflow.started",          // counter, {1}
    WORKFLOW_ACTIVE: "workflowes.workflow.active",            // gauge, {1}
    STEP_DURATION: "workflowes.step.duration",                // histogram, ms
    STEP_ERRORS: "workflowes.step.errors",                    // counter, {1}
    STEP_RETRIES: "workflowes.step.retries",                  // counter, {1}
    EVENT_PUBLISHED: "workflowes.event.published",            // counter, {1}
    QUEUE_DEPTH: "workflowes.queue.depth",                    // gauge, {1}
} as const;

/** Units (UCUM-ish) for each metric, for adapters that register instruments with units. */
export const METRIC_UNITS: { [name: string]: string } = {
    [METRIC_NAMES.WORKFLOW_STARTED]: "{workflow}",
    [METRIC_NAMES.WORKFLOW_ACTIVE]: "{workflow}",
    [METRIC_NAMES.STEP_DURATION]: "ms",
    [METRIC_NAMES.STEP_ERRORS]: "{error}",
    [METRIC_NAMES.STEP_RETRIES]: "{retry}",
    [METRIC_NAMES.EVENT_PUBLISHED]: "{event}",
    [METRIC_NAMES.QUEUE_DEPTH]: "{item}",
};

/** Standard attribute keys used across spans and metrics. */
export const ATTR = {
    WORKFLOW_ID: "workflow.id",
    WORKFLOW_DEFINITION_ID: "workflow.definition.id",
    WORKFLOW_VERSION: "workflow.version",
    STEP_ID: "workflow.step.id",
    STEP_NAME: "workflow.step.name",
    QUEUE: "workflow.queue",           // "workflow" | "event"
} as const;
