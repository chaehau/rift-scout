// LCU（League Client Update API）接入层：认证定位 + 限速 HTTP 客户端

import https from 'node:https'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const REQUEST_TIMEOUT_MS = 8000
const MAX_CONCURRENCY = 5
const RETRY_DELAY_MS = 400

export interface LcuAuth {
  port: number
  token: string
  /** 认证来源：进程参数 / lockfile / 手动指定 */
  via: string
}

export type AuthFailureReason = 'not_running' | 'access_denied' | 'error'

export type AuthResult =
  | ({ ok: true } & LcuAuth)
  | { ok: false; reason: AuthFailureReason; message: string }

export interface LcuResponse<T> {
  status: number
  data: T | null
  error?: string
}

export interface LcuBinaryResponse {
  status: number
  body: Buffer | null
  error?: string
}

// —— 认证定位：进程命令行 → lockfile → 明确区分「没开」与「权限不够」 ——

function parseClientArgs(cmdline: string): LcuAuth | null {
  const port = cmdline.match(/--app-port=(\d+)/)?.[1]
  const token = cmdline.match(/--remoting-auth-token=([^\s"]+)/)?.[1]
  if (!port || !token) return null
  return { port: Number(port), token, via: '进程参数' }
}

function parseLockfile(content: string): LcuAuth | null {
  // 格式：LeagueClient:PID:PORT:PASSWORD:https
  const parts = content.trim().split(':')
  if (parts.length < 4) return null
  const port = Number(parts[2])
  const token = parts[3]
  if (!Number.isFinite(port) || !token) return null
  return { port, token, via: 'lockfile' }
}

/** 读取客户端进程命令行；读不到时返回空串（多见于权限不足） */
function readProcessCmdline(): string {
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'" | Select-Object -ExpandProperty CommandLine`
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
    })
  } catch {
    return ''
  }
}

function isClientProcessRunning(): boolean {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq LeagueClientUx.exe', '/NH'],
      { encoding: 'utf8', timeout: 8000 }
    )
    return /LeagueClientUx\.exe/i.test(out)
  } catch {
    return false
  }
}

export function isAdmin(): boolean {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { encoding: 'utf8', timeout: 10000 }
    )
    return out.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}

/**
 * 定位客户端并取得认证。
 * 顺序：进程命令行 → 用户指定的 lockfile → 常见安装路径的 lockfile。
 * 全都拿不到时，区分「客户端没启动」与「进程在但读不到（需提权）」。
 */
export function resolveAuth(lockfilePaths: string[] = []): AuthResult {
  const cmdlines = readProcessCmdline()
  for (const line of cmdlines.split(/\r?\n/)) {
    const auth = parseClientArgs(line)
    if (auth) return { ok: true, ...auth }
  }

  for (const p of lockfilePaths) {
    try {
      const auth = parseLockfile(fs.readFileSync(p, 'utf8'))
      if (auth) return { ok: true, ...auth }
    } catch {
      // 路径不存在或无权限，继续尝试下一个
    }
  }

  if (isClientProcessRunning()) {
    return {
      ok: false,
      reason: 'access_denied',
      message: isAdmin()
        ? '检测到客户端进程，但读不到认证信息。请重启英雄联盟客户端后再试。'
        : '检测到客户端进程，但当前权限不足（国服客户端常以管理员运行）。请以管理员身份重新启动本程序。',
    }
  }
  return { ok: false, reason: 'not_running', message: '未检测到英雄联盟客户端，请先启动客户端并登录。' }
}

// —— 限速 HTTP 客户端 ——

class Semaphore {
  private active = 0
  private readonly max: number
  private queue: Array<() => void> = []

  constructor(max: number) {
    this.max = max
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active += 1
  }

  release(): void {
    this.active -= 1
    this.queue.shift()?.()
  }
}

export class LcuClient {
  readonly port: number
  readonly token: string
  readonly via: string
  private agent: https.Agent
  private sem: Semaphore

