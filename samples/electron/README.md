# Electron sample — `@reactorynet/workflow-es`

This sample demonstrates how to host `WorkflowHost` **off the Electron main and
renderer threads** using an Electron `utilityProcess`, with `SqlitePersistence`
(C2) for durable embedded storage and an awaited `host.stop()` graceful drain on
`app.on('before-quit')` (H4).

> **Read first:** [`docs/electron-integration.md`](../../docs/electron-integration.md)
> — the full execution-model contract, architecture diagram, and rationale for
> choosing `utilityProcess` over `worker_threads`.

---

## What this sample demonstrates

| Feature | Where |
|---|---|
| Engine hosted in `utilityProcess` (separate OS process) | `src/engine-process.ts` |
| `SqlitePersistence` with user-data DB path | `src/engine-process.ts` |
| Graceful drain on `app.before-quit` (H4) | `src/main.ts` |
| `contextBridge` preload (no Node leaks to renderer) | `src/preload.ts` |
| Always-animating clock (responsiveness proof) | `src/renderer/index.html` |
| Deliberate CPU-heavy step (the "bad example") | `src/workflows/cpu-heavy-step.ts` |
| IO-bound hello workflow (the "good example") | `src/workflows/hello-workflow.ts` |

**Invariant checked by CI:** `main.ts` and `renderer.ts` do NOT import
`@reactorynet/workflow-es` — the engine is confined to `engine-process.ts`.

---

## Prerequisites

- Node.js 20 or 22
- yarn 4
- For the full Electron app: macOS, Windows, or Linux desktop environment

---

## Automated (headless) contract test

Runs in CI without Electron or a native-addon rebuild:

```bash
cd samples/electron
yarn install
yarn build   # tsc → dist/
yarn test    # jasmine headless — no Electron runtime needed
```

The spec (`spec/engine-process.contract.spec.ts`) asserts:

1. `typeof window === "undefined"` and `typeof document === "undefined"` — the host
   runs in a context with no main-thread or browser globals (exactly the environment
   of a `utilityProcess`).
2. A hello workflow (two async steps) starts and reaches `Complete`.
3. `await host.stop()` called twice resolves without throwing (idempotent drain).
4. A CPU-heavy (200 ms busy-loop) workflow still reaches `Complete` — documents
   the §6.2 contract mechanically.

---

## Full Electron app — setup

### 1. Install core and rebuild the native SQLite addon

The `@reactorynet/workflow-es-sqlite` provider uses the `sqlite3` native addon.
It must be rebuilt against Electron's V8 ABI before the first run:

```bash
# Build core first (needed for the file: reference to resolve)
cd ../../core && yarn install && yarn build && cd -

# Build the SQLite provider
cd ../../providers/workflow-es-sqlite && yarn install && yarn build && cd -

# Install sample deps and rebuild sqlite3 for Electron
cd samples/electron
yarn install
yarn rebuild   # runs @electron/rebuild — rebuilds sqlite3 for the Electron ABI
```

> See [providers/workflow-es-sqlite/README.md §Electron packaging notes](../../providers/workflow-es-sqlite/README.md)
> for the full ASAR + rebuild story.

### 2. Build TypeScript and start

```bash
cd samples/electron
yarn build   # tsc → dist/
yarn start   # electron dist/src/main.js
```

---

## Manual verification procedure (M3 §8)

Follow these steps on a developer machine after `yarn rebuild && yarn build && yarn start`:

### Step 1 — Hello workflow + durability check

1. Click **Start hello workflow** in the app window.
2. The log pane shows step 1 and step 2 run, and the workflow completes.
3. **Verify:** a `workflow.db` file appears in the OS user-data directory
   (`~/Library/Application Support/<app-name>/workflow.db` on macOS,
   `%APPDATA%\<app-name>\workflow.db` on Windows).
4. This proves §6.6 (SqlitePersistence + user-data path).

### Step 2 — UI responsiveness during CPU-heavy step

1. Click **Run CPU-heavy workflow (3 s burn)**.
2. **Observe the on-screen clock in the top bar.** It must keep updating every
   100 ms for the full 3 seconds while the CPU-heavy step burns.
3. If the clock freezes, the step is running in the wrong process (main or renderer).
   In the correct setup (engine in `utilityProcess`) it cannot freeze the renderer.
4. This proves §6.5 + §6.8: the busy-loop runs in the engine process, not in the
   main or renderer process.

### Step 3 — Graceful drain on quit

1. Click **Run CPU-heavy workflow** to start a long-running workflow.
2. Immediately after starting, quit the app (Cmd-Q on macOS / Alt-F4 on Windows /
   close the window).
3. **Observe:** the app does NOT exit instantly. The log pane briefly shows
   "Draining engine before quit…" and then the app quits cleanly a moment later.
4. This proves §6.4 + §6.7 (H4 graceful drain via the before-quit IPC handshake).

### Step 4 — Workflow resume after restart (C2 durability)

1. Start a workflow and quit the app **before it completes** (use the CPU-heavy
   workflow with a long duration for a larger window).
2. Relaunch the app.
3. **Observe:** the workflow that was in-flight at shutdown resumes and completes.
   The log pane shows step execution picking up from where it left off.
4. This proves the C2 `SqlitePersistence` durability contract under M3's off-thread
   hosting: state survives a restart.

---

## File structure

```
samples/electron/
├── package.json               # deps: workflow-es core; devDeps: electron, tsc, jasmine
├── tsconfig.json              # module: commonjs, target: es2017, outDir: dist/
├── .gitignore                 # dist/, node_modules/, *.db, *.db-wal, *.db-shm
├── README.md                  # this file
├── spec/
│   ├── support/
│   │   └── jasmine.json       # jasmine runner config (points at dist/spec/)
│   └── engine-process.contract.spec.ts   # headless contract tests (no Electron)
└── src/
    ├── main.ts                # Electron main process (spawns utilityProcess, no engine import)
    ├── preload.ts             # contextBridge surface (startHello, runCpuHeavy, onLog)
    ├── engine-process.ts      # utilityProcess entry — WorkflowHost + SqlitePersistence
    ├── renderer/
    │   ├── index.html         # UI: clock, buttons, log pane
    │   └── renderer.ts        # Renderer script (no Node imports; uses window.workflowAPI)
    └── workflows/
        ├── hello-workflow.ts  # IO-bound workflow (two async steps, ~50 ms each)
        └── cpu-heavy-step.ts  # Deliberate busy-loop workflow (the "bad example")
```

---

## Packaging for distribution

For a packaged app (`electron-builder`), add to your build config:

```jsonc
{
  "asarUnpack": ["**/node_sqlite3.node"]
}
```

This extracts the native `sqlite3` binary from the `app.asar` archive (native binaries
cannot be loaded from inside an asar). See the C2 README for details.

---

## Static checks (acceptance criteria from the M3 spec)

```bash
# Engine imported only by engine-process.ts — not main or renderer:
grep -nE "@reactorynet/workflow-es" src/main.ts src/renderer/renderer.ts
# Expected: no matches.

# Renderer is sandboxed:
grep -nE "contextIsolation|nodeIntegration" src/main.ts
# Expected: contextIsolation: true, nodeIntegration: false.

# preload uses contextBridge:
grep -n "contextBridge.exposeInMainWorld" src/preload.ts
# Expected: at least one match.
```
