# UPGRADES.md — reactory-workflow-es

A prioritized, executable backlog of improvements for `@reactorynet/workflow-es`. Each item is a
self-contained work unit with a **spec**, **expected outcome**, **TDD guidance** (where applicable),
and an **owner** indicating whether the work is deferred to the GitHub Copilot CLI or kept for
hands-on (Claude Code / human) work.

We work through these **systematically, one item at a time**, writing a short spec for each before
touching code. Do not batch unrelated items into a single change.

---

## How we delegate to the GitHub Copilot CLI

Mechanical, low-judgement tasks are deferred to the **GitHub Copilot CLI** running **Claude Sonnet
4.6 (high reasoning effort)** as the model. Items below are tagged:

- **`[copilot]`** — defer to Copilot CLI (mechanical, well-bounded, low risk).
- **`[claude]`** — keep in Claude Code / human review (design judgement, concurrency, public API,
  test design).
- **`[copilot+review]`** — Copilot drafts, a human/Claude reviews before merge.

### Invocation

The Copilot CLI is launched via `gh copilot` (it downloads to `~/.local/share/gh/copilot` on first
run). Use non-interactive print mode with an explicit model and the repo as the working directory:

```bash
gh copilot -- \
  --model claude-sonnet-4.6 \
  --prompt "$(cat .copilot/<task>.prompt.md)" \
  --add-dir "$(pwd)"
```

Notes / conventions:
- **Model:** `claude-sonnet-4.6` with **high** reasoning effort. Confirm the exact model identifier
  with `gh copilot -- --help` / the model picker before each run — Copilot's model slugs change, and
  the closest available Sonnet 4.6 high variant should be selected.
- Pass everything after `--` so `gh` does not intercept Copilot's flags.
- Keep one prompt file per task under `.copilot/` (tracked as provenance) so runs are reproducible
  and the prompt can be tuned and re-run.
- **Working dir:** run Copilot with the repo root added (`--add-dir "$(pwd)"`) but instruct it to run
  `yarn`/`npm` **only inside `core/`**. Left unconstrained it has run `yarn` at the repo root, which
  creates stray `package.json`/`.yarnrc.yml`/`.yarn/` and can re-pack/modify the tracked `.tgz` and
  `core/.yarn/install-state.gz`. Always `git status` after a run and revert anything outside scope.
- **Exact invocation that works** (verified):
  ```bash
  copilot -p "$(cat .copilot/<task>.prompt.md)" \
    --model claude-sonnet-4.6 --reasoning-effort high \
    --allow-all-tools --add-dir "$(pwd)" -s
  ```
  (`--allow-all-tools` is required for non-interactive mode; `-s` prints only the agent response.)
- Each Copilot task must end with: *"Build must pass (`yarn build`) and tests must pass
  (`yarn test`). Do not edit files under `core/build/`, `node_modules/`, or `providers/*/build/`."*
- Every Copilot change lands on its own branch and goes through normal review — Copilot output is
  **not** trusted unreviewed for anything beyond the trivially mechanical.

### Per-task prompt template

```
You are working in the reactory-workflow-es monorepo (a fork of workflow-es).
Conventions: one class per file (kebab-case), TypeScript strict-leaning, inversify 6 IoC,
ExecutionResult via static factories only, no business logic in models.

TASK: <one-line summary>
SCOPE: <exact files / globs allowed to change>
CHANGE: <precise instruction>
DO NOT: touch core/build, node_modules, providers/*/build, or unrelated files.
VERIFY: `cd core && yarn build && yarn test` must pass. Report the commands you ran.
```

---

## Working agreement (per item)

For **every** item we pick up:

1. Write a short spec at the top of the PR/commit (problem → change → acceptance).
2. If TDD applies, **write the failing test first**, then make it pass.
3. Keep the change scoped to the item; no drive-by edits.
4. Update this file: tick the checkbox and note the PR/commit.

---

## P0 — Correctness bugs

### P0.0 — Repair the Jasmine 5 test suite `[copilot]`

**Problem.** The test suite was **red at baseline (9 failures)**. The Jasmine 2→5 upgrade left scenario
specs using `beforeAll(async (done) => { ... spinWaitCallback(fn, done); })`. Jasmine 5 forbids a spec
function that is both `async` and takes a `done` callback. A promise-based `spinWait` helper already
existed in `core/spec/helpers/spin-wait.ts`.

