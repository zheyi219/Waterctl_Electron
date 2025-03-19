import { contextBridge, ipcRenderer } from 'electron';

// 类型声明
interface ElectronAPI {
  bluezclick: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// 实现 IPC 暴露
contextBridge.exposeInMainWorld('electronAPI', {
  bluezclick: () => {
    ipcRenderer.send('bluez-click');
  }
} satisfies ElectronAPI);