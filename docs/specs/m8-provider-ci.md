# Spec — M8 · Providers built + integration-tested in CI (shared conformance suite)

| Field | Value |
|---|---|
| **Item ID** | M8 |
| **Title** | Providers built + integration-tested in CI (Testcontainers / GitHub services) |
| **Plan reference** | [`upgrade-plan.md` → M8](../upgrade-plan.md) |
| **Target** | Cloud |
| **Severity** | Medium |
| **Owner tag** | `[copilot+review]` |
| **Status** | spec |
| **Depends on** | M7 (provider dependency hygiene) must be `done` first |
| **Author / reviewer** | Werner Weber / <reviewer> |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow engine. The repository is a monorepo:

- `core/` — the engine and the provider contract `IPersistenceProvider`
  (`core/src/abstractions/persistence-provider.ts`).
- `providers/workflow-es-postgres/` — the modern, working SQL persistence provider (Sequelize 6 +
  `sequelize-typescript`, Jasmine 5 tests). This is the **reference provider**.
- `providers/workflow-es-mongodb/` — document-store provider (being repaired under C3).
- `providers/workflow-es-mysql/` — **deprecated** under C3 (re-homed as a dialect option of the
  Postgres provider; package keeps a deprecation banner and is excluded from CI).
- `providers/workflow-es-redis/` — distributed lock + queue provider (modernised under C1).
- `providers/workflow-es-azure/` — stale stub.

**The problem.** Continuous integration only builds and tests `core`. The current workflow,
`.github/workflows/ci.yml`, pins every step to the `core` directory:

```yaml
defaults:
  run:
    working-directory: core      # <-- everything runs inside core/
...
    - name: Type check
      run: npx tsc --noEmit
    - name: Build
      run: yarn build
    - name: Test
      run: yarn test
```

Providers are **never installed, never type-checked, never built, never tested** in CI. This is
*precisely* why the Redis/Azure/Mongo/MySQL providers rotted (audit items C1 and C3): the core
interface and tooling moved forward (`inversify@^4`→`^6`, `reflect-metadata@^0.1`→`^0.2`, the
`"workflow-es"`→`@reactorynet/workflow-es` package rename, the `acquireLock` rename, ES2020 target)
and nothing in CI caught the providers falling out of sync.

There are two distinct gaps:

1. **No provider build/test in CI.** A breaking change to a core interface can merge green even though
   every provider is now uncompilable.
2. **No shared notion of "a correct provider".** Each provider that *does* have tests
   (only Postgres today) hand-rolls its own assertions against `IPersistenceProvider`
   (`providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts`). There is no single
   contract test that *every* provider must pass, so "passes its own tests" does not mean "honours the
   contract". The C1 optimistic-concurrency token round-trip, for example, is not exercised anywhere
   shared.

**User-visible impact.** Consumers (e.g. `reactory-express-server`) install a provider package that
type-checks against a different core than the one shipped, or that silently violates the persistence
contract (lost updates, stale reads), with no CI signal that anything is wrong.

## 2. Goal

After this change, CI **builds and integration-tests every non-deprecated provider** against ephemeral
backing services, and a **single shared provider conformance suite** — owned by `core`, imported by each
provider — asserts that any `IPersistenceProvider` honours the full contract (including the C1
optimistic-concurrency token round-trip). A breaking change to a core interface turns provider CI red on
the PR; deprecated providers are excluded; the conformance suite runs green for every non-deprecated
provider before merge.

## 3. Out of scope

- **Do NOT change any provider's runtime behaviour or fix any provider bug.** This item adds the *gate*
  (CI + shared suite). If the gate reveals a bug in Mongo/Redis, that is fixed under C1/C3, not here.
- **Do NOT modify `IPersistenceProvider`** or any core abstraction. The conformance suite tests the
  contract as it exists once C1 has landed; it does not define new contract.
- **Do NOT touch `core/spec/scenarios/*` or `core/spec/support/jasmine.json`.** The shared suite is a new
  *exported library module*, not a core test that runs in core's own `yarn test`.
- **Do NOT modernise or repair the MySQL or Azure providers.** MySQL is deprecated (C3) and excluded.
  Azure is out of M8's scope entirely; it is not added to the CI matrix by this spec.
- **Do NOT change the `core` build/test job** beyond what §5/CI requires (it stays the existing
  `build-and-test` job; M8 only *adds* a provider job).
