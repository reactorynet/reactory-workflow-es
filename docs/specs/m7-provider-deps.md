# Spec — M7 · Provider dependency hygiene

| Field | Value |
|---|---|
| **Item ID** | M7 |
| **Title** | Provider dependency hygiene (peer-deps, package name, versions) |
| **Plan reference** | [`upgrade-plan.md` → M7](../upgrade-plan.md) |
| **Target** | Cloud |
| **Severity** | Medium |
| **Owner tag** | `[copilot+review]` |
| **Status** | spec |
| **Depends on** | none (precedes C3 cleanly) |
| **Author / reviewer** | Werner Weber / — |

---

## 1. Context (self-contained)

This repository is a TypeScript workflow engine published as `@reactorynet/workflow-es`. The
**core** package lives in [`core/`](../../core) and the optional persistence / lock / queue
**providers** live under [`providers/`](../../providers). There are five providers today:

- `providers/workflow-es-mongodb`
- `providers/workflow-es-mysql`
- `providers/workflow-es-redis`
- `providers/workflow-es-azure`
- `providers/workflow-es-postgres`

Each provider imports types and DI machinery (e.g. `IPersistenceProvider`, `IQueueProvider`,
`IDistributedLockProvider`, `TYPES`, `ILogger`, `WorkflowInstance`) from the core package and is
wired into the host through **inversify** decorators, whose binding relies on decorator metadata
emitted via **reflect-metadata**.

### What is wrong today

The core package declares (`core/package.json:33-36`):

```json
"dependencies": {
  "inversify": "^6.0.0",
  "reflect-metadata": "^0.2.0"
}
```

But the providers declare the same libraries as their **own hard runtime dependencies**, at stale,
mismatched versions, and most of them still import from the **old package name** `workflow-es`:

- `providers/workflow-es-mongodb/package.json:29-35` — `"inversify": "^4.1.0"`,
  `"reflect-metadata": "^0.1.10"`, `"workflow-es": "^2.1.0"`.
- `providers/workflow-es-mysql/package.json:29-35` — `"reflect-metadata": "^0.1.12"`,
  `"workflow-es": "^2.3.2"` (no explicit inversify, but pulls core transitively via the old name).
- `providers/workflow-es-redis/package.json:27-35` — `"inversify": "^4.1.0"`,
  `"reflect-metadata": "^0.1.10"`, `"workflow-es": "^2.1.0"`.
- `providers/workflow-es-azure/package.json:27-33` — `"inversify": "^4.1.0"`,
  `"reflect-metadata": "^0.1.10"`, `"workflow-es": "^2.1.0"`.
- `providers/workflow-es-postgres/package.json:33-40` — already imports the new name
  (`"@reactorynet/workflow-es": "file:../../core"`) but declares `"reflect-metadata": "^0.1.13"`,
  which is **skewed** against core's `^0.2.0`.

The provider sources confirm the old-name imports:

```ts
// providers/workflow-es-mongodb/src/mongodb-provider.ts:1
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "workflow-es";
// providers/workflow-es-mysql/src/mysql-provider.ts:1
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "workflow-es";
// providers/workflow-es-redis/src/redis-queue-provider.ts:3
import { IQueueProvider, QueueType, TYPES, ILogger } from "workflow-es";
// providers/workflow-es-redis/src/redis-lock-manager.ts:2
import { IDistributedLockProvider, TYPES, ILogger } from 'workflow-es';
// providers/workflow-es-azure/src/azure-lock-manager.ts:3
import { IDistributedLockProvider, TYPES, ILogger } from 'workflow-es';
// providers/workflow-es-azure/src/azure-queue-provider.ts:3
import { IQueueProvider, QueueType, TYPES, ILogger } from 'workflow-es';
```

Postgres is already correct on imports
(`providers/workflow-es-postgres/src/postgres-provider.ts:1-8` imports from
`"@reactorynet/workflow-es"`).

### Why this is harmful (the decorator-metadata problem)

inversify reads constructor parameter types and injection tokens from metadata that
`reflect-metadata` writes onto a process-global registry (`Reflect.metadata`). That registry, and
inversify's own internal symbols, must be **a single shared module instance** across the core and
every provider loaded into the same process. When a provider declares its **own** copy of
`inversify` / `reflect-metadata` (especially at a different major/minor than core), the package
manager can install a **second physical copy** in the provider's `node_modules`. Node then resolves
two distinct module instances:

- core's `@injectable`/`@inject` decorators write metadata into copy A's registry;
- the provider's decorators write into copy B's registry;
- the container that performs resolution reads only one of them.

The result is the classic dual-instance failure: `Reflect.hasOwnMetadata(...)` returns `false`,
inversify throws `Missing required @injectable annotation` / `Cannot read ... reflect-metadata`, or
silently injects `undefined`. The same dual-instance hazard applies to importing the **old**
`workflow-es` name, which would resolve a *different* core than the host actually runs.

The fix is the standard inversify-ecosystem convention: a provider must **not** own copies of the
shared singletons. It declares `inversify`, `reflect-metadata`, and the core package as
**`peerDependencies`** so they are satisfied by — and deduped against — the host's single copy. To
keep each provider buildable and testable **standalone** (e.g. `tsc --noEmit` in its own folder),
it also lists the core package as a **`devDependency`** via `file:../../core`.

### User-visible impact

A consumer installing a provider alongside the core today can end up with two inversify /
reflect-metadata trees, breaking DI at host construction; and several providers reference a package
name (`workflow-es`) that does not exist in this fork, so they cannot resolve core at all.

## 2. Goal

After this change, none of the five providers declares `inversify`, `reflect-metadata`, or the core
workflow package as a hard runtime `dependency`. Instead each provider declares them as
`peerDependencies` (pinned to the same constraints core uses — `inversify@^6.0.0`,
`reflect-metadata@^0.2.0`, `@reactorynet/workflow-es@^2.3.6-reactory.3`) plus a `devDependency`
`@reactorynet/workflow-es: file:../../core` so it builds standalone. Every provider source imports
from `@reactorynet/workflow-es` (never the bare `workflow-es`). A fresh install of any single
provider, with the peer deps present, resolves exactly one copy of inversify and one of
reflect-metadata, and the provider type-checks against the current core.

## 3. Out of scope

The implementer must **not**:

- Change any provider runtime logic, provider class behaviour, DI binding logic, or query code. This
  is a **manifest + import-statement** change only.
- Touch `core/package.json` or any file under `core/src` / `core/spec`.
- Upgrade or repair the broken Mongo/MySQL driver code, or the stale Redis/Azure stub logic — that is
  C1 (redis/azure) and C3 (mongo/mysql). Do not change `mongodb`, `mysql2`, `sequelize`,
  `sequelize-typescript`, `azure-storage`, `ioredis`, `redis`, `redlock`, `pg`, `pg-hstore`,
  `json-stable-stringify` version constraints — leave those exactly as they are.
- Add, remove, or reconfigure any CI workflow (`.github/workflows/*`) — provider CI is M8.
- Add a shared conformance test suite — that is M8.
- Rename any provider package (`workflow-es-mongodb` stays `workflow-es-mongodb`, etc.). Only the
  *core dependency reference* changes from `workflow-es` to `@reactorynet/workflow-es`.
- Bump the providers' own `version` fields.
- Modify `tsconfig.json`, `.yarnrc.yml`, lockfiles, or `.pnp.cjs` (let the package manager
  regenerate lockfiles during the §8 verification install; do not hand-edit them).

## 4. Files to create / modify

Exhaustive list. No new files are created.

