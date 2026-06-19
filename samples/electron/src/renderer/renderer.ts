/**
 * renderer.ts — Renderer process script.
 *
 * Wires up the UI buttons to the preload API (window.workflowAPI) and renders
 * engine log events in the log pane. The always-animating clock proves the
 * renderer stays responsive even while the CPU-heavy step burns CPU in the
 * utilityProcess.
 *
 * This file MUST NOT import @reactorynet/workflow-es or any Node.js module.
 * It communicates with the engine only through window.workflowAPI (the
 * contextBridge surface exposed by preload.ts).
 */
export {};  // Make this an ES module so the global augmentation is valid.

// TypeScript ambient declaration for the contextBridge surface.
declare global {
    interface Window {
        workflowAPI: {
            startHello:   () => Promise<string>;
            runCpuHeavy:  () => Promise<string>;
            onLog:        (cb: (msg: string) => void) => void;
        };
    }
}

// ---- Always-animating clock --------------------------------------------------

function updateClock(): void {
    const el = document.getElementById("clock");
    if (el) {
        el.textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
    }
}
updateClock();
setInterval(updateClock, 100);

// ---- Log pane ----------------------------------------------------------------

function appendLog(msg: string, isError = false): void {
    const log = document.getElementById("log");
    if (!log) return;
    const entry = document.createElement("div");
    entry.className = "log-entry" + (isError ? " error" : "");
    entry.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

// Subscribe to log messages forwarded from the engine process via main.
window.workflowAPI.onLog((msg: string) => {
    appendLog(msg);
});

// ---- Button handlers ---------------------------------------------------------

document.getElementById("btn-hello")?.addEventListener("click", async () => {
    appendLog("→ Starting hello workflow…");
    try {
        await window.workflowAPI.startHello();
        appendLog("Hello workflow started. Watch the engine log below.");
    } catch (err) {
        appendLog(`Error: ${err}`, true);
    }
});

document.getElementById("btn-cpu-heavy")?.addEventListener("click", async () => {
    appendLog("→ Starting CPU-heavy workflow (3 s busy-loop in the engine process)…");
    appendLog("  The clock above MUST keep animating. If it freezes, the step is not isolated.");
    try {
        await window.workflowAPI.runCpuHeavy();
        appendLog("CPU-heavy workflow started. Clock should keep ticking during the burn.");
    } catch (err) {
        appendLog(`Error: ${err}`, true);
    }
});
