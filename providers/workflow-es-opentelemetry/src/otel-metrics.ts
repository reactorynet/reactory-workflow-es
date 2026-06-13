import { metrics, Attributes, Counter, UpDownCounter, Histogram } from "@opentelemetry/api";
import { IMetrics, MetricAttributes, METRIC_UNITS } from "@reactorynet/workflow-es";

/**
 * Adapts the workflow-es IMetrics facade onto @opentelemetry/api metrics.
 *
 * Instruments are created lazily and cached by name. Counters use OTel counters,
 * gauges are modelled as up-down counters (set-to-value by recording the delta from
 * the last value), and histograms map to OTel histograms. Units are registered from
 * METRIC_UNITS when known.
 *
 * Every method swallows its own errors (spec M5 §6.13): a failing metrics backend
 * MUST NOT break workflow execution.
 */
export class OpenTelemetryMetrics implements IMetrics {
    private readonly meterName: string;
    private counters: Map<string, Counter> = new Map();
    private upDownCounters: Map<string, UpDownCounter> = new Map();
    private histograms: Map<string, Histogram> = new Map();
    // Last observed absolute value per (gauge name + serialised attributes), so a
    // recordGauge(set) can be emitted onto an up-down counter as a delta.
    private gaugeState: Map<string, number> = new Map();

    constructor(meterName: string = "@reactorynet/workflow-es") {
        this.meterName = meterName;
    }

    private meter() {
        return metrics.getMeter(this.meterName);
    }

    private toAttributes(attributes?: MetricAttributes): Attributes | undefined {
        return attributes as Attributes | undefined;
    }

    public incrementCounter(name: string, value: number = 1, attributes?: MetricAttributes): void {
        try {
            let counter = this.counters.get(name);
            if (!counter) {
                counter = this.meter().createCounter(name, { unit: METRIC_UNITS[name] });
                this.counters.set(name, counter);
            }
            counter.add(value, this.toAttributes(attributes));
        }
        catch {
            // swallow — telemetry never breaks execution
        }
    }

    public recordGauge(name: string, value: number, attributes?: MetricAttributes): void {
        try {
            let counter = this.upDownCounters.get(name);
            if (!counter) {
                counter = this.meter().createUpDownCounter(name, { unit: METRIC_UNITS[name] });
                this.upDownCounters.set(name, counter);
            }
            const key = name + "|" + JSON.stringify(attributes || {});
            const prev = this.gaugeState.get(key) || 0;
            counter.add(value - prev, this.toAttributes(attributes));
            this.gaugeState.set(key, value);
        }
        catch {
            // swallow
        }
    }

    public recordHistogram(name: string, value: number, attributes?: MetricAttributes): void {
        try {
            let histogram = this.histograms.get(name);
            if (!histogram) {
                histogram = this.meter().createHistogram(name, { unit: METRIC_UNITS[name] });
                this.histograms.set(name, histogram);
            }
            histogram.record(value, this.toAttributes(attributes));
        }
        catch {
            // swallow
        }
    }
}
