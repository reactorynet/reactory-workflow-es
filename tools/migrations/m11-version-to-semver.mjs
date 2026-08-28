#!/usr/bin/env node
/**
 * M11 — migrate `workflows.version` from an integer to a semantic-version string,
 * and add the M10 `definitionFingerprint` column where it is missing.
 *
 * WHY THIS IS MANDATORY, per store:
 *
 *   postgres — `sequelize.sync()` (postgres-provider.ts:54) has no `alter: true`, so it
 *              creates missing tables and NEVER changes an existing one. After the code
 *              change the column is still INTEGER and every write dies with
 *              `invalid input syntax for type integer: "1.0.0"`.
 *   sqlite   — same bare `sync()` (sqlite-provider.ts:77), but SQLite uses type AFFINITY:
 *              an INTEGER-affinity column silently accepts "1.0.0" and stores it as TEXT.
 *              No error — just a table with mixed 1 and "1.0.0" that no longer matches the
 *              registry. Silent is worse than loud.
 *   mongodb  — schemaless, so nothing fails. Old docs keep BSON int 1, new docs get string
 *              "1.0.0", and the two never compare equal. Mongo is the DEFAULT provider
 *              (WorkflowRunner.ts:553), so this is the most likely store to be hit.
 *
 * MAPPING: integer N -> string "N.0.0". This preserves the semantics of the
 * `engineWorkflowMajorVersion` shim being deleted (which truncated semver to its major),
 * so an instance persisted as 1 under the old code matches a definition declaring 1.0.0
 * under the new code.
 *
 * PROPERTIES:
 *   - Idempotent. A value that is already a string is never rewritten (so a genuine
 *     "1.4.2" is never clobbered back to "1.0.0"). A second run reports 0 changed.
 *   - Forward-only. There is no down migration: reversing would destroy any real
 *     minor/patch version written after the deploy. Roll back by restoring a backup.
 *   - --dry-run reports what would change, including how many NON-TERMINAL instances are
 *     at risk during the window between migrating and deploying, and writes nothing.
 *
 * ORDER OF OPERATIONS: run this while the OLD code is deployed, then deploy the new code.
 * Between the two, the old code compares a string version against integer registry
 * entries and in-flight instances will dead-letter via M1 — so drain first, or treat the
 * migration and the deploy as a single maintenance window. --dry-run tells you the size
 * of that exposure before you commit.
 *
 * USAGE
 *   node m11-version-to-semver.mjs --store=sqlite   --path=/data/workflow.db     [--dry-run]
 *   node m11-version-to-semver.mjs --store=postgres --url=postgres://u:p@h/db    [--dry-run]
 *   node m11-version-to-semver.mjs --store=mongo    --url=mongodb://h/db         [--dry-run]
 *
 * Optional: --collection=workflows (mongo), --table=workflows (sql), --quiet
 *
 * Exit codes: 0 success (including a no-op run) · 1 usage error · 2 migration failure.
 *
 * Drivers are resolved from the CURRENT WORKING DIRECTORY (sqlite3 / pg / mongodb) — the
 * same ones the providers already depend on — so run this from a directory whose
 * node_modules has the driver for your store, e.g.:
 *
 *   cd providers/workflow-es-sqlite && node ../../tools/migrations/m11-version-to-semver.mjs ...
 *
 * Only the driver for the selected --store needs to be installed.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Load a driver from the CWD's dependency tree rather than this file's. A bare
 * `import('sqlite3')` resolves relative to this script, which lives in tools/ and has no
 * node_modules of its own — so it would fail even when the driver is installed in the
 * project the operator is running from.
 */
async function loadDriver(name) {
  const requireFromCwd = createRequire(path.join(process.cwd(), 'noop.js'));
  try {
    const resolved = requireFromCwd.resolve(name);
    return await import(pathToFileURL(resolved).href);
  } catch (err) {
    throw new Error(
      `cannot resolve the "${name}" driver from ${process.cwd()}. ` +
      `Run this from a directory whose node_modules provides it ` +
      `(e.g. providers/workflow-es-sqlite for sqlite3), or install it there. ` +
      `Underlying error: ${err.message}`
    );
  }
}

// Split on the FIRST "=" only. Connection strings carry their own "=" inside query
// parameters (?socketTimeoutMS=360000&authSource=admin), and splitting on every "="
// truncates the URI at the first option — which the driver then rejects with the
// misleading "URI cannot contain options with no value".
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const raw = a.replace(/^--/, '');
    const eq = raw.indexOf('=');
    return eq === -1 ? [raw, true] : [raw.slice(0, eq), raw.slice(eq + 1)];
  })
);

const DRY = Boolean(args['dry-run']);
const QUIET = Boolean(args.quiet);
const TABLE = args.table || 'workflows';
const COLLECTION = args.collection || 'workflows';

const log = (...m) => { if (!QUIET) console.log(...m); };
const warn = (...m) => console.warn(...m);

