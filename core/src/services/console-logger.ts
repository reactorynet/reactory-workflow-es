import { injectable } from "inversify";
import { ILogger, LogLevel, LogContext } from "../abstractions";

@injectable()
export class ConsoleLogger implements ILogger {
    private minLevel: LogLevel;

    constructor(minLevel: LogLevel = LogLevel.Info) {
        this.minLevel = minLevel;
    }

    public log(level: LogLevel, message: string, context?: LogContext): void {
        if (level < this.minLevel) return;                  // level filtering (rule §6.2)
        const record = { level: LogLevel[level], message, ...(context ?? {}) };
        if (level >= LogLevel.Error) console.error(record);
        else if (level >= LogLevel.Warn)  console.warn(record);
        else if (level >= LogLevel.Info)  console.info(record);
        else console.debug(record);
    }

    /** @deprecated Shim — forwards to structured log so old call patterns still produce output. */
    public info(message?: any, ...optionalParams: any[]): void {
        this.log(LogLevel.Info, String(message), optionalParams.length ? { params: optionalParams } : undefined);
    }

    /** @deprecated Shim — forwards to structured log so old call patterns still produce output. */
    public error(message?: any, ...optionalParams: any[]): void {
        this.log(LogLevel.Error, String(message), optionalParams.length ? { params: optionalParams } : undefined);
    }
}
