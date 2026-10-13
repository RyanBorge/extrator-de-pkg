const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openFolder: (p) => ipcRenderer.invoke("open-folder", p),
  listItems: (src) => ipcRenderer.invoke("list-items", src),
  extract: (payload) => ipcRenderer.invoke("extract", payload),
  cancelExtract: () => ipcRenderer.invoke("cancel-extract"),
  onLog: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },
  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },
});