- **Do NOT introduce a monorepo task runner** (turborepo/nx/lerna). Keep per-package `yarn`.
- **Do NOT add Testcontainers as a hard runtime dependency of any published provider package.** It is a
  `devDependency` only, used for local integration runs (see §5 decision).

## 4. Files to create / modify

> Exhaustive. The Mongo/Redis spec files listed as *create* are the per-provider wrappers that import
> and run the shared suite; they are tiny (≈15 lines) and follow the Postgres wrapper shape in §5.

| Path | Action | Why |
|---|---|---|
| `core/src/testing/conformance/persistence-conformance.ts` | create | The **shared conformance suite**: an exported function `runPersistenceProviderConformanceTests(...)` that registers Jasmine `describe`/`it` blocks exercising every `IPersistenceProvider` method incl. the C1 token round-trip. |
| `core/src/testing/conformance/index.ts` | create | Barrel re-export of `persistence-conformance.ts`. |
| `core/src/testing/index.ts` | create | Barrel re-export of `./conformance`. |
| `core/src/index.ts` | modify | Re-export `./testing` so providers can `import { runPersistenceProviderConformanceTests } from "@reactorynet/workflow-es/testing"` (or from the root). See §5 for the exact export path decision. |
| `core/package.json` | modify | Add an `exports` map / `typesVersions` so the `@reactorynet/workflow-es/testing` subpath resolves to `./build/src/testing/index.js`. Add `"files"` includes `build/src/testing` (already covered by `build/`). |
| `core/tsconfig.json` | modify | Ensure `src/testing/**` is in the compiled program (it is, if `include`/`files` already cover `src`). Confirm only; change only if `src/testing` is excluded. |
| `providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts` | modify | Replace the hand-rolled assertions with a call to `runPersistenceProviderConformanceTests`, supplying a Postgres provider factory + reset hook (see §5). |
| `providers/workflow-es-mongodb/spec/mongodb-persistence-provider.spec.ts` | create | Per-provider wrapper that runs the shared suite against a Mongo provider factory. (C3 owns making it pass.) |
| `providers/workflow-es-mongodb/spec/support/jasmine.json` | create | Jasmine config mirroring the Postgres one (`spec_dir: build/spec`). |
| `providers/workflow-es-mongodb/tsconfig.json` | modify | Ensure `include: ["spec/**/*.ts"]` so the spec compiles (mirror Postgres `tsconfig.json`). |
| `providers/workflow-es-mongodb/package.json` | modify | Add a `test`/`pretest` script and `devDependencies` (`jasmine`, `jasmine-core`, `@types/jasmine`, `testcontainers`) mirroring Postgres; **remove** the Docker `pretest`/`posttest` hooks (CI uses `services:`; local uses Testcontainers). |
| `providers/workflow-es-redis/` | n/a | Redis is a **lock + queue** provider, **not** an `IPersistenceProvider`. The *persistence* conformance suite does not apply to it. It is still built + smoke-tested in CI (see §6.6) but does not run `runPersistenceProviderConformanceTests`. No conformance wrapper file. |
| `.github/workflows/ci.yml` | modify | Add a new `providers` job (matrix over postgres + mongodb + redis) with `services:` for postgres/mongo/redis, that installs, type-checks, builds, and tests each provider. See §5 for the full additions. |

## 5. Interface & data-model changes

No change to any persisted shape and **no change to `IPersistenceProvider`** (C1 already added
`WorkflowInstance.concurrencyToken?: number = 0` and the `WorkflowConcurrencyError` type — M8 only
*tests* them). The only new *interface* is the shared conformance entry point and its options object.

### 5.1 New shared conformance entry point (created in core)

