# Spec — C2 · Embedded SQLite/file persistence provider

| Field | Value |
|---|---|
| **Item ID** | C2 |
| **Title** | Embedded SQLite/file persistence provider (Electron unlock) |
| **Plan reference** | [`upgrade-plan.md` → C2](../upgrade-plan.md) |
| **Target** | Electron (also usable for small Cloud) |
| **Severity** | Critical |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | **C1** (must be `done` first — see §5; the `IPersistenceProvider` concurrency token introduced by C1 must be implemented by this provider) |
| **Author / reviewer** | Werner Weber / — |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. A workflow *host* loads and persists
workflow state through an `IPersistenceProvider`. The full contract today is
(`core/src/abstractions/persistence-provider.ts`):

```ts
export interface IPersistenceProvider {
    createNewWorkflow(instance: WorkflowInstance): Promise<string>;
    persistWorkflow(instance: WorkflowInstance): Promise<void>;
    getWorkflowInstance(workflowId: string): Promise<WorkflowInstance>;
    getRunnableInstances(): Promise<Array<string>>;

    createEventSubscription(subscription: EventSubscription): Promise<void>;
    getSubscriptions(eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>>;
    terminateSubscription(id: string): Promise<void>;

    createEvent(event: Event): Promise<string>;
    getEvent(id: string): Promise<Event>;
    getRunnableEvents(): Promise<Array<string>>;
    markEventProcessed(id: string): Promise<void>;
    markEventUnprocessed(id: string): Promise<void>;
    getEvents(eventName: string, eventKey: any, asOf: Date): Promise<Array<string>>;
}
```

> **NOTE — C1 dependency.** C1 adds an **optimistic-concurrency token** to this interface (a
> `version`/`updatedAt` field on `WorkflowInstance` and a version check inside `persistWorkflow`).
> At the time of writing, C1's spec is not yet authored. This provider **must** implement the
> final post-C1 shape of `IPersistenceProvider`, including the concurrency check. The implementer
> **must read C1's spec and `core/src/abstractions/persistence-provider.ts` + `core/src/models/workflow-instance.ts` as they exist when C1 is `done`**, and treat those as the source of truth for the exact field name and signature. §5 of this spec states the concurrency behaviour the provider must honour and the two most likely concrete shapes. Do not start C2 until C1 is merged.

**Current behaviour / why it is wrong.** The core ships only one provider,
`MemoryPersistenceProvider` (`core/src/services/memory-persistence-provider.ts`), which holds all
state in three in-process arrays (`instances`, `subscriptions`, `events`). **All workflow state is
lost when the process restarts.** The only durable providers are Postgres
(`providers/workflow-es-postgres`), MongoDB, MySQL and Redis — every one of which requires an
**external server**. A desktop (Electron) application cannot bundle and manage a Postgres/Mongo
server, so today there is **no supported way to run the engine durably in a desktop app**. This
blocks the Electron target entirely.

**User-visible impact.** A desktop app using this engine loses every in-flight workflow on quit or
crash. Long-running, event-driven, or delayed workflows (`waitFor`, `delay`, `schedule`) cannot
survive a restart. Small cloud deployments that do not want to operate a separate database server
have no lightweight durable option either.

**Reference for the modern provider style.** The Postgres provider
(`providers/workflow-es-postgres/src/postgres-provider.ts` + `src/models/*`) is the modern,
Sequelize-6 / `sequelize-typescript` based reference. Two of its design decisions are load-bearing
and **must be mirrored** by the new provider:

1. **Pointer-replacement strategy.** A `WorkflowInstance` owns its `executionPointers`.
   `persistWorkflow` replaces them wholesale inside a transaction — `ExecutionPointer.destroy({ where: { workflowId } })` then `bulkCreate(...)` — so added/removed/mutated pointers are all
   reflected and factory-assigned pointer ids (`crypto.randomUUID()`) are preserved.
2. **JSON columns for free-form data.** `data`, `persistenceData`, `eventKey`, `eventData`,
   `outcome`, `children`, `contextItem`, `scope` are stored as `JSONB` and round-tripped to
   plain JS objects.

