/**
 * MongoDB persistence provider — shared IPersistenceProvider conformance suite (M8).
 *
 * This thin wrapper opts the MongoDB provider into the shared conformance suite
 * defined in core/src/testing/conformance/persistence-conformance.ts.
 *
 * In CI, WORKFLOW_ES_MONGO_TEST_URL is set from the GitHub Actions mongo:7
 * service container. Locally, point WORKFLOW_ES_MONGO_TEST_URL at a running
 * mongo:7 instance, e.g.:
 *
 *   docker run -d -p 27017:27017 mongo:7
 *   WORKFLOW_ES_MONGO_TEST_URL=mongodb://127.0.0.1:27017/workflow-es-test yarn test
 *
 * Falls back to the default local address when the env var is unset (handy if a
 * local mongod is already running). If the connection fails, the spec fails with
 * a clear connection error rather than a silent skip — that matches CI behaviour.
 *
 * If you genuinely have no Mongo available, set WORKFLOW_ES_MONGO_SKIP=1 to
 * emit a pending() message instead of failing.
 */
import "reflect-metadata";
import { runPersistenceProviderConformanceTests } from "@reactorynet/workflow-es";
import { MongoDBPersistence } from "../src/mongodb-provider";

const MONGO_URL =
    process.env.WORKFLOW_ES_MONGO_TEST_URL ||
    "mongodb://127.0.0.1:27017/workflow-es-test";

const SKIP = process.env.WORKFLOW_ES_MONGO_SKIP === "1";

if (SKIP) {
    describe("mongodb provider (conformance)", () => {
        it("skipped — WORKFLOW_ES_MONGO_SKIP=1 is set (no Mongo available)", () => {
            pending(
                "Set WORKFLOW_ES_MONGO_TEST_URL and unset WORKFLOW_ES_MONGO_SKIP to run " +
                "the full conformance suite against a live MongoDB instance."
            );
        });
    });
} else {
    runPersistenceProviderConformanceTests({
        providerName: "mongodb",

        createProvider: async () => {
            const provider = new MongoDBPersistence(MONGO_URL);
            await provider.connect;
            return provider;
        },

        reset: async (provider) => {
            // Drop all three collections and let the provider recreate them on
            // the next operation — equivalent to sequelize.sync({ force: true })
            // on the SQL providers.
            const p = provider as MongoDBPersistence;
            const db = (p as any).db;
            for (const name of ["workflows", "subscriptions", "events"]) {
                try { await db.collection(name).drop(); } catch { /* ignore — collection may not exist yet */ }
            }
        },

        dispose: async (provider) => {
            await (provider as MongoDBPersistence).close();
        },
    });
}