| Path | Action | Why |
|---|---|---|
| `providers/workflow-es-mongodb/package.json` | modify | Move inversify/reflect-metadata/core to peerDeps; add core devDep; drop old `workflow-es` dep |
| `providers/workflow-es-mongodb/src/mongodb-provider.ts` | modify | Import from `@reactorynet/workflow-es` (line 1) |
| `providers/workflow-es-mysql/package.json` | modify | Move reflect-metadata/core to peerDeps; add inversify peerDep + core devDep; drop old `workflow-es` dep |
| `providers/workflow-es-mysql/src/mysql-provider.ts` | modify | Import from `@reactorynet/workflow-es` (line 1) |
| `providers/workflow-es-redis/package.json` | modify | Move inversify/reflect-metadata/core to peerDeps; add core devDep; drop old `workflow-es` dep |
| `providers/workflow-es-redis/src/redis-queue-provider.ts` | modify | Import from `@reactorynet/workflow-es` (line 3) |
| `providers/workflow-es-redis/src/redis-lock-manager.ts` | modify | Import from `@reactorynet/workflow-es` (line 2) |
| `providers/workflow-es-azure/package.json` | modify | Move inversify/reflect-metadata/core to peerDeps; add core devDep; drop old `workflow-es` dep |
| `providers/workflow-es-azure/src/azure-lock-manager.ts` | modify | Import from `@reactorynet/workflow-es` (line 3) |
| `providers/workflow-es-azure/src/azure-queue-provider.ts` | modify | Import from `@reactorynet/workflow-es` (line 3) |
| `providers/workflow-es-postgres/package.json` | modify | Move reflect-metadata + core to peerDeps; add inversify peerDep; keep `file:../../core` as devDep; align reflect-metadata to `^0.2.0` |

> Postgres source is already correct (`postgres-provider.ts:1-8` imports `@reactorynet/workflow-es`);
> only its `package.json` changes. All other providers need both a manifest and an import change.

### Exact per-provider `package.json` before/after

> Only the dependency blocks are shown. Every other field (`name`, `version`, `scripts`, `keywords`,
> `author`, `license`, `repository`, `devDependencies` test tooling, `packageManager` where present)
> is left **untouched**. Where a `devDependencies` block already exists, **add** the listed key to it
> rather than replacing the block.

#### 4.1 `providers/workflow-es-mongodb/package.json`

```jsonc
// BEFORE  (lines 29-35)
"dependencies": {
  "inversify": "^4.1.0",
  "json-stable-stringify": "^1.0.1",
  "mongodb": "^3.2.7",
  "reflect-metadata": "^0.1.10",
  "workflow-es": "^2.1.0"
}
```

```jsonc
// AFTER
"dependencies": {
  "json-stable-stringify": "^1.0.1",
  "mongodb": "^3.2.7"
},
"peerDependencies": {
  "@reactorynet/workflow-es": "^2.3.6-reactory.3",
  "inversify": "^6.0.0",
  "reflect-metadata": "^0.2.0"
},
"devDependencies": {
  "@reactorynet/workflow-es": "file:../../core",
  "@types/jasmine": "^2.5.38",
  "@types/node": "^6.0.51",
  "jasmine": "^2.5.2",
  "jasmine-core": "^2.4.1",
  "typescript": "^2.2.1"
}
```

#### 4.2 `providers/workflow-es-mysql/package.json`

```jsonc
// BEFORE  (lines 29-35)
"dependencies": {
  "mysql2": "^1.6.4",
  "reflect-metadata": "^0.1.12",
  "sequelize": "^4.41.2",
  "sequelize-typescript": "^0.6.6",
  "workflow-es": "^2.3.2"
}
```

```jsonc
// AFTER
"dependencies": {
  "mysql2": "^1.6.4",
  "sequelize": "^4.41.2",
  "sequelize-typescript": "^0.6.6"
},
"peerDependencies": {
  "@reactorynet/workflow-es": "^2.3.6-reactory.3",
  "inversify": "^6.0.0",
  "reflect-metadata": "^0.2.0"
},
"devDependencies": {
  "@reactorynet/workflow-es": "file:../../core",
  "@types/jasmine": "^3.3.1",
  "@types/node": "^10.12.12",
  "jasmine": "^3.3.1",
  "jasmine-core": "^3.3.0",
  "typescript": "^3.2.1"
}
```

> Note: mysql had no explicit `inversify` dependency before (it inherited it transitively via the old
> `workflow-es` name). It is added to `peerDependencies` because the provider is decorated with
> inversify just like the others.

#### 4.3 `providers/workflow-es-redis/package.json`

```jsonc
// BEFORE  (lines 27-35)
"dependencies": {
  "@types/node_redis": "^0.8.29",
  "inversify": "^4.1.0",
  "ioredis": "^4.6.2",
  "redis": "^2.8.0",
  "redlock": "^3.1.2",
  "reflect-metadata": "^0.1.10",
  "workflow-es": "^2.1.0"
}
```

