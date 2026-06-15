# Electron integration guide — `@reactorynet/workflow-es`

This guide explains the workflow engine's execution model, why a CPU-heavy step is
dangerous in an Electron application, and how to host the engine **off the main and
renderer threads** using an Electron `utilityProcess`. It accompanies the working
sample in [`samples/electron/`](../samples/electron/).

---

## 1. Execution model contract

### 1.1 Step bodies run inline on the host event loop

Every step body is an instance of the abstract class `StepBody`:

```ts
// core/src/abstractions/step-body.ts
@injectable()
export abstract class StepBody {
    public abstract run(context: StepExecutionContext): Promise<ExecutionResult>;
}
```

The engine executes each step by calling `body.run(stepContext)` **inline, on the
event loop of the host process** and `await`ing the resulting promise
(`core/src/services/workflow-executor.ts:76`):

```ts
// core/src/services/workflow-executor.ts (line 76) — do not change
let stepResult = await body.run(stepContext);
```

There is **no thread pool, no process pool, and no automatic CPU offloading**. The
engine is single-event-loop per `WorkflowHost` instance. The `await` yields the loop
while an IO operation is outstanding (network call, disk read, timer), but while
`run()` is executing synchronously the event loop is fully blocked.

**Consequence:** while one step's `run` is executing synchronously, **no other
workflow on that node makes progress**, the poll worker cannot fire, the queue worker
cannot pull new work, and the H4 graceful drain (`host.stop()`) cannot make progress.

### 1.2 Step bodies MUST NOT block the event loop

A step body **must** be asynchronous and IO-bound. The following are forbidden inside
`StepBody.run`:

- Long synchronous CPU computation (image processing, crypto over a large buffer,
  a tight busy-loop, large `JSON.parse`/`JSON.stringify` over huge objects).
- Synchronous disk IO (`fs.readFileSync`, `fs.writeFileSync`).
- Busy-waiting (`while (Date.now() < deadline) {}`).
- Any call that blocks the Node.js event loop for more than a few milliseconds.

#### Bad example (blocks the event loop — referencing `samples/electron/src/workflows/cpu-heavy-step.ts`)

```ts
class CpuHeavyStep extends StepBody {
    public run(context: StepExecutionContext): Promise<ExecutionResult> {
        // BAD: synchronous busy-loop blocks the entire event loop until done.
        // No other workflow can make progress; the H4 drain is stuck; in Electron,
        // the UI freezes if this runs in the main or renderer process.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) { /* burn */ }
        return ExecutionResult.next();
    }
}
```

#### Good examples (IO-bound / offloaded)

```ts
// GOOD — real async IO: the event loop is free while the network call is outstanding.
class FetchStep extends StepBody {
    public async run(context: StepExecutionContext): Promise<ExecutionResult> {
        const res = await fetch("https://api.example.com/data");
        context.persistenceData.result = await res.json();
        return ExecutionResult.next();
    }
}

// GOOD — CPU-heavy work offloaded to a worker_threads Worker via Piscina.
// The event loop is free while the worker burns CPU; only the Worker thread blocks.
import Piscina from "piscina";
const pool = new Piscina({ filename: "./heavy-worker.js" });

class OffloadedCpuStep extends StepBody {
    public async run(context: StepExecutionContext): Promise<ExecutionResult> {
        // await suspends the event loop participation until the worker resolves.
        const result = await pool.run({ input: context.persistenceData.input });
        context.persistenceData.result = result;
        return ExecutionResult.next();
    }
}

// GOOD — large iterative work chunked with yielding to the event loop between chunks.
class ChunkedStep extends StepBody {
    public async run(context: StepExecutionContext): Promise<ExecutionResult> {
        const items: number[] = context.persistenceData.items;
        const chunkSize = 1000;
        for (let i = 0; i < items.length; i += chunkSize) {
            processChunk(items.slice(i, i + chunkSize));
            await new Promise(resolve => setImmediate(resolve)); // yield
        }
        return ExecutionResult.next();
    }
}
```

### 1.3 Scale by hosting, not by threading inside a step

The supported way to keep an interactive (Electron) app responsive is to run the
**whole `WorkflowHost`** off the UI thread — not to spawn threads from inside step
bodies for ordinary IO-bound work.