**Spec.** In the 7 scenario specs, convert `async (done)` → `async ()` and
`spinWaitCallback(fn, done)` → `await spinWait(fn)`; fix imports. Remove the unused
`spinWaitCallback` import from `execution-result-processor.spec.ts`. (Copilot also found and fixed the
same `done`+promise pattern in `memory-persistence-provider.spec.ts`.)

**Expected outcome.** `yarn build && yarn test` green — **25 specs, 0 failures**.

**TDD.** N/A — this *restores* the test suite that everything else's TDD depends on. Must precede all
other work.

- [x] **Done** — delegated to Copilot CLI (Sonnet 4.6, high). Verified 25 specs, 0 failures.
  Prompt: `.copilot/p0.0-jasmine-specs.prompt.md`. Branch: `chore/upgrades-execution`.

### P0.1 — Fix broken statements in the MySQL provider `[copilot+review]`

**Problem.** `providers/workflow-es-mysql/src/mysql-provider.ts` has two shipping bugs:
- `:129` — `result.push` with no call/argument → `getSubscriptions()` returns garbage.
- `:239` — `result.push(event["id"].toString)` pushes the function reference, not the string
  (missing `()`).

It also uses Sequelize v4 APIs removed in v5+ (`updateAttributes`, `findById`, `$lt` operators) — but
that is the larger migration in **P2.x**, not this item.

**Spec.** Fix only the two broken statements so the method bodies are syntactically and semantically
correct. No driver migration in this item.

**Expected outcome.** `getSubscriptions()` returns populated `EventSubscription[]`; `:239` pushes the
stringified id. `tsc --noEmit` clean for the package.

**TDD.** N/A at unit level until the provider has a test harness (see P4.2). Verify via type-check +
manual read; add coverage when the MySQL provider gets CI.

- [x] **Done** — fixed `:129` (`result.push(event)`) and `:239` (`.toString()`) directly (two-token
  fixes; a Copilot round-trip adds no value since the provider cannot `yarn build`/`yarn test` until
  P0.2/P4.2 — it still imports `workflow-es` and uses Sequelize v4 APIs). Verified by inspection;
  build-verification deferred to **P4.2**.

---

### P0.2 — Decide the fate of each provider package `[claude]`

**Problem.** All four providers (`mongodb`, `redis`, `azure`, `mysql`) still:
- import from the old `"workflow-es"` package, not `"@reactorynet/workflow-es"`;
- depend on `inversify ^4` while core is `^6` (IoC token mismatch → broken at runtime);
- pin EOL drivers (`mongodb ^3.2.7`, `redis ^2.8.0`, `ioredis ^4`, `azure-storage ^2` (deprecated),
  `sequelize ^4`).

**Spec.** Make an explicit keep/revive/archive decision per provider and record it in AGENT.md and
each provider README. Likely outcome: **revive MongoDB**, **archive the rest** until needed.

**Expected outcome.** No provider silently appears usable when it is not. Revived providers get their
own upgrade sub-items (package rename, inversify 6, driver bump) tracked under P2.

**TDD.** N/A (decision + docs). Revival work gets tests under P4.2.

- [ ] Done — PR: ____

---

### P0.3 — Throw `Error` objects, not string literals `[copilot]`

**Problem.** `core/src/services/workflow-executor.ts:31` and
`core/src/fluent-builders/step-builder.ts:110` `throw` bare strings. These lose stack traces and make
the `catch (err) { err.message }` blocks read `undefined`.

**Spec.** Replace `throw "..."` with `throw new Error(\`...\`)` at both sites. Search the whole
`core/src` for any other `throw "`/`throw \`` string throws and convert them.

**Expected outcome.** No string throws remain in `core/src`; errors carry stack traces.

**TDD.** Add/extend a unit test asserting that executing a workflow whose definition is missing from
the registry rejects with an `Error` (not a string). `expect(() => ...).toThrowError(Error)`.

- [x] **Done** — delegated to Copilot CLI (Sonnet 4.6, high). Converted **3** string throws
  (`workflow-executor.ts:31`, `step-builder.ts:110`, and a missed template-literal throw in
  `workflow-queue-worker.ts:62`); added `core/spec/services/throw-error.spec.ts`. 26 specs, 0 failures.
  Prompt: `.copilot/p0.3-throw-error.prompt.md`.

---

## P1 — Type safety (prerequisites for `strict: true`)

### P1.1 — Introduce a `toError(unknown)` helper and apply to all catch blocks `[copilot+review]`

**Problem.** 13 `catch (err)` sites read `err.message` / `err.stack`. Enabling `strict`
(`useUnknownInCatchVariables`) makes `err: unknown` and every site a compile error.

