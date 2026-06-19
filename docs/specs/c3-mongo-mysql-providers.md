# Spec — C3 · Repair or deprecate Mongo & MySQL providers

| Field | Value |
|---|---|
| **Item ID** | C3 |
| **Title** | Repair or deprecate Mongo & MySQL providers |
| **Plan reference** | [`upgrade-plan.md` → C3](../upgrade-plan.md) |
| **Target** | Cloud |
| **Severity** | Critical |
| **Owner tag** | `[copilot+review]` |
| **Status** | spec |
| **Depends on** | C1, M7, M8 |
| **Author / reviewer** | Werner Weber / <reviewer> |

---

## 0. Recommendation (read first)

This spec makes a **per-provider** decision. Both decisions are binding; the implementer does not
re-decide them.

### MongoDB → **REWRITE** on driver v6 (async/await, `ObjectId`)
**Decision:** rewrite `providers/workflow-es-mongodb/src/mongodb-provider.ts` against the modern
`mongodb` driver (v6), using `async/await`, `ObjectId`, and the C1 optimistic-concurrency token.

**Justification.**
1. MongoDB is the only **document-store** provider in the repo. Postgres (SQL) and the planned SQLite
   provider (C2) do not cover it, so deprecating Mongo would leave a real capability gap for consumers
   who run Mongo as their primary store.
2. The defects are **shallow and mechanical**, not architectural: the file uses the removed v3 callback
   API and a copy-pasted `.then((err, result) => …)` bug (a `then` callback receives the *result*, not
   an error — so `createNewWorkflow`/`createEventSubscription`/`createEvent` currently swallow errors and
   read the id off a possibly-unset `_id`). The persistence contract itself
   (`IPersistenceProvider`) is unchanged. The driver-v6 API is `async/await`-native, so the rewrite
   *removes* the hand-rolled `new Promise(...)` wrappers rather than adding complexity.
3. The work is well-bounded and verifiable: M8 provides a Mongo Testcontainer and a shared conformance
   suite. A rewrite is cheaper to keep alive than a deprecation that we later have to un-deprecate.

### MySQL → **DEPRECATE**, generalise Postgres to a multi-dialect SQL provider
**Decision:** formally deprecate the standalone `providers/workflow-es-mysql` package. MySQL support is
**not dropped** — it is re-homed as a **dialect option on the existing Postgres provider**, which is
renamed/retitled as the canonical SQL provider. Concretely: the existing
`@reactorynet/workflow-es-postgres` package gains a documented MySQL dialect path
(`new PostgresPersistence(connStr, { dialect: "mysql" })` continues to work via Sequelize), and
`workflow-es-mysql` gets a deprecation banner + a redirect to it + CI exclusion.

**Justification.**
1. The Postgres provider is **already** built on Sequelize 6 + `sequelize-typescript` 2 — Sequelize is a
   multi-dialect ORM. MySQL is one config flag (`dialect: "mysql"` + `mysql2` driver) away. Maintaining a
   *second* near-identical Sequelize provider is pure duplication and exactly the rot that produced C3.
2. The standalone MySQL provider is on **EOL** dependencies (`sequelize@^4`, `sequelize-typescript@^0.6`)
   and uses APIs removed in Sequelize 5/6 (`updateAttributes`, `findById`, the `$lt`/`$gt` query operators
   instead of `Op.lt`/`Op.gt`). Bringing it to Sequelize 6 would reproduce the Postgres provider almost
   line-for-line.
3. The plan (C3 summary) explicitly offers this path: *"Postgres already covers SQL via Sequelize 6 —
   MySQL could become a thin dialect variant or be deprecated."* We take the deprecate-the-package /
   keep-the-capability route, which is the least code and least ongoing maintenance.

**Net effect:** one rewritten document provider (Mongo) and one canonical SQL provider (Postgres, now
documented for both Postgres and MySQL dialects), with the standalone MySQL package deprecated.

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. Persistence is pluggable via the
`IPersistenceProvider` interface (`core/src/abstractions/persistence-provider.ts`):

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

Two providers are broken and will not build / run against current core:

### MongoDB — `providers/workflow-es-mongodb`
File `src/mongodb-provider.ts` targets the removed `mongodb` v3 callback API and contains a logic bug:

- **Old package import** (`mongodb-provider.ts:1`):
  `import { ... } from "workflow-es";` — the package was renamed to `@reactorynet/workflow-es`.
- **Removed driver API — callback `connect`** (`:16-28`):
  ```ts
  const options = { useNewUrlParser: true, useUnifiedTopology: true };
  MongoClient.connect(connectionString, options, (err, client) => { ... });
  ```
  Driver v4+ removed the callback form of `MongoClient.connect`, removed `useNewUrlParser`/
  `useUnifiedTopology` (no-ops now), and the connection is `await`-only.