For CPU-heavy work that truly cannot be made IO-bound, the remedy is to offload
that work to a `worker_threads` Worker or a `Piscina` pool **from inside the step
body's `run` method** (see §1.2 good examples), so that the step body itself is still
`async` and yields the event loop.

Two hosting patterns are documented below. They are **complementary, not competing**:
`utilityProcess` hosts the *engine*; `worker_threads`/Piscina offloads *CPU within a step*.

### 1.4 Graceful shutdown is the consumer's responsibility

An Electron app **must** `await host.stop()` before the process exits. `host.stop()`
performs a graceful drain (H4): it stops intake, awaits all in-flight step executions
up to `gracefulShutdownTimeoutMs` (default `30000` ms), then resolves.

This drain must be driven from `app.on('before-quit')` (or relayed to the engine
process when using `utilityProcess` — see §3).

> **Warning:** a blocking step (rule §1.2) prevents the drain from completing within
> the timeout. If `host.stop()` times out, in-flight workflows may be left in an
> incomplete state. With the C2 `SqlitePersistence` provider they will resume from the
> last completed step on next launch — but incomplete in-flight work is lost.

---

## 2. Why Electron needs off-thread hosting

Electron applications have two classes of thread where workflow execution is
particularly dangerous:

| Thread | Hosts | Risk of a blocking step |
|---|---|---|
| **Main process** | Windows, menus, IPC, tray, `app` lifecycle | App becomes unresponsive; OS may show a "spinning beachball" / "not responding" indicator |
| **Renderer process** | The web UI (Chromium) | The UI freezes; animations stop; user input is dropped |

A blocking step running in either of these threads freezes the entire application, not
just the workflow engine.

The solution is to run the `WorkflowHost` in a **separate execution context** that
does not share an event loop with the main or renderer process.

---

## 3. Recommended pattern: Electron `utilityProcess`

**`utilityProcess`** is Electron's first-class API for hosting Node.js code outside
the main and renderer processes. It runs in a separate OS process with its own V8
isolate and event loop, communicates with the main process via `MessagePort` IPC, and
has access to all Node.js APIs (including native addons like `sqlite3`).

### Why `utilityProcess` over `worker_threads` for this pattern

| Criterion | `utilityProcess` | `worker_threads` |
|---|---|---|
| Electron support | First-class Electron API, purpose-built for hosting services | Standard Node API; works but not Electron's blessed model for long-lived services |
| Native addons (`sqlite3`) | Runs in a full, separate Node process — loads exactly as in plain Node | Adds ABI/threading caveats for native addons |
| Isolation from UI freeze | True separate OS process — a busy loop cannot stall main/renderer event loop | Separate thread in the *same* process — less isolation |
| H4 drain on quit | Maps cleanly: main relays `before-quit` → engine process `await host.stop()` → posts "drained" | Workable via `postMessage`, but lifecycle maps more naturally to a process |

For **non-Electron Node.js** services (e.g. a plain Node server or a unit test
harness), `worker_threads` is the appropriate alternative to run the host off the main
thread. The API surface and step-body contract are identical in both cases.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Main process (Electron)                            │
│  ┌──────────────────┐   MessagePort IPC             │
│  │  main.ts         │◄──────────────────────────────┤
│  │  BrowserWindow   │                               │
│  │  app lifecycle   │                               │
│  └─────────┬────────┘                               │
│            │ contextBridge / IPC                    │
│  ┌─────────▼────────┐                               │
│  │  preload.ts      │                               │
│  └─────────┬────────┘                               │
│            │ window.workflowAPI                     │
│  ┌─────────▼────────┐                               │
│  │  renderer        │  (contextIsolation: true,     │
│  │  index.html      │   nodeIntegration: false)     │
│  └──────────────────┘                               │
├─────────────────────────────────────────────────────┤
│  utilityProcess (separate OS process)               │
│  ┌──────────────────────────────────────────────┐   │
│  │  engine-process.ts                           │   │
│  │  WorkflowHost + SqlitePersistence            │   │
│  │  host.start() / host.stop()                  │   │
│  │  step bodies execute here                    │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Key invariant:** `@reactorynet/workflow-es` is imported **only** by
`engine-process.ts`. Neither `main.ts` nor the renderer script ever import the engine
or the SQLite provider.

