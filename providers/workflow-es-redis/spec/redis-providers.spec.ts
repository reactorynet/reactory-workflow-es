import { QueueType } from "@reactorynet/workflow-es";
import { Redis } from "ioredis";
import { RedisLockManager } from "../src/redis-lock-manager";
import { RedisQueueProvider } from "../src/redis-queue-provider";

// These tests require a real Redis. Point REDIS_URL at it (e.g.
// redis://127.0.0.1:6379). When no Redis is reachable the suite is marked
// pending with a clear message — it is never silently green.
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

async function probe(): Promise<boolean> {
    const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    try {
        await client.connect();
        await client.ping();
        await client.quit();
        return true;
    }
    catch {
        try { client.disconnect(); } catch { /* ignore */ }
        return false;
    }
}

describe("redis providers", () => {

    let redisAvailable = false;
    let clients: Redis[] = [];

    function makeClient(): Redis {
        const c = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
        clients.push(c);
        return c;
    }

    beforeAll(async () => {
        redisAvailable = await probe();
    });

    beforeEach(async () => {
        if (!redisAvailable) return;
        const c = makeClient();
        // Clean the keyspace used by the providers so the suite is repeatable.
        const keys = await c.keys("wes:*");
        if (keys.length > 0)
            await c.del(...keys);
    });

    afterAll(async () => {
        for (const c of clients) {
            try { await c.quit(); } catch { /* ignore */ }
        }
        clients = [];
    });

    it("lock is mutually exclusive", async () => {
        if (!redisAvailable) {
            pending(`No Redis reachable at ${REDIS_URL}; skipping live lock test. Set REDIS_URL to run it.`);
            return;
        }

        const lock1 = new RedisLockManager(makeClient());
        const lock2 = new RedisLockManager(makeClient());

        expect(await lock1.acquireLock("X")).toBe(true);
        expect(await lock2.acquireLock("X")).toBe(false);

        await lock1.releaseLock("X");
        expect(await lock2.acquireLock("X")).toBe(true);

        await lock2.releaseLock("X");
        await lock1.dispose();
        await lock2.dispose();
    });

    it("queue is FIFO and reliable", async () => {
        if (!redisAvailable) {
            pending(`No Redis reachable at ${REDIS_URL}; skipping live queue test. Set REDIS_URL to run it.`);
            return;
        }

        const client = makeClient();
        const queue = new RedisQueueProvider(client);

        await queue.queueForProcessing("a", QueueType.Workflow);
        await queue.queueForProcessing("b", QueueType.Workflow);
        await queue.queueForProcessing("c", QueueType.Workflow);

        expect(await queue.dequeueForProcessing(QueueType.Workflow)).toBe("a");
        expect(await queue.dequeueForProcessing(QueueType.Workflow)).toBe("b");
        expect(await queue.dequeueForProcessing(QueueType.Workflow)).toBe("c");

        // Empty queue returns null, never throws.
        expect(await queue.dequeueForProcessing(QueueType.Workflow)).toBeNull();

        // Dequeued ids were moved to the processing list (reliable dequeue), not dropped.
        const processing = await client.lrange("wes:processing:workflow", 0, -1);
        expect(processing.sort()).toEqual(["a", "b", "c"]);
    });
});
