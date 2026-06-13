import { IMetrics, MetricAttributes, ITracer, ISpan } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";

/** FakeMetrics: records every call so tests can assert. */
export class FakeMetrics implements IMetrics {
    public counters: Array<{ name: string; value: number; attributes?: any }> = [];
    public gauges: Array<{ name: string; value: number; attributes?: any }> = [];
    public histograms: Array<{ name: string; value: number; attributes?: any }> = [];

    public incrementCounter(name: string, value: number = 1, attributes?: MetricAttributes): void {
        this.counters.push({ name, value, attributes });
    }
    public recordGauge(name: string, value: number, attributes?: MetricAttributes): void {
        this.gauges.push({ name, value, attributes });
    }
    public recordHistogram(name: string, value: number, attributes?: MetricAttributes): void {
        this.histograms.push({ name, value, attributes });
    }
    public countOf(name: string): number {
        return this.counters.filter(c => c.name === name).reduce((a, c) => a + c.value, 0);
    }
}

/** FakeSpan / FakeTracer: record spans + attributes + errors + end order. */
export class FakeSpan implements ISpan {
    public attributes: any = {};
    public errors: Error[] = [];
    public ended = false;
    public setAttribute(k: string, v: string | number | boolean): void { this.attributes[k] = v; }
    public recordError(e: Error): void { this.errors.push(e); }
    public end(): void { this.ended = true; }
}

export class FakeTracer implements ITracer {
    public spans: Array<{ name: string; span: FakeSpan }> = [];
    public startSpan(name: string, attributes?: MetricAttributes): ISpan {
        const span = new FakeSpan();
        if (attributes) Object.assign(span.attributes, attributes);
        this.spans.push({ name, span });
        return span;
    }
}

/** ThrowingMetrics: every method throws — proves telemetry cannot break execution. */
export class ThrowingMetrics implements IMetrics {
    public incrementCounter(): void { throw new Error("metrics boom"); }
    public recordGauge(): void { throw new Error("metrics boom"); }
    public recordHistogram(): void { throw new Error("metrics boom"); }
}

/**
 * BrokenPersistenceProvider: a working memory persistence that ALSO implements the
 * optional IHealthProbe, with a togglable ping result. Used to prove health() reports
 * Unhealthy when ping() returns false or throws.
 */
export class BrokenPersistenceProvider extends MemoryPersistenceProvider {
    public pingResult: boolean = false;
    public pingThrows: boolean = false;

    public async ping(): Promise<boolean> {
        if (this.pingThrows)
            throw new Error("persistence unreachable");
        return this.pingResult;
    }
}