/** WorkflowStatus values that are still live and would be disrupted by the window. */
const NON_TERMINAL = [0, 1]; // Runnable, Suspended

function usage(message) {
  console.error(`\nERROR: ${message}\n`);
  console.error('Usage:');
  console.error('  node m11-version-to-semver.mjs --store=sqlite   --path=<file>  [--dry-run]');
  console.error('  node m11-version-to-semver.mjs --store=postgres --url=<url>    [--dry-run]');
  console.error('  node m11-version-to-semver.mjs --store=mongo    --url=<url>    [--dry-run]');
  process.exit(1);
}

/**
 * Map one legacy value to its migrated form, or null when it must be left alone.
 * Centralised so all three stores share exactly one definition of the mapping,
 * and so the idempotency rule (§6.11) has a single place to be wrong in.
 */
function migratedValue(current) {
  if (current === null || current === undefined) return null;      // leave NULL alone
  if (typeof current === 'string') {
    // Already migrated, or a version the operator set by hand. Never rewrite.
    return null;
  }
  if (typeof current === 'number' && Number.isFinite(current)) {
    return `${Math.trunc(current)}.0.0`;
  }
  if (typeof current === 'bigint') return `${current}.0.0`;
  return null;
}

function report(store, { scanned, changed, skipped, atRisk, columnAdded }) {
  log('');
  log(`  store            ${store}`);
  log(`  rows scanned     ${scanned}`);
  log(`  rows ${DRY ? 'to change' : 'changed  '}   ${changed}`);
  log(`  already string   ${skipped}`);
  if (columnAdded !== undefined) log(`  fingerprint col  ${columnAdded ? 'added' : 'already present'}`);
  if (atRisk !== undefined) {
    log(`  non-terminal     ${atRisk}${atRisk > 0 ? '  <-- these dead-letter if the old code runs after this migration' : ''}`);
  }
  log('');
  log(DRY ? '  DRY RUN — nothing was written.' : '  Migration complete.');
  log('');
}

