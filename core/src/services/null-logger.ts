import { injectable } from "inversify";
import { ILogger, LogLevel, LogContext } from "../abstractions";

@injectable()
export class NullLogger implements ILogger {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public log(_level: LogLevel, _message: string, _context?: LogContext): void {
        // intentional no-op — NullLogger is the default binding; the engine is silent out of the box.
    }

    /** @deprecated Shim — no-op. */
    public info(_message?: any, ..._optionalParams: any[]): void {}

    /** @deprecated Shim — no-op. */
    public error(_message?: any, ..._optionalParams: any[]): void {}
}
