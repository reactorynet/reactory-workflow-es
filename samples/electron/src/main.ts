/**
 * main.ts — Electron main process.
 *
 * Responsibilities:
 *   - Create the BrowserWindow with contextIsolation:true, nodeIntegration:false.
 *   - Spawn the engine as a utilityProcess (separate OS process, separate event loop).
 *   - Pass app.getPath("userData") to the engine so it can find the SQLite DB path.
 *   - Relay IPC between renderer (via ipcMain) and the engine (via utilityProcess MessagePort).
 *   - On app.on("before-quit"), ask the engine to drain (await host.stop()) and wait
 *     for the "drained" reply before allowing the quit (H4 graceful shutdown).
 *
 * INVARIANT: This file does NOT import @reactorynet/workflow-es or
 * @reactorynet/workflow-es-sqlite. The engine is entirely confined to engine-process.ts.
 */
import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import * as path from "path";

// ---- State -------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let engineProcess: Electron.UtilityProcess | null = null;
/** Set to true once we have started the before-quit drain sequence. */
let draining = false;

// ---- Engine process ----------------------------------------------------------

function startEngine(): void {
    engineProcess = utilityProcess.fork(
        path.join(__dirname, "engine-process.js"),
        [],
        { stdio: "inherit" }   // engine logs appear in main process stderr for dev
    );

    engineProcess.on("message", (msg: unknown) => {
        const m = msg as { type: string; [key: string]: unknown };

        switch (m.type) {
            case "ready":
                mainWindow?.webContents.send("engine:log", "[engine] WorkflowHost ready");
                break;

            case "started":
                mainWindow?.webContents.send(
                    "engine:log",
                    `[engine] Workflow "${m.workflow}" started — id: ${m.id}`
                );
                break;

            case "log":
                // Forward engine log lines to the renderer's log pane.
                mainWindow?.webContents.send("engine:log", m.message as string);
                break;

            case "drained":
                // Engine has drained; kill the process and allow the app to quit.
                engineProcess?.kill();
                engineProcess = null;
                app.quit();
                break;

            case "error":
                mainWindow?.webContents.send("engine:log", `[engine ERROR] ${m.error}`);
                break;
        }
    });

    // Initialise: pass the userData path so the engine can build the DB path.
    engineProcess.postMessage({
        type: "init",
        userData: app.getPath("userData"),
    });
}

// ---- IPC handlers (renderer → main → engine) --------------------------------

ipcMain.handle("engine:startHello", () => {
    engineProcess?.postMessage({ type: "startWorkflow", workflow: "hello" });
    return "hello-started";
});

ipcMain.handle("engine:runCpuHeavy", () => {
    // Use a 3-second burn; the renderer's clock should keep ticking the whole time.
    engineProcess?.postMessage({ type: "startWorkflow", workflow: "cpu-heavy", durationMs: 3000 });
    return "cpu-heavy-started";
});

// ---- App lifecycle -----------------------------------------------------------

app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            contextIsolation: true,   // required — isolates preload from renderer
            nodeIntegration:  false,  // required — no Node access in the renderer
            preload:          path.join(__dirname, "preload.js"),
        },
    });

    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    startEngine();

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
});

/**
 * Graceful shutdown (H4): on before-quit, ask the engine process to drain
 * (await host.stop()), wait for the "drained" reply, then allow the quit.
 *
 * This handler is idempotent: a second before-quit event while already draining
 * (e.g. from clicking Quit twice) is ignored — the first drain sequence completes
 * and then the app quits normally.
 */
app.on("before-quit", (event) => {
    if (draining) return;           // already draining — let it finish
    if (!engineProcess) return;     // engine never started or already killed

    draining = true;
    event.preventDefault();         // prevent immediate quit

    mainWindow?.webContents.send("engine:log", "[main] Draining engine before quit…");
    engineProcess.postMessage({ type: "drain" });
    // The "drained" reply in engineProcess.on("message") above calls app.quit().
});

app.on("window-all-closed", () => {
    // On macOS, quitting when all windows are closed is conventional.
    if (process.platform !== "darwin") {
        app.quit();
    }
});
