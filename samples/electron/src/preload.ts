/**
 * preload.ts — Electron preload script.
 *
 * Runs in a Node.js context with access to ipcRenderer, but is isolated from
 * the renderer page's JavaScript via contextIsolation: true.
 *
 * Exposes a minimal, typed API to the renderer through contextBridge so that
 * no Node.js API or Electron internals leak into the renderer's window object.
 *
 * The renderer calls:
 *   window.workflowAPI.startHello()
 *   window.workflowAPI.runCpuHeavy()
 *   window.workflowAPI.onLog(cb)
 */
import { contextBridge, ipcRenderer } from "electron";

// Expose a narrow, typed surface — only these three methods.
contextBridge.exposeInMainWorld("workflowAPI", {
    /**
     * Ask the engine process to start the hello workflow.
     * Returns the new workflow ID.
     */
    startHello: (): Promise<string> =>
        ipcRenderer.invoke("engine:startHello"),

    /**
     * Ask the engine process to start the CPU-heavy workflow.
     * The on-screen clock should keep animating while this runs.
     * Returns the new workflow ID.
     */
    runCpuHeavy: (): Promise<string> =>
        ipcRenderer.invoke("engine:runCpuHeavy"),

    /**
     * Subscribe to log messages forwarded from the engine process.
     * @param cb Called with each log line.
     */
    onLog: (cb: (msg: string) => void): void => {
        ipcRenderer.on("engine:log", (_event, msg: string) => cb(msg));
    },
});