### 3.1 Engine process (`engine-process.ts`)

The engine process receives its configuration (DB path, initial commands) from the
main process over `process.parentPort` IPC. It does **not** import `electron` — it is
a plain Node.js module. It constructs `SqlitePersistence`, registers workflows, starts
the host, and listens for commands:

```ts
// samples/electron/src/engine-process.ts (abbreviated — see full sample)
import "reflect-metadata";
import * as path from "path";
import { configureWorkflow } from "@reactorynet/workflow-es";
import { SqlitePersistence } from "@reactorynet/workflow-es-sqlite";
import { HelloWorkflow } from "./workflows/hello-workflow";
import { CpuHeavyWorkflow } from "./workflows/cpu-heavy-step";

let host: ReturnType<ReturnType<typeof configureWorkflow>["getHost"]> | null = null;

process.parentPort!.on("message", async (evt: Electron.MessageEvent) => {
    const msg = evt.data as { type: string; [key: string]: unknown };

    if (msg.type === "init") {
        // DB path is passed in from main — the engine process does NOT call electron.app.
        const dbPath = path.join(msg.userData as string, "workflow.db");
        const persistence = new SqlitePersistence(dbPath);
        await persistence.connect;

        const config = configureWorkflow();
        config.usePersistence(persistence);
        host = config.getHost();
        host.registerWorkflow(HelloWorkflow);
        host.registerWorkflow(CpuHeavyWorkflow);
        await host.start();
        process.parentPort!.postMessage({ type: "ready" });
    }

    if (msg.type === "startWorkflow") {
        const id = await host!.startWorkflow(msg.workflow as string, 1, null);
        process.parentPort!.postMessage({ type: "started", id });
    }

    if (msg.type === "drain") {
        await host!.stop();
        process.parentPort!.postMessage({ type: "drained" });
    }
});
```

### 3.2 Main process (`main.ts`)

The main process spawns the engine as a `utilityProcess`, passes `app.getPath("userData")`
so the engine can construct the DB path, and relays the `before-quit` drain handshake.
**It does not import `@reactorynet/workflow-es`.**

```ts
// samples/electron/src/main.ts (abbreviated — see full sample)
import { app, BrowserWindow, utilityProcess, ipcMain } from "electron";
import * as path from "path";

let engineProcess: Electron.UtilityProcess | null = null;
let draining = false;

function startEngine() {
    engineProcess = utilityProcess.fork(
        path.join(__dirname, "engine-process.js")
    );
    engineProcess.on("message", (msg: { type: string }) => {
        if (msg.type === "ready") {
            mainWindow?.webContents.send("engine:ready");
        }
        if (msg.type === "drained") {
            engineProcess?.kill();
            app.quit();
        }
    });
    engineProcess.postMessage({ type: "init", userData: app.getPath("userData") });
}

app.on("before-quit", (event) => {
    if (draining) return;          // idempotent — a second before-quit is ignored
    draining = true;
    event.preventDefault();        // hold the quit until the drain completes
    engineProcess?.postMessage({ type: "drain" });
});
```

### 3.3 Preload script (`preload.ts`)

The preload uses `contextBridge` to expose a minimal, typed surface to the renderer.
**No Node.js API leaks to the renderer.**

```ts
// samples/electron/src/preload.ts (abbreviated)
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("workflowAPI", {
    startHello:   () => ipcRenderer.invoke("engine:startHello"),
    runCpuHeavy:  () => ipcRenderer.invoke("engine:runCpuHeavy"),
    onLog:        (cb: (msg: string) => void) => {
        ipcRenderer.on("engine:log", (_e, msg) => cb(msg));
    },
});
```

The `BrowserWindow` is created with:

```ts
new BrowserWindow({
    webPreferences: {
        contextIsolation: true,    // required — no shared context between preload and renderer
        nodeIntegration:  false,   // required — no Node access in the renderer
        preload:          path.join(__dirname, "preload.js"),
    },
});
```

### 3.4 Native module rebuild (`sqlite3`)

The `sqlite3` driver is a native addon. In a packaged Electron app it must be rebuilt
against Electron's V8 ABI. The sample includes a `rebuild` script:

