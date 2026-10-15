import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jevsnap", {
  getState: () => ipcRenderer.invoke("settings:get"),
  save: (partial: unknown) => ipcRenderer.invoke("settings:save", partial),
  setApiKey: (key: string) => ipcRenderer.invoke("settings:setApiKey", key),
  pickFolder: () => ipcRenderer.invoke("settings:pickFolder"),
  openFolder: () => ipcRenderer.invoke("settings:openFolder"),
  testConnection: () => ipcRenderer.invoke("settings:testConnection"),
  openExternal: (url: string) => ipcRenderer.invoke("settings:openExternal", url),
});