```ts
// core/src/testing/conformance/persistence-conformance.ts  (NEW)

import { IPersistenceProvider } from "../../abstractions/persistence-provider";

/**
 * Options a provider supplies to opt into the shared persistence conformance
 * suite. The provider package calls runPersistenceProviderConformanceTests()
 * at the top level of one of its Jasmine spec files.
 */
export interface PersistenceConformanceOptions {
    /**
     * Human-readable provider name, used as the root describe() label,
     * e.g. "postgres" or "mongodb".
     */
    providerName: string;

    /**
     * Construct (or return) a connected IPersistenceProvider ready for use.
     * Called once in beforeAll. Implementations should await any internal
     * connect promise before resolving.
     */
    createProvider: () => Promise<IPersistenceProvider>;

    /**
     * Reset the backing store to an empty, known-good schema. Called once in
     * beforeAll after createProvider, and SHOULD be safe to call repeatedly.
     * For SQL this is sequelize.sync({ force: true }); for Mongo, drop the
     * collections.
     */
    reset: (provider: IPersistenceProvider) => Promise<void>;

    /**
     * Optional teardown (close connections / pools). Called in afterAll.
     */
    dispose?: (provider: IPersistenceProvider) => Promise<void>;
}

/**
 * Registers the full IPersistenceProvider conformance test suite as Jasmine
 * describe/it blocks. MUST be called at module top level (not inside another
 * describe), exactly as a normal Jasmine spec file would call describe().
 */
export declare function runPersistenceProviderConformanceTests(
    options: PersistenceConformanceOptions
): void;
```

> The function body is real code, not a stub — the `declare` above is only to show the signature in this
> spec. The body registers the `describe`/`it` blocks enumerated in §6. It depends only on Jasmine
> globals (`describe`, `it`, `expect`, `beforeAll`, `beforeEach`, `afterAll`), which are ambient in any
> provider's Jasmine run; the suite must **not** import `jasmine` as a value.

### 5.2 Per-provider opt-in (the wrapper spec file)

A provider opts in with a ~15-line spec file. Postgres after the change:

```ts
// providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts  (REWRITTEN)

import { runPersistenceProviderConformanceTests } from "@reactorynet/workflow-es/testing";
import { PostgresPersistence } from "../src/postgres-provider";

// CI sets these from the `services:` Postgres container; local runs may set them
// to a Testcontainers-provided URL (see §5.4). Falls back to the dev compose default.
const PG_TEST_URL = process.env.WORKFLOW_ES_PG_TEST_URL
    || "postgres://reactory:reactory@127.0.0.1:5432/reactory";

runPersistenceProviderConformanceTests({
    providerName: "postgres",
    createProvider: async () => {
        const provider = new PostgresPersistence(PG_TEST_URL);
        await provider.connect;
        return provider;
    },
    reset: async (p) => {
        await (p as PostgresPersistence).sequelize.sync({ force: true });
    },
    dispose: async (p) => {
        await (p as PostgresPersistence).sequelize.close();
    },
});
```

> This deletes the bespoke assertions in the existing file (the round-trip, runnable-instance,
> subscription, and event blocks shown in `postgres-persistence-provider.spec.ts`) and replaces them
> with the shared suite, which asserts a strict superset.

### 5.3 DI / config impact

None. `configureWorkflow()`, `WorkflowConfig`, and `TYPES` are untouched. The conformance suite
constructs providers directly via the factory the provider package supplies.

### 5.4 Backing-service strategy — **GitHub Actions `services:` for CI, Testcontainers for local**

> Ambiguity resolved here so the implementer does not guess.

**Decision:** In CI, back each provider with a **GitHub Actions `services:` container** (Postgres,
Mongo, Redis). For **local** developer runs, providers use **Testcontainers** (`testcontainers` npm
package, a `devDependency`) to spin the same images ephemerally.

**Justification:**

1. **CI simplicity & speed.** GitHub Actions `services:` are first-class: declared in YAML, health-gated
   with `--health-cmd`, networked to the job, and torn down automatically. Using Testcontainers *inside*
   GitHub Actions means the job needs the Docker daemon, pulls images at runtime, and adds a Node
   dependency to the critical path — strictly more moving parts for the same result.
2. **Local fidelity without a compose file.** Developers cannot rely on GitHub `services:` locally.
   Testcontainers gives them an ephemeral, version-pinned container with zero manual `docker run` and no
   stale `--name` collisions (the current Mongo/MySQL `pretest`/`posttest` Docker hooks are exactly the
   fragile pattern we are removing).
3. **Single switch.** Both paths converge on a connection URL passed via an env var
   (`WORKFLOW_ES_PG_TEST_URL` / `WORKFLOW_ES_MONGO_TEST_URL` / `WORKFLOW_ES_REDIS_TEST_URL`). In CI the
   env var points at the `services:` container; locally a small `beforeAll` (or a helper) starts a
   Testcontainer and sets the URL. The suite is identical in both.
4. **No prod-dep bloat.** `testcontainers` is a `devDependency` only — never shipped to consumers (per
   §3).

