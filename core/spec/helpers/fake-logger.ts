import { ILogger, LogLevel, LogContext } from "../../src";

export interface CapturedRecord {
    level: LogLevel;
    message: string;
    context?: LogContext;
}

export class FakeLogger implements ILogger {
    public records: CapturedRecord[] = [];

    public log(level: LogLevel, message: string, context?: LogContext): void {
        this.records.push({ level, message, context });
    }
}
