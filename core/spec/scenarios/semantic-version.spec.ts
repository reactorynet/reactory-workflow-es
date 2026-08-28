/**
 * M11 — Semantic workflow versioning.
 *
 * `version` is a STRING, compared by exact equality and never parsed, ordered, or
 * range-matched. These tests pin the behavioural contract from
 * docs/specs/m11-semantic-versioning.md §6 — in particular the case the old integer
 * key could not express: two MINOR versions of the same workflow id, each running its
 * own graph, side by side in one host.
 */

import {
    configureWorkflow,
    WorkflowBuilder,
    WorkflowStatus,
    WorkflowBase,
    StepBody,
    StepExecutionContext,
    ExecutionResult,
    WorkflowInstance,
    ExecutionPointer,
    PointerStatus,
    WorkflowDeadLetteredEvent,
    IWorkflowRegistry,
    IWorkflowHost,
    TYPES,
    computeDefinitionFingerprint,
} from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";
import { spinWait } from "../helpers/spin-wait";

/** Records which (version, step) pairs actually executed. */
const trace: string[] = [];

class StepV1 extends StepBody {
    public run(_c: StepExecutionContext): Promise<ExecutionResult> {
        trace.push("v1-only");
        return ExecutionResult.next();
    }
}
class StepV11 extends StepBody {
    public run(_c: StepExecutionContext): Promise<ExecutionResult> {
        trace.push("v11-only");
        return ExecutionResult.next();
    }
}
class Shared extends StepBody {
    public run(_c: StepExecutionContext): Promise<ExecutionResult> {
        trace.push("shared");
        return ExecutionResult.next();
    }
}

// ---------------------------------------------------------------------------
// §6.1 / §6.3 — two minor versions of the SAME id coexist
// ---------------------------------------------------------------------------

/** Same id as MinorV11, different version AND a different graph. */
class MinorV10 implements WorkflowBase<any> {
    public id: string = "semver.Minor";
    public version: string = "1.0.0";
    public build(b: WorkflowBuilder<any>) { b.startWith(Shared).then(StepV1); }
}
class MinorV11 implements WorkflowBase<any> {
    public id: string = "semver.Minor";
    public version: string = "1.1.0";
    public build(b: WorkflowBuilder<any>) { b.startWith(Shared).then(StepV11); }
}

