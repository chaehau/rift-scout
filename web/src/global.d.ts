// Electron 外壳通过 preload 注入的能力（浏览器里没有，界面据此决定是否显示「选择文件夹」）
interface Window {
  rift?: {
    /** 用系统对话框挑一个目录；取消时返回 null */
    pickFolder: () => Promise<string | null>
  }
}
