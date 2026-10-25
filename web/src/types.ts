export interface GameRecord {
  gameId: number
  win: boolean
  championId: number | null
  championName: string | null
  kills: number
  deaths: number
  assists: number
  queueId: number | null
  /** 该场对局模式的中文短名，如「单双排」「大乱斗」；解析不到时为 null */
  queueName: string | null
  durationSec: number | null
  endedAt: string | null
}

export interface RankInfo {
  queue: 'RANKED_SOLO_5x5'
  tier: string
  division: string
  lp: number
  wins: number
  losses: number
  provisional: boolean
  label: string
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
  championId: number | null
  championName: string | null
  rank: RankInfo | null
  rankState: RankState
  recent: GameRecord[]
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
  selfPuuid: string | null
  teams: TeamBlock[]
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
  /** 饰品（item6）id，界面上固定靠右显示；没有为 null */
  trinket: number | null
  /** 召唤师技能 id（D、F） */
  spells: number[]
  /** 本局选到的海克斯（仅海克斯类模式非空） */
  augments: MatchAugment[]
  win: boolean
}

/** 单场对局详情：teams 里先放被查询者所在队伍 */
export interface MatchDetailResponse {
  ok: boolean
  gameId: number
  queueId: number | null
  queueName: string | null
  /** standard = 常规模板；augments = 海克斯类模板（多一条海克斯带） */
  template: 'standard' | 'augments'
  durationSec: number | null
  endedAt: string | null
  teams: Array<{ side: 'ally' | 'enemy'; players: MatchPlayerDetail[] }>
  updatedAt: string
  tookMs: number
  error?: string
}

export type ClientState = 'connected' | 'not_running' | 'access_denied' | 'error'

/** 轻量状态：只读客户端连通性与当前阶段，不查询任何人的战绩 */
export interface StatusResponse {
  client: ClientState
  phase: string | null
  gameId: number | null
  me: { puuid: string; gameName: string; tagLine: string } | null
  authVia: string | null
  error?: string
  updatedAt: string
}
