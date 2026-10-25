// Electron 外壳：内嵌桥接服务 + 常驻置顶小窗（DEC-011）
// 开发：npx electron .    打包：npm run dist

import { app, BrowserWindow, shell } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const PORT = Number(process.env.PORT ?? 8737)
const ORIGIN = `http://127.0.0.1:${PORT}`

// 指定用户数据目录（调试/受限环境用；正常运行时走系统默认）
if (process.env.LOL_USERDATA) app.setPath('userData', process.env.LOL_USERDATA)

const paths = app.isPackaged
  ? {
      bridge: path.join(process.resourcesPath, 'bridge.cjs'),
      web: path.join(process.resourcesPath, 'web'),
    }
  : {
      bridge: path.join(root, 'dist', 'bridge.cjs'),
      web: path.join(root, 'web', 'dist'),
    }

async function bridgeUp() {
  try {
    const res = await fetch(`${ORIGIN}/api/status`, { signal: AbortSignal.timeout(1200) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureBridge() {
  // 已经有桥接服务在跑（例如手动 npm start）就直接复用，避免端口冲突
  if (await bridgeUp()) return
  process.env.LOL_EMBEDDED = '1'
  process.env.LOL_WEB_DIR = paths.web
  try {
    require(paths.bridge)
  } catch (err) {
    console.error('[shell] 桥接服务启动失败：', err)
    return
  }
  for (let i = 0; i < 40; i += 1) {
    if (await bridgeUp()) return
    await new Promise((r) => setTimeout(r, 150))
  }
}

function createWindow() {
  const win = new BrowserWindow({
    // 横向铺开：两队左右并排展示十人战绩，避免长条
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    center: true,
    title: '峡谷斥候',
    backgroundColor: '#0f1620',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.loadURL(ORIGIN)
  // 页面里的外链一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(async () => {
    await ensureBridge()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => app.quit())
}
