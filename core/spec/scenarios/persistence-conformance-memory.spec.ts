/**
 * Memory persistence provider — shared IPersistenceProvider conformance suite.
 *
 * Runs the same conformance suite the durable providers (sqlite / postgres /
 * mongo) opt into, against the in-memory reference provider. The in-memory
 * provider is the reference semantics (M9 §6 rule 9), so it must pass the full
 * suite — including the M9 query / stats / time-series / delete block — exactly
 * as the durable providers do.
 */
import { runPersistenceProviderConformanceTests } from "../../src/testing/conformance/persistence-conformance";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";

runPersistenceProviderConformanceTests({
    providerName: "memory",

    createProvider: async () => new MemoryPersistenceProvider(),

    reset: async (provider) => {
        // In-place clear (mirrors sequelize.sync({force:true}) / Mongo drop).
        (provider as MemoryPersistenceProvider).reset();
    },
});
