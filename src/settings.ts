// 用户设置：目前只有「战绩记录保存到哪个目录」。
// 配置文件始终留在 %APPDATA%\RiftScout，避免记录目录被改走后找不到设置（DEC-023）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILE_NAME = 'settings.json'

/** 配置目录：固定的应用数据目录，不随记录目录变化 */
export function configDir(): string {
  const appData = process.env.APPDATA
  return appData ? path.join(appData, 'RiftScout') : path.join(os.homedir(), '.riftscout')
}

/** 未自定义时的默认记录目录 */
export function defaultDataDir(): string {
  return configDir()
}

export interface Settings {
  /** 自定义的记录目录；null = 用默认目录 */
  dataDir: string | null
}

export function settingsFile(): string {
  return path.join(configDir(), FILE_NAME)
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>
    const dir = typeof raw?.dataDir === 'string' ? raw.dataDir.trim() : ''
    return { dataDir: dir || null }
  } catch {
    return { dataDir: null }
  }
}

export function saveSettings(next: Settings): void {
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, dataDir: next.dataDir }, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