- **Removed export `ObjectID`** (`:2`, used `:47,62,121,146,175,188`): renamed to `ObjectId` in v4+.
- **Promise/callback bug** (`:34-39`, repeated `:93-98`, `:133-139`): treats a `then` resolution as if it
  were a Node callback:
  ```ts
  self.workflowCollection.insertOne(instance)
      .then((err, result) => {                 // <- WRONG: then gets the result, not (err, result)
          instance.id = instance["_id"].toString();
          resolve(instance.id);
      })
      .catch(err => reject(err));
  ```
  The second arg is always `undefined`; the first arg *is* the insert result. The code never reads it,
  relying on the driver having mutated `instance._id` in place — fragile and version-dependent.
- **Callback CRUD APIs** (`findOneAndUpdate(...,(err,r)=>…)` `:49`, `findOne(...,(err,doc)=>…)` `:62`,
  `.find(...).toArray((err,data)=>…)` `:76`, `remove(...,cb)` `:121`): all removed in v4+, which is
  Promise-only. `remove` was replaced by `deleteOne`/`deleteMany`. The `find` projection second-arg shape
  and `findOneAndUpdate` option `returnOriginal` were also changed (`returnDocument: 'before'|'after'`).
- **`package.json`** declares `mongodb@^3.2.7`, `inversify@^4.1.0`, `reflect-metadata@^0.1.10`,
  `workflow-es@^2.1.0` as hard dependencies — all stale (see M7).

### MySQL — `providers/workflow-es-mysql`
File `src/mysql-provider.ts`:

- **Old package import** (`mysql-provider.ts:1`): `import { ... } from "workflow-es";`.
- **EOL dependencies** (`package.json`): `sequelize@^4.41.2`, `sequelize-typescript@^0.6.6` — both EOL.
  Postgres uses `sequelize@^6.37.0`, `sequelize-typescript@^2.1.6`.
- **Removed Sequelize APIs:** `workflow.updateAttributes(instance)` (`:49` — removed in Sequelize 5, now
  `model.update(...)`), `findById` (`:60,169` — removed, now `findByPk`), and the legacy `$lt`/`$gt`
  query operators (`:76,113,184,234`) which require `Op.lt`/`Op.gt` under Sequelize 5+ operator security.
- **Untyped `sequelize: any`** and `new Sequelize(connectionString)` with no `dialect`/`models` —
  contrast the Postgres provider which passes `{ dialect, models, ... }`.

The Postgres provider (`providers/workflow-es-postgres/src/postgres-provider.ts` + `src/models/*`) is the
**modern reference**: Sequelize 6, `sequelize-typescript` 2, `@reactorynet/workflow-es` import,
`async/await`, `Op.lt`/`Op.lte`/`Op.gte`, owned-pointer `persistWorkflow` inside a transaction, and
model→domain mappers. Both repaired/redirected providers must converge toward it.

**User-visible impact.** A consumer who selects the Mongo or MySQL provider gets a package that does not
compile against current core, and (for Mongo) silently loses errors on insert. CI never caught this
because CI builds `core` only (see M8).

---

## 2. Goal

After this item:
- The **MongoDB** provider compiles against current core and the `mongodb` v6 driver, uses `async/await`
  and `ObjectId` throughout, has the insert-error bug fixed, depends on `@reactorynet/workflow-es` as a
  **peer dependency**, implements the **C1 optimistic-concurrency token**, and passes the shared M8
  conformance suite against a Mongo Testcontainer.
- The **standalone MySQL** package is formally **deprecated**: a prominent README banner, a `deprecated`
  field in `package.json`, redirection to the Postgres (canonical SQL) provider, and exclusion from CI.
- MySQL support is **preserved as a dialect** of the Postgres provider: its README documents the
  `{ dialect: "mysql" }` usage and the `mysql2` driver requirement, and a conformance run can target a
  MySQL Testcontainer through the same `PostgresPersistence` class.

## 3. Out of scope

- **Do NOT** modify the core `IPersistenceProvider` interface in this item. The optimistic-concurrency
  token is **defined by C1**; C3 only *implements* C1's already-merged token in the Mongo provider. If C1
  is not yet `done`, stop and escalate — do not invent a token shape here.
- **Do NOT** rename, move, or restructure the Postgres provider package name (`@reactorynet/workflow-es-postgres`)
  or its model files. C3 only *adds documentation* of the MySQL dialect path and *optionally* a MySQL
  conformance target. Generalising the package name (e.g. to `-sql`) is a separate, later decision.
- **Do NOT** touch `providers/workflow-es-redis` or `providers/workflow-es-azure` (those are C1).
- **Do NOT** add new query indexes here (that is M2).
- **Do NOT** delete the `workflow-es-mysql` directory. Deprecate in place so existing `file:`/git
  references do not 404.
- **Do NOT** change the Mongo collection names (`workflows`, `subscriptions`, `events`) or the persisted
  document shape beyond adding the C1 concurrency token field.