**Spec.** Add a shared helper (e.g. `core/src/abstractions/errors.ts` or a small util):

```typescript
export const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
```

Update all 13 catch sites to `const error = toError(err);` and use `error.message` / `error.stack`.

**Expected outcome.** Codebase compiles cleanly when `useUnknownInCatchVariables` is toggled on; no
behavioural change.

**TDD.** Unit-test `toError`: passes `Error` through unchanged; wraps strings/objects into `Error`
with a sensible `message`.

**Owner note.** Claude designs the helper + its placement; Copilot applies the mechanical sweep
across the 13 sites; human reviews.

- [x] **Done** — Claude placed the helper at `core/src/abstractions/errors.ts` (exported via the
  abstractions barrel so providers can reuse it); Copilot CLI (Sonnet 4.6, high) swept all 11 `catch`
  blocks across 5 service files + `.catch` arrow handlers, and added `core/spec/services/to-error.spec.ts`
  (3 tests). 29 specs, 0 failures. Prompt: `.copilot/p1.1-to-error.prompt.md`.
  **Verified strict-catch ready:** `tsc --noEmit --strict` reports 0 catch-variable (`unknown`) errors.
  _Baseline for P1.4: 168 remaining strict errors, all `strictNullChecks`/`strictPropertyInitialization`._

---

### P1.2 — Type `ExecutionPointer.persistenceData` `[claude]`

**Problem.** `persistenceData: any`, and `_errors[]` is written in two different shapes
(`workflow-executor.ts` writes `{message,stack,errorTime,retryCount}`; the `ExecutionError` model uses
`{message,errorTime}`).

**Spec.** Introduce a typed interface and unify the error-record shape:

```typescript
interface PointerErrorRecord { message: string; stack: string | null; errorTime: string; retryCount: number; }
interface PointerPersistenceData { _errors?: PointerErrorRecord[]; [key: string]: unknown; }
```

Replace `any` on `ExecutionPointer.persistenceData` and reconcile the two write sites.

