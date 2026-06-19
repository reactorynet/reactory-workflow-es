import { MetricAttributes } from "./metrics";

export interface ISpan {
    /** Add/replace an attribute on the span. */
    setAttribute(key: string, value: string | number | boolean): void;
    /** Mark the span as errored and (optionally) attach the error. Does not end the span. */
    recordError(error: Error): void;
    /** End the span. MUST be safe to call exactly once; subsequent calls are ignored. */
    end(): void;
}

/**
 * Minimal tracing facade. Default binding (NoOpTracer) returns a no-op span,
 * so core has zero tracing dependency. Implementations MUST NOT throw.
 */
export interface ITracer {
    /**
     * Start a span. The returned span MUST be ended by the caller (in a finally).
     * `attributes` are the initial attributes (e.g. workflow.id, workflow.step.id).
     */
    startSpan(name: string, attributes?: MetricAttributes): ISpan;
}

/** Canonical span names. */
export const SPAN_NAMES = {
    STEP_EXECUTE: "workflowes.step.execute",   // wraps body.run(...)
} as const;