  constructor(auth: LcuAuth) {
    this.port = auth.port
    this.token = auth.token
    this.via = auth.via
    // 自签证书 + 长连接；Node 的 https 不走系统代理，加速器劫持 127.0.0.1 不受影响
    this.agent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      maxSockets: MAX_CONCURRENCY,
    })
    this.sem = new Semaphore(MAX_CONCURRENCY)
  }

  get<T>(path: string, retries = 1, timeoutMs = REQUEST_TIMEOUT_MS): Promise<LcuResponse<T>> {
    return this.request<T>('GET', path, retries, timeoutMs)
  }

  /** 取二进制资源（英雄头像等）；由桥接服务代理，前端不直连 LCU */
  async getRaw(path: string): Promise<LcuBinaryResponse> {
    await this.sem.acquire()
    try {
      return await this.sendRaw(path)
    } finally {
      this.sem.release()
    }
  }

  private sendRaw(path: string): Promise<LcuBinaryResponse> {
    const auth = 'Basic ' + Buffer.from(`riot:${this.token}`).toString('base64')
    return new Promise((resolve) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method: 'GET',
          agent: this.agent,
          headers: { Authorization: auth },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
          )
        }
      )
      req.on('timeout', () => req.destroy(new Error('请求超时')))
      req.on('error', (err: Error) => resolve({ status: 0, body: null, error: err.message }))
      req.end()
    })
  }

  private async request<T>(
    method: string,
    path: string,
    retries: number,
    timeoutMs: number
  ): Promise<LcuResponse<T>> {
    let last: LcuResponse<T> = { status: 0, data: null, error: '未执行' }
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.sem.acquire()
      try {
        last = await this.send<T>(method, path, timeoutMs)
      } finally {
        this.sem.release()
      }
      // 只对连不上/超时（status 0）重试；HTTP 404 之类的业务状态直接返回
      if (last.status !== 0) return last
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
    return last
  }

  private send<T>(method: string, path: string, timeoutMs: number): Promise<LcuResponse<T>> {
    const auth =
      'Basic ' + Buffer.from(`riot:${this.token}`).toString('base64')
    return new Promise((resolve) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method,
          agent: this.agent,
          headers: { Authorization: auth, Accept: 'application/json' },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (!text) return resolve({ status: res.statusCode ?? 0, data: null })
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) as T })
            } catch {
              resolve({
                status: res.statusCode ?? 0,
                data: null,
                error: '响应不是 JSON',
              })
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('请求超时')))
      req.on('error', (err: Error) => resolve({ status: 0, data: null, error: err.message }))
      req.end()
    })
  }
}

// 冷 puuid 的首个请求区间会钉死缓存场数，所以固定请求 0~count-1 再本地切片
export const endpoints = {
  currentSummoner: '/lol-summoner/v1/current-summoner',
  gameflowPhase: '/lol-gameflow/v1/gameflow-phase',
  gameflowSession: '/lol-gameflow/v1/session',
  champSelectSession: '/lol-champ-select/v1/session',
  /**
   * 本人所在预组队的成员。LCU 只下发自己这支队伍，
   * 敌方是否开黑没有对应字段（DEC-021）。
   */
  lobbyMembers: '/lol-lobby/v2/lobby/members',
  matches: (puuid: string, count: number) =>
    `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=${count - 1}`,
  /** 分页取历史（查询某人时按页拉取，直到取空） */
  matchesRange: (puuid: string, begIndex: number, endIndex: number) =>
    `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=${begIndex}&endIndex=${endIndex}`,
  /** 单场对局详情（十人完整数据） */
  matchDetail: (gameId: number) => `/lol-match-history/v1/games/${gameId}`,
  rankedStats: (puuid: string) => `/lol-ranked/v1/ranked-stats/${puuid}`,
  summonerByPuuid: (puuid: string) => `/lol-summoner/v2/summoners/puuid/${puuid}`,
  /** Riot ID（名字 + TAG）查召唤师；TAG 缺省时退化为按名字查 */
  summonerAlias: (gameName: string, tagLine: string) =>
    `/lol-summoner/v1/summoner-aliases?name=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`,
  summonerByName: (name: string) => `/lol-summoner/v1/summoners/?name=${encodeURIComponent(name)}`,
  championSummary: '/lol-game-data/assets/v1/champion-summary.json',
  championIcon: (id: number) => `/lol-game-data/assets/v1/champion-icons/${id}.png`,
  profileIcon: (id: number) => `/lol-game-data/assets/v1/profile-icons/${id}.jpg`,
  /**
   * 装备/技能图标不能按 id 拼路径（客户端里是 `assets/ASSETS/Items/Icons2D/<名字>.png`），
   * 只能先读清单拿 iconPath，再按清单里的原始大小写请求。
   */
  itemList: '/lol-game-data/assets/v1/items.json',
  spellList: '/lol-game-data/assets/v1/summoner-spells.json',
  /**
   * 海克斯（斗魂 / 海克斯大乱斗）清单：id → 中文名（nameTRA）+ 小图标 + 稀有度。
   * 图标路径在条目里（`/lol-game-data/assets/ASSETS/UX/Cherry|Kiwi/Augments/Icons/*.png`），
   * 同样不能按 id 拼。
   */
  augmentList: '/lol-game-data/assets/v1/cherry-augments.json',
  queueList: '/lol-game-queues/v1/queues',
  /** SGP 网关鉴权：同一 token 也用于拿「超过 50 场」的历史战绩 */
  entitlements: '/entitlements/v1/token',
}

