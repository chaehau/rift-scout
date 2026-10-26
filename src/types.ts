// 对外（前端）契约：/api/status 与 /api/board 的响应类型

export type ClientState = 'connected' | 'not_running' | 'access_denied' | 'error'

/** 一场历史的精简记录，供面板逐场渲染 */
export interface GameRecord {
  gameId: number
  win: boolean
  /** 该场所用英雄 */
  championId: number | null
  championName: string | null
  kills: number
  deaths: number
  assists: number
  queueId: number | null
  /** 该场对局模式的中文短名，如「单双排」「大乱斗」；解析不到时为 null */
  queueName: string | null
  durationSec: number | null
  /** ISO 时间 */
  endedAt: string | null
}

export interface RankInfo {
  queue: 'RANKED_SOLO_5x5'
  /** 原始英文段位，如 EMERALD；未定级时为空串 */
  tier: string
  division: string
  lp: number
  wins: number
  losses: number
  provisional: boolean
  /** 展示用文案：「翡翠 III 27LP」「未定级」 */
  label: string
}

/** 本地对战记录里的一次「相遇」：某一局见过这名玩家 */
export interface EncounterRef {
  gameId: number
  /** 记录到这局的时间（ISO） */
  recordedAt: string
  queueId: number | null
  queueName: string | null
  /** 那局此人用的英雄 */
  championId: number | null
  championName: string | null
  /** 那局此人是否与本人同队 */
  ally: boolean
}

/** 本地记录保存位置（设置页） */
export interface SettingsResponse {
  ok: boolean
  /** 当前生效的目录 */
  dataDir: string
  /** 未自定义时的默认目录 */
  defaultDir: string
  /** 是否为用户自定义目录 */
  custom: boolean
  /** 被 RIFT_SCOUT_DATA 环境变量强制指定（此时界面修改不生效） */
  envOverride: boolean
  /** 该目录里已记录的局数 */
  count: number
  /** 记录文件的完整路径 */
  file: string
  /** 刚切换目录时的处理方式：unchanged = 目录没变，existing = 读目标已有记录，copied = 把当前记录复制过去 */
  mode?: 'unchanged' | 'existing' | 'copied' | 'empty'
  error?: string
}

export type PlayerState = 'ok' | 'hidden' | 'error' | 'loading'
/** 段位状态：查到了 / 确实没打过排位 / 查询失败 / 还在读，四者不能混为一谈 */
export type RankState = 'ok' | 'unranked' | 'error' | 'loading'

export interface PlayerCard {
  puuid: string
  gameName: string
  tagLine: string
  /** 召唤师头像（资料图标）id；读不到时为 null */
  profileIconId: number | null
  side: 'ally' | 'enemy'
  /** 本局英雄；选人阶段可能是暂选，进入对局后以 gameData 为准 */
  championId: number | null
  championName: string | null
  rank: RankInfo | null
  rankState: RankState
  /** 近 10 场，最新在前 */
  recent: GameRecord[]
  /**
   * 与本人同处一个预组队的人数（含本人）。
   * 0 = 单人开或未知；敌方队伍客户端不下发，一律 0。
   */
  partySize: number
  /**
   * 本地对战记录里之前遇到过这个人几次；0 = 没记录到过。
   * 记录只来自本机开着的对局（DEC-022）。
   */
  met: number
  /** 最近几次相遇（最多 8 条，最新在前），供面板展开查看 */
  metGames: EncounterRef[]
  state: PlayerState
  error?: string
}

export interface TeamBlock {
  side: 'ally' | 'enemy'
  players: PlayerCard[]
}

export interface BoardResponse {
  ok: boolean
  phase: string
  gameId: number | null
  queueId: number | null
  /** 本人 puuid，前端用来标记「我」 */
  selfPuuid: string | null
  teams: TeamBlock[]
  /** 选人阶段官方隐藏敌方身份，前端据此渲染占位 */
  enemyHidden: boolean
  updatedAt: string
  tookMs: number
  error?: string
}

/** 按召唤师名查询：query 为回填输入框的标准写法（名字#TAG） */
export interface LookupResponse {
  ok: boolean
  query: string
  player: PlayerCard | null
  updatedAt: string
  tookMs: number
  error?: string
}

/** 对局详情里的一枚海克斯（斗魂 / 海克斯大乱斗） */
export interface MatchAugment {
  id: number
  /** 中文名，如「秘术冲拳」；清单里查不到时回退为「海克斯 {id}」 */
  name: string
  /** silver / gold / prismatic，未知为空串 */
  rarity: string
}

/** 对局详情里的单个玩家 */
export interface MatchPlayerDetail {
  puuid: string
  gameName: string
  tagLine: string
  profileIconId: number | null
  side: 'ally' | 'enemy'
  championId: number | null
  championName: string | null
  level: number
  kills: number
  deaths: number
  assists: number
  /** 补刀（小兵 + 野怪） */
  cs: number
  gold: number
  /** 对英雄造成的伤害 */
  damage: number
  vision: number
  /** 装备 id（item0..item5），已过滤 0 */
  items: number[]
  /** 饰品（item6）id；没有时 null，界面上单独靠右显示 */
  trinket: number | null
  /** 召唤师技能 id（D、F） */
  spells: number[]
  /** 海克斯 id 列表（仅海克斯类模式非空） */
  augments: MatchAugment[]
  win: boolean
}

/** 单场对局详情：teams 里先放被查询者所在队伍 */
export interface MatchDetailResponse {
  ok: boolean
  gameId: number
  queueId: number | null
  queueName: string | null
  /** 按模式选模板：海克斯类（斗魂/海克斯大乱斗）多显示一条海克斯带 */
  template: 'standard' | 'augments'
  durationSec: number | null
  endedAt: string | null
  teams: Array<{ side: 'ally' | 'enemy'; players: MatchPlayerDetail[] }>
  updatedAt: string
  tookMs: number
  error?: string
}

export interface StatusResponse {
  client: ClientState
  phase: string | null
  gameId: number | null
  me: { puuid: string; gameName: string; tagLine: string } | null
  authVia: string | null
  error?: string
  updatedAt: string
}