```jsonc
// AFTER
"dependencies": {
  "@types/node_redis": "^0.8.29",
  "ioredis": "^4.6.2",
  "redis": "^2.8.0",
  "redlock": "^3.1.2"
},
"peerDependencies": {
  "@reactorynet/workflow-es": "^2.3.6-reactory.3",
  "inversify": "^6.0.0",
  "reflect-metadata": "^0.2.0"
},
"devDependencies": {
  "@reactorynet/workflow-es": "file:../../core",
  "@types/node": "^6.0.51",
  "@types/jasmine": "^2.5.38",
  "jasmine": "^2.5.2",
  "jasmine-core": "^2.4.1",
  "typescript": "^2.2.1"
}
```

#### 4.4 `providers/workflow-es-azure/package.json`

```jsonc
// BEFORE  (lines 27-33)
"dependencies": {
  "inversify": "^4.1.0",
  "json-stable-stringify": "^1.0.1",
  "azure-storage": "^2.1.0",
  "reflect-metadata": "^0.1.10",
  "workflow-es": "^2.1.0"
}
```

```jsonc
// AFTER
"dependencies": {
  "json-stable-stringify": "^1.0.1",
  "azure-storage": "^2.1.0"
},
"peerDependencies": {
  "@reactorynet/workflow-es": "^2.3.6-reactory.3",
  "inversify": "^6.0.0",
  "reflect-metadata": "^0.2.0"
},
"devDependencies": {
  "@reactorynet/workflow-es": "file:../../core",
  "@types/node": "^6.0.51",
  "@types/jasmine": "^2.5.38",
  "jasmine": "^2.5.2",
  "jasmine-core": "^2.4.1",
  "typescript": "^2.2.1"
}
```

#### 4.5 `providers/workflow-es-postgres/package.json`

```jsonc
// BEFORE  (lines 24-40)
"devDependencies": {
  "@types/jasmine": "^4.6.0",
  "@types/node": "^20.0.0",
  "@types/validator": "^13.15.10",
  "jasmine": "^5.0.0",
  "jasmine-core": "^5.0.0",
  "json-stable-stringify": "^1.1.1",
  "typescript": "^5.0.0"
},
"dependencies": {
  "@reactorynet/workflow-es": "file:../../core",
  "pg": "^8.11.0",
  "pg-hstore": "^2.3.4",
  "reflect-metadata": "^0.1.13",
  "sequelize": "^6.37.0",
  "sequelize-typescript": "^2.1.6"
}
```

```jsonc
// AFTER
"devDependencies": {
  "@reactorynet/workflow-es": "file:../../core",
  "@types/jasmine": "^4.6.0",
  "@types/node": "^20.0.0",
  "@types/validator": "^13.15.10",
  "jasmine": "^5.0.0",
  "jasmine-core": "^5.0.0",
  "json-stable-stringify": "^1.1.1",
  "typescript": "^5.0.0"
},
"peerDependencies": {
  "@reactorynet/workflow-es": "^2.3.6-reactory.3",
  "inversify": "^6.0.0",
  "reflect-metadata": "^0.2.0"
},
"dependencies": {
  "pg": "^8.11.0",
  "pg-hstore": "^2.3.4",
  "sequelize": "^6.37.0",
  "sequelize-typescript": "^2.1.6"
}
```

> Postgres keeps `@reactorynet/workflow-es: file:../../core` but it MOVES from `dependencies` to
> `devDependencies` (and is also declared as a peer). `reflect-metadata` moves out of `dependencies`
> into `peerDependencies` at `^0.2.0` (was the skewed `^0.1.13`). `inversify` is newly added to
> `peerDependencies` (postgres did not declare it before).

## 5. Interface & data-model changes

None. No TypeScript types, method signatures, DI bindings, enums, or persisted shapes change. This
item only changes package manifests and the module specifier in `import` statements. The imported
symbols are identical; only the package the implementer imports them *from* changes name.

### Exact version constraints to use