- **Do NOT** add `inversify` back as a hard dependency anywhere (see M7).

## 4. Files to create / modify

> Exhaustive. `<token>` below is the C1 concurrency-token field name (see §5/§7 — read C1's spec for the
> exact identifier; this spec assumes `version` is already taken by the workflow-definition version, so
> the token is a **separate** field, referred to here as `concurrencyToken`).

### MongoDB (REWRITE path)

| Path | Action | Why |
|---|---|---|
| `providers/workflow-es-mongodb/src/mongodb-provider.ts` | modify (rewrite) | Driver v6 async/await, `ObjectId`, fix insert bug, implement C1 token, import `@reactorynet/workflow-es`. |
| `providers/workflow-es-mongodb/src/index.ts` | create if absent / verify | Re-export `MongoDBPersistence` (mirror Postgres `index.ts`). |
| `providers/workflow-es-mongodb/package.json` | modify | `mongodb@^6`, drop `inversify`, peer-dep core, align `reflect-metadata`, devDeps for build/test (see §7). |
| `providers/workflow-es-mongodb/tsconfig.json` | create if absent | Mirror Postgres tsconfig (ES2020, decorators, `include` spec, `files` index). |
| `providers/workflow-es-mongodb/README.md` | create | Usage + constructor + schema notes, modelled on the Postgres README. |
| `providers/workflow-es-mongodb/spec/mongodb-persistence-provider.spec.ts` | create | Conformance spec (M8 shared suite or local mirror of Postgres spec). |
| `providers/workflow-es-mongodb/spec/support/jasmine.json` | create | Mirror Postgres `spec/support/jasmine.json` (`spec_dir: build/spec`). |

### MySQL (DEPRECATE path)

| Path | Action | Why |
|---|---|---|
| `providers/workflow-es-mysql/README.md` | create | Deprecation banner + redirect to Postgres SQL provider with the `{ dialect: "mysql" }` recipe. |
| `providers/workflow-es-mysql/package.json` | modify | Add `"deprecated": "<message>"`, mark `private: true` so it is never published, point `repository.directory` is unchanged. Do **not** bump source deps. |
| `providers/workflow-es-mysql/src/mysql-provider.ts` | modify (top-of-file banner only) | Add a JSDoc `@deprecated` block pointing to `@reactorynet/workflow-es-postgres`. No behavioural change. |

### Postgres (becomes canonical SQL provider — documentation + optional MySQL conformance)

| Path | Action | Why |
|---|---|---|
| `providers/workflow-es-postgres/README.md` | modify | Add a "Using MySQL (and other Sequelize dialects)" section with the `{ dialect: "mysql" }` recipe and the `mysql2` peer requirement. |
| `providers/workflow-es-postgres/package.json` | modify | Add `mysql2` as an **optional/peer** dependency (only needed for the MySQL dialect); keep `pg`/`pg-hstore`. |
| `providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts` | (no change required) | The same suite can run against MySQL by overriding the connection URL + dialect; documented in §8. |

### CI (M8 surface — coordinate, do not own)

| Path | Action | Why |
|---|---|---|
| `.github/workflows/ci.yml` | modify (M8) | Add Mongo provider build + conformance job (Mongo Testcontainer). **Exclude** `workflow-es-mysql` from the build/test matrix (deprecated). Optionally add a MySQL-dialect conformance job that runs the Postgres provider against a MySQL Testcontainer. |

## 5. Interface & data-model changes

### Core interface
**None.** C3 does not change `IPersistenceProvider`. The optimistic-concurrency token is introduced by
**C1**; this spec consumes it.

### MongoDB provider — API translation (driver v3 callback → v6 async/await)

Full before/after for the rewritten `mongodb-provider.ts`. `self`/`new Promise(...)` wrappers are removed
in favour of `async/await`.

#### Imports + class fields
```ts
// BEFORE
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "workflow-es";
import { MongoClient, ObjectID } from "mongodb";

export class MongoDBPersistence implements IPersistenceProvider {
    public connect: Promise<void>;
    private client: any;
    private workflowCollection: any;
    private subscriptionCollection: any;
    private eventCollection: any;
    private retryCount: number = 0;

// AFTER
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "@reactorynet/workflow-es";
import { MongoClient, ObjectId, Collection, Db } from "mongodb";

export class MongoDBPersistence implements IPersistenceProvider {
    public connect: Promise<void>;
    private client: MongoClient;
    private db: Db;
    private workflowCollection: Collection;
    private subscriptionCollection: Collection;
    private eventCollection: Collection;
```
(`retryCount` was dead — remove it.)

