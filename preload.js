const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  setDefaultSrc: (src) => ipcRenderer.invoke("set-default-src", src),
  setRepkg: (p) => ipcRenderer.invoke("set-repkg", p),
  pickFile: (filters) => ipcRenderer.invoke("pick-file", filters),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  listItems: (src) => ipcRenderer.invoke("list-items", src),
  extract: (payload) => ipcRenderer.invoke("extract", payload),
  onLog: (cb) => ipcRenderer.on("log", (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, data) => cb(data)),
});