// ── SQLite ───────────────────────────────────────────────────────────────────
// SQLite cannot ALTER a column's type, so the table is rebuilt. Foreign keys are
// disabled for the swap (executionPointers references workflows) and the whole thing
// runs in one transaction, so a failure leaves the original table intact.
async function migrateSqlite() {
  if (!args.path) usage('--path=<file> is required for --store=sqlite');
  const { default: sqlite3 } = await loadDriver('sqlite3');
  const db = new sqlite3.Database(args.path);

  // Promisified wrappers — sqlite3 is callback-based, and serialize() alone does not
  // give us the sequencing guarantees a multi-statement rebuild needs.
  const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows))));
  const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { return e ? rej(e) : res(this); }));
  const close = () => new Promise((res, rej) => db.close(e => (e ? rej(e) : res())));

  try {
    const cols = await all(`PRAGMA table_info(${TABLE})`);
    if (cols.length === 0) throw new Error(`table "${TABLE}" does not exist in ${args.path}`);

    const versionCol = cols.find(c => c.name === 'version');
    if (!versionCol) throw new Error(`table "${TABLE}" has no "version" column`);
    const hasFingerprint = cols.some(c => c.name === 'definitionFingerprint');

    const rows = await all(`SELECT id, version, status FROM ${TABLE}`);
    let changed = 0, skipped = 0, atRisk = 0;
    const updates = [];
    for (const row of rows) {
      const next = migratedValue(row.version);
      if (next === null) { if (typeof row.version === 'string') skipped++; continue; }
      updates.push({ id: row.id, version: next });
      changed++;
      if (NON_TERMINAL.includes(row.status)) atRisk++;
    }

    if (!DRY) {
      // Rebuild only when the declared type is not already textual. SQLite cannot ALTER
      // a column type, and its INTEGER affinity would otherwise keep silently accepting
      // strings into a column the schema still calls INTEGER.
      const needsRebuild = !/TEXT|VARCHAR|CHAR/i.test(versionCol.type || '');
      await run('PRAGMA foreign_keys = OFF');
      await run('BEGIN');
      try {
        if (needsRebuild) {
          const defs = cols.map(c => {
            const type = c.name === 'version' ? 'VARCHAR(64)' : (c.type || 'TEXT');
            const notNull = c.notnull ? ' NOT NULL' : '';
            const dflt = c.dflt_value !== null && c.dflt_value !== undefined ? ` DEFAULT ${c.dflt_value}` : '';
            const pk = c.pk ? ' PRIMARY KEY' : '';
            return `"${c.name}" ${type}${pk}${notNull}${dflt}`;
          });
          if (!hasFingerprint) defs.push('"definitionFingerprint" VARCHAR(64)');
          const names = cols.map(c => `"${c.name}"`).join(', ');
          await run(`CREATE TABLE "${TABLE}__m11" (${defs.join(', ')})`);
          await run(`INSERT INTO "${TABLE}__m11" (${names}) SELECT ${names} FROM "${TABLE}"`);
          await run(`DROP TABLE "${TABLE}"`);
          await run(`ALTER TABLE "${TABLE}__m11" RENAME TO "${TABLE}"`);
          // The rebuild drops indexes; recreate the M2 contract index.
          await run(`CREATE INDEX IF NOT EXISTS idx_workflows_status_next_execution
                     ON "${TABLE}" ("tenantId", "status", "nextExecution")`);
        } else if (!hasFingerprint) {
          await run(`ALTER TABLE "${TABLE}" ADD COLUMN "definitionFingerprint" VARCHAR(64)`);
        }
        for (const u of updates) {
          await run(`UPDATE "${TABLE}" SET version = ? WHERE id = ?`, [u.version, u.id]);
        }
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
      await run('PRAGMA foreign_keys = ON');
    }

    report('sqlite', { scanned: rows.length, changed, skipped, atRisk, columnAdded: !hasFingerprint });
  } finally {
    await close();
  }
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────
// One transaction: widen the column with a USING clause that back-fills in place, then
// add the M10 column. ALTER TABLE is transactional in Postgres, so a failure rolls back.
async function migratePostgres() {
  const url = args.url || process.env.WORKFLOW_POSTGRES_URL || process.env.POSTGRES_URL;
  if (!url) usage('--url=<postgres url> is required for --store=postgres');
  const { default: pg } = await loadDriver('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const { rows: colRows } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
      [TABLE]
    );
    if (colRows.length === 0) throw new Error(`table "${TABLE}" does not exist`);
    const versionType = colRows.find(c => c.column_name === 'version')?.data_type;
    if (!versionType) throw new Error(`table "${TABLE}" has no "version" column`);
    const hasFingerprint = colRows.some(c => c.column_name === 'definitionFingerprint');
    const alreadyText = /character|text/i.test(versionType);

    const { rows: counts } = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = ANY($1::int[]))::int AS at_risk
         FROM "${TABLE}"`,
      [NON_TERMINAL]
    );
    const scanned = counts[0].total;
    const atRisk = counts[0].at_risk;
    const changed = alreadyText ? 0 : scanned;
    const skipped = alreadyText ? scanned : 0;

    if (!DRY) {
      await client.query('BEGIN');
      try {
        if (!alreadyText) {
          // USING back-fills every existing row in the same statement: N -> "N.0.0".
          await client.query(
            `ALTER TABLE "${TABLE}"
               ALTER COLUMN version TYPE VARCHAR(64)
               USING (version::text || '.0.0')`
          );
        }
        if (!hasFingerprint) {
          await client.query(`ALTER TABLE "${TABLE}" ADD COLUMN "definitionFingerprint" VARCHAR(64)`);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    report('postgres', { scanned, changed, skipped, atRisk, columnAdded: !hasFingerprint });
  } finally {
    await client.end();
  }
}

// ── MongoDB ──────────────────────────────────────────────────────────────────
// No schema to alter. Rewrite only documents whose `version` is still a BSON number;
// the $type filter is what makes a second run a no-op.
async function migrateMongo() {
  const url = args.url || process.env.MONGOOSE;
  if (!url) usage('--url=<mongodb url> is required for --store=mongo');
  const { MongoClient } = await loadDriver('mongodb');
  const client = new MongoClient(url);
  await client.connect();

  try {
    const col = client.db().collection(COLLECTION);
    const numericFilter = { version: { $type: 'number' } };

    const scanned = await col.countDocuments({});
    const changed = await col.countDocuments(numericFilter);
    const skipped = await col.countDocuments({ version: { $type: 'string' } });
    const atRisk = await col.countDocuments({ ...numericFilter, status: { $in: NON_TERMINAL } });

    if (!DRY && changed > 0) {
      const result = await col.updateMany(numericFilter, [
        { $set: { version: { $concat: [{ $toString: { $toInt: '$version' } }, '.0.0'] } } },
      ]);
      if (result.modifiedCount !== changed) {
        warn(`  WARNING: expected to modify ${changed} documents, modified ${result.modifiedCount}.`);
        warn('  Re-run with --dry-run to confirm the remaining count before deploying.');
      }
    }

    report('mongo', { scanned, changed, skipped, atRisk });
  } finally {
    await client.close();
  }
}

const STORES = { sqlite: migrateSqlite, postgres: migratePostgres, mongo: migrateMongo };

async function main() {
  const store = args.store;
  if (!store || !STORES[store]) {
    usage(`--store must be one of: ${Object.keys(STORES).join(', ')}`);
  }
  log(`\nM11 version -> semver migration${DRY ? '  (DRY RUN)' : ''}`);
  await STORES[store]();
}

main().catch(err => {
  console.error(`\nMIGRATION FAILED: ${err.message}`);
  if (err.stack && !QUIET) console.error(err.stack);
  console.error('\nNothing was committed. Fix the cause and re-run — the migration is idempotent.\n');
  process.exit(2);
});