Image versions to pin (CI `services:` and local Testcontainers must match):
`postgres:16`, `mongo:7`, `redis:7`.

### 5.5 `core` package export of the testing subpath

Add to `core/package.json` an `exports` map so the subpath import resolves:

```jsonc
// core/package.json (additions — keep existing fields)
{
  "exports": {
    ".": {
      "types": "./build/src/index.d.ts",
      "default": "./build/src/index.js"
    },
    "./testing": {
      "types": "./build/src/testing/index.d.ts",
      "default": "./build/src/testing/index.js"
    }
  }
}
```

> If adding `exports` would break the existing `main`/`typings` consumers, keep `main`/`typings` as-is and
> additionally provide the `exports` map (Node honours `exports` over `main` when present, and the `"."`
> entry above preserves the current resolution). The suite is **also** re-exported from the root barrel
> (`core/src/index.ts`), so `import { runPersistenceProviderConformanceTests } from "@reactorynet/workflow-es"`
> works as a fallback if the subpath proves problematic under the `file:` tarball install.

### 5.6 CI additions — full `.github/workflows/ci.yml` change

The existing `build-and-test` job (core) is **unchanged**. Add a second job `providers`:

```yaml
  providers:
    name: Providers (build + integration)
    runs-on: ubuntu-latest
    # Build core first is implicit: providers install core via file:../../core,
    # so each provider's install compiles against the checked-out core source.
    strategy:
      fail-fast: false
      matrix:
        provider: [workflow-es-postgres, workflow-es-mongodb, workflow-es-redis]
        node-version: [20.x, 22.x]

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: reactory
          POSTGRES_PASSWORD: reactory
          POSTGRES_DB: reactory
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U reactory"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      mongo:
        image: mongo:7
        ports:
          - 27017:27017
        options: >-
          --health-cmd "echo 'db.runCommand({ping:1}).ok' | mongosh --quiet"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    defaults:
      run:
        working-directory: providers/${{ matrix.provider }}

    env:
      WORKFLOW_ES_PG_TEST_URL: postgres://reactory:reactory@127.0.0.1:5432/reactory
      WORKFLOW_ES_MONGO_TEST_URL: mongodb://127.0.0.1:27017/workflow-es-test
      WORKFLOW_ES_REDIS_TEST_URL: redis://127.0.0.1:6379

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: "yarn"
          cache-dependency-path: providers/${{ matrix.provider }}/yarn.lock

      # core is installed as file:../../core; build it once so providers compile
      # against emitted .d.ts/.js, not raw TS.
      - name: Build core
        working-directory: core
        run: |
          yarn install --frozen-lockfile
          yarn build

      - name: Install provider dependencies
        run: yarn install --frozen-lockfile

      - name: Type check
        run: npx tsc --noEmit

      - name: Build
        run: yarn build

      - name: Test (conformance + provider specs)
        run: yarn test
```

> Notes for the implementer:
> - `fail-fast: false` so one provider's failure does not mask the others.
> - The `mongo` service health check uses `mongosh`, which `mongo:7` ships.
> - All three services are declared on every matrix leg for simplicity; an unused service (e.g. Mongo on
>   the Postgres leg) is harmless and idle.
> - Redis is in the matrix to **build + smoke-test** the lock/queue provider (it does not run the
>   persistence conformance suite — see §6.6). If Redis has no test yet, its `yarn test` must at minimum
>   be a no-op-safe script (a single trivial spec); do not leave `jasmine` failing on "no specs".

## 6. Behavioural contract (numbered rules)

The conformance suite (`runPersistenceProviderConformanceTests`) MUST register tests proving each rule
below. Rules 1–13 are persistence-contract assertions run for every `IPersistenceProvider`. Rules
14–17 are CI-gate rules.

1. **Create round-trip.** After `createNewWorkflow(instance)`, the returned id is defined,
   `instance.id` is set to the returned id, and `getWorkflowInstance(id)` returns an instance whose
   `workflowDefinitionId`, `version`, `status`, `nextExecution`, and `data` deep-equal what was written.
2. **Persist scalars.** After mutating `nextExecution` and `data` on a loaded instance and calling
   `persistWorkflow`, a fresh `getWorkflowInstance` reflects the new scalar values.
3. **Persist execution pointers.** `persistWorkflow` with a replaced `executionPointers` array
   round-trips pointer `id`, `stepId`, `stepName`, and `active` exactly (replace-not-append semantics).
