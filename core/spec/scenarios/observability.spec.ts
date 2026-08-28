import {
    configureWorkflow, WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody,
    StepExecutionContext, ExecutionResult, WorkflowInstance, WorkflowErrorHandling,
    METRIC_NAMES, SPAN_NAMES, ATTR, HealthStatus, NoOpMetrics, NoOpTracer, TYPES, IMetrics, ITracer, DEFAULT_TENANT
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";
import { FakeMetrics, FakeTracer, ThrowingMetrics, BrokenPersistenceProvider } from "../helpers/fake-telemetry";

// ---------------------------------------------------------------------------
// Span + duration (failing-first: records a step-execute span per step)
// ---------------------------------------------------------------------------
describe("observability - step span and duration", () => {

    class Step1 extends StepBody {
        public run(_context: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
    }
    class Step2 extends StepBody {
        public run(_context: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
    }
    class Obs_Workflow implements WorkflowBase<any> {
        public id: string = "obs-workflow";
        public version: string = "1.0.0";
        public build(builder: WorkflowBuilder<any>) {
            builder.startWith(Step1).then(Step2);
        }
    }

    let workflowId: string | null = null;
    let persistence = new MemoryPersistenceProvider();
    let tracer = new FakeTracer();
    let metrics = new FakeMetrics();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    config.useTracer(tracer);
    config.useMetrics(metrics);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Obs_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("obs-workflow", "1.0.0", {});
        await spinWait(async () => (await persistence.getWorkflowInstance(workflowId)).status === WorkflowStatus.Complete);
    });

    afterAll(async () => { await host.stop(); });

    it("records a step-execute span per step", () => {
        const stepSpans = tracer.spans.filter(s => s.name === SPAN_NAMES.STEP_EXECUTE);
        expect(stepSpans.length).toBeGreaterThanOrEqual(2);
        for (const s of stepSpans) {
            expect(s.span.attributes[ATTR.WORKFLOW_ID]).toBe(workflowId);
            expect(s.span.attributes[ATTR.STEP_ID]).toBeDefined();
            expect(s.span.ended).toBe(true);
        }
    });

    it("records step duration histogram (one per step run)", () => {
        const durations = metrics.histograms.filter(h => h.name === METRIC_NAMES.STEP_DURATION);
        expect(durations.length).toBeGreaterThanOrEqual(2);
        expect(durations.every(h => h.value >= 0)).toBe(true);
    });

    it("counts started workflows", () => {
        expect(metrics.countOf(METRIC_NAMES.WORKFLOW_STARTED)).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// Error metric + span error
// ---------------------------------------------------------------------------
describe("observability - error metric and span error", () => {

    class FailingStep extends StepBody {
        public run(_context: StepExecutionContext): Promise<ExecutionResult> { throw new Error("boom"); }
    }
    class Failing_Workflow implements WorkflowBase<any> {
        public id: string = "obs-failing-workflow";
        public version: string = "1.0.0";
        public build(builder: WorkflowBuilder<any>) {
            builder.startWith(FailingStep, step => step.onError(WorkflowErrorHandling.Terminate));
        }
    }

    let persistence = new MemoryPersistenceProvider();
    let tracer = new FakeTracer();
    let metrics = new FakeMetrics();
    let config = configureWorkflow({ pollIntervalMs: 1000 });
    config.usePersistence(persistence);
    config.useTracer(tracer);
    config.useMetrics(metrics);
    let host = config.getHost();
    let workflowId: string | null = null;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Failing_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("obs-failing-workflow", "1.0.0", {});
        await spinWait(async () => (await persistence.getWorkflowInstance(workflowId)).status !== WorkflowStatus.Runnable);
    });

    afterAll(async () => { await host.stop(); });

    it("records an error metric and a span error on a failing step", () => {
        expect(metrics.countOf(METRIC_NAMES.STEP_ERRORS)).toBeGreaterThanOrEqual(1);
        const stepSpans = tracer.spans.filter(s => s.name === SPAN_NAMES.STEP_EXECUTE);
        expect(stepSpans.length).toBeGreaterThanOrEqual(1);
        expect(stepSpans.some(s => s.span.errors.length >= 1 && s.span.ended)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Retry metric
// ---------------------------------------------------------------------------
describe("observability - retry metric", () => {

    let scope = { counter: 0 };
    class FailsOnce extends StepBody {
        public run(_context: StepExecutionContext): Promise<ExecutionResult> {
            scope.counter++;
            if (scope.counter <= 1) throw new Error("transient");
            return ExecutionResult.next();
        }
    }
    class Retry_Workflow implements WorkflowBase<any> {
        public id: string = "obs-retry-workflow";
        public version: string = "1.0.0";
        public build(builder: WorkflowBuilder<any>) {
            builder.startWith(FailsOnce, step => step.onError(WorkflowErrorHandling.Retry, 50, 3));
        }
    }

    let persistence = new MemoryPersistenceProvider();
    let metrics = new FakeMetrics();
    let config = configureWorkflow({ pollIntervalMs: 1000 });
    config.usePersistence(persistence);
    config.useMetrics(metrics);
    let host = config.getHost();
    let workflowId: string | null = null;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

    beforeAll(async () => {
        host.registerWorkflow(Retry_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("obs-retry-workflow", "1.0.0", {});
        await spinWait(async () => (await persistence.getWorkflowInstance(workflowId)).status === WorkflowStatus.Complete);
    });

    afterAll(async () => { await host.stop(); });

    it("records a retry metric when a step is retried", () => {
        expect(metrics.countOf(METRIC_NAMES.STEP_RETRIES)).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// Event-published counter + active/queue gauges
// ---------------------------------------------------------------------------
describe("observability - event counter and gauges", () => {

    class Step1 extends StepBody {
        public run(_context: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
    }
    class Gauge_Workflow implements WorkflowBase<any> {
        public id: string = "obs-gauge-workflow";
        public version: string = "1.0.0";
        public build(builder: WorkflowBuilder<any>) {
            builder.startWith(Step1)
                .waitFor("obs-event", () => "0");
        }
    }

    let persistence = new MemoryPersistenceProvider();
    let metrics = new FakeMetrics();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    config.useMetrics(metrics);
    let host = config.getHost();
    let workflowId: string | null = null;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Gauge_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("obs-gauge-workflow", "1.0.0", {});
        await spinWait(async () => {
            const subs = await persistence.getSubscriptions(DEFAULT_TENANT, "obs-event", "0", new Date());
            return subs.length > 0;
        });
        await host.publishEvent("obs-event", "0", "Pass", new Date());
        await spinWait(async () => (await persistence.getWorkflowInstance(workflowId)).status === WorkflowStatus.Complete);
    });

    afterAll(async () => { await host.stop(); });

    it("counts published events", () => {
        expect(metrics.countOf(METRIC_NAMES.EVENT_PUBLISHED)).toBeGreaterThanOrEqual(1);
    });

    it("reports an active-workflow gauge", () => {
        expect(metrics.gauges.some(g => g.name === METRIC_NAMES.WORKFLOW_ACTIVE)).toBe(true);
    });

    it("reports a queue-depth gauge with a queue attribute (SingleNodeQueueProvider)", () => {
        const qd = metrics.gauges.filter(g => g.name === METRIC_NAMES.QUEUE_DEPTH);
        expect(qd.length).toBeGreaterThanOrEqual(1);
        expect(qd.some(g => g.attributes && g.attributes[ATTR.QUEUE] === "workflow")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// health() — all healthy
// ---------------------------------------------------------------------------
describe("observability - health all healthy", () => {

    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => { await host.start(); });
    afterAll(async () => { await host.stop(); });

    it("reports per-component status (all healthy)", async () => {
        const r = await host.health();
        expect(r.status).toBe(HealthStatus.Healthy);
        const names = r.components.map(c => c.name);
        expect(names).toContain("persistence");
        expect(names).toContain("lock");
        expect(names).toContain("queue");
        expect(names).toContain("poll");
        expect(typeof r.activeWorkflows).toBe("number");
        expect(isNaN(Date.parse(r.timestamp))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// health() — unreachable provider (ping false)
// ---------------------------------------------------------------------------
describe("observability - health unreachable provider", () => {

    let persistence = new BrokenPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    config.allowSingleNodeProviders(true);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => { await host.start(); });
    afterAll(async () => { await host.stop(); });

    it("reflects an unreachable persistence provider", async () => {
        persistence.pingResult = false;
        const r = await host.health();
        const p = r.components.find(c => c.name === "persistence");
        expect(p.status).toBe(HealthStatus.Unhealthy);
        expect(r.status).toBe(HealthStatus.Unhealthy);
    });
});

// ---------------------------------------------------------------------------
// health() — never throws (ping throws)
// ---------------------------------------------------------------------------
describe("observability - health never throws", () => {

    let persistence = new BrokenPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    config.allowSingleNodeProviders(true);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => { await host.start(); });
    afterAll(async () => { await host.stop(); });

    it("never throws when a probe throws; component is Unhealthy with the error message", async () => {
        persistence.pingThrows = true;
        await expectAsync(host.health()).toBeResolved();
        const r = await host.health();
        const p = r.components.find(c => c.name === "persistence");
        expect(p.status).toBe(HealthStatus.Unhealthy);
        expect(p.detail).toContain("persistence unreachable");
    });
});

// ---------------------------------------------------------------------------
// health() — degraded on stale/missing poll heartbeat
// ---------------------------------------------------------------------------
describe("observability - health degraded on stale poll", () => {

    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    let host = config.getHost();
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        await host.start();
        // Stub every worker's getLastPollAt() to report a timestamp > 30000ms old,
        // simulating a stale poll heartbeat (default poll interval 10000ms; stale > 3x).
        const workers: any[] = (host as any).workers;
        for (const w of workers) {
            if (typeof w.getLastPollAt === "function") {
                w.getLastPollAt = () => Date.now() - 60000;
            }
        }
    });
    afterAll(async () => { await host.stop(); });

    it("is degraded (not unhealthy) when the poll heartbeat is stale, with all providers healthy", async () => {
        const r = await host.health();
        const poll = r.components.find(c => c.name === "poll");
        expect(poll.status).toBe(HealthStatus.Degraded);
        expect(r.status).toBe(HealthStatus.Degraded);
    });
});

// ---------------------------------------------------------------------------
// Telemetry never breaks execution
// ---------------------------------------------------------------------------
describe("observability - throwing metrics does not fail the workflow", () => {

    class Step1 extends StepBody {
        public run(_context: StepExecutionContext): Promise<ExecutionResult> { return ExecutionResult.next(); }
    }
    class Throwing_Workflow implements WorkflowBase<any> {
        public id: string = "obs-throwing-workflow";
        public version: string = "1.0.0";
        public build(builder: WorkflowBuilder<any>) { builder.startWith(Step1); }
    }

    let persistence = new MemoryPersistenceProvider();
    let config = configureWorkflow();
    config.usePersistence(persistence);
    config.useMetrics(new ThrowingMetrics());
    let host = config.getHost();
    let workflowId: string | null = null;
    let instance: WorkflowInstance | null = null;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;

    beforeAll(async () => {
        host.registerWorkflow(Throwing_Workflow);
        await host.start();
        workflowId = await host.startWorkflow("obs-throwing-workflow", "1.0.0", {});
        await spinWait(async () => {
            instance = await persistence.getWorkflowInstance(workflowId);
            return instance.status === WorkflowStatus.Complete;
        });
    });

    afterAll(async () => { await host.stop(); });

    it("completes the workflow despite metrics throwing", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });
});

// ---------------------------------------------------------------------------
// Default host emits no-ops (zero-dependency)
// ---------------------------------------------------------------------------
describe("observability - default host emits no-ops", () => {

    it("binds NoOpMetrics / NoOpTracer by default and they do not throw", () => {
        const config = configureWorkflow();
        const container = config.getContainer();
        const metrics = container.get<IMetrics>(TYPES.IMetrics);
        const tracer = container.get<ITracer>(TYPES.ITracer);
        expect(metrics instanceof NoOpMetrics).toBe(true);
        expect(tracer instanceof NoOpTracer).toBe(true);
        expect(() => {
            metrics.incrementCounter("x");
            metrics.recordGauge("x", 1);
            metrics.recordHistogram("x", 1);
            const span = tracer.startSpan("x");
            span.setAttribute("a", "b");
            span.recordError(new Error("e"));
            span.end();
        }).not.toThrow();
    });
});