describe("M11 — two minor versions of one workflow id run side by side", () => {

    let host: IWorkflowHost;
    let persistence: MemoryPersistenceProvider;
    let v10Instance: WorkflowInstance;
    let v11Instance: WorkflowInstance;

    beforeAll(async () => {
        trace.length = 0;
        persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.usePersistence(persistence);
        host = config.getHost();
        host.registerWorkflow(MinorV10);
        host.registerWorkflow(MinorV11);
        await host.start();

        const idA = await host.startWorkflow("semver.Minor", "1.0.0", {});
        const idB = await host.startWorkflow("semver.Minor", "1.1.0", {});
        await spinWait(async () => {
            const a = await persistence.getWorkflowInstance(idA);
            const b = await persistence.getWorkflowInstance(idB);
            return a && b && a.status === WorkflowStatus.Complete && b.status === WorkflowStatus.Complete;
        });
        v10Instance = await persistence.getWorkflowInstance(idA);
        v11Instance = await persistence.getWorkflowInstance(idB);
    });

    afterAll(async () => { await host.stop(); });

    it("both instances complete", () => {
        expect(v10Instance.status).toBe(WorkflowStatus.Complete);
        expect(v11Instance.status).toBe(WorkflowStatus.Complete);
    });

    it("each instance persists its own version string", () => {
        expect(v10Instance.version).toBe("1.0.0");
        expect(v11Instance.version).toBe("1.1.0");
    });

    it("the persisted version is a string, not coerced to a number", () => {
        expect(typeof v10Instance.version).toBe("string");
    });

    it("each version ran its OWN graph — the case the integer key could not express", () => {
        expect(trace).toContain("v1-only");
        expect(trace).toContain("v11-only");
    });

    it("the two versions are distinct registry entries with distinct fingerprints", () => {
        const container = (() => {
            const c = configureWorkflow();
            c.getContainer().get<IWorkflowRegistry>(TYPES.IWorkflowRegistry).registerWorkflow(new MinorV10());
            return c.getContainer();
        })();
        const registry = container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry);
        expect(registry.getDefinition("semver.Minor", "1.0.0")).toBeDefined();
        expect(registry.tryGetDefinition("semver.Minor", "1.1.0")).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// §6.1 / §6.2 / §6.5 — matching is exact, opaque, and never a range
// ---------------------------------------------------------------------------
class Exact implements WorkflowBase<any> {
    public id: string = "semver.Exact";
    public version: string = "1.2.0";
    public build(b: WorkflowBuilder<any>) { b.startWith(Shared); }
}

describe("M11 — version matching is exact string equality", () => {

    let registry: IWorkflowRegistry;

    beforeAll(() => {
        registry = configureWorkflow().getContainer().get<IWorkflowRegistry>(TYPES.IWorkflowRegistry);
        registry.registerWorkflow(new Exact());
    });

    it("resolves the exact string", () => {
        expect(registry.getDefinition("semver.Exact", "1.2.0").version).toBe("1.2.0");
    });

    it("does NOT range-match a caret range (§6.2)", () => {
        expect(registry.tryGetDefinition("semver.Exact", "^1.2.0")).toBeUndefined();
    });

    it("does NOT range-match a tilde range (§6.2)", () => {
        expect(registry.tryGetDefinition("semver.Exact", "~1.2")).toBeUndefined();
    });

    it("does NOT prefix-match a partial version (§6.1)", () => {
        expect(registry.tryGetDefinition("semver.Exact", "1.2")).toBeUndefined();
    });

    it("does NOT trim whitespace (§6.1)", () => {
        expect(registry.tryGetDefinition("semver.Exact", "1.2.0 ")).toBeUndefined();
    });

    it("does NOT accept a v-prefix (§6.1)", () => {
        expect(registry.tryGetDefinition("semver.Exact", "v1.2.0")).toBeUndefined();
    });

    it("does NOT coerce a numeric-looking version (§6.5)", () => {
        expect(registry.tryGetDefinition("semver.Exact", 1 as any)).toBeUndefined();
    });

    it("throws on a miss via getDefinition, rendering the version as a string", () => {
        expect(() => registry.getDefinition("semver.Exact", "9.9.9"))
            .toThrowError(/semver\.Exact@9\.9\.9/);
    });
});

// ---------------------------------------------------------------------------
// §6.5 — a non-semver string is an opaque key, not something to parse
// ---------------------------------------------------------------------------
class DateVersioned implements WorkflowBase<any> {
    public id: string = "semver.Opaque";
    public version: string = "2024-06-01";
    public build(b: WorkflowBuilder<any>) { b.startWith(Shared); }
}

describe("M11 — a non-semver version string is treated as an opaque key", () => {

    let host: IWorkflowHost;
    let persistence: MemoryPersistenceProvider;
    let instance: WorkflowInstance;

    beforeAll(async () => {
        persistence = new MemoryPersistenceProvider();
        const config = configureWorkflow();
        config.usePersistence(persistence);
        host = config.getHost();
        host.registerWorkflow(DateVersioned);
        await host.start();
        const id = await host.startWorkflow("semver.Opaque", "2024-06-01", {});
        await spinWait(async () => {
            const i = await persistence.getWorkflowInstance(id);
            return i && i.status === WorkflowStatus.Complete;
        });
        instance = await persistence.getWorkflowInstance(id);
    });

    afterAll(async () => { await host.stop(); });

    it("starts and completes", () => {
        expect(instance.status).toBe(WorkflowStatus.Complete);
    });

    it("round-trips the version verbatim — no parsing, no truncation to a major", () => {
        expect(instance.version).toBe("2024-06-01");
    });
});

// ---------------------------------------------------------------------------
// §6.9 — empty / undefined version fails fast rather than defaulting
// ---------------------------------------------------------------------------
describe("M11 — an absent version fails fast", () => {

    let host: IWorkflowHost;

    beforeAll(async () => {
        const config = configureWorkflow();
        config.usePersistence(new MemoryPersistenceProvider());
        host = config.getHost();
        host.registerWorkflow(Exact);
        await host.start();
    });

    afterAll(async () => { await host.stop(); });

    it("rejects an empty-string version instead of defaulting to 1.0.0", async () => {
        await expectAsync(host.startWorkflow("semver.Exact", "", {})).toBeRejected();
    });

    it("rejects an undefined version instead of defaulting to 1.0.0", async () => {
        await expectAsync(host.startWorkflow("semver.Exact", undefined as any, {})).toBeRejected();
    });
});

// ---------------------------------------------------------------------------
// §6.8 — M11 and M10 are independent
// ---------------------------------------------------------------------------
describe("M11 — version is not part of the M10 fingerprint", () => {

    it("the same graph under two versions fingerprints identically", () => {
        const build = (v: string) => {
            const b = new WorkflowBuilder<any>();
            b.startWith(Shared).then(StepV1);
            return b.build("semver.Fp", v);
        };
        expect(build("1.0.0").fingerprint).toBe(build("2.0.0").fingerprint);
    });

    it("but a changed graph under the SAME version still changes the fingerprint", () => {
        const a = new WorkflowBuilder<any>(); a.startWith(Shared).then(StepV1);
        const b = new WorkflowBuilder<any>(); b.startWith(Shared).then(StepV11);
        expect(a.build("semver.Fp", "1.0.0").fingerprint)
            .not.toBe(b.build("semver.Fp", "1.0.0").fingerprint);
    });
});

// ---------------------------------------------------------------------------
// §6.7 — M1 dead-letter parity, with the version rendered as a string
// ---------------------------------------------------------------------------
describe("M11 — an unregistered version string dead-letters cleanly", () => {

    let events: Array<WorkflowDeadLetteredEvent> = [];
    let instance: WorkflowInstance;

    beforeAll(async () => {
        events = [];
        const config = configureWorkflow();
        config.onLifecycleEvent(evt => events.push(evt as WorkflowDeadLetteredEvent));
        const container = config.getContainer();
        container.get<IWorkflowRegistry>(TYPES.IWorkflowRegistry).registerWorkflow(new Exact());
        const executor = container.get<any>(TYPES.IWorkflowExecutor);

        instance = new WorkflowInstance();
        instance.id = "m11-dl-1";
        instance.workflowDefinitionId = "semver.Exact";
        instance.version = "1.3.0";   // registered version is 1.2.0
        instance.status = WorkflowStatus.Runnable;
        instance.data = {};
        instance.createTime = new Date();
        const p = new ExecutionPointer();
        p.id = "m11-dl-p1"; p.active = true; p.stepId = 0;
        p.status = PointerStatus.Pending; p.retryCount = 0;
        instance.executionPointers.push(p);

        await executor.execute(instance);
    });

    it("dead-letters with reason definition-not-registered", () => {
        expect(instance.status).toBe(WorkflowStatus.DeadLettered);
        expect(events[0].reason).toBe("definition-not-registered");
    });

    it("the event carries the version as a string", () => {
        expect(events[0].version).toBe("1.3.0");
        expect(typeof events[0].version).toBe("string");
    });

    it("the message renders the full semver, not a truncated major", () => {
        expect(events[0].errorMessage).toContain("version=1.3.0");
    });
});