4. **Runnable instances.** A `Runnable` instance with `nextExecution` in the past appears in
   `getRunnableInstances()`; a `Complete`/future-`nextExecution` instance does not.
5. **Create subscription.** `createEventSubscription(sub)` assigns `sub.id`.
6. **Get subscriptions by name/key/asOf.** A subscription with `subscribeAsOf` ≤ now is returned by
   `getSubscriptions(name, key, now)`; one with a non-matching name/key is not.
7. **Terminate subscription.** After `terminateSubscription(id)`, that id is no longer returned by
   `getSubscriptions`.
8. **Create + get event.** `createEvent(ev)` returns a defined id and sets `ev.id`; `getEvent(id)`
   round-trips `eventName`, `eventKey`, `eventData`, `eventTime`, and `isProcessed`.
9. **Runnable events.** An unprocessed event with `eventTime` ≤ now appears in `getRunnableEvents()`; a
   processed event does not.
10. **Mark processed / unprocessed.** `markEventProcessed(id)` then `getEvent(id).isProcessed === true`;
    `markEventUnprocessed(id)` then `=== false`.
11. **getEvents by name/key/asOf.** `getEvents(name, key, asOf)` returns ids of matching events whose
    `eventTime` ≥ `asOf` and excludes non-matching name/key.
12. **Missing reads.** `getWorkflowInstance(unknownId)` and `getEvent(unknownId)` resolve to `undefined`
    (do not throw).
13. **Concurrency token round-trip (C1).** This is the load-bearing C1 assertion and MUST be present:
    - `createNewWorkflow` seeds `instance.concurrencyToken` to `0`.
    - After a successful `persistWorkflow`, `instance.concurrencyToken` is incremented by 1 **in place**,
      and a fresh `getWorkflowInstance` returns the incremented value.
    - **Optimistic-concurrency conflict:** load the same instance twice (two in-memory copies at the
      same token); `persistWorkflow(copyA)` succeeds; `persistWorkflow(copyB)` (still at the stale token)
      **rejects** by throwing a `WorkflowConcurrencyError` (assert via
      `await expectAsync(persistWorkflow(copyB)).toBeRejected()` and that the error is an instance of /
      has the name `WorkflowConcurrencyError`). The stored token reflects only copyA's write.
14. **Breaking interface change fails provider CI.** If a change to `IPersistenceProvider` (or any type
    the conformance suite references) makes a non-deprecated provider fail to type-check, build, or pass
    the suite, the `providers` job MUST go red on the PR. (This is the whole point of the gate; proven in
    §8 meta.)
15. **Deprecated providers excluded.** `workflow-es-mysql` (deprecated per C3) and `workflow-es-azure`
    (stub, out of scope) MUST NOT appear in the CI `providers` matrix and MUST NOT run the conformance
    suite. Mongo and Postgres (and Redis, for build/smoke) are included.
16. **Green-for-every-non-deprecated-provider on PR.** On every pull request to `master`/`main`, the
    `providers` job runs and must be green for postgres and mongodb (conformance) and redis (build +
    smoke) before merge. The job runs on Node 20 and 22, matching core.
17. **Idempotent reset.** The suite calls `options.reset` to start from a clean store; the suite must not
    depend on residual state from a previous run, and `reset` must be safe to invoke on a populated DB.

## 7. Provider parity

No core interface changes in M8 (it consumes the post-C1 contract). The cross-cutting relationships:

| Concern | Relationship |
|---|---|
| **M7 (depends on)** | M7 makes core libs `peerDependencies` and standardises the `@reactorynet/workflow-es` import + aligned versions so a fresh provider install resolves a *single* inversify/reflect-metadata. M8's CI installs each provider fresh; without M7, dual module instances would break decorator metadata and the conformance suite would fail for the wrong reason. **M7 must be `done` before M8 lands.** |
| **C1** | C1 introduced `WorkflowInstance.concurrencyToken` and `WorkflowConcurrencyError`. Rule §6.13 is the test C1 is validated against. The conformance suite is the regression harness that keeps C1 honest. |
| **C2 (future)** | The SQLite provider (C2) opts into the same suite by supplying a factory + reset; no suite change needed. |
| **C3** | C3 repairs Mongo and deprecates MySQL. The conformance suite is the acceptance bar C3's Mongo rewrite must pass (§6, rules 1–13) and the reason MySQL is excluded (§6.15). C3 depends on M8 for this harness. |
| **Per-provider opt-in** | Adding a provider to the gate = (1) add a wrapper spec calling `runPersistenceProviderConformanceTests`, (2) add a `spec/support/jasmine.json`, (3) add the provider to the CI matrix. Nothing in core changes. |