#### Constructor — connect
```ts
// BEFORE
constructor(connectionString: string) {
    var self = this;
    this.connect = new Promise<void>((resolve, reject) => {
        const options = { useNewUrlParser: true, useUnifiedTopology: true };
        MongoClient.connect(connectionString, options, (err, client) => {
            if (err) reject(err);
            self.client = client;
            const db = self.client.db();
            self.workflowCollection = db.collection("workflows");
            self.subscriptionCollection = db.collection("subscriptions");
            self.eventCollection = db.collection("events");
            resolve();
        });
    });
}

// AFTER
constructor(connectionString: string, options: any = {}) {
    this.connect = (async () => {
        // v4+ removed useNewUrlParser / useUnifiedTopology (now no-ops/defaults).
        this.client = await MongoClient.connect(connectionString, options);
        this.db = this.client.db();
        this.workflowCollection = this.db.collection("workflows");
        this.subscriptionCollection = this.db.collection("subscriptions");
        this.eventCollection = this.db.collection("events");
    })();
}
```

#### `createNewWorkflow` — fix the then/catch bug
```ts
// BEFORE
public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
    var self = this;
    let deferred = new Promise<string>((resolve, reject) => {
        self.workflowCollection.insertOne(instance)
            .then((err, result) => {                       // BUG
                instance.id = instance["_id"].toString();
                resolve(instance.id);
            })
            .catch(err => reject(err));
    });
    return deferred;
}

// AFTER
public async createNewWorkflow(instance: WorkflowInstance): Promise<string> {
    // C1: stamp the initial concurrency token before first write.
    (instance as any).concurrencyToken = (instance as any).concurrencyToken ?? 0;
    const result = await this.workflowCollection.insertOne(instance as any);
    instance.id = result.insertedId.toString();
    return instance.id;
}
```
Note: read the id from `result.insertedId`, **not** from a mutated `instance._id`.

#### `persistWorkflow` — async + `ObjectId` + C1 optimistic concurrency
This is the **only method that gains real new behaviour** (the C1 token). The write must be a
compare-and-set on the token.
```ts
// BEFORE
public persistWorkflow(instance: WorkflowInstance): Promise<void> {
    var self = this;
    let deferred = new Promise<void>((resolve, reject) => {
        var id = ObjectID(instance.id);
        delete instance['_id'];
        self.workflowCollection.findOneAndUpdate({ _id: id }, { $set: instance }, { returnOriginal: false },
        (err, r) => { if (err) reject(err); resolve(); });
    });
    return deferred;
}

// AFTER
public async persistWorkflow(instance: WorkflowInstance): Promise<void> {
    const id = new ObjectId(instance.id);
    const expected = (instance as any).concurrencyToken ?? 0;
    const next = expected + 1;

    const update = { ...instance } as any;
    delete update._id;            // never $set _id
    delete update.id;             // domain id is the stringified _id
    update.concurrencyToken = next;

    const result = await this.workflowCollection.findOneAndUpdate(
        { _id: id, concurrencyToken: expected },   // compare-and-set on the token
        { $set: update },
        { returnDocument: "after" }                // v4+ replaced returnOriginal
    );

    if (!result) {
        // No document matched the (id, expected-token) filter → a concurrent
        // writer advanced the token (or the row is gone). Surface as the C1
        // concurrency error so the host can re-load and retry.
        throw new (require("@reactorynet/workflow-es").WorkflowConcurrencyError ?? Error)(
            `Optimistic concurrency conflict persisting workflow ${instance.id}`
        );
    }
    (instance as any).concurrencyToken = next;     // reflect the new token in memory
}
```
> **C1 dependency note:** the exact error type/name (`WorkflowConcurrencyError` above is a placeholder)
> and whether the token lives on `WorkflowInstance` as a typed field are **defined by C1**. Use C1's
> exact symbol; do not invent one. If C1 stores the token under a different name than `concurrencyToken`,
> use C1's name everywhere in this file. The mechanism (filter on expected token, `$set` incremented
> token, treat null result as conflict) is the contract here.

#### `getWorkflowInstance` — async + null-safe + hydrate token
```ts
// BEFORE
public getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
    var self = this;
    let deferred = new Promise<WorkflowInstance>((resolve, reject) => {
        self.workflowCollection.findOne({ _id: ObjectID(workflowId) }, ((err, doc) => {
            if (err) reject(err);
            doc.id = doc._id.toString();
            resolve(doc);
        }));
    });
    return deferred;
}

// AFTER
public async getWorkflowInstance(workflowId: string): Promise<WorkflowInstance> {
    const doc = await this.workflowCollection.findOne({ _id: new ObjectId(workflowId) });
    if (!doc) return undefined;
    (doc as any).id = doc._id.toString();
    return doc as any;     // concurrencyToken rides along on the doc for the next persist
}
```

#### `getRunnableInstances` — async, `toArray()` returns a Promise
```ts
// BEFORE
self.workflowCollection.find({ status: WorkflowStatus.Runnable, nextExecution: { $lt: Date.now() } }, { _id: 1 })
    .toArray((err, data) => { ... });

// AFTER
public async getRunnableInstances(): Promise<Array<string>> {
    const data = await this.workflowCollection
        .find({ status: WorkflowStatus.Runnable, nextExecution: { $lt: Date.now() } })
        .project({ _id: 1 })                 // projection moved to .project() in v4+
        .toArray();
    return data.map((item) => item._id.toString());
}
```

