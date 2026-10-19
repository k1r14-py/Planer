// Мост между окном Planer и оболочкой: горячая клавиша диктовки и её подпись.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("planerDesktop", {
  getHotkey: () => ipcRenderer.invoke("planer:get-hotkey"),
  onDictate: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("planer:dictate", handler);
    return () => ipcRenderer.removeListener("planer:dictate", handler);
  },
  onHotkey: (cb) => {
    const handler = (_e, label) => cb(label);
    ipcRenderer.on("planer:hotkey", handler);
    return () => ipcRenderer.removeListener("planer:hotkey", handler);
  },
});
