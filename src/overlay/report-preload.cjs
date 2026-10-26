// The report window: gets the frame and what was read, sends the player's note.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("report", {
  onInit: (callback) => ipcRenderer.on("report:init", (_event, data) => callback(data)),
  /** Resolves to null when sent, else what went wrong. */
  send: (text) => ipcRenderer.invoke("report:send", text),
});