**Expected outcome.** One canonical error-record shape; `persistenceData` typed; persistence
providers still round-trip it (it's plain JSON).

**TDD.** Extend the executor scenario test (or add one) that forces a step to throw and asserts the
persisted pointer has a well-formed `_errors[0]` matching `PointerErrorRecord`.

- [ ] Done — PR: ____

---

### P1.3 — Compile all source, not just the `index.ts` graph `[copilot]`

**Problem.** `core/tsconfig.json` uses `files: ["src/index.ts"]` + `include: ["spec/**/*.ts"]`. Only
files transitively imported from `index.ts` are type-checked; an orphaned new source file is silently
skipped.

**Spec.** Replace with `include: ["src/**/*.ts", "spec/**/*.ts"]` and drop the `files` array (keep
`exclude: ["node_modules"]`). Confirm `yarn build` output is unchanged.

**Expected outcome.** Every `core/src/**/*.ts` is type-checked on build and in CI.

**TDD.** N/A — verified by build + a deliberately-broken throwaway file failing the check (then
reverted).

- [x] **Done** (cd17f2e) — done directly (one-line config; not worth a Copilot round-trip).

---

### P1.4 — Enable full `strict: true` `[claude]`

**Problem.** Only `noImplicitAny` is on. `strictNullChecks`, `strictPropertyInitialization`, etc. will
surface real issues (e.g. uninitialised injected fields on services).

**Spec.** Land **after** P1.1–P1.3. Flip `strict: true`; resolve fallout (likely `!` definite-assign
on `@inject` fields or constructor injection, and null guards in the executor/result-processor).

**Expected outcome.** `strict: true` with a clean build and green tests. Update the AGENT.md tech
table.

**TDD.** Existing scenario suite is the regression guard; do not weaken types to pass — fix the call
sites.

- [ ] Done — PR: ____

---

## P2 — Robustness / concurrency

### P2.1 — Resolve the `PollWorker` `//TODO: lock` and re-queue dedup `[claude]`

**Problem.** `core/src/services/poll-worker.ts:36` re-queues every runnable instance every 10s with no
dedup; with the 100ms queue worker the same id can be enqueued repeatedly.

**Spec.** Either track in-flight/queued ids, or make the queue idempotent for already-queued ids.
Preserve single-node semantics; keep the provider interface intact.

**Expected outcome.** A sleeping workflow that wakes is processed once per wake, not spammed.

**TDD.** Scenario test with a `delay` step: assert the executor runs the woken step exactly once
(spy/count executions) rather than N times across poll ticks.

- [ ] Done — PR: ____

---

### P2.2 — Symmetric async lifecycle on `WorkflowHost` `[claude]`

**Problem.** `start(): Promise<void>` but `stop(): void`; only `SIGINT` is handled
(`workflow-host.ts:177`); `stop()` clears timers without draining in-flight work.

**Spec.** Make `stop(): Promise<void>`, handle `SIGTERM` as well as `SIGINT`, and await in-flight
queue processing (or a bounded drain) before clearing timers. This is the prerequisite for the
Reactory `IReactoryService` start/stop hooks (P5).

**Expected outcome.** Graceful shutdown under both signals; no work lost mid-step on shutdown.

**TDD.** Test: start host, enqueue a slow step, call `stop()`, assert it resolves only after the
step completes and that timers are cleared.

- [ ] Done — PR: ____

---

### P2.3 — Drop redundant field initializer `[copilot]`

**Problem.** `workflow-host.ts:27` —
`@inject(TYPES.IQueueProvider) private queueProvider = new SingleNodeQueueProvider();`. The initializer
constructs a throwaway that property injection immediately overwrites.

**Spec.** Remove the `= new SingleNodeQueueProvider()` initializer (keep the `@inject`). Remove the
now-unused import if nothing else uses it.

**Expected outcome.** No behaviour change; cleaner intent. Build + tests green.

**TDD.** N/A — covered by existing host scenarios.

- [x] **Done** (cd17f2e) — done directly (single-line edit).

---

### P2.4 — Dead-letter path for exhausted retries / unknown strategy `[claude]`

**Problem.** `execution-result-processor.ts:89` `default` branch sleeps 60s indefinitely on an unknown
strategy; there is no max-retry → dead-letter hand-off. Background workers swallow errors into the
logger with no escalation.

**Spec.** Add a configurable dead-letter handler invoked when retries are exhausted or an unknown
error strategy is hit. Surface via `WorkflowConfig` (e.g. `.useDeadLetterHandler()`), default to a
no-op + warning log. Aligns with the AGENT.md roadmap DLQ item.

**Expected outcome.** Permanently-failed steps are routed to the DLQ handler rather than silently
looping; default behaviour unchanged for existing consumers.

**TDD.** Test a step that always throws under a retry policy with `maxRetries`; assert the DLQ handler
is invoked once after exhaustion and the workflow lands in a terminal/known state.

- [ ] Done — PR: ____

---

## P3 — Repo hygiene

### P3.1 — Stop committing build artifacts (`*.tgz`) `[copilot]`

**Problem.** `core/reactorynet-workflow-es-2.3.6-reactory.1.tgz` and `...-.2.tgz` are tracked; `.tgz`
is not git-ignored. These are `build:pack` outputs and the stale `.1` contradicts the current version.

**Spec.** `git rm --cached` both `.tgz` files, add `*.tgz` to `.gitignore`. Confirm `build:pack` still
emits the artifact locally (just untracked).

**Expected outcome.** No build artifacts in git; `.gitignore` covers future packs.

**TDD.** N/A.

- [x] **Done** (cd17f2e) — done directly (git operation).

---

### P3.2 — De-duplicate and reconcile AGENT.md `[claude]`

**Problem.** AGENT.md contains the document **twice**; the second copy describes the pre-modernization
state (`workflow-es` 2.3.5, `noImplicitAny: false`) and contradicts the first half.

**Spec.** Keep one authoritative version reflecting current reality; remove the stale duplicate. Cross-
link to this UPGRADES.md for the backlog.

**Expected outcome.** A single, internally-consistent AGENT.md.

**TDD.** N/A.

- [ ] Done — PR: ____

---

### P3.3 — Remove dead toolchain files `[copilot]`

**Problem.** `.travis.yml` remains (CI is GitHub Actions now); the root `yarn.lock` is an empty v1 stub
while `core/` uses Yarn 4.

**Spec.** Delete `.travis.yml` and the root `yarn.lock`. Confirm `core/yarn.lock` (Yarn 4) is the only
lockfile and CI still resolves it.

**Expected outcome.** One live toolchain; no misleading legacy config.

**TDD.** N/A — CI run is the check.

- [x] **Done** (cd17f2e) — done directly (file deletions).

---

### P3.4 — Add ESLint + Prettier with a CI lint step `[copilot+review]`

**Problem.** No linter/formatter. A lint pass would have caught P0.1 and P0.3
(`no-throw-literal`, missing `()`, unused vars).

**Spec.** Add `eslint` + `@typescript-eslint` + `prettier` to `core/`, a flat config tuned for the
existing style (don't reformat the world in one PR — scope formatting to changed files or do a single
isolated format commit), and a `lint` script. Add a `lint` job to `.github/workflows/ci.yml`.

**Expected outcome.** `yarn lint` runs clean (after fixing or `// eslint-disable` justifying any
legacy hits); CI fails on new lint errors.

**TDD.** N/A — lint is itself the gate.

**Owner note.** Copilot scaffolds config + script + CI job; human reviews the rule set and the initial
format commit.

- [ ] Done — PR: ____

---

## P4 — Test coverage & CI

### P4.1 — Scenario tests for saga/compensation, delay, schedule, foreach `[claude]`

**Problem.** `core/spec/scenarios/` covers basic, data-io, external-events, if, outcome-fork, parallel,
while — but **not** saga/compensation (the most complex code, `execution-result-processor.ts:97-160`),
nor `delay`, `schedule`, `foreach`, despite samples existing for all.

**Spec.** Add scenario specs mirroring the `samples/` for each missing feature, prioritising
compensation (happy path + revert/resume variants).

**Expected outcome.** Compensation, delay, schedule, foreach each have a green scenario test;
coverage of `execution-result-processor.ts` materially up.

**TDD.** These **are** the tests — write them to encode expected behaviour, using the existing
`spinWaitCallback` helper. For compensation, assert compensation pointers are created and the workflow
reaches the expected terminal state.

- [ ] Done — PR: ____

---

### P4.2 — Build/type-check providers in CI `[copilot+review]`

**Problem.** `ci.yml` runs only in `core/`; providers are never compiled in CI, which is why P0.1 went
unnoticed.

**Spec.** Add a CI job (matrix over the providers we **keep** per P0.2) that runs `tsc --noEmit` for
each. Defer docker-backed integration tests (mongo/mysql) to a separate, optional job.

**Expected outcome.** A provider that fails to type-check breaks CI.

**TDD.** N/A for the CI wiring; integration tests are P4.x follow-ups per revived provider.

**Owner note.** Copilot wires the workflow YAML; human confirms which providers are in scope.

- [ ] Done — PR: ____

---

### P4.3 — Migrate Jasmine → Jest `[claude]`

**Problem.** Roadmap item; aligns with the rest of the Reactory platform and unlocks watch mode,
coverage, snapshots.

**Spec.** Replace Jasmine with Jest in `core/`; port the scenario specs and the `spinWait` helper;
add coverage reporting with a baseline threshold. Land **after** P4.1 so the new specs come along.

**Expected outcome.** `yarn test` runs Jest green; coverage emitted in CI.

**TDD.** Port-and-verify: every existing/added spec must pass under Jest before Jasmine is removed.

- [ ] Done — PR: ____

---

## P5 — Reactory integration (roadmap)

Tracked here for sequencing; specs to be expanded when picked up. Dependencies noted.

- **P5.1 — Reactory service adapter** `[claude]` (wrap `WorkflowHost` as an `IReactoryService`).
  _Depends on P2.2 (symmetric async lifecycle)._
- **P5.2 — Lifecycle event emission** `[claude]` (`workflow.started/completed/failed/suspended` on the
  Reactory Queue). _Depends on P5.1._
- **P5.3 — OpenTelemetry instrumentation** `[claude]` (spans per step; metrics: active instances, step
  durations, error rates). _Depends on P5.1._
- **P5.4 — Dead-letter queue wiring into Reactory** `[claude]`. _Builds on P2.4._

**Suggested overall sequence:** P0 → P1 (strict-readiness) → P3 hygiene (parallelisable, mostly
`[copilot]`) → P2.2 lifecycle → P4 tests → P5 integration.

---

## Status legend

- [ ] not started  ·  [~] in progress  ·  [x] done (record PR/commit)

| Phase | Items | Mostly |
|---|---|---|
| P0 Correctness | P0.1–P0.3 | mixed |
| P1 Type safety | P1.1–P1.4 | `[claude]` w/ `[copilot]` sweeps |
| P2 Robustness | P2.1–P2.4 | `[claude]` |
| P3 Hygiene | P3.1–P3.4 | `[copilot]` |
| P4 Tests/CI | P4.1–P4.3 | mixed |
| P5 Reactory | P5.1–P5.4 | `[claude]` |
</content>
</invoke>