| Provider | M8 action |
|---|---|
| memory (core) | No CI matrix entry (lives in core, already tested). May optionally run the suite in core later — out of scope here. |
| postgres | Rewrite spec to call shared suite; in matrix; conformance must pass. |
| mongodb | Add wrapper spec + jasmine.json; in matrix; conformance must pass (C3 makes it pass). |
| redis | In matrix for build + smoke only (lock/queue provider, not `IPersistenceProvider`). |
| mysql | **Excluded** (deprecated, C3). Not in matrix. |
| azure | **Excluded** (stub, out of scope). Not in matrix. |

## 8. Test plan (TDD)

The conformance suite *is* the test artifact. Follow the existing Jasmine 5 pattern in
`providers/workflow-es-postgres/spec/postgres-persistence-provider.spec.ts` (async `beforeAll`,
`spec_dir: build/spec`). Use `expectAsync(...).toBeRejected()` for the concurrency-conflict rejection
(Jasmine 5 async matcher), and the core `spinWait` helper (`core/spec/helpers/spin-wait.ts`) only if a
provider needs to poll for eventual visibility (Postgres/Mongo are read-your-write, so it is generally
not needed).

### Failing-test-first
- **`postgres › concurrency token › rejects a stale write`** — arrange: build the Postgres provider,
  `reset`, create a workflow (token 0), load two in-memory copies. · act: `persistWorkflow(copyA)`
  (succeeds, token→1), then `persistWorkflow(copyB)` (still token 0). · assert: copyB's persist rejects
  with `WorkflowConcurrencyError`; `getWorkflowInstance` shows copyA's data and token 1. **This test
  must fail before C1's CAS is wired and before the suite exists** — it proves rule §6.13 and is the
  reason the shared suite exists.

### Coverage (one `it` per rule, registered by the shared suite)
- **`creates and round-trips a workflow`** — rule §6.1.
- **`persists scalar changes`** — rule §6.2.
- **`persists execution pointers (replace semantics)`** — rule §6.3.
- **`lists runnable instances; excludes complete/future`** — rule §6.4.
- **`creates / queries / terminates subscriptions`** — rules §6.5–6.7.
- **`creates and round-trips events`** — rule §6.8.
- **`lists runnable events; excludes processed`** — rule §6.9.
- **`marks events processed and unprocessed`** — rule §6.10.
- **`getEvents filters by name/key/asOf`** — rule §6.11.
- **`returns undefined for unknown ids`** — rule §6.12.
- **`increments and round-trips the concurrency token`** — rule §6.13 (happy path).

### CI-gate tests (meta — see §8 "How to prove the gate works")
- Rules §6.14–6.16 are proven operationally, not by a Jasmine `it`. See the meta procedure below.

### How to run
```bash
# Build core first (providers consume the emitted build).
cd core && yarn install --frozen-lockfile && yarn build

# Per provider (CI): point the env var at a running service, then:
cd providers/workflow-es-postgres
WORKFLOW_ES_PG_TEST_URL=postgres://reactory:reactory@127.0.0.1:5432/reactory yarn test

# Local (no service running): the spec's beforeAll uses Testcontainers to start
# postgres:16 / mongo:7 and sets the URL automatically — just:
cd providers/workflow-es-mongodb && yarn test
```

### How to prove the gate works (meta — required acceptance for §6.14)
1. On a scratch branch, introduce a **deliberate breaking change** to the core interface — e.g. rename
   `IPersistenceProvider.getWorkflowInstance` to `getInstance` in
   `core/src/abstractions/persistence-provider.ts` (and only there).
2. Push the branch and open a PR.
3. **Expected:** the `core` `build-and-test` job may stay green (core compiles its own rename), but the
   `providers` job goes **red** on `npx tsc --noEmit` / `yarn build` for postgres and mongodb, because
   their providers and the shared conformance suite still call `getWorkflowInstance`. This demonstrates
   the gate catches breaking interface changes that previously merged silently.
