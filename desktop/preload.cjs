// Electron 预加载：只给页面开一个能力——用系统对话框挑目录（DEC-023）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rift', {
  /** 打开系统「选择文件夹」对话框；取消时返回 null */
  pickFolder: () => ipcRenderer.invoke('rift:pick-folder'),
})