// —— 用到的 LCU 原始返回结构（只声明实际读取的字段） ——

export interface LcuSummoner {
  puuid: string
  gameName?: string
  tagLine?: string
  displayName?: string
  summonerLevel?: number
  profileIconId?: number
}

export interface LcuTeamPlayer {
  puuid: string
  championId?: number
  summonerId?: number
  selectedPosition?: string
}

export interface LcuGameflowSession {
  phase?: string
  gameData?: {
    gameId?: number
    queue?: { id?: number } | null
    teamOne?: LcuTeamPlayer[]
    teamTwo?: LcuTeamPlayer[]
    /** 本局十人的 puuid + championId；对局起始阶段队伍列表不全时用它补齐（DEC-009） */
    playerChampionSelections?: LcuChampionSelection[]
  } | null
}

export interface LcuChampionSelection {
  puuid?: string
  championId?: number
  spell1Id?: number
  spell2Id?: number
}

export interface LcuChampSelectPlayer {
  cellId: number
  puuid: string
  summonerId: number
  championId: number
  championPickIntent: number
  gameName?: string
  tagLine?: string
  nameVisibilityType?: string
}

export interface LcuChampSelectSession {
  gameId: number
  queueId: number
  myTeam: LcuChampSelectPlayer[]
  theirTeam: LcuChampSelectPlayer[]
  localPlayerCellId: number
}

/** 大厅成员：只有本人这支预组队，没有分组字段，靠成员列表判断人数 */
export interface LcuLobbyMember {
  puuid: string
  summonerId?: number
  isLeader?: boolean
}

export interface LcuMatchParticipant {
  participantId?: number
  teamId?: number
  championId?: number
  spell1Id?: number
  spell2Id?: number
  stats?: {
    win?: boolean
    kills?: number
    deaths?: number
    assists?: number
    /** 当前等级（部分版本叫 champLevel） */
    champLevel?: number
    totalMinionsKilled?: number
    neutralMinionsKilled?: number
    goldEarned?: number
    totalDamageDealtToChampions?: number
    visionScore?: number
    item0?: number
    item1?: number
    item2?: number
    item3?: number
    item4?: number
    item5?: number
    item6?: number
    /** 海克斯：斗魂最多 4 个，新斗魂（3v3 六队）实测会用到 5/6 */
    playerAugment1?: number
    playerAugment2?: number
    playerAugment3?: number
    playerAugment4?: number
    playerAugment5?: number
    playerAugment6?: number
  }
}

export interface LcuMatchIdentity {
  participantId: number
  player?: { puuid?: string; gameName?: string; tagLine?: string; summonerName?: string }
}

