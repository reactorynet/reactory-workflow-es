# @reactorynet/workflow-es-sqlite

Embedded SQLite persistence provider for
[`@reactorynet/workflow-es`](../../core/README.md).

Implements the full `IPersistenceProvider` interface against a local SQLite
database file — **no external server, no network**.  A process that uses this
provider survives a restart with zero data loss: in-flight workflows resume to
completion after a kill-and-restart.  It is the recommended provider for
Electron/desktop applications and for small single-node cloud deployments that
do not want to operate a separate database server.

Built on [Sequelize 6](https://sequelize.org/) +
[sequelize-typescript](https://github.com/sequelize-typescript/sequelize-typescript)
with the [`sqlite3`](https://github.com/TryGhost/node-sqlite3) driver (see
[Engine decision](#engine-decision)).

---

## Installation

```bash
# in the consuming project
npm install @reactorynet/workflow-es-sqlite
# or
yarn add @reactorynet/workflow-es-sqlite
```

`@reactorynet/workflow-es` is a **peer dependency** — install it separately if
you have not already done so.

---

## Usage

```ts
import { configureWorkflow } from "@reactorynet/workflow-es";
import { SqlitePersistence } from "@reactorynet/workflow-es-sqlite";
import * as path from "path";

const dbPath = path.join("/abs/writable/dir", "workflow.db");
const persistence = new SqlitePersistence(dbPath);

// Wait for the schema to be created / migrated before starting the host.
await persistence.connect;

const config = configureWorkflow();
config.usePersistence(persistence);
const host = config.getHost();

host.registerWorkflow(MyWorkflow);
await host.start();
```

### In-memory (tests only)

Pass `":memory:"` as the filename for a fast, non-durable, in-process database:

```ts
const persistence = new SqlitePersistence(":memory:");
await persistence.connect;
```

**`:memory:` is not durable.** State is lost when the process exits.  Use it
for unit/conformance tests only.

---

## Schema

Four tables are created automatically by `sequelize.sync()` on first connect:

| Table | Description |
|---|---|
| `workflows` | One row per `WorkflowInstance`, including the C1 optimistic-concurrency `concurrencyToken` column. |
| `execution_pointers` | Owned by a workflow; replaced wholesale on every `persistWorkflow`. |
| `subscriptions` | Event subscriptions created by `waitFor` steps. |
| `events` | Published external events pending delivery. |

JSON columns (`data`, `persistenceData`, `eventData`, …) are stored as SQLite
`TEXT` and round-tripped transparently by Sequelize.  Epoch-millisecond columns
(`nextExecution`, `sleepUntil`) are stored as `BIGINT`.

SQLite WAL mode is enabled on every open (`PRAGMA journal_mode=WAL`); this
gives durability + concurrent reads during a write and persists in the file
header.

---

## Optimistic concurrency (C1)

`persistWorkflow` performs a compare-and-set on `concurrencyToken` inside the
transaction.  If another writer updated the same instance first, the call rejects
with `WorkflowConcurrencyError` (from `@reactorynet/workflow-es`) and writes
nothing — identical to the Postgres and in-memory providers.

---

## Electron packaging notes

### Native module rebuild

`sqlite3` is a **native addon**.  It must be rebuilt against Electron's V8 ABI
— not the system Node's.  Use
[`@electron/rebuild`](https://github.com/electron/rebuild) in the app's
`postinstall` script, or configure `electron-builder` to rebuild native
dependencies automatically.

> **This package does not own the rebuild step** — the consuming Electron app
> does.

```jsonc
// package.json of the Electron app
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w sqlite3"
  }
}
```

### ASAR unpacking

Native `.node` binaries cannot load from inside an `app.asar` archive.  Add
`sqlite3` to `asarUnpack` in your `electron-builder` config so the
binary is extracted to `app.asar.unpacked`:

```jsonc
// electron-builder.yml  (or the build key in package.json)
{
  "asarUnpack": ["**/node_sqlite3.node"]
}
```

### Database file path

Pass an **absolute path** in a directory that is writable at runtime.  The
canonical Electron location is:

```ts
import { app } from "electron";
import * as path from "path";
const dbPath = path.join(app.getPath("userData"), "workflow.db");
```

Never pass a path inside the read-only app bundle.

### WAL sidecar files

SQLite in WAL mode creates `-wal` and `-shm` sidecar files alongside the `.db`.
The chosen directory must remain writable and these files must not be deleted
while a connection is open.

### Off-main-thread hosting (M3, out of scope here)

For Electron responsiveness, run the workflow host in a `utilityProcess` or
Worker thread rather than the main process.  Refer to the M3 spec
(`docs/specs/m3-execution-model.md`) for the supported pattern — that is not
part of this package.

---

## Engine decision: `sqlite3` (via Sequelize) vs `better-sqlite3` vs `sql.js`

C2's entire purpose is **true fsync durability**, which rules out `sql.js` (it
operates on an in-memory buffer and needs a manual, non-transactional whole-DB
export to persist).

`better-sqlite3` was the spec's initial recommendation, but Sequelize 6's SQLite
dialect drives the database through the callback-based
[`sqlite3`](https://github.com/TryGhost/node-sqlite3) package; `better-sqlite3`
exposes a fundamentally different *synchronous* API and cannot be dropped in as
the Sequelize `dialectModule` without a bespoke adapter. To keep parity with the
Postgres provider (same Sequelize model layer, same CAS implementation), this
provider uses `sqlite3` as the driver. Durability is provided by enabling
**WAL mode** (`PRAGMA journal_mode=WAL`) on every connection.

A future provider built directly on `better-sqlite3` (bypassing Sequelize) could
be added if desktop write performance ever demands it; it is not required for the
durability contract.

---

## Running tests

```bash
# Build core first (the file:../../core dependency must be built)
cd ../../core && yarn build

# Install, build, and test the SQLite provider
cd ../providers/workflow-es-sqlite
yarn install
yarn test
```

No external service is required.  Conformance tests use `:memory:`; the
kill-and-restart integration test uses a temp file that is deleted after the run.
