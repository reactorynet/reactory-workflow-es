/**
 * PostgreSQL persistence provider — shared IPersistenceProvider conformance suite (M8).
 *
 * This thin wrapper opts the Postgres provider into the shared conformance suite
 * defined in core/src/testing/conformance/persistence-conformance.ts.
 *
 * In CI, WORKFLOW_ES_PG_TEST_URL is set from the GitHub Actions postgres service
 * container. Locally, point WORKFLOW_ES_PG_TEST_URL at a running postgres:16 instance
 * (e.g. docker run -e POSTGRES_USER=reactory -e POSTGRES_PASSWORD=reactory
 *  -e POSTGRES_DB=reactory -p 5432:5432 postgres:16).
 * Falls back to the Reactory develop docker-compose default.
 */
import { runPersistenceProviderConformanceTests } from "@reactorynet/workflow-es";
import { PostgresPersistence } from "../src/postgres-provider";

const PG_TEST_URL = process.env.WORKFLOW_ES_PG_TEST_URL
    || "postgres://reactory:reactory@127.0.0.1:5432/reactory";

runPersistenceProviderConformanceTests({
    providerName: "postgres",

    createProvider: async () => {
        const provider = new PostgresPersistence(PG_TEST_URL);
        await provider.connect;
        return provider;
    },

    reset: async (provider) => {
        // force:true drops and recreates all tables — idempotent.
        await (provider as PostgresPersistence).sequelize.sync({ force: true });
    },

    dispose: async (provider) => {
        await (provider as PostgresPersistence).sequelize.close();
    },
});
