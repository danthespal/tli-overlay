// Exposes one function to the overlay page: subscribe to state updates from the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
  // The panel's box; the window takes clicks only while the cursor is inside it.
  setPanelRect: (rect) => ipcRenderer.send("panelRect", rect),
  setGoal: (goal) => ipcRenderer.send("goal", goal),
  // The first-start question: share anonymous data or not.
  setShare: (on) => ipcRenderer.send("share", on),
  report: () => ipcRenderer.send("report"),
  // Blessings from Gods: { source: "bought" | "farmed" } or { margin: percent }.
  setShopOptions: (options) => ipcRenderer.send("shopOptions", options),
  // A price typed in the table (null: back to the last price check), and an item name to copy.
  setShopPrice: (key, price) => ipcRenderer.send("shopPrice", key, price),
  copyItem: (key) => ipcRenderer.send("copyItem", key),
  // An input of the table has the keyboard: the overlay takes focus while it does.
  setEditing: (on) => ipcRenderer.send("editing", on),
  // The mouse is over an input of the table: the overlay may take a click's focus then.
  setOverInput: (on) => ipcRenderer.send("overInput", on),
  // The panel is being dragged by its title: keep the mouse until it's let go.
  setDragging: (on) => ipcRenderer.send("dragging", on),
  // --demo only: show a saved screenshot behind the drawings.
  onBackground: (callback) => ipcRenderer.on("background", (_event, url) => callback(url)),
});
