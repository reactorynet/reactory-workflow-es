# Workflow store migrations

Standalone, idempotent scripts that alter a durable workflow store. They are plain `.mjs` — no build
step, no framework — because they must be runnable against a production database from a shell,
without the engine loaded.

There is no migration framework in this repo, and the SQL providers call bare `sequelize.sync()`
([postgres](../../providers/workflow-es-postgres/src/postgres-provider.ts) line 54,
[sqlite](../../providers/workflow-es-sqlite/src/sqlite-provider.ts) line 77), which **creates missing
tables and never alters an existing one**. Any change to a persisted column therefore needs a script
here; it will not happen by itself.

## `m11-version-to-semver.mjs`

Migrates `workflows.version` from an integer to a semantic-version string (`N` → `"N.0.0"`) and adds
the M10 `definitionFingerprint` column where it is missing. Required by
[spec M11](../../docs/specs/m11-semantic-versioning.md).

### Run it

The driver is resolved from your **current working directory**, so run from a project whose
`node_modules` has it:

```bash
# SQLite — driver: sqlite3
cd providers/workflow-es-sqlite
node ../../tools/migrations/m11-version-to-semver.mjs \
  --store=sqlite --path=/data/workflow.db --dry-run

# PostgreSQL — driver: pg
cd providers/workflow-es-postgres
node ../../tools/migrations/m11-version-to-semver.mjs \
  --store=postgres --url="$WORKFLOW_POSTGRES_URL" --dry-run

# MongoDB — driver: mongodb
cd ../reactory-express-server
node ../reactory-workflow-es/tools/migrations/m11-version-to-semver.mjs \
  --store=mongo --url="$MONGOOSE" --dry-run
```

Drop `--dry-run` to apply. Other flags: `--table=workflows`, `--collection=workflows`, `--quiet`.

### `--repair-from-id`

The version column went through the old truncating shim (`engineWorkflowMajorVersion`: `"1.0.1"` →
`1`), so the integer alone cannot recover a non-zero minor or patch — `N` → `"N.0.0"` guesses wrong
for every such workflow.

`workflowDefinitionId` is a second, lossless record of the same version (`ns.Name@1.0.1`), so where
it carries one it is **authoritative** and the migration prefers it automatically.

`--repair-from-id` extends that to rows an **earlier** run already converted with the naive rule: it
rewrites a string version when the id proves it wrong. Off by default, because without it a string
value is never rewritten and an operator-set version stays safe.

```bash
node ../../tools/migrations/m11-version-to-semver.mjs \
  --store=mongo --url="$MONGOOSE" --repair-from-id --dry-run
```

Exit codes: `0` success (a no-op run included) · `1` usage error · `2` migration failure.

### Always dry-run first

`--dry-run` writes nothing and reports the one number that decides your deployment plan:

```
  rows scanned     412
  rows to change   412
  already string   0
  fingerprint col  added
  non-terminal     37  <-- these dead-letter if the old code runs after this migration
```

`non-terminal` counts Runnable + Suspended instances. Between the migration and the deploy, the OLD
code reads a string `version` and compares it with `===` against integer registry entries, so those
instances will not resolve and will dead-letter via M1. **Either drain them first, or run the
migration and the deploy inside one maintenance window.** If that count is 0, the ordering does not
matter.

### Order of operations

1. **Back up the store.** The migration is forward-only; there is no down script (see below).
2. Dry-run. Read the `non-terminal` count.
3. Apply the migration.
4. Deploy the code that expects a string version.

### Guarantees

- **Idempotent.** A value that is already a string is never rewritten, so a genuine `"1.4.2"` is
  never clobbered back to `"1.0.0"`. A second run reports `0 changed` and exits `0`.
- **Atomic per store.** SQLite rebuilds the table inside one transaction (and recreates the M2
  index the rebuild drops); Postgres runs the `ALTER`s in one transaction. A failure leaves the
  original intact and commits nothing.
- **No down migration, by design.** Reversing `"1.4.2"` to an integer would destroy any real
  minor/patch version written after the deploy. Roll back by restoring the backup from step 1.

### Verification status

| Store | Status |
|---|---|
| sqlite | **Verified end to end** against a seeded legacy database: column retyped `INTEGER` → `VARCHAR(64)`, values migrated, `definitionFingerprint` added, M2 index and foreign-key rows preserved, dry-run confirmed to write nothing, second run a no-op, pre-existing string version left untouched. |
| mongo | **Applied to a real dev store** (`reactory-reactory`, 1459 instances) after a verified `mongodump`: all versions string, 0 numeric, 0 non-semver, second run a no-op, and all 35 definition/version pairs agree. Mapping rules proven separately on an isolated probe: id-embedded semver wins over `N.0.0`, no-semver ids fall back to `N.0.0`, an existing correct string is untouched, and `--repair-from-id` corrects a bad earlier guess and is itself idempotent. |
| postgres | **Not executed** — no live instance available at authoring time. The `ALTER … USING` and transaction handling are written but unproven. Dry-run first; it is read-only. |