## 2. Goal

Ship a new first-class **durable, embedded** persistence provider package,
`@reactorynet/workflow-es-sqlite`, that implements the complete (post-C1) `IPersistenceProvider`
contract against a **local SQLite database file** — no external server, no network. After this is
done: a host configured with this provider survives a process restart with zero data loss;
in-flight workflows resume to completion after a kill-and-restart; it bundles inside a packaged
Electron app; and it behaves identically to `MemoryPersistenceProvider` for every interface method
(including the C1 optimistic-concurrency check). It also serves as a lightweight durable option for
small single-node cloud deployments.

## 3. Out of scope

- **Do NOT change the core** (`core/src/**`). This item adds a provider package only. The
  `IPersistenceProvider` interface and the concurrency token are owned by **C1**; C2 only
  *implements* them.
- **Do NOT modify any other provider** (`workflow-es-postgres`, `-mongodb`, `-mysql`, `-redis`,
  `-azure`). No core-interface change originates here (see §7).
- **Do NOT implement a distributed lock or queue provider.** Locking/queueing is C1/H3. This is a
  *persistence* provider only.
- **Do NOT build an Electron sample app or worker-thread hosting pattern.** That is M3. §10 contains
  packaging *notes* only — no app code.
- **Do NOT add encryption/redaction of `data`/`eventData`.** That is H6. Store JSON as-is.
- **Do NOT add multi-tenancy/namespace columns.** That is M6.
- **Do NOT add provider performance indexes beyond the minimum needed for the queries in §5/§6.**
  Mandated index hardening is M2.
- **Do NOT register this provider as the core default.** `configureWorkflow()` keeps
  `MemoryPersistenceProvider` as its default; consumers opt in via `config.usePersistence(...)`.

## 4. Files to create / modify

> New package lives at `providers/workflow-es-sqlite/`. Mirror the Postgres provider's layout exactly.

| Path | Action | Why |
|---|---|---|
| `providers/workflow-es-sqlite/package.json` | create | Package manifest. Mirrors Postgres manifest; `@reactorynet/workflow-es` is a **`peerDependency`** per M7 convention (see §5). |
| `providers/workflow-es-sqlite/tsconfig.json` | create | Identical compiler options to `providers/workflow-es-postgres/tsconfig.json`. |
| `providers/workflow-es-sqlite/README.md` | create | Install/usage/schema/Electron notes (content from §10). |
| `providers/workflow-es-sqlite/src/index.ts` | create | Barrel: `export * from "./sqlite-provider"` and each model file. |
| `providers/workflow-es-sqlite/src/sqlite-provider.ts` | create | The `SqlitePersistence implements IPersistenceProvider` class. |
| `providers/workflow-es-sqlite/src/models/workflow.ts` | create | `Workflow` Sequelize model (table `workflows`). |
| `providers/workflow-es-sqlite/src/models/executionPointer.ts` | create | `ExecutionPointer` model (table `execution_pointers`). |
| `providers/workflow-es-sqlite/src/models/subscription.ts` | create | `Subscription` model (table `subscriptions`). |
| `providers/workflow-es-sqlite/src/models/event.ts` | create | `Event` model (table `events`). |
| `providers/workflow-es-sqlite/spec/support/jasmine.json` | create | Jasmine config; identical to Postgres `spec/support/jasmine.json`. |
| `providers/workflow-es-sqlite/spec/sqlite-persistence-provider.spec.ts` | create | Unit/conformance spec, ported from `postgres-persistence-provider.spec.ts` (§8). |
| `providers/workflow-es-sqlite/spec/sqlite-restart.spec.ts` | create | Kill-and-restart durability integration test (§8). |
| `docs/upgrade-plan.md` | modify | Flip C2 status `planned → done` in the §3 roadmap table when acceptance met. |

## 5. Interface & data-model changes

**No core interface change originates in this item.** This provider *implements* the existing
(post-C1) `IPersistenceProvider`. The class shape:

```ts
// providers/workflow-es-sqlite/src/sqlite-provider.ts
import {
    IPersistenceProvider,
    WorkflowInstance,
    ExecutionPointer as CoreExecutionPointer,
    EventSubscription,
    Event as CoreEvent,
    WorkflowStatus
} from "@reactorynet/workflow-es";
import { Sequelize } from "sequelize-typescript";

export interface SqlitePersistenceOptions {
    /** Extra Sequelize options merged over the defaults (logging, pool, etc.). */
    [key: string]: any;
}

export class SqlitePersistence implements IPersistenceProvider {
    public sequelize: Sequelize;
    public connect: Promise<void>;

    /**
     * @param filename Absolute path to the SQLite database file, or ":memory:".
     *                 The directory must exist (the implementer must NOT create it).
     * @param options  Extra Sequelize options merged over the defaults.
     */
    constructor(filename: string, options: SqlitePersistenceOptions = {}) { /* ... */ }

    // ...all IPersistenceProvider methods (post-C1 shape)...
}
```

Constructor mirrors `PostgresPersistence` but uses the SQLite dialect. Use the `better-sqlite3`
dialect (see §12 for the engine decision):

```ts
this.sequelize = new Sequelize({
    dialect: "sqlite",
    dialectModule: require("better-sqlite3"), // force the better-sqlite3 binding (see §12)
    storage: filename,                         // ":memory:" or an absolute file path
    logging: false,
    models: [Workflow, ExecutionPointer, Subscription, EventModel],
    ...options
});

this.connect = new Promise<void>(async (resolve, reject) => {
    try {
        await this.sequelize.authenticate();
        await this.sequelize.query("PRAGMA journal_mode=WAL;");  // durability + concurrent reads
        await this.sequelize.query("PRAGMA foreign_keys=ON;");
        await this.sequelize.sync();
        resolve();
    } catch (err) { reject(err); }
});
```

> If Sequelize 6's bundled SQLite path resolves to `sqlite3` rather than `better-sqlite3` and
> `dialectModule` cannot redirect it cleanly, fall back to `dialect: "sqlite"` with the default
> binding and add `better-sqlite3` as the runtime dependency that the build verifies loads. The
> contract that matters is §6, not the exact wiring. Document whichever path is taken in the README.

### Schema (the four tables)

Mirror the Postgres models exactly, with **two dialect adaptations** because SQLite has no native
`JSONB` and a narrower type set:

- **JSON columns:** use `DataType.JSON` (Sequelize serialises/deserialises to/from a `TEXT` column
  automatically on SQLite). Applies to: `Workflow.data`; `ExecutionPointer.persistenceData`,
  `eventKey`, `eventData`, `outcome`, `children`, `contextItem`, `scope`; `Subscription.eventKey`;
  `Event.eventData`.
- **Epoch-millis columns** (`Workflow.nextExecution`, `ExecutionPointer.sleepUntil`): keep
  `DataType.BIGINT` with the same getter/setter normaliser used in Postgres (`Number(value)` on
  read). SQLite stores BIGINT as an 8-byte signed integer — `Date.now()` fits — but the driver may
  return it as a string, so the normaliser is still required.
- **Primary keys / ids:** `DataType.UUID` with `@Default(DataType.UUIDV4)`. On SQLite, `UUID` maps
  to `TEXT`; ids assigned by the core factory (`crypto.randomUUID()`) are preserved on insert, as in
  Postgres.

Tables and columns (field set taken from `core/src/models/*` and the Postgres models):

**`workflows`** — `id` (UUID PK), `workflowDefinitionId` (STRING), `version` (INTEGER),
`description` (STRING), `nextExecution` (BIGINT, normalised), `status` (INTEGER), `data` (JSON),
`createTime` (DATE), `completeTime` (DATE), plus the **C1 concurrency token column** (see below).
`@HasMany(() => ExecutionPointer)`.

