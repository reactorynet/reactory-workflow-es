/**
 * M2 — Mandated provider indexes: Postgres EXPLAIN / index-presence assertions.
 *
 * These tests verify that the four composite indexes mandated by M2 are:
 *   (a) present in pg_indexes after sync(), and
 *   (b) actually used by the planner (EXPLAIN shows index scan, not seq scan).
 *
 * Gating: this suite requires a live Postgres connection.  When
 * WORKFLOW_ES_PG_TEST_URL is not set, all tests are pending (matching the
 * gating pattern used by the shared conformance suite in M8 CI).  Docker is
 * unavailable locally during development; the tests are written to run in CI
 * where the env var is provided by the GitHub Actions postgres service.
 *
 * FAILING-TEST-FIRST: before M2 added the indexes, the EXPLAIN for
 * getRunnableInstances returned "Seq Scan on workflows", not an index scan.
 * The test below would have failed on the pre-M2 schema and passes after.
 */
import "reflect-metadata";
import { PostgresPersistence } from "../src/postgres-provider";
import { WorkflowStatus } from "@reactorynet/workflow-es";

const PG_TEST_URL = process.env.WORKFLOW_ES_PG_TEST_URL || "";

/**
 * Normalise an EXPLAIN plan text to lowercase for reliable substring matching.
 * The planner may emit "Index Scan" or "Bitmap Index Scan" — both are accepted;
 * "Seq Scan on <table>" is the rejected pattern.
 */
function normalisePlan(plan: string): string {
    return plan.toLowerCase();
}

