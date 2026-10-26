// Exposes one function to the overlay page: subscribe to state updates from the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
  // The panel's box; the window takes clicks only while the cursor is inside it.
  setPanelRect: (rect) => ipcRenderer.send("panelRect", rect),
  setGoal: (goal) => ipcRenderer.send("goal", goal),
  // --demo only: show a saved screenshot behind the drawings.
  onBackground: (callback) => ipcRenderer.on("background", (_event, url) => callback(url)),
});
