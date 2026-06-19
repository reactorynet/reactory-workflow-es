import { trace, Span, SpanStatusCode, Attributes } from "@opentelemetry/api";
import { ITracer, ISpan, MetricAttributes } from "@reactorynet/workflow-es";

/**
 * Wraps an OTel Span behind the workflow-es ISpan facade. end() is guarded so it is
 * safe to call exactly once. Every method swallows its own errors (spec M5 §6.13).
 */
class OpenTelemetrySpan implements ISpan {
    private span: Span;
    private ended: boolean = false;

    constructor(span: Span) {
        this.span = span;
    }

    public setAttribute(key: string, value: string | number | boolean): void {
        try { this.span.setAttribute(key, value); }
        catch { /* swallow */ }
    }

    public recordError(error: Error): void {
        try {
            this.span.recordException(error);
            this.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }
        catch { /* swallow */ }
    }

    public end(): void {
        if (this.ended)
            return;
        this.ended = true;
        try { this.span.end(); }
        catch { /* swallow */ }
    }
}

const NOOP_SPAN: ISpan = { setAttribute() {}, recordError() {}, end() {} };

/**
 * Adapts the workflow-es ITracer facade onto @opentelemetry/api trace.
 */
export class OpenTelemetryTracer implements ITracer {
    private readonly tracerName: string;

    constructor(tracerName: string = "@reactorynet/workflow-es") {
        this.tracerName = tracerName;
    }

    public startSpan(name: string, attributes?: MetricAttributes): ISpan {
        try {
            const span = trace.getTracer(this.tracerName).startSpan(name, {
                attributes: attributes as Attributes | undefined,
            });
            return new OpenTelemetrySpan(span);
        }
        catch {
            return NOOP_SPAN;
        }
    }
}