**`execution_pointers`** — `id` (UUID PK), `workflowId` (UUID FK → `workflows`, `@BelongsTo`),
`stepId` (INTEGER), `active` (BOOLEAN), `sleepUntil` (BIGINT, normalised), `persistenceData` (JSON),
`startTime` (DATE), `endTime` (DATE), `eventName` (STRING), `eventKey` (JSON), `eventPublished`
(BOOLEAN), `eventData` (JSON), `outcome` (JSON), `stepName` (STRING), `retryCount` (INTEGER
default 0), `children` (JSON), `contextItem` (JSON), `predecessorId` (STRING), `scope` (JSON),
`status` (INTEGER default 0).

**`subscriptions`** — `id` (UUID PK), `workflowId` (UUID), `stepId` (INTEGER), `eventName` (STRING),
`eventKey` (JSON), `subscribeAsOf` (DATE).

**`events`** — `id` (UUID PK), `eventName` (STRING), `eventKey` (STRING), `eventData` (JSON),
`eventTime` (DATE), `isProcessed` (BOOLEAN).

All four models use `timestamps: false`, `freezeTableName: true`, and the table names above —
identical to Postgres.

### How JSON `data` / `persistenceData` are stored

Stored via `DataType.JSON`: Sequelize `JSON.stringify`s on write into a `TEXT` column and
`JSON.parse`s on read, so the domain objects round-trip as plain JS values exactly as the Postgres
`JSONB` columns do. The model→domain mappers (`toWorkflowInstance`, `toExecutionPointer`,
`toEventSubscription`, `toEvent`) are **copied verbatim** from the Postgres provider — they are
dialect-independent.

### Optimistic concurrency (C1 token) — REQUIRED

This is the **headline dependency**. C1 introduces an optimistic-concurrency token. The provider
**must** honour it: a `persistWorkflow` that races against a concurrent update of the *same*
instance must detect the conflict instead of silently last-write-wins. The implementer must adopt
the **exact** field name and check semantics defined by C1's merged spec. The two most likely
concrete shapes are:

```ts
// SHAPE A — integer version counter on WorkflowInstance
// WorkflowInstance gains:  public version_lock: number;   (or whatever C1 names it)
// persistWorkflow updates WHERE id = :id AND <token> = :expected, SET <token> = :expected + 1
const [affected] = await Workflow.update(
    { /* fields */, [TOKEN]: expected + 1 },
    { where: { id: instance.id, [TOKEN]: expected }, transaction }
);
if (affected === 0) {
    throw new <C1ConcurrencyError>(`optimistic concurrency conflict for workflow ${instance.id}`);
}

// SHAPE B — updatedAt timestamp token: same pattern, WHERE id = :id AND updatedAt = :expected.
```

Rules: the version check and the pointer replacement happen in the **same transaction**; on a
`affected === 0` mismatch, throw the **error type C1 defines** (do not invent a new one) and make
**no** partial write (the transaction rolls back). Mirror the error/throw behaviour of
`MemoryPersistenceProvider` and Postgres *exactly* as C1 specifies them — if C1's memory/Postgres
implementations throw a specific class, this provider throws the same class.

> **If C1's final shape differs** from A/B, the C1 spec wins. The fixed requirements are: (a) the
> column exists in the `workflows` table, (b) `persistWorkflow` performs the version check inside
> the transaction, and (c) a conflict raises C1's error and writes nothing.

### DI / config impact

None to the core. Consumers wire the provider exactly like Postgres:

```ts
import { configureWorkflow } from "@reactorynet/workflow-es";
import { SqlitePersistence } from "@reactorynet/workflow-es-sqlite";

const persistence = new SqlitePersistence("/abs/path/workflow.db");
await persistence.connect;
const config = configureWorkflow();
config.usePersistence(persistence);
const host = config.getHost();
```

`configureWorkflow()` default stays `MemoryPersistenceProvider` (unchanged).

### `package.json` (peerDependency per M7)

