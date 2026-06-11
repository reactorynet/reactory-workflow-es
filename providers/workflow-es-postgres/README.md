# @reactorynet/workflow-es-postgres

PostgreSQL persistence provider for [Workflow ES](../../core) (Reactory fork).

Built on [Sequelize 6](https://sequelize.org/) and
[`sequelize-typescript`](https://github.com/sequelize/sequelize-typescript). It
implements the `IPersistenceProvider` contract so a Workflow ES host can store
workflow instances, execution pointers, event subscriptions, and events in
Postgres.

## Install

```bash
npm install @reactorynet/workflow-es-postgres pg pg-hstore
```

## Usage

```typescript
import { configureWorkflow } from "@reactorynet/workflow-es";
import { PostgresPersistence } from "@reactorynet/workflow-es-postgres";

const persistence = new PostgresPersistence(
    "postgres://user:password@localhost:5432/workflow"
);

// Wait for the connection + schema sync before starting the host.
await persistence.connect;

const config = configureWorkflow();
config.usePersistence(persistence);

const host = config.getHost();
// register workflows, then:
await host.start();
```

### Constructor

```typescript
new PostgresPersistence(connectionString: string, options?: SequelizeOptions)
```

- `connectionString` — a Postgres connection URI.
- `options` — optional Sequelize options merged over the defaults
  (`dialect: "postgres"`, `logging: false`). Use this to configure the
  connection `pool`, `schema`, `logging`, SSL `dialectOptions`, etc.

On construction the provider opens a connection and runs `sequelize.sync()` to
create the `workflows`, `execution_pointers`, `subscriptions`, and `events`
tables if they do not exist. Await the `connect` promise before use.

## Schema notes

- `nextExecution` / `sleepUntil` are stored as `BIGINT` (they hold
  `Date.now()` epoch milliseconds, which overflow a 4-byte `INTEGER`) and
  normalised back to JS numbers on read.
- Document fields (`data`, `persistenceData`, `eventKey`, `eventData`,
  `outcome`, `children`, `contextItem`, `scope`) are stored as `JSONB`.
- Execution pointers are owned by their workflow: `persistWorkflow` replaces a
  workflow's pointers wholesale inside a transaction, preserving the
  factory-assigned pointer ids.

## Testing

The spec runs against a real Postgres instance. By default it connects to the
Reactory develop compose service:

```bash
npm test
```

Override the target with an environment variable:

```bash
WORKFLOW_ES_PG_TEST_URL="postgres://user:password@host:5432/db" npm test
```
