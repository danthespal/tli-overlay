// Bridge for capture.html (the hidden window that holds the game window share).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cap", {
  onStart: (callback) => ipcRenderer.on("capture:start", (_event, sourceId) => callback(sourceId)),
  onGrab: (callback) => ipcRenderer.on("capture:grab", (_event, request) => callback(request)),
  onStop: (callback) => ipcRenderer.on("capture:stop", () => callback()),
  started: (result) => ipcRenderer.send("capture:started", result),
  grabbed: (result) => ipcRenderer.send("capture:grabbed", result),
  ended: () => ipcRenderer.send("capture:ended"),
  log: (message) => ipcRenderer.send("capture:log", message),
});