#### `createEventSubscription` / `createEvent` — same then/catch fix as `createNewWorkflow`
```ts
// AFTER (createEventSubscription)
public async createEventSubscription(subscription: EventSubscription): Promise<void> {
    const result = await this.subscriptionCollection.insertOne(subscription as any);
    subscription.id = result.insertedId.toString();
}

// AFTER (createEvent)
public async createEvent(event: Event): Promise<string> {
    const result = await this.eventCollection.insertOne(event as any);
    event.id = result.insertedId.toString();
    return event.id;
}
```

#### `getSubscriptions` / `getEvents` / `getRunnableEvents` — async `toArray()`
```ts
// AFTER (getSubscriptions)
public async getSubscriptions(eventName: string, eventKey: string, asOf: Date): Promise<Array<EventSubscription>> {
    const data = await this.subscriptionCollection
        .find({ eventName, eventKey, subscribeAsOf: { $lt: asOf } })
        .toArray();
    return data.map((item) => { (item as any).id = item._id.toString(); return item as any; });
}

// AFTER (getRunnableEvents)
public async getRunnableEvents(): Promise<Array<string>> {
    const data = await this.eventCollection
        .find({ isProcessed: false, eventTime: { $lt: new Date() } })
        .project({ _id: 1 }).toArray();
    return data.map((item) => item._id.toString());
}

// AFTER (getEvents)
public async getEvents(eventName: string, eventKey: any, asOf: Date): Promise<Array<string>> {
    const data = await this.eventCollection
        .find({ eventName, eventKey, eventTime: { $gt: asOf } })
        .project({ _id: 1 }).toArray();
    return data.map((item) => item._id.toString());
}
```

#### `terminateSubscription` — `remove(cb)` → `deleteOne`
```ts
// BEFORE
self.subscriptionCollection.remove({ _id: ObjectID(id) }, { single: true }, (err, n) => { ... });

// AFTER
public async terminateSubscription(id: string): Promise<void> {
    await this.subscriptionCollection.deleteOne({ _id: new ObjectId(id) });
}
```

#### `getEvent` — async + null-safe
```ts
// AFTER
public async getEvent(id: string): Promise<Event> {
    const doc = await this.eventCollection.findOne({ _id: new ObjectId(id) });
    if (!doc) return undefined;
    (doc as any).id = doc._id.toString();
    return doc as any;
}
```

#### `markEventProcessed` / `markEventUnprocessed` — async + `returnDocument`
```ts
// AFTER
public async markEventProcessed(id: string): Promise<void> {
    await this.eventCollection.findOneAndUpdate(
        { _id: new ObjectId(id) }, { $set: { isProcessed: true } }, { returnDocument: "after" });
}
public async markEventUnprocessed(id: string): Promise<void> {
    await this.eventCollection.findOneAndUpdate(
        { _id: new ObjectId(id) }, { $set: { isProcessed: false } }, { returnDocument: "after" });
}
```

### MySQL provider — interface changes
**None to the source.** Deprecation is documentation + `package.json` metadata only. The source keeps its
existing (broken-against-current-core) state but gains a top-of-file `@deprecated` JSDoc banner.

### Postgres provider — MySQL dialect
**None to the source code.** `PostgresPersistence(connStr, options)` already spreads `options` over the
Sequelize config (`postgres-provider.ts:30-36`), so `new PostgresPersistence(connStr, { dialect: "mysql" })`
selects MySQL with no code change. Document-typed columns use `JSONB`/`UUID` in the models; under MySQL,
Sequelize maps these to `JSON`/`CHAR(36)` automatically. The only addition is the optional `mysql2`
driver dependency and README documentation.

### DI / config impact
No change to `configureWorkflow()`, `WorkflowConfig`, or `TYPES`. Providers are passed to
`config.usePersistence(provider)` as today.

### Persisted / at-rest format impact
- **Mongo:** adds a `concurrencyToken` field (number, default 0) to documents in the `workflows`
  collection. **Forward migration:** none required — `persistWorkflow` filters on `concurrencyToken: 0`
  for legacy rows that lack the field only if `0` is the missing-field default; to be safe, on first
  persist of a legacy row, the filter `{ _id, concurrencyToken: 0 }` will **not** match a document with no
  `concurrencyToken` field. **Therefore:** the spec requires `createNewWorkflow` to stamp
  `concurrencyToken: 0`, and a one-time migration note (§10) for pre-existing data: run
  `db.workflows.updateMany({ concurrencyToken: { $exists: false } }, { $set: { concurrencyToken: 0 } })`.