4. Revert the deliberate break; confirm `providers` returns to green. Record the red→green run links in
   the PR description (satisfies the upgrade-plan §6.2 "the TDD failing-test-first was real" rule).

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds and emits `build/src/testing/index.js` and
      `build/src/testing/conformance/persistence-conformance.js`.
- [ ] `import { runPersistenceProviderConformanceTests } from "@reactorynet/workflow-es/testing"` resolves
      from a provider package (and the root import resolves too).
- [ ] `cd providers/workflow-es-postgres && yarn build && WORKFLOW_ES_PG_TEST_URL=... yarn test` passes,
      running the shared suite (all §6 rules 1–13), against `postgres:16`.
- [ ] `cd providers/workflow-es-mongodb && yarn build && WORKFLOW_ES_MONGO_TEST_URL=... yarn test` passes
      the shared suite against `mongo:7` (after C3's repair).
- [ ] `cd providers/workflow-es-redis && yarn build && yarn test` succeeds (build + smoke).
- [ ] The CI `providers` job runs on Node 20 and 22, with postgres/mongo/redis `services:`, and is
      green for postgres + mongodb + redis on a clean PR.
- [ ] `workflow-es-mysql` and `workflow-es-azure` do **not** appear in the CI `providers` matrix.
- [ ] The deliberate-break procedure in §8 turns the `providers` job red, then green on revert (recorded
      in the PR).
- [ ] No published provider package gains a runtime (`dependencies`) entry for `testcontainers`.

## 10. Backward compatibility & migration

- **Public API.** Additive only: a new `@reactorynet/workflow-es/testing` subpath export (and root
  re-export). No existing core export changes signature. No on-disk/at-rest format change.
- **Provider packages.** Postgres's existing bespoke spec is replaced by the shared suite (test-only
  change, no runtime impact). Mongo gains test scaffolding. The fragile Docker `pretest`/`posttest`
  hooks in Mongo/MySQL are removed in favour of `services:`/Testcontainers.
- **Consumer (`reactory-express-server`).** Unaffected at runtime — the conformance module is test
  tooling and is not imported by production code paths. If a consumer happens to import the `/testing`
  subpath, it is purely additive.
- **Version bump.** Core: `2.3.6-reactory.3` → `2.3.6-reactory.4` (additive export, no behavioural
  change). Provider packages bump their patch/prerelease (e.g. postgres `1.0.0-reactory.0` →
  `1.0.0-reactory.1`) since their test scripts and devDependencies change. No migration steps for
  consumers.

## 11. Definition of Done

CI builds, type-checks, and integration-tests every non-deprecated persistence provider (postgres,
mongodb) against ephemeral GitHub Actions service containers on Node 20 and 22, with redis built and
smoke-tested, while mysql and azure are excluded. A single conformance suite owned by `core` and
imported by each provider asserts the entire `IPersistenceProvider` contract including the C1
optimistic-concurrency token round-trip and conflict rejection, and is green for every included provider
on every PR. A deliberate breaking change to a core persistence interface demonstrably turns the
`providers` job red. M7 is `done` so provider installs resolve a single inversify/reflect-metadata.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) add `core/src/testing/conformance/persistence-conformance.ts` and barrels +
  `core/package.json` `exports`; rebuild core. (2) Rewrite the Postgres spec to call the suite; run it
  locally against a `docker run postgres:16` to confirm all §6 rules pass. (3) Wire the CI `providers`
  job with **postgres only** in the matrix first; confirm green. (4) Add mongodb to the matrix +
  wrapper; let C3 make it pass. (5) Add redis build/smoke. (6) Run the §8 deliberate-break procedure.
- The conformance suite must not `import "jasmine"` as a value — rely on ambient globals so it works in
  any provider's Jasmine context. Keep it framework-agnostic in spirit (only `describe/it/expect/
  beforeAll/beforeEach/afterAll`).
- For Testcontainers local runs, a thin helper per provider spec (in `beforeAll`) that starts the image
  and sets `process.env.WORKFLOW_ES_*_TEST_URL` before calling `createProvider` keeps the CI and local
  paths identical; guard it with `if (!process.env.WORKFLOW_ES_*_TEST_URL)` so CI (which sets the env)
  skips Testcontainers.
- Upstream `danielgerlag/workflow-es` has a comparable `test-suite` of persistence assertions reused
  across providers — the shape (a single exported function registering describes) mirrors that.
