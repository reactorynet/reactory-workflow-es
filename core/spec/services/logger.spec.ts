/**
 * Unit tests for M4 structured logging — ILogger, LogLevel, ConsoleLogger, NullLogger.
 * Run with: cd core && yarn test
 */
import { LogLevel, LogContext, configureWorkflow } from "../../src";
import { ConsoleLogger } from "../../src/services/console-logger";
import { NullLogger } from "../../src/services/null-logger";
import { FakeLogger } from "../helpers/fake-logger";

describe("LogLevel", () => {
    it("is ordered ascending (Debug < Info < Warn < Error < Silent)", () => {
        expect(LogLevel.Debug).toBeLessThan(LogLevel.Info);
        expect(LogLevel.Info).toBeLessThan(LogLevel.Warn);
        expect(LogLevel.Warn).toBeLessThan(LogLevel.Error);
        expect(LogLevel.Error).toBeLessThan(LogLevel.Silent);
    });
});

describe("ConsoleLogger", () => {
    it("respects minimum level — drops records below minLevel", () => {
        const infoSpy  = spyOn(console, "info");
        const errorSpy = spyOn(console, "error");

        const l = new ConsoleLogger(LogLevel.Warn);
        l.log(LogLevel.Info,  "hidden");
        l.log(LogLevel.Error, "shown",  { workflowId: "w1" });

        expect(infoSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const arg = errorSpy.calls.mostRecent().args[0] as any;
        expect(arg.workflowId).toBe("w1");
    });

    it("emits a structured record with level name, message, and context fields", () => {
        const infoSpy = spyOn(console, "info");
        const l = new ConsoleLogger(LogLevel.Debug);
        l.log(LogLevel.Info, "msg", { workflowId: "w1", stepId: "s1" });

        expect(infoSpy).toHaveBeenCalledTimes(1);
        const record = infoSpy.calls.mostRecent().args[0] as any;
        expect(record.level).toBe("Info");
        expect(record.message).toBe("msg");
        expect(record.workflowId).toBe("w1");
        expect(record.stepId).toBe("s1");
    });

    it("routes Error to console.error", () => {
        const errorSpy = spyOn(console, "error");
        const l = new ConsoleLogger(LogLevel.Debug);
        l.log(LogLevel.Error, "boom");
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("routes Warn to console.warn", () => {
        const warnSpy = spyOn(console, "warn");
        const l = new ConsoleLogger(LogLevel.Debug);
        l.log(LogLevel.Warn, "caution");
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("routes Debug to console.debug", () => {
        const debugSpy = spyOn(console, "debug");
        const l = new ConsoleLogger(LogLevel.Debug);
        l.log(LogLevel.Debug, "verbose");
        expect(debugSpy).toHaveBeenCalledTimes(1);
    });

    it("Silent level drops everything", () => {
        const infoSpy  = spyOn(console, "info");
        const errorSpy = spyOn(console, "error");
        const warnSpy  = spyOn(console, "warn");
        const debugSpy = spyOn(console, "debug");
        const l = new ConsoleLogger(LogLevel.Silent);
        l.log(LogLevel.Error, "nope");
        expect(infoSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();
    });
});

describe("NullLogger", () => {
    it("swallows everything — no console method is called", () => {
        const infoSpy  = spyOn(console, "info");
        const errorSpy = spyOn(console, "error");
        const warnSpy  = spyOn(console, "warn");
        const debugSpy = spyOn(console, "debug");
        const logSpy   = spyOn(console, "log");

        const l = new NullLogger();
        l.log(LogLevel.Error, "x", { workflowId: "w" });
        l.info!("y");
        l.error!("z");

        expect(infoSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });
});

describe("default binding (NullLogger)", () => {
    it("is silent — zero console calls from the engine with no useLogger call", () => {
        const infoSpy  = spyOn(console, "info");
        const errorSpy = spyOn(console, "error");
        const warnSpy  = spyOn(console, "warn");
        const debugSpy = spyOn(console, "debug");
        const logSpy   = spyOn(console, "log");

        // Intentionally no config.useLogger call.
        const config = configureWorkflow();
        const host = config.getHost();

        // Just verify the DI-resolved logger is a NullLogger (no actual workflow run needed).
        const container = (config as any).container;
        const TYPES = require("../../src/abstractions/types").TYPES;
        const logger = container.get(TYPES.ILogger);
        expect(logger instanceof NullLogger).toBe(true);

        // And calling log on it touches no console method.
        logger.log(LogLevel.Error, "ignored");
        expect(infoSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });
});

describe("FakeLogger", () => {
    it("captures records in order with level, message, and context", () => {
        const fake = new FakeLogger();
        fake.log(LogLevel.Info,  "first",  { workflowId: "w1" });
        fake.log(LogLevel.Error, "second", { workflowId: "w1", stepId: "s2", err: new Error("oops") });

        expect(fake.records.length).toBe(2);
        expect(fake.records[0].level).toBe(LogLevel.Info);
        expect(fake.records[0].message).toBe("first");
        expect(fake.records[0].context!.workflowId).toBe("w1");
        expect(fake.records[1].level).toBe(LogLevel.Error);
        expect(fake.records[1].context!.err).toBeInstanceOf(Error);
    });
});