```jsonc
{
  "name": "@reactorynet/workflow-es-sqlite",
  "version": "1.0.0-reactory.0",
  "description": "Embedded SQLite persistence provider for Workflow ES (Reactory fork)",
  "main": "./build/src/index.js",
  "typings": "./build/src/index.d.ts",
  "scripts": {
    "build": "tsc",
    "build:pack": "npm run build && npm pack",
    "pretest": "npm run build",
    "test": "jasmine"
  },
  "keywords": ["workflow", "saga", "sqlite", "embedded", "electron"],
  "author": { "email": "wweber@zepz.io", "name": "Werner Weber" },
  "license": "MIT",
  "peerDependencies": {
    "@reactorynet/workflow-es": ">=2.3.6-reactory.4"
  },
  "devDependencies": {
    "@reactorynet/workflow-es": "file:../../core",
    "@types/jasmine": "^4.6.0",
    "@types/node": "^20.0.0",
    "jasmine": "^5.0.0",
    "jasmine-core": "^5.0.0",
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "reflect-metadata": "^0.2.0",
    "sequelize": "^6.37.0",
    "sequelize-typescript": "^2.1.6"
  }
}
```

> M7 convention: `@reactorynet/workflow-es` is a **`peerDependency`** (consumer supplies one copy,
> avoids dual inversify/reflect-metadata instances) **and** a `devDependency` via `file:../../core`
> so the package builds and tests stand-alone. `reflect-metadata` is aligned to core's `^0.2.0`
> (not the `^0.1.13` the Postgres manifest still carries — that is M7's to fix; here we start clean).
> The peer version floor `>=2.3.6-reactory.4` assumes C1 bumps core to `…-reactory.4`; set it to the
> actual C1 version when known.

### Persisted / at-rest format impact

New on-disk format: a single SQLite file with the four tables above. No migration from a prior
release (no embedded provider existed). Forward migrations across future schema changes are handled
by `sequelize.sync()` for additive columns; destructive migrations are out of scope here.

## 6. Behavioural contract (numbered rules)

1. **Interface completeness.** `SqlitePersistence` implements every method of the post-C1
   `IPersistenceProvider`; `class SqlitePersistence implements IPersistenceProvider` compiles with
   no `// @ts-ignore`.
2. **Memory-provider equivalence.** For every interface method, given identical inputs,
   `SqlitePersistence` returns results equivalent to `MemoryPersistenceProvider`:
   - `createNewWorkflow` assigns and returns a non-empty id and sets `instance.id` to it.
   - `getWorkflowInstance(id)` round-trips all scalar fields, `data`, and the full
     `executionPointers` array (ids preserved); returns `undefined` for an unknown id.
   - `getRunnableInstances()` returns ids where `status === WorkflowStatus.Runnable` **and**
     `nextExecution < Date.now()`.
   - `createEventSubscription` assigns `subscription.id`; `getSubscriptions(name, key, asOf)`
     returns subs matching name+key with `subscribeAsOf <= asOf`; `terminateSubscription(id)`
     removes exactly that sub.
   - `createEvent` assigns and returns `event.id`; `getEvent(id)` round-trips; unknown id →
     `undefined`.
   - `getRunnableEvents()` returns ids where `isProcessed === false` **and** `eventTime <= now`.
   - `markEventProcessed`/`markEventUnprocessed` flip exactly that event's `isProcessed`.
   - `getEvents(name, key, asOf)` returns ids matching name+key with `eventTime >= asOf`.
3. **Durability across restart.** Every successful write is `fsync`-durable before the promise
   resolves (guaranteed by SQLite WAL + default synchronous mode). After the process exits and a new
   `SqlitePersistence` is constructed against the **same file**, all previously persisted workflows,
   pointers, subscriptions, and events are present and identical.
4. **Pointer replacement.** `persistWorkflow` replaces the instance's execution pointers wholesale
   inside a single transaction (`destroy where workflowId` then `bulkCreate`), preserving
   factory-assigned pointer ids — identical to the Postgres provider. Removed pointers disappear;
   added pointers appear; mutated pointers reflect their new values.
5. **Concurrency token honoured (C1).** `persistWorkflow` performs the C1 optimistic-concurrency
   check inside the transaction. When the stored token does not match the expected token (a
   concurrent writer won), it throws C1's concurrency error and writes nothing (transaction
   rolls back). When the token matches, it commits and advances the token.
