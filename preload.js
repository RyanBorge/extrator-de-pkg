const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  setDefaultSrc: (src) => ipcRenderer.invoke("set-default-src", src),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openFolder: (p) => ipcRenderer.invoke("open-folder", p),
  listItems: (src) => ipcRenderer.invoke("list-items", src),
  extract: (payload) => ipcRenderer.invoke("extract", payload),
  onLog: (cb) => ipcRenderer.on("log", (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, data) => cb(data)),
});