describe("postgres index presence and EXPLAIN verification (M2)", () => {
    let provider: PostgresPersistence;
    let skipped: boolean;

    beforeAll(async () => {
        if (!PG_TEST_URL) {
            skipped = true;
            return;
        }
        provider = new PostgresPersistence(PG_TEST_URL);
        await provider.connect;
        // Force-sync recreates all tables and their indexes fresh.
        await provider.sequelize.sync({ force: true });
    });

    afterAll(async () => {
        if (provider && provider.sequelize) {
            await provider.sequelize.close();
        }
    });

    // ── §8 Acceptance: all four canonical index names exist after sync ────────

    it("all four M2 indexes exist in pg_indexes after sync()", async () => {
        if (skipped) { pending("WORKFLOW_ES_PG_TEST_URL not set — skipping live Postgres test"); return; }

        const [rows] = await provider.sequelize.query(
            `SELECT indexname FROM pg_indexes
             WHERE tablename IN ('workflows', 'events', 'subscriptions')
               AND indexname IN (
                 'idx_workflows_status_next_execution',
                 'idx_events_isprocessed_eventtime',
                 'idx_events_name_key_eventtime',
                 'idx_subscriptions_name_key_subscribeasof'
               )`
        ) as [Array<{ indexname: string }>, unknown];

        const names = rows.map((r) => r.indexname);
        expect(names).toContain("idx_workflows_status_next_execution");
        expect(names).toContain("idx_events_isprocessed_eventtime");
        expect(names).toContain("idx_events_name_key_eventtime");
        expect(names).toContain("idx_subscriptions_name_key_subscribeasof");
    });

    // ── §8 Idempotency: a second sync() must not error or duplicate indexes ──

    it("sync() is idempotent — a second call succeeds and produces no duplicate indexes", async () => {
        if (skipped) { pending("WORKFLOW_ES_PG_TEST_URL not set — skipping live Postgres test"); return; }

        // Second sync() on the already-synced schema must not throw.
        await provider.sequelize.sync();

        const [rows] = await provider.sequelize.query(
            `SELECT indexname, COUNT(*) AS cnt
             FROM pg_indexes
             WHERE tablename IN ('workflows', 'events', 'subscriptions')
               AND indexname IN (
                 'idx_workflows_status_next_execution',
                 'idx_events_isprocessed_eventtime',
                 'idx_events_name_key_eventtime',
                 'idx_subscriptions_name_key_subscribeasof'
               )
             GROUP BY indexname`
        ) as [Array<{ indexname: string; cnt: string }>, unknown];

        // Each canonical index must appear exactly once.
        for (const row of rows) {
            expect(Number(row.cnt)).toEqual(1, `Index ${row.indexname} duplicated after second sync`);
        }
        expect(rows.length).toEqual(4);
    });

    // ── §8 EXPLAIN: getRunnableInstances uses the index (failing-test-first) ─

    it("getRunnableInstances uses idx_workflows_status_next_execution (not Seq Scan)", async () => {
        if (skipped) { pending("WORKFLOW_ES_PG_TEST_URL not set — skipping live Postgres test"); return; }

        // Seed enough rows for the Postgres planner to prefer the index.
        // Near-empty tables are always seq-scanned; 5 000 rows is enough for
        // the planner to choose the composite index.
        const batchSize = 500;
        const batches = 10;
        for (let b = 0; b < batches; b++) {
            const rows = [];
            for (let i = 0; i < batchSize; i++) {
                const global = b * batchSize + i;
                rows.push({
                    id: require("crypto").randomUUID(),
                    tenantId: "default",
                    workflowDefinitionId: "bench-wf",
                    version: 1,
                    status: global % 10 === 0
                        ? WorkflowStatus.Runnable   // 10 % are Runnable-and-due
                        : WorkflowStatus.Complete,
                    nextExecution: global % 10 === 0 ? Date.now() - 1000 : null,
                    data: {},
                    concurrencyToken: 0
                });
            }
            // Raw insert via sequelize to bypass model validation overhead.
            await provider.sequelize.getQueryInterface().bulkInsert("workflows", rows as any);
        }

        const [[planRow]] = await provider.sequelize.query(
            `EXPLAIN SELECT id FROM workflows WHERE status = ${WorkflowStatus.Runnable} AND "nextExecution" < ${Date.now()}`
        ) as [Array<{ "QUERY PLAN": string }>, unknown];

        const plan = normalisePlan(planRow["QUERY PLAN"]);
        // Accept "index scan" or "bitmap index scan"; reject "seq scan on workflows".
        const hasIndexScan = plan.includes("index scan") || plan.includes("bitmap index scan");
        const hasSeqScan = plan.includes("seq scan on workflows");
        expect(hasIndexScan).toBe(true, `Expected index scan but got: ${planRow["QUERY PLAN"]}`);
        expect(hasSeqScan).toBe(false, `Expected no seq scan but plan contains one: ${planRow["QUERY PLAN"]}`);
    });

    // ── §8 EXPLAIN: getEvents uses the index ─────────────────────────────────

    it("getEvents uses idx_events_name_key_eventtime (not Seq Scan)", async () => {
        if (skipped) { pending("WORKFLOW_ES_PG_TEST_URL not set — skipping live Postgres test"); return; }

        // Insert enough event rows for the planner to use the index.
        const rows = [];
        for (let i = 0; i < 5000; i++) {
            rows.push({
                id: require("crypto").randomUUID(),
                tenantId: "default",
                eventName: i % 50 === 0 ? "target-event" : `event-${i % 100}`,
                eventKey: i % 50 === 0 ? "target-key" : `key-${i}`,
                eventData: null,
                eventTime: new Date(Date.now() - 10000),
                isProcessed: false
            });
        }
        await provider.sequelize.getQueryInterface().bulkInsert("events", rows as any);

        const [[planRow]] = await provider.sequelize.query(
            `EXPLAIN SELECT id FROM events WHERE "tenantId" = 'default' AND "eventName" = 'target-event' AND "eventKey" = 'target-key' AND "eventTime" >= '${new Date(0).toISOString()}'`
        ) as [Array<{ "QUERY PLAN": string }>, unknown];

        const plan = normalisePlan(planRow["QUERY PLAN"]);
        const hasIndexScan = plan.includes("index scan") || plan.includes("bitmap index scan");
        const hasSeqScan = plan.includes("seq scan on events");
        expect(hasIndexScan).toBe(true, `Expected index scan but got: ${planRow["QUERY PLAN"]}`);
        expect(hasSeqScan).toBe(false, `Expected no seq scan but plan contains one: ${planRow["QUERY PLAN"]}`);
    });

    // ── §8 EXPLAIN: getRunnableEvents uses the index ──────────────────────────

    it("getRunnableEvents uses idx_events_isprocessed_eventtime (not Seq Scan)", async () => {
        if (skipped) { pending("WORKFLOW_ES_PG_TEST_URL not set — skipping live Postgres test"); return; }

        // Events table already has rows from the previous test.
        const [[planRow]] = await provider.sequelize.query(
            `EXPLAIN SELECT id FROM events WHERE "isProcessed" = false AND "eventTime" <= '${new Date().toISOString()}'`
        ) as [Array<{ "QUERY PLAN": string }>, unknown];

        const plan = normalisePlan(planRow["QUERY PLAN"]);
        const hasIndexScan = plan.includes("index scan") || plan.includes("bitmap index scan");
        const hasSeqScan = plan.includes("seq scan on events");
        expect(hasIndexScan).toBe(true, `Expected index scan but got: ${planRow["QUERY PLAN"]}`);
        expect(hasSeqScan).toBe(false, `Expected no seq scan but plan contains one: ${planRow["QUERY PLAN"]}`);
    });

    // ── §8 EXPLAIN: getSubscriptions uses the index ───────────────────────────

    it("getSubscriptions uses idx_subscriptions_name_key_subscribeasof (not Seq Scan)", async () => {
        if (skipped) { pending("WORKFLOW_ES_PG_TEST_URL not set — skipping live Postgres test"); return; }

        // Seed subscription rows.
        const rows = [];
        for (let i = 0; i < 5000; i++) {
            rows.push({
                id: require("crypto").randomUUID(),
                tenantId: "default",
                workflowId: require("crypto").randomUUID(),
                stepId: 0,
                eventName: i % 50 === 0 ? "target-event" : `event-${i % 100}`,
                eventKey: i % 50 === 0 ? "target-key" : `key-${i}`,
                subscribeAsOf: new Date(0)
            });
        }
        await provider.sequelize.getQueryInterface().bulkInsert("subscriptions", rows as any);

        const [[planRow]] = await provider.sequelize.query(
            `EXPLAIN SELECT id FROM subscriptions WHERE "tenantId" = 'default' AND "eventName" = 'target-event' AND "eventKey" = 'target-key' AND "subscribeAsOf" <= '${new Date().toISOString()}'`
        ) as [Array<{ "QUERY PLAN": string }>, unknown];

        const plan = normalisePlan(planRow["QUERY PLAN"]);
        const hasIndexScan = plan.includes("index scan") || plan.includes("bitmap index scan");
        const hasSeqScan = plan.includes("seq scan on subscriptions");
        expect(hasIndexScan).toBe(true, `Expected index scan but got: ${planRow["QUERY PLAN"]}`);
        expect(hasSeqScan).toBe(false, `Expected no seq scan but plan contains one: ${planRow["QUERY PLAN"]}`);
    });
});
