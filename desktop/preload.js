// Мост между окном Planer и оболочкой: горячая клавиша диктовки и её подпись, обновление оболочки.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("planerDesktop", {
  getHotkey: () => ipcRenderer.invoke("planer:get-hotkey"),
  onDictate: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("planer:dictate", handler);
    return () => ipcRenderer.removeListener("planer:dictate", handler);
  },
  shellUpdate: {
    check: () => ipcRenderer.invoke("planer:shell-check"),
    install: () => ipcRenderer.invoke("planer:shell-install"),
    status: () => ipcRenderer.invoke("planer:shell-status"),
    onStatus: (cb) => {
      const handler = (_e, job) => cb(job);
      ipcRenderer.on("planer:shell-status", handler);
      return () => ipcRenderer.removeListener("planer:shell-status", handler);
    },
  },
  onHotkey: (cb) => {
    const handler = (_e, label) => cb(label);
    ipcRenderer.on("planer:hotkey", handler);
    return () => ipcRenderer.removeListener("planer:hotkey", handler);
  },
});
