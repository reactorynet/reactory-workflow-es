/**
 * engine-process.ts — Electron utilityProcess entry point.
 *
 * This module runs INSIDE the utilityProcess, completely isolated from the
 * Electron main and renderer processes. It owns the WorkflowHost lifecycle:
 *
 *   1. Receives an "init" message from main with the userData path.
 *   2. Constructs the persistence provider using that path.
 *   3. Registers workflows and starts the host.
 *   4. Handles "startWorkflow" commands, relaying workflow IDs back.
 *   5. On "drain", calls await host.stop() and posts "drained" back to main.
 *
 * Invariant: this file is the ONLY place that imports @reactorynet/workflow-es
 * (or @reactorynet/workflow-es-sqlite). Neither main.ts nor the renderer ever
 * touch those packages.
 *
 * ---- PRODUCTION SETUP WITH SQLITE (C2 provider) ----------------------------
 * In a real Electron app, replace MemoryPersistenceProvider with SqlitePersistence:
 *
 *   import { SqlitePersistence } from "@reactorynet/workflow-es-sqlite";
 *   // In the "init" handler:
 *   const dbPath = path.join(msg.userData, "workflow.db");
 *   const persistence = new SqlitePersistence(dbPath);
 *   await persistence.connect;
 *
 * Then add @reactorynet/workflow-es-sqlite to package.json dependencies and run
 * `yarn rebuild` to rebuild the native sqlite3 addon for the Electron ABI.
 * See providers/workflow-es-sqlite/README.md §Electron packaging notes and
 * samples/electron/README.md for the full setup procedure.
 * -----------------------------------------------------------------------------
 */
import "reflect-metadata";
import * as path from "path";
import {
    configureWorkflow,
    IWorkflowHost,
    MemoryPersistenceProvider,
} from "@reactorynet/workflow-es";
import { HelloWorkflow } from "./workflows/hello-workflow";
import { CpuHeavyWorkflow } from "./workflows/cpu-heavy-step";

// ----- IPC message types (shared by engine-process <-> main) ----------------

interface InitMessage       { type: "init";          userData: string }
interface StartWorkflowMsg  { type: "startWorkflow"; workflow: string; durationMs?: number }
interface DrainMessage      { type: "drain" }

type IncomingMessage = InitMessage | StartWorkflowMsg | DrainMessage;

// --------- Engine state -------------------------------------------------------

let host: IWorkflowHost | null = null;
let draining = false;

// --------- IPC receive --------------------------------------------------------

// process.parentPort is the utilityProcess child-side MessagePort.
// It is typed in Electron's type declarations as `Electron.ParentPort`.
const parentPort = (process as NodeJS.Process & {
    parentPort: {
        on: (event: "message", handler: (evt: { data: unknown }) => void) => void;
        postMessage: (msg: unknown) => void;
    };
}).parentPort;

parentPort.on("message", async (evt: { data: unknown }) => {
    const msg = evt.data as IncomingMessage;

    switch (msg.type) {

        case "init": {
            try {
                // -----------------------------------------------------------------
                // PRODUCTION: replace with SqlitePersistence for durable storage.
                // See the module-level comment for the SqlitePersistence setup.
                // The userData path is passed in from main to avoid importing electron.
                // -----------------------------------------------------------------
                void path.join(msg.userData, "workflow.db"); // path is available for SqlitePersistence
                log(`Initialising with userData=${msg.userData}`);
                log("Using MemoryPersistenceProvider (replace with SqlitePersistence for production)");

                const persistence = new MemoryPersistenceProvider();

                const config = configureWorkflow();
                config.usePersistence(persistence);

                host = config.getHost();
                host.registerWorkflow(HelloWorkflow);
                host.registerWorkflow(CpuHeavyWorkflow);

                await host.start();
                log("WorkflowHost started");
                parentPort.postMessage({ type: "ready" });
            } catch (err) {
                parentPort.postMessage({ type: "error", error: String(err) });
            }
            break;
        }

        case "startWorkflow": {
            if (!host) {
                parentPort.postMessage({ type: "error", error: "Host not initialised" });
                return;
            }
            try {
                const data = msg.durationMs !== undefined ? { durationMs: msg.durationMs } : null;
                const id = await host.startWorkflow(msg.workflow, 1, data);
                log(`Started workflow "${msg.workflow}" → id=${id}`);
                parentPort.postMessage({ type: "started", workflow: msg.workflow, id });
            } catch (err) {
                parentPort.postMessage({ type: "error", error: String(err) });
            }
            break;
        }

        case "drain": {
            if (draining) return;   // idempotent
            draining = true;
            log("Draining WorkflowHost…");
            try {
                if (host) {
                    // host.stop() returns void in the current core implementation.
                    // In the enterprise-upgraded branch (H4) it returns Promise<void>
                    // and performs a true graceful drain. Either way, awaiting it is safe.
                    await host.stop();
                }
                log("Drain complete");
                parentPort.postMessage({ type: "drained" });
            } catch (err) {
                // Even on error, notify main so the app can quit.
                log(`Drain error (notifying main anyway): ${err}`);
                parentPort.postMessage({ type: "drained" });
            }
            break;
        }

        default:
            log(`Unknown message type: ${(msg as { type: string }).type}`);
    }
});

function log(msg: string): void {
    console.log(`[engine-process] ${msg}`);
    // Forward log lines to main so the renderer can display them.
    parentPort.postMessage({ type: "log", message: `[engine] ${msg}` });
}
