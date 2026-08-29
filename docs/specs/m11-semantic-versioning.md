# Spec — M11 · Semantic workflow versioning (`version: number` → `version: string`)

| Field | Value |
|---|---|
| **Item ID** | M11 |
| **Title** | Semantic workflow versioning (`major.minor.patch` as a string) |
| **Plan reference** | [`upgrade-plan.md`](../upgrade-plan.md) |
| **Target** | Both (Cloud + Electron) |
| **Severity** | Medium |
| **Owner tag** | `[claude]` |
| **Status** | done |
| **Depends on** | M1 (done), M10 definition fingerprint (done) |
| **Author / reviewer** | Werner Weber / — |

---

## 1. Context (self-contained)

The engine types a workflow definition's version as a **`number`**:

```ts
// core/src/abstractions/workflow-base.ts:5
public abstract version: number;

// core/src/models/workflow-definition.ts:5
public version: number;

// core/src/models/workflow-instance.ts:14
public version : number;
```

Every consumer above the engine has already standardised on **semantic version strings**, and has
done so for long enough that the integer is now vestigial:

- `Reactory.Workflow.IWorkflow` types `version` as `string`
  (`reactory-core/src/types/workflow/index.d.ts:41`).
- The GraphQL schema declares `version: String!` in eight places
  (`.../graph/types/System/Workflow.graphql`); exactly one field, `WorkflowExecutionHistory.version`
  at line 701, is still `Int!`.
- The YAML catalog is laid out on disk by semver:
  `$REACTORY_DATA/workflows/catalog/<nameSpace>/<name>/<version>/<name>.yaml`.
- Every registered workflow class in `reactory-express-server` carries a semver in its **`id`** and a
  constant `1` in its `version`:

```ts
// modules/reactory-core/workflows/CleanCacheWorkflow.ts:29-30
id: string = "core.CleanCacheWorkflow@1.0.0"   // semver lives here
version: number = 1;                            // always 1, everywhere
```

The two representations are bridged by a lossy funnel that truncates semver to its major component:

```ts
// modules/reactory-core/workflow/YamlFlow/YamlFlowBuilder.ts:60-64
export function engineWorkflowMajorVersion(version: string): number {
  if (!version) return 1;
  const major = parseInt(String(version).split('.')[0], 10);
  return Number.isNaN(major) ? 1 : major;
}
```

…duplicated inline in `WorkflowRunner.ts:788-798`, and undone downstream by a `String(obj.version)`
coercion plus a `'1.0.0'` fallback that reconstructs the semver by re-parsing the `id`
(`WorkflowResolver.ts:835-840`).

### What is NOT wrong today

The registry key is the **pair** `(id, version)`, and the semver is already embedded in `id`:

```ts
// core/src/services/workflow-registry.ts:23
const item = this.registry.find(x => x.id === id && x.version === version);
```

So `ns.Foo@1.2.0` and `ns.Foo@1.3.0` are already distinct registry entries. **Start-on-a-version /
complete-on-that-version is already enforced**, and M10 now enforces the stronger property that the
graph itself cannot change underneath a running instance. This spec is NOT motivated by a
correctness gap in version pinning, and must not be justified as such.

### What IS wrong

1. **Two workflows register with no version in the id at all** —
   `CampaignWorkflow` (`id = 'campaign'`, `modules/reactory-communicator/workflows/CampaignWorkflow.ts:556`)
   and `SendMessageWorkflow` (`id = 'send-message'`, `.../SendMessageWorkflow.ts:498`). Their registry
   key is `('campaign', 1)` permanently, so a `meta.version` bump on either is a no-op: the new graph
   replaces the old under an identical key. M10 now *detects* this (the instance dead-letters rather
   than mis-executing), but the version bump still cannot be *expressed*. A version-bearing `version`
   field removes the dependency on id-naming discipline.
2. **Three representations that can disagree** — semver-in-`id`, integer-in-`version`,
   semver-in-`meta.version` — with a shim in the middle and a coercion at the far end.
