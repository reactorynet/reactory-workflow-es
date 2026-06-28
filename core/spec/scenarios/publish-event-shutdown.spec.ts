/**
 * Scenario tests for P4.1 — publishEvent shutdown guard.
 *
 * Before the fix, workflow-host.publishEvent had a `//todo: check host status` comment and no
 * actual check, so events were persisted and queued even after stop() — accumulating on a host
 * whose workers are stopped and will never process them. The fix adds a `shuttingDown` flag
 * (set in performStop, reset in start) and refuses new events with a Warn log while shutting down.
 *
 * Run with: cd core && yarn test
 */
import { configureWorkflow, LogLevel } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { FakeLogger } from "../helpers/fake-logger";

describe("P4.1 publishEvent shutdown guard", () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    it("refuses the event and logs a warning when the host is shutting down", async () => {
        const fake = new FakeLogger();
        const persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.useLogger(fake);
        config.usePersistence(persistence);
        const host = config.getHost();

        spyOn(persistence, "createEvent").and.callThrough();

        await host.start();
        await host.stop();

        // Published AFTER stop() — must be refused (no persistence write, no queue).
        await host.publishEvent("evt-after-stop", "k", { x: 1 }, new Date());

        expect(persistence.createEvent).not.toHaveBeenCalled();

        const warned = fake.records.some(r =>
            r.level === LogLevel.Warn &&
            r.context?.["eventName"] === "evt-after-stop"
        );
        expect(warned).toBe(true);
    });

    it("accepts the event while the host is running", async () => {
        const fake = new FakeLogger();
        const persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.useLogger(fake);
        config.usePersistence(persistence);
        const host = config.getHost();

        spyOn(persistence, "createEvent").and.callThrough();

        await host.start();
        await host.publishEvent("evt-running", "k", { x: 1 }, new Date());

        expect(persistence.createEvent).toHaveBeenCalled();

        await host.stop();
    });
});
