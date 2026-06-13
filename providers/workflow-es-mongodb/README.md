# @reactorynet/workflow-es-mongodb

MongoDB persistence provider for [Workflow ES](../../core) (Reactory fork).

Built on the official [`mongodb`](https://www.npmjs.com/package/mongodb) driver **v6** with
`async/await` and `ObjectId`. It implements the `IPersistenceProvider` contract so a Workflow ES
host can store workflow instances, execution pointers, event subscriptions, and events in MongoDB.

## Install

```bash
npm install @reactorynet/workflow-es-mongodb mongodb
```

## Usage

```typescript
import { configureWorkflow } from "@reactorynet/workflow-es";
import { MongoDBPersistence } from "@reactorynet/workflow-es-mongodb";

const persistence = new MongoDBPersistence(
    "mongodb://user:password@localhost:27017/workflow-es"
);

// Wait for the connection before starting the host.
await persistence.connect;

const config = configureWorkflow();
config.usePersistence(persistence);

const host = config.getHost();
// register workflows, then:
await host.start();
```

## Constructor

```typescript
new MongoDBPersistence(connectionString: string, options?: MongoClientOptions)
```

- `connectionString` — a MongoDB connection URI.
- `options` — optional `MongoClientOptions` forwarded to `MongoClient`. The driver v4+
  defaults cover everything; do **not** pass `useNewUrlParser` or `useUnifiedTopology`
  (both were removed in v4).

On construction the provider connects to MongoDB and binds the `workflows`, `subscriptions`,
and `events` collections. Await the `connect` promise before use.

## Collections

| Collection      | Purpose |
|-----------------|---------|
| `workflows`     | `WorkflowInstance` documents including execution pointers as an embedded array. |
| `subscriptions` | `EventSubscription` documents. |
| `events`        | `Event` documents. |

Collection names are fixed and match the upstream `workflow-es` convention.

## Optimistic concurrency (C1)

`persistWorkflow` is a compare-and-set operation on the `concurrencyToken` field:

- `createNewWorkflow` stamps `concurrencyToken: 0` on every new document.
- `persistWorkflow` filters on `{ _id, concurrencyToken: expected }` and atomically sets
  `concurrencyToken` to `expected + 1`. If no document matches (a concurrent writer advanced
  the token first), it throws `WorkflowConcurrencyError` — the host's executor catches this and
  retries.

## Migration (existing data)

Documents created before this release do not have a `concurrencyToken` field. Run this
one-time migration against your `workflows` collection to seed it:

```js
db.workflows.updateMany(
    { concurrencyToken: { $exists: false } },
    { $set: { concurrencyToken: 0 } }
);
```

## Testing

The spec runs against a live MongoDB instance. By default it connects to
`mongodb://127.0.0.1:27017/workflow-es-test`. Override with an environment variable:

```bash
WORKFLOW_ES_MONGO_TEST_URL="mongodb://user:pass@host:27017/db" npm test
```

To skip the suite when no MongoDB is available, set `WORKFLOW_ES_MONGO_SKIP=1`.

Start a local Mongo with Docker if needed:

```bash
docker run -d -p 27017:27017 mongo:7
npm test
```