- **MySQL standalone:** none (deprecated, not published).
- **Postgres-as-MySQL:** the same schema `sequelize.sync()` creates the tables in MySQL; no migration for
  greenfield use.

## 6. Behavioural contract (numbered rules)

**MongoDB provider (rewrite):**
1. `await provider.connect` resolves once the client is connected and all three collection handles are
   bound; it rejects if the connection fails.
2. `createNewWorkflow(instance)` inserts the document, sets `instance.id = insertedId.toString()`, stamps
   `concurrencyToken = 0`, and returns `instance.id`. Insert failures **reject** (the old then/catch bug
   swallowed them — this must no longer happen).
3. `getWorkflowInstance(id)` returns the hydrated instance with `id` set from `_id`, **including** its
   current `concurrencyToken`; returns `undefined` for a missing id (no throw on missing doc).
4. **Concurrency:** `persistWorkflow(instance)` is a compare-and-set: it updates only the document whose
   `_id` matches **and** whose stored `concurrencyToken` equals the in-memory expected token, incrementing
   the token by 1. If no document matches (a concurrent writer won), it **throws the C1 concurrency
   error** and does not partially write.
5. On a successful `persistWorkflow`, the in-memory `instance.concurrencyToken` is advanced to the new
   value so the same instance object can be persisted again without a re-read.
6. `getRunnableInstances()` returns string ids of workflows with `status === Runnable` and
   `nextExecution < Date.now()`.
7. `createEventSubscription` / `createEvent` set the generated id from `insertedId` and reject on failure
   (then/catch bug fixed).
8. `getSubscriptions(name,key,asOf)` returns subscriptions with matching name/key and
   `subscribeAsOf < asOf`, each with `id` populated.
9. `terminateSubscription(id)` deletes exactly one subscription by `_id`; idempotent (deleting a missing
   id is a no-op, not an error).
10. `getRunnableEvents()` returns ids of unprocessed events with `eventTime < now`;
    `getEvents(name,key,asOf)` returns ids matching name/key with `eventTime > asOf`.
11. `markEventProcessed` / `markEventUnprocessed` flip `isProcessed`; no-op (not error) on missing id.
12. **No removed APIs:** the file contains no `ObjectID`, no `useNewUrlParser`, no `useUnifiedTopology`,
    no `.remove(`, no callback-style `find().toArray(cb)`/`findOne(...,cb)`/`findOneAndUpdate(...,cb)`,
    and no `returnOriginal`. (Mechanically greppable — see §9.)

**MySQL deprecation:**
13. `workflow-es-mysql/package.json` has `"private": true` and a `"deprecated"` message; the package is
    never published and is excluded from CI build/test.
14. The MySQL README's first line is a deprecation banner directing users to
    `@reactorynet/workflow-es-postgres` with the `{ dialect: "mysql" }` recipe.

**Postgres-as-canonical-SQL:**
15. `new PostgresPersistence(connStr, { dialect: "mysql" })` connects to MySQL and satisfies the same
    conformance suite (rule set 2–11) when `mysql2` is installed.

## 7. Provider parity

C3 does **not** change a core interface, so it does not itself trigger an all-provider edit. However, C3
**lands the consumer side of three other items** in the Mongo provider, and must be consistent with them:

| Provider | Change required in this PR |
|---|---|
| memory | none |
| sqlite (C2) | none (separate item) |
| postgres | add MySQL-dialect docs + optional `mysql2` dep; no source change |
| **mongodb** | rewrite to driver v6; switch to `@reactorynet/workflow-es` **peerDependency** (M7); align `reflect-metadata` to core `^0.2.0` (M7); drop `inversify` hard dep (M7); implement the **C1 optimistic-concurrency token** in `persistWorkflow`/`createNewWorkflow`; pass the **M8** conformance suite |
| **mysql** | deprecate (README banner, `private:true` + `deprecated` in package.json, `@deprecated` JSDoc); excluded from M8 CI |
| redis | none (C1) |
| azure | none (C1) |

### M7 cross-reference — dependency hygiene (applies to the Mongo package.json)
```jsonc
// BEFORE (providers/workflow-es-mongodb/package.json dependencies)
"dependencies": {
    "inversify": "^4.1.0",
    "json-stable-stringify": "^1.0.1",
    "mongodb": "^3.2.7",
    "reflect-metadata": "^0.1.10",
    "workflow-es": "^2.1.0"
}

// AFTER
"dependencies": {
    "mongodb": "^6.0.0"
},
"peerDependencies": {
    "@reactorynet/workflow-es": "^2.3.6-reactory.0",   // align to current core; see M7 for exact range
    "reflect-metadata": "^0.2.0"
},
"devDependencies": {
    "@reactorynet/workflow-es": "file:../../core",     // for local build/test, mirrors postgres
    "@types/jasmine": "^4.6.0",
    "@types/node": "^20.0.0",
    "jasmine": "^5.0.0",
    "jasmine-core": "^5.0.0",
    "reflect-metadata": "^0.2.0",
    "typescript": "^5.0.0"
}
```
> `inversify` is removed entirely (the provider does not use DI decorators). The Mongo `package.json`
> `main`/`typings` should point at `./build/src/index.js` / `./build/src/index.d.ts` to match the build
> layout, and `scripts` should mirror Postgres (`build: tsc`, `pretest: npm run build`, `test: jasmine`).
> The exact peer-dep version **range** is governed by **M7** — use whatever M7 standardised; do not invent
> a different range than the other providers.

