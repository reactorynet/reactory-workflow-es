# Spec — M3 · Document & guard the execution model

| Field | Value |
|---|---|
| **Item ID** | M3 |
| **Title** | Document & guard the execution model (off-main-thread hosting for Electron) |
| **Plan reference** | [`upgrade-plan.md` → M3](../upgrade-plan.md) |
| **Target** | Electron |
| **Severity** | Medium |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | C2 (embedded SQLite persistence) · H4 (async graceful drain) |
| **Author / reviewer** | claude / Werner Weber |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` is a TypeScript workflow/saga engine. A workflow definition is a chain
of **steps**; each step is a class extending the abstract `StepBody`, whose only contract is one
method:

```ts
// core/src/abstractions/step-body.ts
@injectable()
export abstract class StepBody {
    public abstract run(context: StepExecutionContext): Promise<ExecutionResult>;
}
```

The engine executes a step body **inline, on the event loop of the host process**. In
`core/src/services/workflow-executor.ts:76` the executor does:

```ts
//execute
let stepResult = await body.run(stepContext);
```

There is no thread pool, no process pool, and no offloading: `body.run(...)` runs in the same
JavaScript execution context as every other workflow on that node, and as everything else hosted in
that process. This is correct and intended for IO-bound work (the `await` yields the loop while a
network/disk call is outstanding), but it has a sharp edge:

- **A CPU-heavy or synchronous step body stalls *all* workflow processing on that node.** While a
  `run()` is doing synchronous CPU work (a tight loop, a large `JSON.parse`, image/PDF processing,
  crypto over a big buffer), the event loop is blocked: no other step runs, the poll worker cannot
  fire, the queue worker cannot pull work, and `host.stop()`'s drain (H4) cannot make progress.
- **In Electron this is doubly harmful.** A desktop app may host the engine in the **main process**
  (which also drives windows, menus, IPC, the tray, and `app` lifecycle) or — worse — in a
  **renderer process** (which drives the UI). A blocking step body there freezes the application
  window, not just the workflow engine.

There is no documentation of the step-body contract (that it must be async/IO-bound and must not
block), and there is no supported pattern or sample showing how to host the engine **off** the
Electron main/renderer thread so that workflow execution never competes with the UI.

This item does **not** change how the executor runs steps. It is a **documentation + sample**
deliverable: write down the execution-model contract, and ship a working Electron sample that hosts
the engine in a child execution context (Electron `utilityProcess`) using the C2 SQLite provider and
the H4 graceful-drain shutdown.

### Dependencies recap (so the reader needs no other doc)

- **C2** delivered the package `@reactorynet/workflow-es-sqlite` exporting class `SqlitePersistence`.
  Usage: `const p = new SqlitePersistence("/abs/path/workflow.db"); await p.connect; config.usePersistence(p);`.
  It is durable (survives restart), needs **zero external services**, and is backed by the native
  `better-sqlite3` addon — which in a packaged Electron app must be ABI-rebuilt for Electron and
  added to `asarUnpack`.
- **H4** made `WorkflowHost.stop()` return `Promise<void>` and perform a graceful drain: stop
  intake, await in-flight executions up to `gracefulShutdownTimeoutMs` (default `30000`), then
  resolve. It handles `SIGTERM`/`SIGINT`, and is explicitly designed to be awaited from an Electron
  `app.on('before-quit')` handler.

## 2. Goal

After this item, the repository **documents the step-body execution-model contract** (step bodies
must be `async`/IO-bound and must never block the event loop; long CPU work must be offloaded) in a
new guide, and ships a **working Electron sample** that runs the `WorkflowHost` in an Electron
`utilityProcess` — entirely off the main and renderer threads — persisting with the C2
`SqlitePersistence` provider and shutting down via H4's awaited `host.stop()` on `app.on('before-quit')`.
A developer reading the guide understands *why* a blocking step is dangerous and *how* to host the
engine so a CPU-heavy step can never freeze the UI. There is **little or no core code change**: this
is guidance + a sample, plus at most one small, defensive affordance (see §5) to guarantee the host
is constructible off the main thread.

## 3. Out of scope

The implementer MUST NOT:

- Change how steps execute. Do **not** add a thread pool, worker pool, `worker_threads` offloading,
  `Piscina`, or any automatic CPU-offload mechanism inside the engine. `WorkflowExecutor.execute`
  and `body.run(stepContext)` (`core/src/services/workflow-executor.ts:76`) stay exactly as they are.
- Change the `StepBody` contract / `core/src/abstractions/step-body.ts`. Its signature
  (`run(context): Promise<ExecutionResult>`) is unchanged.
- Change any provider, the C2 SQLite provider source, or any `IPersistenceProvider`/
  `IDistributedLockProvider`/`IQueueProvider` interface.
- Change H4's `stop()`/drain behaviour or signatures. The sample *consumes* H4; it does not modify it.
- Add Electron, `electron-builder`, or `better-sqlite3` as dependencies of `core/` or of any
  `providers/*` package. They belong only to the new sample package.
- Add a CI job that builds/runs Electron (Electron UI in CI is heavy and explicitly out of scope —
  verification of the sample is manual per §8, plus a headless unit-testable affordance).
- Touch the existing samples under `samples/node.js/javascript/**` or
  `samples/node.js/typescript/**`. The new sample is additive in a new directory.
- Modify `docs/upgrade-plan.md` status table beyond flipping the M3 row to reflect progress (the
  reviewer may do this; the implementer should not invent new rows).

## 4. Files to create / modify

> Exhaustive. Every path. The sample mirrors the layout/conventions of the existing TypeScript
> samples under `samples/node.js/typescript/` but adds the Electron host/renderer/preload structure.

| Path | Action | Why |
|---|---|---|
| `docs/electron-integration.md` | **create** | The execution-model contract + the off-main-thread hosting guide. Content specified in §6 and §12. |
| `README.md` | modify | Add `docs/electron-integration.md` to the **Guides** list (alongside `es2017-guide.md`, `typescript-guide.md`) and add a one-line "Desktop / Electron" note pointing at it. |
| `samples/electron/README.md` | **create** | How to install, rebuild native deps, run, and package the sample; what it demonstrates; manual verification steps (§8). |
| `samples/electron/package.json` | **create** | Sample manifest. Depends on `@reactorynet/workflow-es`, `@reactorynet/workflow-es-sqlite`, `electron`, `@electron/rebuild`, `typescript`. Scripts: `build`, `start`, `rebuild`. |
| `samples/electron/tsconfig.json` | **create** | Compiler options mirroring `samples/node.js/typescript/tsconfig.json` (`module: commonjs`, `target: es2017`), emitting to `dist/`. |
| `samples/electron/.gitignore` | **create** | Ignore `dist/`, `node_modules/`, and the runtime `*.db`/`*.db-wal`/`*.db-shm` files. |
| `samples/electron/src/main.ts` | **create** | Electron **main process**. Creates the `BrowserWindow`, spawns the engine `utilityProcess`, relays IPC between renderer and the engine process, and on `app.on('before-quit')` asks the engine process to drain and waits for confirmation. The main process does **not** import the engine. |
| `samples/electron/src/preload.ts` | **create** | `contextBridge` exposing a minimal, typed API to the renderer (`startWorkflow()`, `onWorkflowEvent()`, `runBlockingDemo()`); no Node access leaks to the renderer. |
| `samples/electron/src/engine-process.ts` | **create** | The `utilityProcess` entry. **This** is where `configureWorkflow()`, `new SqlitePersistence(...)`, `host.registerWorkflow(...)`, `host.start()` and (on shutdown) `await host.stop()` live. Communicates with main via `parentPort`/`process.parentPort` IPC. |
| `samples/electron/src/workflows/hello-workflow.ts` | **create** | A small IO-bound workflow (two async steps) used to show normal, non-blocking execution. Mirrors `samples/node.js/typescript/01-hello-world.ts` shape. |
| `samples/electron/src/workflows/cpu-heavy-step.ts` | **create** | A deliberately CPU-heavy `StepBody` (busy-loop for a fixed duration) plus a workflow that uses it — used to *demonstrate* that, because the host runs in the `utilityProcess`, the UI stays responsive while this step burns CPU. The guide references this as the cautionary example. |
| `samples/electron/src/renderer/index.html` | **create** | Minimal UI: buttons "Start hello workflow", "Run CPU-heavy workflow", a spinner/clock that visibly keeps animating, and a log pane. Proves UI responsiveness during the CPU-heavy run. |
| `samples/electron/src/renderer/renderer.ts` | **create** | Renderer script wiring the buttons to the preload API and rendering engine events + the always-animating clock. |
| `samples/electron/spec/engine-process.contract.spec.ts` | **create** | Headless unit test of the **affordance** in §5 and the engine bootstrap: that the host module can be constructed and started **without** any Electron/main-thread global present, and `await host.stop()` resolves. This is the automated portion of §8 (no Electron runtime needed). |
| `samples/electron/spec/support/jasmine.json` | **create** | Jasmine config, identical in shape to `providers/workflow-es-postgres/spec/support/jasmine.json`, so `yarn test` runs the contract spec. |

> Cross-reference: C2's README §10 already notes "Off-main-thread hosting (cross-ref M3) … is M3's
> deliverable, not C2's." This spec is that deliverable.

## 5. Interface & data-model changes

**Core API change: essentially None.** This is a documentation + sample item. The executor, the
`StepBody` contract, all models, and all DI bindings are unchanged.

### Small defensive affordance (the *only* permitted core touch)

The sample requires that `WorkflowHost` is **constructible and startable off the main thread**
(inside a `utilityProcess`/`worker_thread`), i.e. the engine must not depend on any main-thread- or
renderer-only global (`window`, `document`, Electron `app`, the DOM). A grep confirms the host today
references only `process.on('SIGINT', …)` (`core/src/services/workflow-host.ts:179`) and no
browser/Electron globals — so **no change is required to make it constructible off-thread**.

The implementer MUST verify this and only act if the verification fails:

```bash
grep -rnE "\\bwindow\\b|\\bdocument\\b|require\\(['\"]electron|globalThis\\.(window|document)" core/src
# Expected: no matches. If any match exists in a code path reachable from
# WorkflowHost construction/start, guard it behind a typeof check so the host
# does not throw when those globals are absent (the worker/utilityProcess case).
```

If — and only if — a reachable main-thread-only global is found, wrap its access in a
`typeof X !== "undefined"` guard. Do not add config, do not add new methods. If the grep is clean
(the expected case), make **zero** core changes and record "no core change required" in the PR.

```ts
// BEFORE / AFTER for core: identical — no signature changes.
// (Documented here only to make the no-op explicit for the reviewer.)
```

### DI / config impact

None. `configureWorkflow()`, `WorkflowConfig`, and `TYPES` are unchanged. The sample uses the
**existing** H4 config knob `gracefulShutdownTimeoutMs` only via its default.

### Persisted / at-rest format impact

None. The sample uses C2's `SqlitePersistence` as-is; no schema or format change.

## 6. Behavioural contract (numbered rules)

> These are the rules the **documentation** must state and the **sample** must demonstrably satisfy.
> Rules 1–4 are the documented contract (verified by review of `docs/electron-integration.md`);
> rules 5–9 are properties of the sample (verified per §8).

1. **Step bodies must be asynchronous and IO-bound.** `docs/electron-integration.md` MUST state that
   `StepBody.run` returns a `Promise` and that the engine `await`s it inline on the host event loop
   (cite `core/src/services/workflow-executor.ts:76`). It MUST state that while one step's `run` is
   executing synchronously, **no other workflow on that node makes progress** and the H4 drain
   cannot proceed.

2. **A step body MUST NOT block the event loop.** The guide MUST forbid long synchronous CPU work,
   long synchronous IO, and busy-waiting inside `run`. It MUST give the offloading remedies:
   (a) `await` real async IO; (b) for unavoidable CPU work, offload to a `worker_threads` Worker /
   `Piscina` / a child process and `await` the result inside `run`; (c) chunk + `await` yields for
   large iterative work. The guide MUST include a **bad example** (synchronous busy loop —
   referencing `samples/electron/src/workflows/cpu-heavy-step.ts`) and a **good example** (the same
   work `await`ed off-thread).

3. **The engine is single-event-loop per host; scale by hosting, not by threading inside a step.**
   The guide MUST state that the supported way to keep an interactive (Electron) app responsive is
   to run the **whole host** off the UI thread — not to spawn threads from inside step bodies for
   ordinary work. The recommended Electron pattern is an **Electron `utilityProcess`** (a Node
   execution context, not a renderer), with `worker_threads` documented as the alternative for
   non-Electron Node hosts (see §12 for the rationale of this choice).

4. **Graceful shutdown is the consumer's responsibility on quit.** The guide MUST state that an
   Electron app MUST `await host.stop()` (H4) before the process exits, driven from
   `app.on('before-quit')` (or relayed to the engine process), and that `stop()` drains in-flight
   executions up to `gracefulShutdownTimeoutMs` (default 30000). It MUST note that a blocking step
   (rule 2) can *prevent* the drain from completing within the timeout.

5. **The sample runs the host OFF the main/renderer thread.** In the sample, `configureWorkflow()`,
   `host.start()`, `host.registerWorkflow(...)`, and `host.startWorkflow(...)` execute **only**
   inside `samples/electron/src/engine-process.ts`, which runs as an Electron `utilityProcess`.
   `samples/electron/src/main.ts` MUST NOT import `@reactorynet/workflow-es` or the SQLite provider,
   and the renderer MUST NOT either (it talks to the engine only through the preload IPC bridge).

6. **The sample uses C2 SQLite persistence.** `engine-process.ts` MUST construct
   `new SqlitePersistence(path)` where `path = path.join(app.getPath("userData"), "workflow.db")`
   passed in from main (the engine process does not call Electron `app` directly), `await persistence.connect`,
   then `config.usePersistence(persistence)`. The DB path MUST be a writable user-data location, not
   inside the app bundle. `:memory:` is used **only** in the §8 unit test, never in the running app.

7. **The sample demonstrates graceful drain on quit (H4).** `main.ts` MUST handle
   `app.on('before-quit')` by (a) preventing the immediate quit (`event.preventDefault()` once),
   (b) signalling the engine `utilityProcess` to drain, (c) the engine process running
   `await host.stop()` and posting a "drained" message back, then (d) main allowing the quit /
   killing the now-idle engine process and quitting. The handler MUST be idempotent (a second
   `before-quit` while already draining must not double-trigger).

8. **UI responsiveness is observable.** Because the host runs in the `utilityProcess`, triggering
   the CPU-heavy workflow (rule 2's bad example) MUST NOT freeze the renderer: the always-animating
   clock/spinner in `renderer/index.html` keeps updating while the CPU-heavy step burns its loop.
   This is the headline manual-verification observation (§8).

9. **No engine code runs in the renderer; no Node leaks to the renderer.** `preload.ts` MUST use
   `contextBridge.exposeInMainWorld` to expose only a small typed surface
   (`startHello()`, `runCpuHeavy()`, `onLog(cb)`); the renderer MUST run with `contextIsolation: true`
   and `nodeIntegration: false`.

## 7. Provider parity

No core interface change; no provider impact. (Per §5 the only possible core touch is a defensive
`typeof` guard that, by grep, is expected to be unnecessary — and even if applied, changes no
interface.) `IPersistenceProvider`, `IDistributedLockProvider`, and `IQueueProvider` are untouched.

| Provider | Change required |
|---|---|
| memory | None |
| sqlite (C2) | None — consumed by the sample as-is |
| postgres | None |
| mongodb | None |
| mysql | None |
| redis | None |
| azure | None |

## 8. Test plan (TDD)

Electron UI cannot be reasonably driven in CI, so acceptance is **(a)** one headless, automated
unit test that proves the off-main-thread affordance, plus **(b)** a documented manual verification
procedure for the full Electron sample. The automated test is the failing-test-first.

### Failing-test-first (automated, headless — no Electron runtime)

- **`engine-process.contract.spec.ts › constructs and starts the host with no main-thread globals`**
  — *arrange:* in a plain Node/Jasmine process, assert `typeof window === "undefined"` and
  `typeof document === "undefined"` (proving we are off any DOM/main thread); build a host via
  `configureWorkflow()` + `usePersistence(new SqlitePersistence(":memory:"))` (after `await connect`),
  register the sample `hello-workflow`. *act:* `await host.start()`, `await host.startWorkflow("hello", 1, null)`,
  spin-wait for completion using the repo's **`spinWait`** helper (the pattern used in
  `core/spec/scenarios/**`), then `await host.stop()`. *assert:* the workflow reached `Complete` and
  `stop()` resolved without throwing. **Before any sample code exists this test cannot compile/run —
  it is red first.** It proves rules §6.5 and §6.6 in a headless context (the host is fully usable
  with no Electron/main-thread globals present, which is exactly what running inside a
  `utilityProcess` requires).

### Coverage

- **`engine-process.contract.spec.ts › stop() is idempotent and awaitable`** — *arrange:* start the
  host as above. *act:* call `await host.stop()` twice. *assert:* both resolve; the second resolves
  immediately; no unhandled rejection. (Proves §6.7's drain is awaitable/idempotent at the engine
  level — the part of rule 7 that does not require Electron.)

- **`engine-process.contract.spec.ts › a CPU-heavy step still completes (off the test's critical path)`**
  — *arrange:* register the `cpu-heavy` workflow with a **short** busy duration (e.g. 200ms).
  *act:* start it and `spinWait` for completion. *assert:* it reaches `Complete`. (Documents rule
  §6.2's example mechanically; the *UI-responsiveness* aspect of §6.8 is the manual step below.)

### Manual verification (the Electron sample — documented in `samples/electron/README.md`)

A numbered, reproducible procedure (no automation required):

1. `cd samples/electron && yarn install && yarn rebuild` (rebuilds `better-sqlite3` for Electron's
   ABI via `@electron/rebuild` — C2's native-rebuild requirement).
2. `yarn build && yarn start` launches the app.
3. Click **Start hello workflow** → the log pane shows the two steps run and the workflow completes;
   confirm a `workflow.db` file appears under the OS user-data directory (proves §6.6 durability path).
4. Click **Run CPU-heavy workflow** → **observe the on-screen clock/spinner keeps animating** the
   whole time the CPU-heavy step runs (proves §6.5 + §6.8: the burn happens in the `utilityProcess`,
   not the renderer/main thread).
5. Quit the app (Cmd/Ctrl-Q or close) **while a workflow is mid-flight** → the app does not exit
   instantly; the engine logs a drain and then the app quits cleanly (proves §6.4 + §6.7). Relaunch
   → any workflow that was mid-flight resumes from the SQLite file (proves C2 durability end-to-end
   under M3's hosting).

### How to run

```bash
# Automated (CI-safe, headless) part:
cd samples/electron && yarn install && yarn test     # runs engine-process.contract.spec.ts

# Manual Electron verification (developer machine, not CI):
cd samples/electron && yarn rebuild && yarn build && yarn start
# then follow the 5-step procedure in samples/electron/README.md
```

## 9. Acceptance criteria (binary)

- [ ] `docs/electron-integration.md` exists and documents the step-body contract (rules §6.1–§6.4),
      including the bad/good CPU-offload examples and the `utilityProcess`-vs-`worker_threads`
      guidance.
- [ ] `README.md` **Guides** list links `docs/electron-integration.md`.
- [ ] `cd samples/electron && yarn install && yarn build` succeeds (TypeScript compiles for main,
      preload, engine-process, renderer).
- [ ] `cd samples/electron && yarn test` passes on Node 20 + 22: the contract spec is green,
      including the failing-test-first (`constructs and starts the host with no main-thread globals`)
      and the idempotent-`stop()` test.
- [ ] Static check: `grep -nE "@reactorynet/workflow-es" samples/electron/src/main.ts samples/electron/src/renderer/renderer.ts`
      returns **no matches** (engine is imported only by `engine-process.ts` — proves §6.5).
- [ ] Static check: `samples/electron/src/preload.ts` uses `contextBridge.exposeInMainWorld` and the
      `BrowserWindow` in `main.ts` is created with `contextIsolation: true`, `nodeIntegration: false`
      (proves §6.9).
- [ ] `cd core && yarn build && yarn test` still pass unchanged (this item adds no core behaviour;
      if the §5 grep was clean, the core diff is empty).
- [ ] Manual procedure in `samples/electron/README.md` is followed once and the §8 observations hold
      (clock keeps animating during CPU-heavy run; quit drains; restart resumes). Reviewer records
      this in the PR.

## 10. Backward compatibility & migration

No public API change, no on-disk format change, no provider change. **No version bump for `core`**
(C1 owns the `2.3.6-reactory.3 → -reactory.4` bump; C2 ships the SQLite package). The new
`samples/electron` package is private (`"private": true`, never published) and is purely additive.
`reactory-express-server` (the `file:` tarball consumer) is **unaffected** — it gains a new guide and
a sample, nothing it depends on changes. Adopting the pattern is opt-in: a consumer wanting
desktop responsiveness moves its host into a `utilityProcess`/`worker_thread` following the guide.

## 11. Definition of Done

The repository documents the workflow execution model — step bodies run inline on the host event
loop, so they must be async/IO-bound and must never block, with explicit offloading guidance — in a
new `docs/electron-integration.md` linked from the README, and ships a private, working Electron
sample under `samples/electron/` that hosts `WorkflowHost` in an Electron `utilityProcess` (off the
main and renderer threads), persists with the C2 `SqlitePersistence` provider in the user-data
directory, and drains gracefully via H4's awaited `host.stop()` on `app.on('before-quit')`. The
engine is imported only by the engine process; the renderer stays responsive while a CPU-heavy step
runs (manually verified); and a headless contract spec proves the host constructs, runs a workflow,
and stops cleanly with no main-thread globals present, passing on Node 20 + 22. Core has no
behavioural change (and an empty diff if the §5 affordance grep is clean, which is expected).

## 12. Implementation notes (optional, non-binding)

### Decision: Electron `utilityProcess` (primary) vs `worker_threads` (documented alternative)

The sample's off-thread host runs in an **Electron `utilityProcess`**, with `worker_threads`
documented as the alternative for non-Electron Node hosts. Rationale:

| Criterion | `utilityProcess` (chosen for the Electron sample) | `worker_threads` |
|---|---|---|
| Electron support | First-class Electron API (`utilityProcess.fork`) purpose-built for hosting Node code outside main/renderer; integrates with Electron's process lifecycle and `MessagePort` IPC. | Standard Node API; works inside Electron but is not Electron's blessed model for long-lived service processes. |
| Native addons (C2 `better-sqlite3`) | Runs in a full, separate Node-context process — `better-sqlite3` loads exactly as in plain Node; simplest rebuild/`asarUnpack` story. | Native addons can run in a worker but add ABI/threading caveats; more failure modes for a sample. |
| Isolation from UI freeze | True separate OS process — a busy loop cannot stall the main/renderer event loop. | Separate thread in the *same* process — also avoids blocking the UI loop, but shares the process. |
| Lifecycle / drain (H4) | Clean: main relays `before-quit` → engine process `await host.stop()` → posts "drained" → main quits. | Workable via `postMessage`, but process-level lifecycle maps more naturally to `utilityProcess`. |

**Chosen: `utilityProcess`** for the Electron sample because (1) the deliverable is explicitly an
*Electron* sample and `utilityProcess` is Electron's first-class mechanism for exactly this, (2) the
C2 dependency `better-sqlite3` is a native addon whose simplest, lowest-risk hosting is a full Node
process context, and (3) the H4 drain-on-quit handshake maps cleanly onto process IPC. The guide
documents `worker_threads`/`Piscina` as the right tool for **offloading CPU work from inside a single
step** (rule §6.2) and as the alternative host for **non-Electron** Node services. These are
complementary, not competing: `utilityProcess` hosts the *engine*; `worker_threads` offloads *CPU
within a step*.

### Hints

- Mirror `samples/node.js/typescript/01-hello-world.ts` for the workflow/step shape, but import from
  `@reactorynet/workflow-es` (not the legacy `"workflow-es"` string the old samples still use).
- The engine process is a normal Node entry; reach IPC via `process.parentPort` (the
  `utilityProcess` child side) and `child.postMessage` / `child.on('message', …)` on the main side.
- Pass `app.getPath("userData")` from main → engine over the initial IPC message; do **not** import
  `electron` inside `engine-process.ts`.
- For the contract spec, follow an existing scenario in `core/spec/scenarios/**` for the `spinWait`
  usage pattern and Jasmine layout; copy `providers/workflow-es-postgres/spec/support/jasmine.json`
  for the runner config.
- C2 README already documents `@electron/rebuild` + `asarUnpack`; the sample README should link to
  it rather than restate the whole packaging story.
- Upstream `danielgerlag/workflow-es` has no off-thread/Electron pattern — this is net-new for the
  fork; there is no upstream equivalent to copy.