| Library | Constraint in every provider | Section | Rationale |
|---|---|---|---|
| `inversify` | `^6.0.0` | `peerDependencies` | Matches `core/package.json:34`; single shared container/metadata instance |
| `reflect-metadata` | `^0.2.0` | `peerDependencies` | Matches `core/package.json:35`; single shared metadata registry |
| `@reactorynet/workflow-es` | `^2.3.6-reactory.3` | `peerDependencies` | Pins to the current published core version (`core/package.json:2`) |
| `@reactorynet/workflow-es` | `file:../../core` | `devDependencies` | Lets each provider build/test standalone against the in-repo core |

### Import-specifier change (per source file)

```ts
// BEFORE — providers/workflow-es-mongodb/src/mongodb-provider.ts:1
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "workflow-es";
// AFTER
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "@reactorynet/workflow-es";
```

```ts
// BEFORE — providers/workflow-es-mysql/src/mysql-provider.ts:1
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "workflow-es";
// AFTER
import { IPersistenceProvider, WorkflowInstance, EventSubscription, Event, WorkflowStatus } from "@reactorynet/workflow-es";
```

```ts
// BEFORE — providers/workflow-es-redis/src/redis-queue-provider.ts:3
import { IQueueProvider, QueueType, TYPES, ILogger } from "workflow-es";
// AFTER
import { IQueueProvider, QueueType, TYPES, ILogger } from "@reactorynet/workflow-es";
```

```ts
// BEFORE — providers/workflow-es-redis/src/redis-lock-manager.ts:2
import { IDistributedLockProvider, TYPES, ILogger } from 'workflow-es';
// AFTER
import { IDistributedLockProvider, TYPES, ILogger } from '@reactorynet/workflow-es';
```

```ts
// BEFORE — providers/workflow-es-azure/src/azure-lock-manager.ts:3
import { IDistributedLockProvider, TYPES, ILogger } from 'workflow-es';
// AFTER
import { IDistributedLockProvider, TYPES, ILogger } from '@reactorynet/workflow-es';
```

```ts
// BEFORE — providers/workflow-es-azure/src/azure-queue-provider.ts:3
import { IQueueProvider, QueueType, TYPES, ILogger } from 'workflow-es';
// AFTER
import { IQueueProvider, QueueType, TYPES, ILogger } from '@reactorynet/workflow-es';
```

> Preserve the original quote style of each line (mongodb/mysql/redis-queue use double quotes;
> redis-lock/azure files use single quotes). Change only the package name, nothing else on the line.

### DI / config impact

None. `configureWorkflow()`, `WorkflowConfig`, and `TYPES` are unchanged. The fix actually *protects*
DI by guaranteeing a single inversify/reflect-metadata instance backs the `TYPES` symbols.

### Persisted / at-rest format impact

None. Nothing written to any provider store changes.

## 6. Behavioural contract (numbered rules)

1. **No hard core-lib deps.** After the change, no provider lists `inversify`, `reflect-metadata`, or
   any `workflow-es*` core package in its `dependencies` block.
2. **Peer declaration.** Every provider lists exactly these three keys in `peerDependencies`:
   `@reactorynet/workflow-es` at `^2.3.6-reactory.3`, `inversify` at `^6.0.0`, `reflect-metadata` at
   `^0.2.0`.
3. **Standalone buildability.** Every provider lists `@reactorynet/workflow-es: file:../../core` in
   `devDependencies` so it resolves core when installed/built in isolation.
4. **New name in imports.** No provider source file contains the bare specifier `"workflow-es"` or
   `'workflow-es'` in an `import` statement; all such imports use `@reactorynet/workflow-es`.
5. **No version skew.** The `reflect-metadata` and `inversify` constraints in every provider's
   `peerDependencies` are byte-identical to core's `dependencies` (`^0.2.0`, `^6.0.0`). The old
   `^0.1.x` reflect-metadata and `^4.1.0` inversify constraints no longer appear anywhere in any
   provider manifest.
6. **Single deduped copy.** A fresh install of any one provider — with its peers present — yields a
   single physical copy of `inversify` and a single physical copy of `reflect-metadata` (verified in
   §8). No second copy nested under the provider's own `node_modules`.
7. **No behavioural change.** Provider runtime logic, other dependency constraints, package names,
   versions, scripts, and tsconfig are unchanged; only manifests' dependency placement and import
   specifiers change.