export interface LcuMatchGame {
  gameId: number
  gameCreation?: number
  gameDuration?: number
  gameMode?: string
  queueId?: number
  participants?: LcuMatchParticipant[]
  participantIdentities?: LcuMatchIdentity[]
}

export interface LcuMatchList {
  /** 所属大区（如 TJ100），SGP 查全量历史时用来选网关 */
  platformId?: string
  games?: { games?: LcuMatchGame[] }
}

export interface LcuRankEntry {
  tier?: string
  division?: string
  leaguePoints?: number
  wins?: number
  losses?: number
  isProvisional?: boolean
  queueType?: string
}

export interface LcuRankedStats {
  queueMap?: Record<string, LcuRankEntry>
  highestRankedEntry?: LcuRankEntry | null
}

export interface LcuChampionSummaryItem {
  id: number
  name: string
}

/** items.json / summoner-spells.json 的条目：只需要 id → 图标路径 */
export interface LcuIconAsset {
  id: number
  iconPath?: string
}

/** cherry-augments.json 的条目（只声明用到的字段；名字字段各版本不统一） */
export interface LcuAugment {
  id: number
  /** 中文名；老版本只有 nameTRA，新版本偶尔叫 name */
  nameTRA?: string
  name?: string
  tooltip?: string
  descriptionTRA?: string
  description?: string
  augmentSmallIconPath?: string
  iconLargePath?: string
  /** kSilver / kGold / kPrismatic（少数版本给数字） */
  rarity?: string | number
}

export interface LcuQueue {
  id: number
  name?: string
  shortName?: string
  gameMode?: string
}

export interface LcuEntitlements {
  accessToken?: string
}

// —— SGP：本地 LCU 的历史战绩最多只给 50 场，更多要走大区网关 ——

/** platformId → 腾讯 SGP 网关主机（主机名不规则，不能按规则拼；端口统一 21019） */
const SGP_HOSTS: Record<string, string> = {
  HN1: 'hn1-k8s-sgp.lol.qq.com',
  HN10: 'hn10-k8s-sgp.lol.qq.com',
  NJ100: 'nj100-sgp.lol.qq.com',
  GZ100: 'gz100-sgp.lol.qq.com',
  CQ100: 'cq100-sgp.lol.qq.com',
  TJ100: 'tj100-sgp.lol.qq.com',
  TJ101: 'tj101-sgp.lol.qq.com',
  BGP2: 'bgp2-k8s-sgp.lol.qq.com',
}

export function sgpHost(platformId: string): string | null {
  return SGP_HOSTS[platformId] ?? null
}

/** SGP 战绩概要：`games[].json` 是 match-v5 扁平结构（含十人，字段与 LCU 不同名） */
export interface SgpMatchGame {
  gameId?: number
  gameCreation?: number
  gameDuration?: number
  queueId?: number
  /** 参与者是「扁平」的：击杀/胜负等直接挂在人身上，没有 stats 子对象 */
  participants?: Array<{
    puuid?: string
    championId?: number
    win?: boolean
    kills?: number
    deaths?: number
    assists?: number
  }>
}

export interface SgpMatchSummary {
  games?: Array<{ json?: SgpMatchGame }>
}

/** 直连 SGP 拉一页战绩；失败返回 null（调用方回退到 LCU 的 50 场） */
export function fetchSgpMatches(
  host: string,
  token: string,
  puuid: string,
  startIndex: number,
  count: number,
  timeoutMs = 12_000
): Promise<SgpMatchSummary | null> {
  const path = `/match-history-query/v1/products/lol/player/${puuid}/SUMMARY?startIndex=${startIndex}&count=${count}`
  return new Promise((resolve) => {
    const req = https.request(
      {
        host,
        port: 21019,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          if ((res.statusCode ?? 0) !== 200) {
            resolve(null)
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SgpMatchSummary)
          } catch {
            resolve(null)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('SGP 请求超时')))
    req.on('error', () => resolve(null))
    req.end()
  })
}