```bash
cd samples/electron
yarn install
yarn rebuild    # runs @electron/rebuild for the Electron version in use
yarn build      # tsc → dist/
yarn start      # electron dist/main.js
```

For a packaged app, add to your `electron-builder` config:

```jsonc
{
  "asarUnpack": ["**/node_sqlite3.node"]
}
```

See also the C2 SQLite provider README §Electron packaging notes for the full rebuild
and ASAR story.

---

## 4. Alternative: `worker_threads` (non-Electron Node.js hosts)

For non-Electron Node.js services (long-running servers, CLI tools), `worker_threads`
is the appropriate alternative. The engine module is importable from a `Worker` thread
without modification — the `WorkflowHost` has no dependency on any main-thread-only
global (`window`, `document`, Electron `app`).

```ts
// host-worker.ts — run as: new Worker("./host-worker.js")
import "reflect-metadata";
import { workerData, parentPort } from "worker_threads";
import { configureWorkflow } from "@reactorynet/workflow-es";
import { SqlitePersistence } from "@reactorynet/workflow-es-sqlite";

const persistence = new SqlitePersistence(workerData.dbPath);
await persistence.connect;
const config = configureWorkflow();
config.usePersistence(persistence);
const host = config.getHost();
await host.start();
parentPort!.postMessage({ type: "ready" });

parentPort!.on("message", async (msg: { type: string }) => {
    if (msg.type === "drain") {
        await host.stop();
        parentPort!.postMessage({ type: "drained" });
    }
});
```

> **Note:** `worker_threads` also isolates the engine's event loop from the main
> thread's, so a blocking step still cannot stall the main thread. However, in Electron
> the `utilityProcess` pattern is preferred because it is a true separate process
> (stronger isolation, simpler native-addon story, cleaner lifecycle).

---

## 5. Manual verification procedure

The full procedure is documented in [`samples/electron/README.md`](../samples/electron/README.md).
In summary:

1. `cd samples/electron && yarn install && yarn rebuild && yarn build && yarn start`
2. Click **Start hello workflow** — the log pane shows both steps complete; a
   `workflow.db` file appears in the OS user-data directory.
3. Click **Run CPU-heavy workflow** — observe the on-screen clock **keeps animating**
   the whole time the CPU-heavy step runs. This proves the step executes in the
   `utilityProcess` and cannot freeze the renderer.
4. Quit while a workflow is mid-flight — the app does not exit instantly; it drains,
   then quits cleanly.
5. Relaunch — any workflow that was mid-flight resumes from the SQLite file (C2
   durability under M3 hosting).

---

## 6. Core affordance verification

Per the M3 spec, the `WorkflowHost` must be constructible and startable in a process
that has no main-thread-only globals (`window`, `document`, Electron `app`).

```bash
grep -rnE "\bwindow\b|\bdocument\b|require\(['\"]electron|globalThis\.(window|document)" core/src
# Expected: no matches.
```

Running this grep against `core/src` returns **no matches**. The host references only
`process.on('SIGINT', ...)` in `registerCleanCallbacks()` and has no browser or
Electron globals in any code path reachable from construction or `start()`. **No core
change is required.**

The automated contract spec in
[`samples/electron/spec/engine-process.contract.spec.ts`](../samples/electron/spec/engine-process.contract.spec.ts)
proves this mechanically: it asserts `typeof window === "undefined"` and
`typeof document === "undefined"`, then constructs a host with an in-memory SQLite
provider and runs a hello workflow to completion — all in a plain Node/Jasmine process
with no Electron runtime.

---

## 7. Summary

| Rule | What to do |
|---|---|
| Step bodies must be async/IO-bound | Return a `Promise`; `await` real async operations; never block synchronously |
| Do not block the event loop | No busy-loops, no synchronous disk/CPU in `run()` |
| Offload CPU work | Use `worker_threads` / Piscina / a child process from inside `run()` |
| Host the engine off the UI thread | Use `utilityProcess` (Electron) or `worker_threads` (plain Node) |
| Graceful shutdown | `await host.stop()` in `app.on('before-quit')` or the engine process drain handler |
| Persistence | Use `SqlitePersistence` (C2) for durable embedded storage; pass an absolute path in a writable directory |
