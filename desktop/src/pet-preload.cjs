"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hanaPet", {
  getState: () => ipcRenderer.invoke("pet-state"),
  getConnection: () => ipcRenderer.invoke("pet-connection"),
  hide: () => ipcRenderer.invoke("pet-hide"),
  setOptions: (options) => ipcRenderer.invoke("pet-set-options", options),
  openMain: () => ipcRenderer.invoke("pet-open-main"),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("pet-state-changed", handler);
    return () => ipcRenderer.removeListener("pet-state-changed", handler);
  },
  onContext: (callback) => {
    const handler = (_event, context) => callback(context);
    ipcRenderer.on("pet-context-changed", handler);
    return () => ipcRenderer.removeListener("pet-context-changed", handler);
  },
  onResume: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("pet-resumed", handler);
    return () => ipcRenderer.removeListener("pet-resumed", handler);
  },
});