8. **Idempotency.** Re-running the change against an already-migrated tree is a no-op (the matcher in
   rule 4 finds nothing to replace; the manifests already satisfy rules 1–5).

## 7. Provider parity

No core interface changes (§5 = None), so the usual "all providers in the same PR because core
changed" rule does not apply for a *core-side* reason. However, M7 is itself a sweep **across all
five providers** and they should all be migrated **in the same PR** for consistency.

This spec is the convention that **C2** (new embedded SQLite provider) and **C3** (Mongo/MySQL
repair-or-deprecate) reference for how a provider must declare its dependencies: core libs as peers,
core package as a peer + `file:` devDependency, new package name in imports. When C2 creates a new
provider it MUST follow §4/§5 of this spec; when C3 touches Mongo/MySQL it inherits the manifests
M7 lays down. **M7 itself is self-contained for the providers that currently exist** — it does not
wait on C2/C3 and does not change their logic.

| Provider | Change required |
|---|---|
| memory | None — lives in core (`core/src`), not a separate package; not affected |
| sqlite | Does not exist yet (created by C2, which must adopt this convention) |
| postgres | `package.json` only: reflect-metadata→peer `^0.2.0`, add inversify peer, core→peer + keep `file:` devDep (§4.5). Source already uses new name |
| mongodb | `package.json` (§4.1) + import specifier in `mongodb-provider.ts` |
| mysql | `package.json` (§4.2, incl. adding inversify peer) + import specifier in `mysql-provider.ts` |
| redis | `package.json` (§4.3) + import specifiers in `redis-queue-provider.ts` and `redis-lock-manager.ts` |
| azure | `package.json` (§4.4) + import specifiers in `azure-lock-manager.ts` and `azure-queue-provider.ts` |

## 8. Test plan (TDD)

There is no runtime behaviour to unit-test; M7 is a manifest + import sweep. The "tests" are
**static manifest assertions** and a **fresh-install dedupe / type-check** verification per provider.

### Failing-check-first (must fail before the change)

- **`no-old-import-name`** — arrange: clean working tree before edits · act:
  `grep -rn "from ['\"]workflow-es['\"]" providers/*/src` · assert: returns matches for
  mongodb/mysql/redis/azure (6 lines). After the change the same command returns nothing (exit 1).
  Proves rule §6.4.
- **`no-hard-core-deps`** — arrange: before edits · act: inspect each provider `dependencies` block ·
  assert: at least one of `inversify` / `reflect-metadata` / `workflow-es` is present (it is, in all
  five). After the change none are. Proves rules §6.1, §6.5.

### Coverage (must pass after the change)

- **`peer-deps-present`** — for each of the five providers, assert `peerDependencies` contains
  `@reactorynet/workflow-es: ^2.3.6-reactory.3`, `inversify: ^6.0.0`, `reflect-metadata: ^0.2.0`.
  Proves §6.2, §6.5.
- **`core-devdep-present`** — for each provider assert `devDependencies["@reactorynet/workflow-es"]`
  equals `file:../../core`. Proves §6.3.
- **`single-deduped-copy`** — per provider: fresh install, then
  `npm ls inversify reflect-metadata` shows exactly one resolved version of each, deduped at the top
  (no `(deduped)`-conflicting second copy nested under the provider). Proves §6.6.
- **`standalone-typecheck`** — per provider: `npx tsc --noEmit` (using the provider's own
  `tsconfig.json`) compiles against the in-repo core resolved via the `file:` devDependency, with no
  unresolved-module or type errors originating from the core import. Proves §6.3, §6.4.

### How to run

```bash
# Static assertions (from repo root):
grep -rn "from ['\"]workflow-es['\"]" providers/*/src   # expect: no output (exit 1)
for p in mongodb mysql redis azure postgres; do
  echo "== $p =="; node -e "const d=require('./providers/workflow-es-'+process.argv[1]+'/package.json'); console.log({deps:d.dependencies, peer:d.peerDependencies});" "$p";
done

# Fresh-install dedupe + standalone type-check, per provider:
for p in mongodb mysql redis azure postgres; do
  ( cd "providers/workflow-es-$p" && npm install && npm ls inversify reflect-metadata && npx tsc --noEmit )
done
```

