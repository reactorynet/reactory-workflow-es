/**
 * SQLite persistence provider — shared IPersistenceProvider conformance suite (M8).
 *
 * This thin wrapper opts the SQLite provider into the shared conformance suite
 * defined in core/src/testing/conformance/persistence-conformance.ts.
 *
 * No service container is needed: SQLite runs entirely in-process against ":memory:".
 * This spec MUST pass in CI with no external dependencies.
 */
import "reflect-metadata";
// Import from the root barrel — works with any moduleResolution setting.
// The /testing subpath export also works when moduleResolution is node16+.
import { runPersistenceProviderConformanceTests } from "@reactorynet/workflow-es";
import { SqlitePersistence } from "../src/sqlite-provider";

runPersistenceProviderConformanceTests({
    providerName: "sqlite",

    createProvider: async () => {
        const provider = new SqlitePersistence(":memory:");
        await provider.connect;
        return provider;
    },

    reset: async (provider) => {
        // force:true drops and recreates all tables — idempotent.
        await (provider as SqlitePersistence).sequelize.sync({ force: true });
    },

    dispose: async (provider) => {
        await (provider as SqlitePersistence).sequelize.close();
    },
});