3. **`1.2.0` and `1.9.7` are indistinguishable in `WorkflowInstance.version`**, so every persisted
   instance, dead-letter log line, metrics attribute and trace span reports `1`. Operationally this
   makes history and telemetry unable to answer "which minor version was this instance running?"

## 2. Goal

`version` is a semantic-version **string** end to end: declared on `WorkflowBase`, carried on
`WorkflowDefinition` and `WorkflowInstance`, persisted as a string by every provider, and passed
through `startWorkflow` unchanged. The truncation shim and its downstream compensating coercions are
deleted. Registry lookup remains **exact string equality** — no range resolution.

## 3. Out of scope

- **Range/semver-aware matching in the registry** (`^1.2.0`, `~1.2`, "latest"). Resolving a range at
  load time would let an in-flight instance resume against a different graph than it started on —
  exactly the hazard M1 and M10 exist to prevent. If range resolution is ever wanted, it belongs at
  `startWorkflow` time only, pinning the exact resolved version onto the instance. Do not add it here.
- **Ordering / comparison of versions anywhere in the engine.** There is none today (verified: no
  `<`, `>`, sort, or arithmetic on `version` in `core/src` or any provider) and none is added.
- **Indexing `version`.** The M2 index contract does not include it; do not add an index.
- **Adding `version` to `WorkflowInstanceQuery`** or any M9 read-layer type.
- **The M10 fingerprint.** Already landed; leave it alone.
- **Renaming `WorkflowInstance.version`** or changing `workflowDefinitionId`'s `ns.name@semver` shape.
- **Redis / Azure providers.** Lock and queue only; they carry no version. Do not touch.

## 4. Files to create / modify

