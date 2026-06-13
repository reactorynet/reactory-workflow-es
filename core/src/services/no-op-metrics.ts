import { injectable } from "inversify";
import { IMetrics, MetricAttributes } from "../abstractions";

@injectable()
export class NoOpMetrics implements IMetrics {
    public incrementCounter(_name: string, _value?: number, _attributes?: MetricAttributes): void {}
    public recordGauge(_name: string, _value: number, _attributes?: MetricAttributes): void {}
    public recordHistogram(_name: string, _value: number, _attributes?: MetricAttributes): void {}
}
