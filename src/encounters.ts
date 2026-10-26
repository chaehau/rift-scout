// 本地对战记录：把每局遇到的十个人落到本机，下次排到时能认出「老熟人」。
// 只依赖对局开始时能读到的名单，不涉及任何组队字段（对方是否开黑无从得知，见 DEC-021）。

import fs from 'node:fs'
import path from 'node:path'

import { defaultDataDir, loadSettings } from './settings.ts'

/** 最多保留多少局（10 人/局，400 局也只有 1MB 量级） */
const MAX_GAMES = 400
/** 每个人最多回显最近几次相遇 */
const MAX_RECENT = 8
const FILE_NAME = 'encounters.json'

/** 一局里的一个人 */
export interface EncounterPlayer {
  puuid: string
  gameName: string
  tagLine: string
  championId: number | null
  /** 那局此人是否与本人同队 */
  ally: boolean
}

/** 本地保存的一局对战 */
export interface EncounterGame {
  gameId: number
  /** 记录时间（ISO）：识别到对局的那一刻 */
  recordedAt: string
  queueId: number | null
  /** 记录时的登录账号 */
  selfPuuid: string
  players: EncounterPlayer[]
}

/** 一次相遇：某一局里见过这个人 */
export interface EncounterHit {
  gameId: number
  recordedAt: string
  queueId: number | null
  championId: number | null
  ally: boolean
}

export interface EncounterSummary {
  /** 一共遇到过几局 */
  total: number
  /** 最近几局，最新在前 */
  recent: EncounterHit[]
}

interface FileShape {
  version: number
  games: EncounterGame[]
}

/**
 * 数据目录：用户设置的目录 → 默认 %APPDATA%\RiftScout（便携版换了位置也不会丢）。
 * RIFT_SCOUT_DATA 可以强制覆盖，供测试使用。
 */
export function encounterDir(): string {
  const override = process.env.RIFT_SCOUT_DATA
  if (override) return override
  return loadSettings().dataDir ?? defaultDataDir()
}

/** 记录文件名 */
export const ENCOUNTER_FILE = FILE_NAME

export class EncounterStore {
  private file = path.join(encounterDir(), FILE_NAME)
  /** 新的在前 */
  private games: EncounterGame[] = []
  private loaded = false
  private writing: Promise<void> = Promise.resolve()

  /** 读盘；文件不存在或损坏都当作「还没有记录」，绝不影响面板主流程 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as FileShape
      if (Array.isArray(parsed?.games)) {
        this.games = parsed.games.filter(
          (g) => g && typeof g.gameId === 'number' && Array.isArray(g.players)
        )
      }
    } catch {
      // 首次运行或文件损坏：从空开始
    }
  }

  /**
   * 记录一局。同一 gameId 重复上报时保留人数更多的那份：
   * 开局初期名单可能不满十人，后续轮询会把完整名单补上。
   */
  record(game: EncounterGame): void {
    this.ensureLoaded()
    const players = game.players.filter((p) => p.puuid)
    if (!players.length) return

    const existing = this.games.findIndex((g) => g.gameId === game.gameId)
    if (existing >= 0) {
      if (this.games[existing].players.length >= players.length) return
      this.games.splice(existing, 1)
    }
    this.games.unshift({ ...game, players })
    if (this.games.length > MAX_GAMES) this.games.length = MAX_GAMES
    this.flush()
  }

  /**
   * 这批人里谁在本地记录中出现过。
   * excludeGameId 用于跳过当前这局，避免把「这一局」也算成相遇。
   */
  against(puuids: string[], excludeGameId: number | null = null): Map<string, EncounterSummary> {
    this.ensureLoaded()
    const want = new Set(puuids.filter(Boolean))
    const out = new Map<string, EncounterSummary>()
    if (!want.size) return out

    for (const game of this.games) {
      if (excludeGameId !== null && game.gameId === excludeGameId) continue
      for (const p of game.players) {
        // 每局记录里都有本人，直接跳过，否则会变成「遇过自己」
        if (p.puuid === game.selfPuuid) continue
        if (!want.has(p.puuid)) continue
        let summary = out.get(p.puuid)
        if (!summary) {
          summary = { total: 0, recent: [] }
          out.set(p.puuid, summary)
        }
        summary.total += 1
        if (summary.recent.length < MAX_RECENT) {
          summary.recent.push({
            gameId: game.gameId,
            recordedAt: game.recordedAt,
            queueId: game.queueId,
            championId: p.championId,
            ally: p.ally,
          })
        }
      }
    }
    return out
  }

  /** 已记录的局数 */
  get size(): number {
    this.ensureLoaded()
    return this.games.length
  }

  /** 当前记录目录 */
  get dir(): string {
    return path.dirname(this.file)
  }

  /**
   * 切换记录目录（用户改了保存位置）。
   * - 目录没变：unchanged；
   * - 目标目录已有 encounters.json：改读那份；
   * - 目标目录还没有：把当前内存里的记录原样写过去，不让历史白攒。
   */
  setDir(dir: string): 'unchanged' | 'existing' | 'copied' | 'empty' {
    this.ensureLoaded()
    const next = path.join(dir, FILE_NAME)
    if (path.resolve(next) === path.resolve(this.file)) return 'unchanged'

    const hasTarget = fs.existsSync(next)
    this.file = next
    if (hasTarget) {
      this.games = []
      this.loaded = false
      this.ensureLoaded()
      return 'existing'
    }
    if (!this.games.length) return 'empty'
    this.flush()
    return 'copied'
  }

  /** 串行写盘：先写临时文件再改名，避免留下半个 JSON */
  private flush(): void {
    // 路径要在这里定死：写盘排队期间用户可能又改了保存位置
    const target = this.file
    const payload = JSON.stringify({ version: 1, games: this.games } satisfies FileShape)
    const dir = path.dirname(target)
    const tmp = `${target}.tmp`
    this.writing = this.writing
      .then(async () => {
        await fs.promises.mkdir(dir, { recursive: true })
        await fs.promises.writeFile(tmp, payload, 'utf8')
        await fs.promises.rename(tmp, target)
      })
      .catch((err: Error) => {
        // 写不进去只影响下次启动能否认出熟人，不能让面板因此报错
        console.warn(`[encounters] 保存失败：${err.message}`)
      })
  }
}