6. **Atomicity.** A failed `persistWorkflow` (token conflict or DB error) leaves the row and its
   pointers exactly as they were before the call — no partial pointer set.
7. **JSON fidelity.** Objects, arrays, `null`, nested structures in `data`/`persistenceData`/
   `eventData`/`eventKey`/`outcome`/`children`/`contextItem`/`scope` round-trip byte-equivalent
   after `JSON.parse(JSON.stringify(x))` (e.g. `{ counter: 2 }` reads back `{ counter: 2 }`).
8. **Concurrent reads under WAL.** Reads (`getRunnableInstances`, `getEvent`, etc.) do not block on
   an in-progress write and never return a torn/partial row.
9. **Idempotency:** `terminateSubscription`/`markEventProcessed` on an absent or already-applied id
   is a no-op that does not throw (matches memory provider's guarded behaviour).
10. **No external service.** Constructing and using the provider requires only the SQLite file path
    and the bundled native module — no network, no server process.

## 7. Provider parity

**No core interface change originates in C2** — it only adds a new provider. The
`IPersistenceProvider` change (concurrency token) is owned by **C1** and is enumerated across all
providers in C1's spec; C2 simply lands as a *new* implementation of the already-changed interface.

| Provider | Change required |
|---|---|
| memory | None (C1's concern). |
| **sqlite** | **This spec** — new provider implementing the post-C1 interface. |
| postgres | None in C2 (C1 already updated it). |
| mongodb | None in C2. |
| mysql | None in C2. |
| redis | None in C2 (lock/queue, not persistence). |
| azure | None in C2. |

## 8. Test plan (TDD)

Tests follow the Jasmine layout of `providers/workflow-es-postgres/spec`. SQLite needs **no external
service**, so tests use a temp file (durability) or `":memory:"` (fast conformance). Use a unique
temp file per run: `path.join(os.tmpdir(), \`wf-es-sqlite-${Date.now()}.db\`)`, deleted in
`afterAll`.

### Failing-test-first
- **`resumes an in-flight workflow after a simulated process restart`** (in
  `spec/sqlite-restart.spec.ts`) — **must fail before implementation** (the package/class does not
  exist yet, so the import fails to compile / construct).
  - **arrange:** a 2-step workflow whose first step is a `waitFor("resume-event", …)` so the
    instance persists in a non-terminal `Runnable`/waiting state. Build it against a fresh
    `SqlitePersistence(dbFile)` host; `await persistence.connect`; `host.registerWorkflow(...)`;
    `await host.start()`; `const id = await host.startWorkflow(...)`. `spinWait` until a
    subscription for `"resume-event"` exists (proves state hit disk).
  - **act:** `await host.stop()` and **drop all references** to the host and provider (simulating
    process exit — the file remains on disk). Construct a **brand-new** `SqlitePersistence(dbFile)`
    and a **brand-new** host against the **same file**; re-register the same workflow; `start()`;
    `publishEvent("resume-event", key, "Pass", new Date())`.
  - **assert:** `spinWait` until `getWorkflowInstance(id).status !== WorkflowStatus.Runnable`;
    expect `status === WorkflowStatus.Complete` and the data output equals `"Pass"`. Proves
    rules §6.3 and §6.2. Pattern: `core/spec/scenarios/external-events.spec.ts` (the
    `waitFor`/`publishEvent`/`spinWait` flow) and the `spinWait` helper in
    `core/spec/helpers/spin-wait.ts`.

### Coverage
- **`sqlite-persistence-provider.spec.ts`** — a near-verbatim port of
  `postgres-persistence-provider.spec.ts`, run against `":memory:"` (or a temp file with
  `sequelize.sync({ force: true })` in `beforeAll`). Covers `createNewWorkflow`,
  `getWorkflowInstance` round-trip, `persistWorkflow` scalar + pointer persistence,
  `getRunnableInstances`, subscription create/get/terminate, event create/get/runnable/mark.
  Proves §6.2, §6.4, §6.7, §6.9.
- **`getWorkflowInstance returns undefined for unknown id`** — proves §6.2 edge.
- **`persistWorkflow removes a pointer that is no longer present`** — arrange: persist with 2
  pointers, then persist with 1; assert reload has exactly 1. Proves §6.4.
- **`persistWorkflow with a stale concurrency token throws and writes nothing`** — arrange: load
  instance A twice (two in-memory copies with the same token); persist copy 1 (succeeds, advances
  token); persist copy 2 (stale token). Assert: copy-2 persist rejects with C1's concurrency error,
  and a fresh `getWorkflowInstance` shows copy-1's data unchanged. Proves §6.5, §6.6. **Use C1's
  test for this rule as the canonical pattern** if it exists.
- **`durable round-trip across a fresh provider instance`** — arrange: write workflow + event +
  subscription to a temp file, dispose the provider, construct a new provider on the same file.
  Assert all three read back identically. Proves §6.3.
- **`getRunnableInstances respects status and nextExecution`** — proves §6.2.
- **`JSON fields round-trip nested structures`** — `data = { a: [1, {b: null}], c: "x" }`; reload
  equals. Proves §6.7.

### How to run
```bash
# build the core first so the file:../../core dependency resolves
cd core && yarn build

# provider unit + integration (no external service needed)
cd ../providers/workflow-es-sqlite && yarn install && yarn test
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd providers/workflow-es-sqlite && yarn install && yarn build` succeeds (TypeScript compiles;
      `better-sqlite3` native module loads on the CI Node 20 + 22 matrix).
- [ ] `cd providers/workflow-es-sqlite && yarn test` passes, including the kill-and-restart test
      (`sqlite-restart.spec.ts`) and the concurrency-conflict test.
- [ ] The kill-and-restart test demonstrates an in-flight workflow resuming to `Complete` after the
      provider/host are torn down and rebuilt against the same `.db` file (see §8 first test).
- [ ] `class SqlitePersistence implements IPersistenceProvider` type-checks against the **post-C1**
      core with no `@ts-ignore`.
- [ ] A `persistWorkflow` with a stale token throws C1's concurrency error and leaves prior state
      intact (test asserts).
- [ ] Provider uses no network/external server (constructible with only a file path).
- [ ] `docs/upgrade-plan.md` C2 row flipped to `done`.

## 10. Backward compatibility & migration

- **Public API:** purely additive — a new package. No existing public API changes. Core is
  unchanged by C2.
- **Version bump:** core needs **no bump for C2** (C1 owns the `2.3.6-reactory.3 → -reactory.4`
  bump that adds the concurrency token). The new package starts at `1.0.0-reactory.0`.
- **`reactory-express-server` (consumer via `file:` tarball):** no change required; the server keeps
  its current provider. To adopt SQLite it adds the new package and calls
  `config.usePersistence(new SqlitePersistence(path))`.
- **On-disk format:** brand new; no prior format to migrate.

### Electron packaging / migration notes (for the README)

- **Native module rebuild.** `better-sqlite3` is a **native (N-API) addon**. It must be rebuilt
  against Electron's V8 ABI, not the system Node's. Use `electron-rebuild` (or
  `@electron/rebuild`) in the app's `postinstall`, or `electron-builder`'s automatic native-deps
  rebuild. Document that the app — not this package — owns the rebuild step. (This is the headline
  tradeoff vs. `sql.js`; see §12.)
- **ASAR.** Native `.node` binaries cannot load from inside an `app.asar` archive. The app must add
  `better-sqlite3` to `asarUnpack` (electron-builder) so the binary is unpacked to
  `app.asar.unpacked`.
- **File path / location.** The provider takes an **absolute file path**; it must **not** create
  directories. The Electron app should pass a writable, persistent location —
  `path.join(app.getPath("userData"), "workflow.db")` — never a path inside the read-only app
  bundle. Document that `":memory:"` is for tests only (not durable).
- **WAL files.** SQLite in WAL mode creates `-wal` and `-shm` sidecar files next to the `.db`; the
  chosen directory must be writable and these files must not be deleted out from under a live
  connection.
- **Off-main-thread hosting** (cross-ref M3, out of scope here): note in the README that for
  responsiveness the host is best run in a `utilityProcess`/worker — but that is M3's deliverable,
  not C2's.

## 11. Definition of Done

A new package `@reactorynet/workflow-es-sqlite` exists at `providers/workflow-es-sqlite/`, mirroring
the Postgres provider's structure, that implements the full post-C1 `IPersistenceProvider` against a
local SQLite file with **zero external services**. It survives process restart (proven by a
kill-and-restart integration test where an in-flight `waitFor` workflow resumes to `Complete` after
the provider and host are rebuilt against the same `.db` file), behaves equivalently to
`MemoryPersistenceProvider` for every interface method (proven by a port of the Postgres conformance
spec), and honours C1's optimistic-concurrency token (a stale-token `persistWorkflow` throws C1's
error and writes nothing). The package builds and its tests pass on the Node 20 + 22 CI matrix, the
README documents the Electron native-rebuild/ASAR/file-path packaging story, and the C2 roadmap row
is `done`.

## 12. Implementation notes (optional, non-binding)

### Engine decision: `better-sqlite3` vs `sql.js` — **recommend `better-sqlite3`**

| Criterion | `better-sqlite3` (native N-API) | `sql.js` (SQLite compiled to WASM) |
|---|---|---|
| **Durability** | Writes go to a real OS file via SQLite's normal `fsync` path — **truly durable**, the core requirement of C2. | Operates on an **in-memory** DB; persistence means manually `export()`ing the whole DB to a byte array and writing the file yourself. No incremental/transactional fsync — a crash between exports loses data. |
| **Performance** | Fast, synchronous C bindings. | Slower; whole-DB serialise on each save. |
| **Native build** | Requires a native compile and, for Electron, `electron-rebuild` against Electron's ABI. | **No native build** — pure WASM, trivial to bundle. |
| **Sequelize fit** | First-class SQLite dialect support (via `dialectModule`). | No standard Sequelize dialect; would require a custom adapter. |

**Decision: `better-sqlite3`.** C2's entire reason for existing is *durability that survives
restart*. `sql.js`'s in-memory model makes durability a manual, lossy, non-transactional afterthought
and would force a bespoke Sequelize adapter — defeating the goal and the "mirror Postgres" mandate.
The one cost of `better-sqlite3` is the Electron native rebuild, which is a **well-trodden, documented
build-time step** (`electron-rebuild` + `asarUnpack`), fully addressed in §10. We accept that cost.
If a future, genuinely zero-native-build constraint emerges (e.g. a sandbox that forbids native
addons), `sql.js` could be offered as a *secondary, explicitly non-durable* dev provider — but that
is not in scope here.

### Suggested order of edits
1. Scaffold the package (`package.json`, `tsconfig.json`, `src/index.ts`) by copying Postgres and
   swapping names/deps per §5.
2. Copy the four model files from Postgres; change `JSONB → JSON`, keep `BIGINT` normalisers, add
   the C1 token column to `workflow.ts`.
3. Copy `postgres-provider.ts` to `sqlite-provider.ts`; swap the constructor to the SQLite dialect +
   PRAGMAs; copy the mappers verbatim; add the C1 version check to `persistWorkflow`.
4. Port `postgres-persistence-provider.spec.ts` (point at `":memory:"`), then write
   `sqlite-restart.spec.ts` (the failing-test-first).

### Gotchas
- Read C1's merged code **before** writing `persistWorkflow` — the token field name and error class
  must match C1 exactly (§5).
- The Postgres provider's mappers are dialect-agnostic; copy them rather than re-deriving.
- SQLite `DataType.UUID` is `TEXT`; do not rely on a native UUID type. Core-assigned ids are strings
  already.
- Enable `PRAGMA journal_mode=WAL` once on connect (not per-write); it persists in the file header.
- Upstream `danielgerlag/workflow-es` has no SQLite provider — there is no upstream equivalent to
  mirror; the Postgres provider in this repo is the canonical reference.