## 8. Test plan (TDD)

The Mongo provider must pass the **shared conformance suite (M8)**. Where M8's shared suite is not yet
extracted, mirror `providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts` (which is
the de-facto conformance contract). The spec runs against a real Mongo via Testcontainers/Docker.

### Failing-test-first
- **`persistWorkflow rejects on concurrent write (optimistic concurrency)`** — *arrange:* create a
  workflow, load it into two separate `WorkflowInstance` references A and B (both with the same
  `concurrencyToken`). *act:* `await persistWorkflow(A)`; then `await persistWorkflow(B)`. *assert:* the
  first succeeds and advances the token; the **second rejects** with the C1 concurrency error. *Proves
  rule §6.4.* **Must fail before the rewrite** (the old code uses last-write-wins `findOneAndUpdate` with
  no token filter, so B would silently overwrite A).
- **`createNewWorkflow rejects when the insert fails`** — *arrange:* point the provider at a collection
  that rejects the insert (e.g. duplicate `_id`, or a closed client). *act:* `await createNewWorkflow(x)`.
  *assert:* the returned promise **rejects**. *Proves §6.2.* **Must fail before the fix** (old then/catch
  swallowed the error and resolved).

### Coverage (mirror the Postgres spec, rule → test)
- **`createNewWorkflow returns a generated id and sets instance.id`** — §6.2.
- **`getWorkflowInstance round-trips persisted fields incl. data`** — §6.3.
- **`getWorkflowInstance returns undefined for an unknown id`** — §6.3.
- **`persistWorkflow persists scalar changes and replaces execution pointers`** — §6.4/§6.5.
- **`persistWorkflow advances the in-memory concurrencyToken on success`** — §6.5.
- **`getRunnableInstances contains a runnable, past-due workflow`** — §6.6.
- **`event subscription create / getSubscriptions / terminate (idempotent)`** — §6.7–§6.9.
- **`createEvent + getRunnableEvents includes unprocessed, excludes processed`** — §6.7/§6.10.
- **`getEvents matches name/key with eventTime > asOf`** — §6.10.
- **`markEventProcessed / markEventUnprocessed flip isProcessed; no-op on missing id`** — §6.11.
- **`no-removed-driver-API grep`** — a unit/lint assertion (or a CI grep step) that the compiled provider
  source contains none of `ObjectID`, `useNewUrlParser`, `useUnifiedTopology`, `.remove(`,
  `returnOriginal` — §6.12.

### MySQL deprecation tests
- **`mysql package is marked deprecated and private`** — read `workflow-es-mysql/package.json`, assert
  `private === true` and `deprecated` is a non-empty string. §6.13.
- **CI assertion:** the M8 matrix does **not** include `workflow-es-mysql` (verified by inspecting
  `.github/workflows/ci.yml` job list).

### Postgres-as-MySQL conformance (optional but recommended in M8)
- Run the existing Postgres spec with `WORKFLOW_ES_PG_TEST_URL` pointed at a MySQL Testcontainer and the
  provider constructed as `new PostgresPersistence(url, { dialect: "mysql" })`. §6.15.

### How to run
```bash
# Mongo provider (Docker available):
cd providers/workflow-es-mongodb && npm run build && npm test
# (pretest pulls/starts a mongo container per the package.json scripts, or use a running Mongo and
#  set the connection string in the spec/env.)

# Postgres provider against MySQL dialect (optional):
WORKFLOW_ES_PG_TEST_URL="mysql://user:pass@127.0.0.1:3306/workflow" \
  cd providers/workflow-es-postgres && npm test    # spec constructs PostgresPersistence with { dialect: "mysql" }
```

## 9. Acceptance criteria (binary)

- [ ] `cd providers/workflow-es-mongodb && npm run build` succeeds (TypeScript compiles against current
      core + `mongodb@^6`).
- [ ] `cd providers/workflow-es-mongodb && npm test` passes against a Mongo container, including both
      failing-first tests (concurrency conflict + insert-error rejection).
- [ ] `grep -REn "ObjectID|useNewUrlParser|useUnifiedTopology|\.remove\(|returnOriginal" providers/workflow-es-mongodb/src`
      returns **no matches**.
- [ ] `grep -n '"workflow-es"' providers/workflow-es-mongodb/src/*.ts` returns no matches; the import is
      `@reactorynet/workflow-es`.
