import { injectable } from "inversify";
import { ITracer, ISpan, MetricAttributes } from "../abstractions";

const NOOP_SPAN: ISpan = {
    setAttribute() {},
    recordError() {},
    end() {},
};

@injectable()
export class NoOpTracer implements ITracer {
    public startSpan(_name: string, _attributes?: MetricAttributes): ISpan {
        return NOOP_SPAN;
    }
}