> **Overlap note (M8):** the per-provider fresh-install + type-check above is exactly what M8 will
> wire into a CI matrix with Testcontainers. **M7 keeps to the manifest + import change and the
> local verification only.** Do **not** add or edit `.github/workflows/*` here — CI wiring is M8's
> job. The §8 commands are run **locally / by the reviewer**, not committed as a workflow.

## 9. Acceptance criteria (binary)

- [ ] `grep -rn "from ['\"]workflow-es['\"]" providers/*/src` returns no matches (exit 1).
- [ ] No provider `package.json` `dependencies` block contains `inversify`, `reflect-metadata`, or
      `workflow-es`.
- [ ] All five providers declare `@reactorynet/workflow-es@^2.3.6-reactory.3`, `inversify@^6.0.0`,
      `reflect-metadata@^0.2.0` in `peerDependencies`.
- [ ] All five providers declare `@reactorynet/workflow-es: file:../../core` in `devDependencies`.
- [ ] For each provider: `cd providers/workflow-es-<p> && npm install && npm ls inversify
      reflect-metadata` shows a single deduped copy of each.
- [ ] For each provider: `npx tsc --noEmit` compiles cleanly against the current core.
- [ ] `core` is untouched: `git diff --name-only` lists no path under `core/`.
- [ ] No `.github/workflows/*` file changed.

## 10. Backward compatibility & migration

**Public API:** none of the providers' exported symbols change, so consumers' import code is
unaffected. The only consumer-visible change is the **dependency contract**: providers now expect the
host to supply `inversify`, `reflect-metadata`, and `@reactorynet/workflow-es`. The consuming
`reactory-express-server` integrates providers and core via a `file:` tarball / workspace and already
installs core (which brings `inversify@^6` and `reflect-metadata@^0.2`), so the peer requirements are
**satisfied by what the server already has** — this is the intended, *more compatible* state (it
removes the duplicate trees that previously broke DI). No data migration. No runtime config change.

**Provider version bumps:** provider `version` fields are NOT bumped in M7 (out of scope §3). If the
team chooses to publish the providers, a patch/prerelease bump per provider can be done at publish
time; it is not part of this change.

**Peer-dep install ergonomics:** with npm v7+ peer deps auto-install; under older npm or strict
modes a consumer installing a provider in isolation must also have the three peers present — which
the in-repo `file:` devDependency covers for local builds, and the server's existing core install
covers in production. Document this expectation in each provider README only if a README exists;
do not create new README files (postgres already has one; the others can be updated by C3 when it
touches them).

## 11. Definition of Done

All five providers (`mongodb`, `mysql`, `redis`, `azure`, `postgres`) declare `inversify`,
`reflect-metadata`, and `@reactorynet/workflow-es` as `peerDependencies` pinned to core's
constraints, carry `@reactorynet/workflow-es: file:../../core` as a `devDependency`, and no longer
list any of those three as hard `dependencies`. Every provider source imports from
`@reactorynet/workflow-es` rather than `workflow-es`. A fresh install of each provider resolves a
single deduped copy of inversify and reflect-metadata and type-checks against the current core. Core
and CI files are untouched. The reviewer confirms the §9 checklist passes.

## 12. Implementation notes (optional, non-binding)

- Suggested order: (1) edit the four old-name source imports first and confirm the grep in §8 goes
  empty; (2) then edit the five manifests; (3) then run the per-provider install/typecheck loop.
- The mysql provider had **no** explicit `inversify` before — remember to **add** it as a peer
  (rule §6.2), do not just move an existing entry.
- When moving keys between blocks, keep JSON valid: a trailing block (`dependencies`) needs no comma
  after its closing brace; intermediate blocks do. Verify with `node -e "require('./package.json')"`.
- Do not hand-edit `yarn.lock` / `.pnp.cjs`; the `npm install` / `yarn` step in §8 regenerates lock
  state. If a provider has a `.yarnrc.yml` (postgres does), leave it as-is.
- This mirrors the upstream `danielgerlag/workflow-es` provider layout, where providers peer-depend
  on the core and on inversify/reflect-metadata rather than vendoring them.