- [ ] Mongo `package.json` has `@reactorynet/workflow-es` + `reflect-metadata` under `peerDependencies`,
      no `inversify`, and `mongodb@^6` (M7).
- [ ] `node -e "const p=require('./providers/workflow-es-mysql/package.json'); process.exit(p.private===true && p.deprecated ? 0 : 1)"`
      exits 0.
- [ ] `workflow-es-mysql/README.md` first heading/line is a deprecation banner naming
      `@reactorynet/workflow-es-postgres`.
- [ ] `.github/workflows/ci.yml` (M8) builds + conformance-tests the Mongo provider and **excludes**
      `workflow-es-mysql`.
- [ ] (Optional) Postgres spec passes against a MySQL container via `{ dialect: "mysql" }`.

## 10. Backward compatibility & migration

- **Public API:** `MongoDBPersistence` constructor signature stays
  `(connectionString: string)` and gains an **optional** second `options` arg — additive, non-breaking.
  Method signatures are unchanged (interface-driven). The new behaviour is that `persistWorkflow` can now
  **throw** a concurrency error where it previously silently overwrote — this is the intended C1 contract
  and is documented; the host's executor handles it (per C1).
- **At-rest (Mongo):** documents gain a `concurrencyToken` field. New workflows get it from
  `createNewWorkflow`. **Pre-existing data** (created before this change) must be migrated once:
  ```js
  db.workflows.updateMany({ concurrencyToken: { $exists: false } }, { $set: { concurrencyToken: 0 } });
  ```
  Document this in the Mongo README "Migration" section.
- **MySQL:** consumers of the standalone `workflow-es-mysql` package must migrate to
  `@reactorynet/workflow-es-postgres` with `{ dialect: "mysql" }` and install `mysql2`. The deprecation
  banner + README spell out the swap. No data migration is implied by the deprecation itself (the schema
  Sequelize 6 produces differs from the EOL Sequelize 4 schema — note in the README that existing MySQL
  data may need a schema reconciliation; greenfield use is unaffected).
- **Version bump:** Mongo provider moves from `2.1.1` to a `-reactory.N` line consistent with the other
  reactory-forked providers (mirror the Postgres `1.0.0-reactory.0` convention; coordinate the exact
  number with M7). MySQL package version is left as-is but marked `private`/`deprecated`.
- **`reactory-express-server` impact:** if the consumer wires Mongo, it must update its dependency to the
  new peer-dep layout (install `@reactorynet/workflow-es` + `reflect-metadata` itself). If it wired MySQL,
  it switches to the Postgres provider with the MySQL dialect. Flag in the PR description.

## 11. Definition of Done

The MongoDB provider builds and runs against the current `@reactorynet/workflow-es` core and the modern
`mongodb` v6 driver, using `async/await` and `ObjectId` exclusively, with the insert-error-swallowing bug
fixed and the C1 optimistic-concurrency token enforced on `persistWorkflow` (compare-and-set, throws on
conflict). Its `package.json` follows M7 (core + `reflect-metadata` as peer deps, no `inversify`,
`mongodb@^6`), and it passes the M8 shared conformance suite against a Mongo Testcontainer in CI —
including the two failing-first tests for concurrency conflict and insert-error propagation. The standalone
MySQL provider is formally deprecated in place (private, `deprecated` metadata, README banner, `@deprecated`
JSDoc) and excluded from CI; its capability is preserved and documented as the `{ dialect: "mysql" }` path
on the canonical Postgres SQL provider, which a reviewer can verify by reading the updated READMEs and the
CI matrix.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) update Mongo `package.json` + add `tsconfig.json` (M7 layout) so `npm run
  build` even works; (2) rewrite `mongodb-provider.ts` method-by-method top to bottom following §5;
  (3) add the spec mirroring the Postgres spec; (4) deprecate MySQL (cheap, do it last); (5) Postgres
  README + optional `mysql2`.
- The `mongodb` v6 `findOneAndUpdate` returns the document directly (not a `{ value }` wrapper) when using
  the modern overload; verify against the installed `@types/mongodb`/driver types — if the installed
  typing returns `{ value }`, read `result?.value` instead of `result`. Treat the conformance test, not
  this note, as the contract.
- Upstream reference: `danielgerlag/workflow-es` `workflow-es-mongodb` was itself ported to the async
  driver in later versions — useful as a sanity check, but our C1 token is a Reactory addition not present
  upstream.
- For the MySQL-as-Postgres-dialect conformance, the only gotcha is `DataType.JSONB` (Postgres-specific):
  Sequelize maps `JSONB` to `JSON` under MySQL automatically, but if a column is declared `JSONB`
  explicitly and MySQL rejects it, change those columns to `DataType.JSON` (portable across both) — but
  that is a Postgres-model change and therefore **out of scope here**; if it surfaces, file a follow-up,
  do not edit the models in this item.
