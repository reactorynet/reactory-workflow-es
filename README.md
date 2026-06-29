# @reactorynet/workflow-es

[![CI](https://github.com/reactorynet/reactory-workflow-es/actions/workflows/ci.yml/badge.svg)](https://github.com/reactorynet/reactory-workflow-es/actions/workflows/ci.yml)

> **A Reactory-maintained fork of [`danielgerlag/workflow-es`](https://github.com/danielgerlag/workflow-es).**
> Upstream has not been updated since 2019 (v2.3.5). This fork modernises the codebase and hardens it
> for enterprise use — both as a horizontally-scaled **cloud workflow runner** and as an embedded engine
> inside a **desktop / Electron** app. All credit for the original design goes to **Daniel Gerlag**.

A lightweight, durable workflow / saga engine for Node.js + TypeScript. Workflows are defined as code,
persisted as data, and resumed across restarts; long-running steps can sleep, wait for external events,
branch, run in parallel, and compensate (Saga). Persistence, queueing and distributed locking are
pluggable providers, so the same engine runs single-process on a laptop or across many nodes in a cluster.

- **Current version:** `2.5.0` (strict semver — the `-reactory.N` prerelease suffix has been dropped)
- **Status:** enterprise-hardening programme complete (see [Project status](#project-status)).
- **Runtime:** Node.js 20 & 22 (CI matrix). TypeScript ≥ 5, ES2020 output, CommonJS.

---

## Project status

The engine has been through a full enterprise-readiness programme. The roadmap and per-item
specifications live in [`docs/upgrade-plan.md`](docs/upgrade-plan.md) and [`docs/specs/`](docs/specs).
All 17 items are complete:

| Capability | Status | How to use it |
|---|---|---|
| Multi-node safety — distributed lock + reliable queue | ✅ | Redis provider + optimistic concurrency (built in) |
| Optimistic concurrency on persist (`WorkflowConcurrencyError`) | ✅ | Automatic; providers compare-and-set on `concurrencyToken` |
| Graceful shutdown / drain (SIGTERM + Electron quit) | ✅ | `await host.stop()` |
| Bounded concurrency / backpressure | ✅ | `maxConcurrentWorkflows` / `maxConcurrentEvents` |
| Dead-letter + configurable max retries (no more poison loops) | ✅ | `WorkflowOptions.retry`, `onLifecycleEvent(...)` |
| Durable embedded persistence (Electron) | ✅ | `@reactorynet/workflow-es-sqlite` |
| Health endpoint | ✅ | `await host.health()` |
| OpenTelemetry tracing + metrics (optional, zero-dep core) | ✅ | `useMetrics()` / `useTracer()` + OTel adapter |
| Structured logging + correlation IDs | ✅ | `useLogger()` / `useConsoleLogger()` |
| At-rest encryption / redaction hook | ✅ | `useDataCodec()` |
| Multi-tenancy / namespace scoping | ✅ | `tenantId` arg on `startWorkflow` / `publishEvent` |
| Provider indexes + CI conformance for every provider | ✅ | built into providers + CI |

> The default configuration (in-memory persistence, single-node lock/queue) is for **development and
> a single process only**. For any multi-instance / production deployment, wire durable persistence and
> a distributed lock + queue (see [Cloud integration](#cloud-multi-node-integration)). The engine
> **fails loud** at `start()` if it detects single-node providers paired with real persistence — pass
> `config.allowSingleNodeProviders(true)` to override intentionally (e.g. tests).

---

## Installing

This package is consumed by `reactory-express-server` as a `file:` dependency built from source; the
Reactory installer (`bin/install.sh`) clones, builds, and wires it up automatically. To use it directly,
build the tarball and reference it:

```bash
git clone https://github.com/reactorynet/reactory-workflow-es.git
cd reactory-workflow-es/core
yarn install
yarn build        # compile TypeScript → build/
yarn test         # run the Jasmine scenarios
yarn build:pack   # build + emit @reactorynet-workflow-es-<version>.tgz
```

```jsonc
// consumer package.json
{
  "dependencies": {
    "@reactorynet/workflow-es": "file:../reactory-workflow-es/core/reactorynet-workflow-es-2.5.0.tgz"
  }
}
```

`inversify` and `reflect-metadata` are **peer dependencies** (the consumer must provide a single copy —
they back the decorator metadata). Provider packages declare the same peers.

---

## Quick start

A workflow is a class with an `id`, a `version`, and a `build()` method that wires step bodies together.
Step bodies are classes whose `run()` returns an `ExecutionResult`.

```ts
import {
  configureWorkflow, WorkflowBase, WorkflowBuilder,
  StepBody, StepExecutionContext, ExecutionResult,
} from "@reactorynet/workflow-es";

class SayHello extends StepBody {
  public name!: string;                         // populated via .input(...)
  public run(_ctx: StepExecutionContext): Promise<ExecutionResult> {
    console.log(`hello, ${this.name}`);
    return Promise.resolve(ExecutionResult.next());
  }
}

class HelloWorkflow implements WorkflowBase<{ name: string }> {
  public id = "hello";
  public version = 1;
  public build(builder: WorkflowBuilder<{ name: string }>) {
    builder
      .startWith(SayHello)
        .input((step, data) => (step.name = data.name));
  }
}

async function main() {
  const config = configureWorkflow();           // defaults: in-memory + single-node (dev only)
  const host = config.getHost();

  host.registerWorkflow(HelloWorkflow);
  await host.start();

  const id = await host.startWorkflow("hello", 1, { name: "world" });
  console.log("started", id);

  // ... on process exit / app quit:
  await host.stop();                             // graceful drain (SIGTERM/SIGINT handled automatically)
}
main();
```

More patterns (data I/O, events, outcomes/branching, `foreach`, `while`, `if`, parallel, deferred steps)
are in [`samples/node.js/typescript/`](samples/node.js/typescript) and the guides below.

> Note: the sample files predate the rename and still `import … from "workflow-es"`; use
> `@reactorynet/workflow-es` (and the scoped provider names) in new code.

---

## Configuration

`configureWorkflow(options?)` accepts scalar/behavioural tunables; **swappable services** are set with
fluent `useX()` methods on the returned `WorkflowConfig`. Everything is optional — the no-arg call is
fully backward-compatible.

```ts
const config = configureWorkflow({
  pollIntervalMs: 10000,            // poll-worker scan interval (default 10000)
  workflowQueueIntervalMs: 100,     // workflow dequeue tick (default 100)
  eventQueueIntervalMs: 500,        // event dequeue tick (default 500)
  maxConcurrentWorkflows: 10,       // concurrency cap (default 10)
  maxConcurrentEvents: 20,          // concurrency cap (default 20)
  gracefulShutdownTimeoutMs: 30000, // stop() drain budget (default 30000)
  retry: {
    defaultMaxRetries: 3,           // retries AFTER the first attempt (default 3)
    defaultRetryIntervalMs: 60000,  // (default 60000)
    stepNotFoundRetryIntervalMs: 60000,
  },
  dataCodecMaxBytes: 0,             // at-rest payload size guard, 0 = unlimited
});
```

| `WorkflowConfig` setter | Injects | Default |
|---|---|---|
| `usePersistence(p)` | `IPersistenceProvider` | `MemoryPersistenceProvider` |
| `useQueueManager(q)` | `IQueueProvider` | `SingleNodeQueueProvider` |
| `useLockManager(l)` | `IDistributedLockProvider` | `SingleNodeLockProvider` |
| `useLogger(l)` / `useConsoleLogger(level?)` | `ILogger` | `NullLogger` (silent) |
| `useMetrics(m)` / `useTracer(t)` | `IMetrics` / `ITracer` | no-op |
| `useDataCodec(c)` / `useDataCodecSizeLimit(n)` | `IDataCodec` | `NullDataCodec` (plaintext) |
| `useLifecycleEventHub(h)` | `ILifecycleEventHub` | no-op |
| `allowSingleNodeProviders(true)` | (escape hatch) | guard enabled |
| `getHost()` | → `IWorkflowHost` | — |

### Host API (`IWorkflowHost`)

```ts
start(): Promise<void>
stop(): Promise<void>                                              // graceful drain; idempotent
startWorkflow(id, version, data, tenantId?): Promise<string>       // tenantId defaults to "default"
publishEvent(name, key, data, eventTime, tenantId?): Promise<void> // wakes same-tenant subscriptions only
suspendWorkflow(id) / resumeWorkflow(id) / terminateWorkflow(id): Promise<boolean>
registerWorkflow(WorkflowClass): void
onLifecycleEvent(handler): void                                    // e.g. "workflow.dead-lettered"
health(): Promise<HealthReport>                                    // never throws
```

---

## Cloud (multi-node) integration

For a horizontally-scaled runner, give every node **shared durable persistence** and a **distributed
lock + queue**. With these, nodes coordinate via the lock, `persistWorkflow` rejects stale writes
(`WorkflowConcurrencyError`), and exactly one poller scans per cycle.

```ts
import { configureWorkflow } from "@reactorynet/workflow-es";
import { PostgresPersistence } from "@reactorynet/workflow-es-postgres";
import { RedisQueueProvider, RedisLockManager } from "@reactorynet/workflow-es-redis";
import IORedis from "ioredis";

const persistence = new PostgresPersistence(process.env.DATABASE_URL!);
await persistence.connect;                       // each provider exposes a `connect` promise
const redis = new IORedis(process.env.REDIS_URL!);

const config = configureWorkflow({ maxConcurrentWorkflows: 25 });
config.usePersistence(persistence);
config.useQueueManager(new RedisQueueProvider(redis));
config.useLockManager(new RedisLockManager(redis));

const host = config.getHost();
await host.start();
```

Operational guidance:

- **Graceful shutdown:** handle `SIGTERM` (Kubernetes) by awaiting `host.stop()` — it stops intake,
  drains in-flight executions up to `gracefulShutdownTimeoutMs`, and removes its signal handlers.
  (The engine registers `SIGTERM`/`SIGINT` handlers itself; `stop()` is safe to call again.)
- **Health/readiness:** expose `await host.health()` — it probes persistence/lock/queue, reports the
  poll heartbeat and active-workflow count, and aggregates worst-of `Healthy < Degraded < Unhealthy`.
- **Observability:** `useMetrics()` / `useTracer()` with the optional
  `@reactorynet/workflow-es-opentelemetry` adapter (core has **no** OpenTelemetry dependency).
- **Multi-tenancy:** pass `tenantId` to `startWorkflow` / `publishEvent`; events only wake subscriptions
  in the same tenant, even when `(eventName, eventKey)` collide across tenants.
- **Dead-letter:** steps retry up to `maxRetries` (per-step via `.onError(...)`, else
  `WorkflowOptions.retry.defaultMaxRetries`) then move to `DeadLettered` and emit a
  `workflow.dead-lettered` event — subscribe via `host.onLifecycleEvent(...)`.
- **Data at rest:** `useDataCodec()` to encrypt/redact `data` / `eventData` at the persistence boundary
  (query fields like `eventName`/`eventKey`/`status` stay plaintext). See [`docs/data-at-rest.md`](docs/data-at-rest.md).
- **Versioning across deploys:** never unregister an old workflow `version` while instances of it may
  be in flight — an instance whose `(id, version)` is no longer registered is dead-lettered with an
  actionable message rather than looping. See `core/README.md`.

---

## Desktop / Electron integration

For a desktop app, use the durable embedded SQLite provider (no external server) and host the engine
**off the main/renderer thread**. Full guide: [`docs/electron-integration.md`](docs/electron-integration.md);
working sample: [`samples/electron/`](samples/electron).

```ts
import path from "path";
import { app } from "electron";
import { configureWorkflow } from "@reactorynet/workflow-es";
import { SqlitePersistence } from "@reactorynet/workflow-es-sqlite";

const persistence = new SqlitePersistence(path.join(app.getPath("userData"), "workflow.db"));
await persistence.connect;

const config = configureWorkflow();
config.usePersistence(persistence);
const host = config.getHost();
await host.start();

app.on("before-quit", async (e) => {             // drain in-flight work before exit
  e.preventDefault();
  await host.stop();
  app.exit();
});
```

Key constraints (see the guide for detail): step bodies run **inline on the host event loop**, so they
must be async/IO-bound — offload CPU-heavy work to a worker; run the host in a `utilityProcess` (or
`worker_thread`) so it never blocks the UI; `sqlite3` is a native module and must be rebuilt for
Electron's ABI (`electron-rebuild`) and `asarUnpack`ed.

---

## Providers

### Persistence (`IPersistenceProvider`)

| Provider | Package | Use |
|---|---|---|
| In-memory | core (`MemoryPersistenceProvider`) | **dev/test only** — lost on restart |
| SQLite (embedded, durable) | [`@reactorynet/workflow-es-sqlite`](providers/workflow-es-sqlite) | Electron / small single-node cloud |
| PostgreSQL | [`@reactorynet/workflow-es-postgres`](providers/workflow-es-postgres) | cloud reference SQL provider |
| MongoDB (driver v6) | [`@reactorynet/workflow-es-mongodb`](providers/workflow-es-mongodb) | cloud document store |
| MySQL | _deprecated_ | use the Postgres provider with `{ dialect: "mysql" }` + `mysql2` |

All persistence providers honour the optimistic-concurrency `concurrencyToken` and pass a shared
conformance suite in CI. Each exposes a `connect: Promise<void>` you must `await` before use.

### Queue + distributed lock (multi-node)

| Provider | Package | Provides |
|---|---|---|
| Single-node | core | **dev only** — in-process queue + lock |
| Redis | [`@reactorynet/workflow-es-redis`](providers/workflow-es-redis) | reliable queue + Redlock |
| Azure | [`@reactorynet/workflow-es-azure`](providers/workflow-es-azure) | Service Bus queue + blob lock |

---

## Guides

- [TypeScript](typescript-guide.md) · [JavaScript (ES6)](es2017-guide.md) — defining workflows, steps, events, saga
- [Desktop / Electron integration](docs/electron-integration.md) — execution-model contract, off-main-thread hosting, drain
- [Data at rest](docs/data-at-rest.md) — the encryption/redaction codec model
- [Enterprise upgrade plan](docs/upgrade-plan.md) + [specs](docs/specs) — the full hardening programme

---

## Development

```bash
cd core && yarn install && yarn build && yarn test     # engine (Jasmine, Node 20 & 22 in CI)
```

CI builds **every** provider and runs the shared persistence conformance suite against ephemeral
Postgres / MongoDB / Redis service containers, so a breaking change to a core interface fails provider
CI. Per-provider details: [`docs/specs/m8-provider-ci.md`](docs/specs/m8-provider-ci.md).
Contributor conventions, including the mandated provider indexes: [`CONTRIBUTING.md`](CONTRIBUTING.md)
and [`AGENT.md`](AGENT.md).

---

## Authors

- **Daniel Gerlag** — original design and implementation
- **Reactory contributors** — fork maintenance and enterprise hardening

## License

MIT — see [LICENSE](LICENSE)
