
/**
 * Severity levels, ordered ascending. A logger configured with a minimum level
 * emits a record only when record.level >= minLevel. `Silent` disables all output.
 */
export enum LogLevel {
    Debug = 10,
    Info  = 20,
    Warn  = 30,
    Error = 40,
    Silent = 100,
}

/**
 * Structured correlation context attached to every engine log record.
 * All fields are optional so call sites only set what they know.
 * `tenantId` is now populated by M6 where available (workers/host have the tenant).
 * The index signature allows adapters/consumers to attach arbitrary extra fields.
 */
export interface LogContext {
    workflowId?: string;
    stepId?:     string;
    eventId?:    string;
    /** Tenant dimension (M6). Populated at call sites where tenantId is in scope. */
    tenantId?:   string;
    /** Attached when the record describes an error. */
    err?: Error;
    [key: string]: unknown;
}

export interface ILogger {
    /**
     * Primary structured entry point. Implementations MUST honour level filtering
     * (drop the record when `level` is below the configured minimum).
     */
    log(level: LogLevel, message: string, context?: LogContext): void;

    /**
     * @deprecated printf-style compatibility shims kept for consumers that
     * implemented the pre-M4 `ILogger`. New engine code MUST NOT call these.
     * Default implementations are provided on the shipped loggers; custom
     * consumer loggers that only implement the old three methods continue to work
     * because the engine never calls them (see migration note §10).
     */
    info?(message?: any, ...optionalParams: any[]): void;
    error?(message?: any, ...optionalParams: any[]): void;
}
