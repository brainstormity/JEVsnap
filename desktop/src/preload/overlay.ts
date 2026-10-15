import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("overlay", {
  onInit: (cb: (data: { image: string; width: number; height: number }) => void) => {
    ipcRenderer.once("overlay:init", (_e, data) => cb(data));
  },
  done: (rect: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.send("overlay:done", rect),
});