### `reactory-workflow-es/core`

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/workflow-base.ts` | modify | `version: string` |
| `core/src/models/workflow-definition.ts` | modify | `version: string` |
| `core/src/models/workflow-instance.ts` | modify | `version: string` |
| `core/src/abstractions/workflow-registry.ts` | modify | `getDefinition` / `tryGetDefinition` param types |
| `core/src/abstractions/workflow-host.ts` | modify | `startWorkflow(id, version: string, …)` |
| `core/src/abstractions/data-codec.ts` | modify | `DataCodecContext.version?: string` (advisory only) |
| `core/src/abstractions/lifecycle-events.ts` | modify | `WorkflowDeadLetteredEvent.version: string` |
| `core/src/services/workflow-registry.ts` | modify | signatures + `RegistryEntry.version` |
| `core/src/services/workflow-host.ts` | modify | `startWorkflow` signature (body is pass-through) |
| `core/src/fluent-builders/workflow-builder.ts` | modify | `build(id, version: string, seed?)` |
| `core/src/services/workflow-executor.ts` | verify | pass-through only; confirm no coercion is introduced |
| `core/src/services/execution-result-processor.ts` | verify | pass-through only |
| `core/src/services/data-codec-runner.ts` | verify | pass-through only |
| `core/src/testing/conformance/persistence-conformance.ts` | modify | 13 literals: `= 1` → `= "1.0.0"`, `toEqual(1)` → `toEqual("1.0.0")` (lines 96, 112, 116, 131, 163, 213, 223, 233, 266, 461, 620, 629, 679) |
| `core/spec/scenarios/version-safety.spec.ts` | modify | `version = 1` → `"1.0.0"`; unregistered `999` → `"9.9.9"` |
| `core/spec/scenarios/definition-fingerprint.spec.ts` | modify | `version` literals |
| `core/spec/scenarios/*.spec.ts` (remaining) | modify | ~88 `version` references across the scenario suite |
| `core/spec/scenarios/semantic-version.spec.ts` | create | New coverage — see §8 |
| `core/README.md` | modify | Document the string contract and the "no range matching" rule |

### Providers

| Path | Action | Why |
|---|---|---|
| `providers/workflow-es-postgres/src/models/workflow.ts` | modify | `@Column(DataType.INTEGER) version` → `DataType.STRING` |
| `providers/workflow-es-sqlite/src/models/workflow.ts` | modify | same |
| `providers/workflow-es-postgres/src/postgres-provider.ts` | verify | lines 78 / 414 are pass-through; no change expected |
| `providers/workflow-es-sqlite/src/sqlite-provider.ts` | verify | lines 101 / 432 are pass-through; no change expected |
| `providers/workflow-es-mongodb/src/mongodb-provider.ts` | none | schemaless; `version` rides the whole-document spread |
| `providers/workflow-es-redis`, `-azure`, `-opentelemetry` | none | no `version` reference (verified by grep) |

### Migration tooling

| Path | Action | Why |
|---|---|---|
| `tools/migrations/m11-version-to-semver.mjs` | create | **Delivered with this spec** — idempotent back-fill for mongo / postgres / sqlite |
| `tools/migrations/README.md` | create | **Delivered with this spec** — how to run it |

### `reactory-express-server`

| Path | Action | Why |
|---|---|---|
| `.../workflow/YamlFlow/YamlFlowBuilder.ts` | modify | Delete `engineWorkflowMajorVersion`; `GeneratedYamlWorkflow.version` becomes `def.version` |
| `.../workflow/YamlFlow/index.ts` | modify | Drop the `engineWorkflowMajorVersion` export |
| `.../workflow/WorkflowRunner/WorkflowRunner.ts` | modify | Delete the inline parse block (788-798); pass `version` straight through; line 918 uses `definition.version` |
| `.../workflow/LifecycleManager/LifecycleManager.ts` | modify | `IWorkflowHistoryItem.version: number` → `string` (line 179) |
| `.../resolvers/Workflow/WorkflowResolver.ts` | modify | Drop `String(obj.version)` coercion (837) and the `'1.0.0'` id-reparse fallbacks (244, 839) |
| `.../graph/types/System/Workflow.graphql` | modify | `WorkflowExecutionHistory.version: Int!` → `String!` (line 701) — **the only breaking GraphQL change** |
| `modules/*/workflows/*.ts` (10 classes) | modify | `version: number = 1` → `version: string = '1.0.0'`, sourced from `meta.version` |
| `modules/reactory-communicator/workflows/CampaignWorkflow.ts` | modify | Also give it a versioned `id` (`communicator.CampaignWorkflow@1.0.0`) |
| `modules/reactory-communicator/workflows/SendMessageWorkflow.ts` | modify | Same |
| `.../workflow/YamlFlow/__tests__/YamlFlowBuilder.test.ts` | modify | Drop `engineWorkflowMajorVersion` assertions (61-63, 135, 323) |
| `modules/reactory-core/workflows/examples/__tests__/examples.smoke.test.ts` | modify | Drop the `engineWorkflowMajorVersion` call (98) |

## 5. Interface & data-model changes

```ts
// BEFORE — core/src/abstractions/workflow-base.ts
export abstract class WorkflowBase<TData> {
    public abstract id: string;
    public abstract version: number;
    public abstract build(builder: WorkflowBuilder<TData>): void;
    public fingerprintSeed?: string;
}

// AFTER
export abstract class WorkflowBase<TData> {
    public abstract id: string;
    /**
     * Semantic version, "major.minor.patch". Compared by EXACT STRING EQUALITY —
     * the engine never parses, orders, or range-matches it.
     */
    public abstract version: string;
    public abstract build(builder: WorkflowBuilder<TData>): void;
    public fingerprintSeed?: string;
}
```

```ts
// BEFORE — core/src/abstractions/workflow-registry.ts
getDefinition(id: string, version: number) : WorkflowDefinition;
tryGetDefinition(id: string, version: number) : WorkflowDefinition | undefined;

// AFTER
getDefinition(id: string, version: string) : WorkflowDefinition;
tryGetDefinition(id: string, version: string) : WorkflowDefinition | undefined;
```

```ts
// BEFORE — core/src/abstractions/workflow-host.ts
startWorkflow(id: string, version: number, data: any, tenantId?: string): Promise<string>;

// AFTER
startWorkflow(id: string, version: string, data: any, tenantId?: string): Promise<string>;
```

`WorkflowDefinition.version`, `WorkflowInstance.version`, `DataCodecContext.version` and
`WorkflowDeadLetteredEvent.version` change `number` → `string` identically.

### DI / config impact

None. No new `configureWorkflow()` option, no new `TYPES` binding, no validation. The engine
deliberately does not validate the string's shape: enforcing a semver grammar in the engine would
reject callers who legitimately use another scheme (a date stamp, a git sha), and the engine's only
requirement is that the value is a stable, exactly-comparable string.

### Persisted / at-rest format impact

`workflows.version` changes from an integer to a string in every durable store.

| Store | Schema change | Behaviour without migration |
|---|---|---|
| postgres | `ALTER COLUMN version TYPE VARCHAR(64)` | **Hard failure.** `sequelize.sync()` (postgres-provider.ts:54) has no `alter: true`, so it will NOT change an existing table. The column stays `INTEGER` and every write fails with `invalid input syntax for type integer: "1.0.0"`. |
| sqlite | Table rebuild | **Silent corruption.** SQLite type affinity accepts `"1.0.0"` into an INTEGER-affinity column and stores it as TEXT. No error; the table ends up with mixed `1` and `"1.0.0"`, and legacy instances stop matching the registry. |
| mongodb | None (schemaless) | **Silent mixed types.** Old docs hold `version: 1` (BSON int), new docs `version: "1.0.0"` (BSON string). These never compare equal. Mongo is the DEFAULT provider (`WorkflowRunner.ts:553`), so this is the most likely store to hit. |
| memory | None | Nothing persisted. |

The migration is therefore **mandatory before the code change is deployed**, on every durable store
that holds rows. `tools/migrations/m11-version-to-semver.mjs` (shipped with this spec) performs it.
It is idempotent and forward-only: integer `N` becomes the string `"N.0.0"`, which preserves the
existing `engineWorkflowMajorVersion` semantics exactly, so an instance written as `1` before the
migration matches a definition declaring `1.0.0` after it. It also adds the missing
`definitionFingerprint` column to SQL stores (M10 relies on `sync()`, which likewise will not alter
an existing table).

**Deployment order is not optional:**

1. Run the migration against every durable store while the OLD code is still deployed. It only
   rewrites `version` and adds a nullable column, both of which the old code tolerates
   (`instance.version = model.version` becomes a string the old registry no longer matches — see the
   caveat below).
2. Deploy the new code.

> **Caveat on step 1 — plan a maintenance window.** Between the migration and the deploy, the old
> code reads a string `version` and compares it with `===` against its integer registry entries, so
> in-flight instances will not resolve and will dead-letter via M1. Either drain running instances
> first, or run the migration and the deploy as one window. The migration's `--dry-run` reports
> exactly how many non-terminal instances are at risk before you commit.

## 6. Behavioural contract (numbered rules)

1. `registry.getDefinition(id, version)` matches on **exact string equality**. `"1.2.0"` does not
   match `"1.2"`, `"1.2.0 "`, or `"v1.2.0"`.
2. **No range matching.** A registered `"1.2.0"` is not returned for a requested `"^1.2.0"`.
3. `startWorkflow(id, version, …)` stamps `instance.version = def.version` verbatim — the exact
   string the definition declared, not the caller's argument.
4. An instance's `version` is **immutable** for its lifetime. Nothing in the engine rewrites it.
5. **No parsing.** The engine never calls `parseInt`, `split('.')`, or any comparison operator on a
   version. A version of `"2024-06-01"` or `"abc"` behaves identically to `"1.0.0"`.
6. **Round-trip:** for every provider, `getWorkflowInstance(createNewWorkflow(i)).version === i.version`
   as a string, with no numeric coercion. `"1.0.0"` must not come back as `1`, and `"2"` must not
   come back as the number `2`.
7. **M1 parity:** an instance whose `(workflowDefinitionId, version)` is unregistered still
   dead-letters cleanly with `reason: "definition-not-registered"`, and the message renders the
   version as the string.
8. **M10 parity:** the definition fingerprint is unaffected. Version is not part of the canonical
   form, so changing a definition's version alone does NOT change its fingerprint — the two
   mechanisms are independent and both must hold.
9. **Empty/undefined:** `startWorkflow(id, undefined)` and `startWorkflow(id, "")` throw the existing
   "Workflow not registered" error from `getDefinition`. No defaulting to `"1.0.0"` inside the engine
   — that fallback belongs to the express layer, if anywhere, and silently starting the wrong version
   is worse than failing.
10. **Migration idempotency:** running the migration twice is a no-op. The second run reports 0 rows
    changed and exits 0.
11. **Migration safety:** a value already a string is never rewritten. `"1.4.2"` stays `"1.4.2"`; it
    is not re-mapped to `"1.0.0"`.

## 7. Provider parity

`IPersistenceProvider`'s method signatures do not change — `version` is a field on
`WorkflowInstance`, not a parameter. But the persisted column type does, so the SQL providers must
land **in the same PR** as the core change.

| Provider | Change required |
|---|---|
| memory | None. Stores whole object graphs; zero `version` references. |
| sqlite | `models/workflow.ts:36-37` → `DataType.STRING`. Provider body is pass-through. Migration rebuilds the table. |
| postgres | `models/workflow.ts:36-37` → `DataType.STRING`. Provider body is pass-through. Migration runs `ALTER COLUMN … USING`. |
| mongodb | No code change (schemaless). Migration back-fill required. |
| redis | None — lock/queue only, no `version` reference. |
| azure | None — lock/queue only, no `version` reference. |
| opentelemetry | None. `MetricAttributes` is `string \| number \| boolean` (`abstractions/metrics.ts:2`), so `ATTR.WORKFLOW_VERSION` already accepts a string. |

The shared conformance suite (`core/src/testing/conformance/persistence-conformance.ts`) is the
arbiter: it is a published entry point (`core/package.json` exposes `./testing`), so any downstream
provider is bound by rule §6.6.

## 8. Test plan (TDD)

### Failing-test-first

- **`round-trips a semantic version string without coercion`** — arrange: build an instance with
  `version = "1.2.3"`; act: `createNewWorkflow` then `getWorkflowInstance`; assert:
  `typeof loaded.version === "string"` and `loaded.version === "1.2.3"`. Proves §6.6. Must fail
  before the change (the INTEGER column coerces or rejects).

### Coverage — `core/spec/scenarios/semantic-version.spec.ts`

- **`registers and starts a workflow declaring version "1.2.3"`** — end-to-end through the host to
  Complete. Proves §6.3.
- **`two minor versions of the same id are distinct registry entries`** — register `"1.0.0"` and
  `"1.1.0"` with the SAME id and different graphs; start one of each; assert each completes on its
  own graph and neither dead-letters. Proves §6.1 — **this is the case the old integer key could not
  express.**
- **`does not range-match`** — register `"1.2.0"`, request `"^1.2.0"`; assert `tryGetDefinition`
  returns `undefined`. Proves §6.2.
- **`does not prefix- or whitespace-match`** — register `"1.2.0"`, request `"1.2"` then `"1.2.0 "`;
  assert both miss. Proves §6.1.
- **`treats a non-semver string as an opaque key`** — register `"2024-06-01"`; assert it starts and
  completes. Proves §6.5.
- **`an unregistered version dead-letters with the string in the message`** — proves §6.7.
- **`changing only the version does not change the fingerprint`** — build the same graph under
  `"1.0.0"` and `"2.0.0"`; assert equal fingerprints. Proves §6.8.
- **`startWorkflow with an empty or undefined version throws`** — proves §6.9.

### Migration tests — `tools/migrations/__tests__/m11-migration.test.mjs`

- **`sqlite: integer 1 becomes "1.0.0"`** — seed a legacy-shaped table, run, assert.
- **`sqlite: a second run reports 0 changed`** — proves §6.10.
- **`sqlite: an existing string version is left alone`** — proves §6.11.
- **`sqlite: adds the missing definitionFingerprint column`** — proves the M10 column back-fill.
- **`--dry-run mutates nothing`** — assert row values unchanged and a non-zero at-risk count reported.

### How to run

```bash
cd core && npm test                                   # 267 specs + new scenario
cd providers/workflow-es-sqlite && npm test           # 93 specs, real SQL round-trip
cd providers/workflow-es-postgres && npm test         # requires live postgres
node tools/migrations/m11-version-to-semver.mjs --store=sqlite --path=./tmp.db --dry-run
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && npm run build` succeeds.
- [ ] `cd core && npm test` passes (≥ 267 specs, 0 failures).
- [ ] `cd providers/workflow-es-sqlite && npm test` passes (93 specs, 0 failures).
- [ ] `grep -rn "engineWorkflowMajorVersion" reactory-express-server/src` returns **no matches**.
- [ ] `grep -rn "version: number" reactory-workflow-es/core/src` returns **no matches**.
- [ ] `grep -rn "version: number" reactory-express-server/src/modules/*/workflows/` returns no matches.
- [ ] No workflow registers with an unversioned `id`: every `id` in `modules/*/workflows/` matches
      `@\d+\.\d+\.\d+$`.
- [ ] Running the migration twice against the same store reports 0 rows changed on the second run.
- [ ] A workflow registered at `"1.0.0"` and one at `"1.1.0"` under the same id both run to Complete
      on their own graphs in the same host.

## 10. Backward compatibility & migration

**Breaking.** `@reactorynet/workflow-es` goes **2.6.0 → 3.0.0** under strict semver: `WorkflowBase`,
`IWorkflowHost.startWorkflow`, `IWorkflowRegistry`, and three persisted model types all change shape.
The SQL provider packages go to `2.0.0` and must declare `"@reactorynet/workflow-es": "3.0.0"`.

Consumer impact:

- Every `WorkflowBase` implementation must change `version: number` → `version: string`.
- Every `startWorkflow` caller must pass a string. In `reactory-express-server` most already do —
  `ReactorProjectService.ts:1124,1177` pass `'1.0.0'` today and only work because the runner's parse
  shim absorbs it.
- **GraphQL:** `WorkflowExecutionHistory.version` changes `Int!` → `String!`. This is the only
  client-visible break in the schema; every other `version` field is already `String`. Audit
  `reactory-pwa-client` and any external consumer before flipping. If a transition is needed, add a
  `versionString: String!` field first, migrate clients, then flip `version` in a later release.
- **Data migration is mandatory** on every durable store holding rows, before the deploy. See §5 and
  `tools/migrations/README.md`.

Rollback: the migration is forward-only. To roll back, restore from backup — do not attempt to coerce
`"1.0.0"` back to `1`, because any genuine minor/patch version written after the deploy would be
destroyed by the round trip.

## 11. Definition of Done

`version` is a string from `WorkflowBase` through the registry, the host, the instance, and every
persistence provider, compared only by exact equality and never parsed or ordered. The
`engineWorkflowMajorVersion` shim and its downstream compensating coercions are gone, the two
unversioned workflow ids are versioned, and a definition can now express a minor-version bump that
the engine actually distinguishes. Every durable store has been migrated by the shipped idempotent
script, the conformance suite proves string round-trip on every provider, and a host can run
`1.0.0` and `1.1.0` of the same workflow id side by side, each instance completing on the graph it
started on.

## 12. Implementation notes (non-binding)

Suggested order — each step leaves the tree compiling:

1. Run and verify the migration against a scratch copy of each store first.
2. Core types (§5), then `npx tsc --noEmit` in `core`. The compiler enumerates every remaining site;
   most are pure pass-throughs that need no edit.
3. Core spec literals, then `npm test`.
4. Conformance suite literals, then the SQL provider models, then `npm test` in each provider. Note
   the providers resolve core from their own `node_modules` — rebuild core and sync
   `core/build/` into `providers/*/node_modules/@reactorynet/workflow-es/build/` before typechecking,
   or the change will appear absent.
5. Express: delete the shim, then follow the compiler.
6. GraphQL field flip last, after auditing clients.

Watch for: `WorkflowResolver.ts:1008` splits `workflow.id` on `'@'` to recover the version — once
`version` is authoritative this is redundant, but it is also the fallback for unversioned ids, so
delete it only after acceptance criterion 7 (all ids versioned) holds.
