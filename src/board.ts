// 面板聚合：阶段 → 名单 → 每人段位 + 近 10 场逐场战绩

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  LcuClient,
  endpoints,
  fetchSgpMatches,
  resolveAuth,
  sgpHost,
  type AuthResult,
  type LcuChampSelectSession,
  type LcuChampionSelection,
  type LcuChampionSummaryItem,
  type LcuAugment,
  type LcuEntitlements,
  type LcuGameflowSession,
  type LcuIconAsset,
  type LcuLobbyMember,
  type LcuMatchGame,
  type LcuMatchIdentity,
  type LcuMatchList,
  type LcuMatchParticipant,
  type LcuQueue,
  type LcuRankedStats,
  type LcuSummoner,
  type LcuTeamPlayer,
  type SgpMatchGame,
} from './lcu.ts'
import { EncounterStore, ENCOUNTER_FILE, type EncounterGame, type EncounterHit } from './encounters.ts'
import { defaultDataDir, loadSettings, saveSettings } from './settings.ts'
import type {
  BoardResponse,
  ClientState,
  EncounterRef,
  GameRecord,
  LookupResponse,
  MatchAugment,
  MatchDetailResponse,
  MatchPlayerDetail,
  PlayerCard,
  PlayerState,
  RankInfo,
  RankState,
  SettingsResponse,
  StatusResponse,
} from './types.ts'

const RECENT_GAMES = 10
/** 玩家战绩缓存：对局内不会变化，避免每次轮询都重新拉取 */
const PLAYER_CACHE_TTL_MS = 180_000
/** 失败结果只短暂缓存：否则一次超时会把「读取失败」钉在界面上三分钟 */
const PLAYER_ERROR_TTL_MS = 10_000
/**
 * 单个玩家最多让面板等这么久。超时先返回「读取中」，慢请求继续在后台跑，
 * 成功后会写入缓存，下一轮轮询自然补上（冷战绩首次可能超过 8 秒）
 */
const PLAYER_SOFT_WAIT_MS = 6_000
/** 战绩首取（冷缓存）在选人/开局这种客户端繁忙时段经常超过默认 8 秒，单独放宽 */
const MATCH_HISTORY_TIMEOUT_MS = 12_000
/** 按人查询历史：LCU 侧尝试的区间（客户端最多 50 场，对别人 0..49 常报 500，需退让）、
 * SGP 侧每页条数与总量/耗时上限 */
const LOOKUP_LCU_SIZES = [50, 20, 10, 1]
const SGP_PAGE_SIZE = 100
const LOOKUP_MAX_GAMES = 300
const LOOKUP_MAX_MS = 15_000
/** 记住上次见到的大区：LCU 的战绩插件抽风（500/503）时，SGP 仍能查 */
const REGION_CACHE_FILE = path.join(os.tmpdir(), 'lol-tracker-region.txt')

/** 带海克斯的模式：斗魂竞技场 / 新斗魂 3x3 / 海克斯大乱斗（2400 实测为 KIWI） */
const AUGMENT_QUEUES = new Set([1700, 1750, 2400, 2410, 2450])

/** 海克斯稀有度：清单里是 kSilver/kGold/kPrismatic，少数版本给数字 */
function normalizeRarity(raw: string | number | undefined): string {
  if (typeof raw === 'number') return ['silver', 'gold', 'prismatic'][raw] ?? ''
  const s = (raw ?? '').toLowerCase()
  if (s.includes('silver')) return 'silver'
  if (s.includes('gold')) return 'gold'
  if (s.includes('prism')) return 'prismatic'
  return ''
}

function readRegionCache(): string | null {
  try {
    return fs.readFileSync(REGION_CACHE_FILE, 'utf8').trim() || null
  } catch {
    return null
  }
}

interface RosterEntry {
  puuid: string
  gameName: string
  tagLine: string
  championId: number | null
  side: 'ally' | 'enemy'
  /** 与本人同队开黑的人数；0 = 单人/未知 */
  partySize?: number
}

interface PlayerSnapshot {
  rank: RankInfo | null
  rankState: RankState
  recent: GameRecord[]
  state: PlayerState
  error?: string
}

/**
 * 常用队列的人工短名：LCU 原始名偏长（「排位赛 单排/双排」），窄列放不下。
 * LCU 的 `/lol-game-queues/v1/queues` 只用来补齐这里没有的新模式。
 */
const QUEUE_CN: Record<number, string> = {
  400: '匹配',
  420: '单双排',
  430: '匹配',
  440: '灵活排',
  450: '大乱斗',
  480: '快速匹配',
  490: '匹配',
  700: '冠军杯赛',
  830: '人机(入门)',
  840: '人机(新手)',
  850: '人机(一般)',
  870: '人机(入门)',
  880: '人机(新手)',
  890: '人机(一般)',
  900: '无限乱斗',
  1700: '斗魂竞技场',
  1750: '斗魂(3x6)',
  1900: '无限火力',
  2400: '海克斯乱斗',
  2410: '海克斯乱斗(锦标赛)',
  2450: '海克斯乱斗(经典)',
  3140: '训练模式',
}

const TIER_CN: Record<string, string> = {
  IRON: '黑铁',
  BRONZE: '青铜',
  SILVER: '白银',
  GOLD: '黄金',
  PLATINUM: '铂金',
  EMERALD: '翡翠',
  DIAMOND: '钻石',
  MASTER: '大师',
  GRANDMASTER: '宗师',
  CHALLENGER: '王者',
}

function parseRank(json: LcuRankedStats | null): RankInfo | null {
  const entry = json?.queueMap?.RANKED_SOLO_5x5 ?? json?.highestRankedEntry ?? null
  if (!entry) return null

  // tier 为空 + isProvisional 是「未定级」，不是「无排位」
  if (!entry.tier) {
    if (!entry.isProvisional) return null
    return {
      queue: 'RANKED_SOLO_5x5',
      tier: '',
      division: '',
      lp: 0,
      wins: entry.wins ?? 0,
      losses: entry.losses ?? 0,
      provisional: true,
      label: '未定级',
    }
  }

  const tierCn = TIER_CN[entry.tier] ?? entry.tier
  const division = entry.division && entry.division !== 'NA' ? entry.division : ''
  const lp = entry.leaguePoints ?? 0
  return {
    queue: 'RANKED_SOLO_5x5',
    tier: entry.tier,
    division,
    lp,
    wins: entry.wins ?? 0,
    losses: entry.losses ?? 0,
    provisional: Boolean(entry.isProvisional),
    label: [tierCn, division, `${lp}LP`].filter(Boolean).join(' '),
  }
}

export class BoardService {
  private lockfilePaths: string[]
  private client: LcuClient | null = null
  private authState: AuthResult | null = null
  private authAt = 0

  private champions = new Map<number, string>()
  private championsLoaded = false
  /** 客户端本地图片（英雄/头像/物品/技能）按路径缓存 */
  private assetCache = new Map<string, Buffer>()
  /** 装备/召唤师技能的 id → iconPath（来自 items.json / summoner-spells.json） */
  private itemIcons = new Map<number, string>()
  private spellIcons = new Map<number, string>()
  /** 海克斯 id → 中文名 / 稀有度 / 小图标路径（cherry-augments.json） */
  private augments = new Map<number, { name: string; rarity: string; iconPath: string }>()
  private augmentsLoaded = false
  /** LCU 队列表兜底（人工表没覆盖的新模式） */
  private queues = new Map<number, string>()
  private queuesLoaded = false

  private nameCache = new Map<string, { gameName: string; tagLine: string; profileIconId: number | null }>()
  private playerCache = new Map<string, { at: number; value: PlayerSnapshot }>()
  /** 按人查询的全量战绩缓存（与面板的 10 场缓存分开，避免互相污染） */
  private lookupCache = new Map<string, { at: number; value: PlayerSnapshot }>()
  private inflight = new Map<string, Promise<PlayerSnapshot>>()
  private lastGameId: number | null = null
  /**
   * 本局的预组队成员：只在选人阶段能读到（对局开始后大厅就没了），
   * 用 gameId 记下来给对局中使用（DEC-021）。
   */
  private party: { gameId: number | null; puuids: string[]; size: number } | null = null
  /** 本地对战记录：把每局十人落盘，下次排到时标出「遇过几次」 */
  private encounters = new EncounterStore()
  /** 大区（如 HN1）：LCU 任意一次战绩返回里都带，留着给 SGP 兜底用（跨启动记忆） */
  private platformId: string | null = readRegionCache()

  constructor(lockfilePaths: string[] = []) {
    this.lockfilePaths = lockfilePaths
  }

  async status(): Promise<StatusResponse> {
    const updatedAt = new Date().toISOString()
    let client = await this.ensureClient()
    if (!client) return this.failStatus(updatedAt)

    let me = await client.get<LcuSummoner>(endpoints.currentSummoner)
    if (me.status === 0) {
      client = await this.ensureClient(true)
      if (!client) return this.failStatus(updatedAt)
      me = await client.get<LcuSummoner>(endpoints.currentSummoner)
    }
    if (me.status !== 200 || !me.data?.puuid) {
      return {
        client: 'error',
        phase: null,
        gameId: null,
        me: null,
        authVia: client.via,
        error: `读取当前账号失败（HTTP ${me.status}${me.error ? '：' + me.error : ''}）`,
        updatedAt,
      }
    }

    const phaseRes = await client.get<string>(endpoints.gameflowPhase)
    return {
      client: 'connected',
      phase: typeof phaseRes.data === 'string' ? phaseRes.data : null,
      gameId: this.lastGameId,
      me: {
        puuid: me.data.puuid,
        gameName: me.data.gameName ?? (me.data.displayName ?? '').split('#')[0] ?? '',
        tagLine: me.data.tagLine ?? (me.data.displayName ?? '').split('#')[1] ?? '',
      },
      authVia: client.via,
      updatedAt,
    }
  }

  /** 本地记录的保存位置：当前目录、默认目录、已记录局数 */
  settings(): SettingsResponse {
    return this.settingsInfo()
  }

  /**
   * 改保存位置。dataDir 为空表示恢复默认。
   * 先验证可写，再落设置，最后让 store 切目录（目标已有记录就改读那份）。
   */
  async setDataDir(input: string): Promise<SettingsResponse> {
    const raw = input.trim()
    const custom = raw.length > 0
    if (custom && !path.isAbsolute(raw)) {
      return { ...this.settingsInfo(), ok: false, error: '请填写绝对路径，例如 D:\\峡谷斥候记录' }
    }
    const target = custom ? path.resolve(raw) : defaultDataDir()

    try {
      await fs.promises.mkdir(target, { recursive: true })
      const probe = path.join(target, '.rift-scout-write-test')
      await fs.promises.writeFile(probe, 'ok', 'utf8')
      await fs.promises.unlink(probe)
    } catch (err) {
      return {
        ...this.settingsInfo(),
        ok: false,
        error: `这个目录不可写：${(err as Error).message}`,
      }
    }

    try {
      saveSettings({ dataDir: custom ? target : null })
    } catch (err) {
      return { ...this.settingsInfo(), ok: false, error: `保存设置失败：${(err as Error).message}` }
    }

    const mode = this.encounters.setDir(target)
    return { ...this.settingsInfo(), mode }
  }

  private settingsInfo(mode?: SettingsResponse['mode']): SettingsResponse {
    return {
      ok: true,
      dataDir: this.encounters.dir,
      defaultDir: defaultDataDir(),
      custom: loadSettings().dataDir !== null,
      envOverride: Boolean(process.env.RIFT_SCOUT_DATA),
      count: this.encounters.size,
      file: path.join(this.encounters.dir, ENCOUNTER_FILE),
      ...(mode ? { mode } : {}),
    }
  }

  /** force=true 时忽略玩家缓存，用于用户手动点「刷新」（不做定时轮询，见 R22） */
  async board(force = false): Promise<BoardResponse> {
    if (force) this.playerCache.clear()
    const t0 = Date.now()
    const updatedAt = new Date().toISOString()
    const empty: BoardResponse = {
      ok: true,
      phase: 'None',
      gameId: null,
      queueId: null,
      selfPuuid: null,
      teams: [],
      enemyHidden: false,
      updatedAt,
      tookMs: 0,
    }
    const fail = (error: string, phase = 'None', gameId: number | null = null): BoardResponse => ({
      ...empty,
      ok: false,
      phase,
      gameId,
      error,
      tookMs: Date.now() - t0,
    })

    let client = await this.ensureClient()
    if (!client) {
      const a = this.authState
      return fail(a && !a.ok ? a.message : '客户端不可用', a && !a.ok ? a.reason : 'error')
    }

    let me = await client.get<LcuSummoner>(endpoints.currentSummoner)
    if (me.status === 0) {
      client = await this.ensureClient(true)
      if (!client) return fail('客户端连接已断开')
      me = await client.get<LcuSummoner>(endpoints.currentSummoner)
    }
    if (me.status !== 200 || !me.data?.puuid) {
      return fail(`读取当前账号失败（HTTP ${me.status}）`)
    }
    const myPuuid = me.data.puuid

    await Promise.all([this.loadChampions(client), this.loadQueues(client)])

    const phaseRes = await client.get<string>(endpoints.gameflowPhase)
    const phase = typeof phaseRes.data === 'string' ? phaseRes.data : 'Unknown'

    // 选人阶段：官方只给己方 5 人，gameData 可能是上一局残留，一律不采信（DEC-006）
    if (phase === 'ChampSelect') {
      const cs = await client.get<LcuChampSelectSession>(endpoints.champSelectSession)
      if (cs.status !== 200 || !cs.data) {
        return fail(`选人会话读取失败（HTTP ${cs.status}）`, phase)
      }
      this.noteGame(cs.data.gameId ?? null)
      const party = await this.readParty(client)
      this.party =
        party && party.puuids.length >= 2
          ? { gameId: cs.data.gameId ?? null, puuids: party.puuids, size: party.puuids.length }
          : null
      const partySet = new Set(this.party?.puuids ?? [])
      const entries: RosterEntry[] = (cs.data.myTeam ?? []).map((p) => ({
        puuid: p.puuid,
        gameName: p.gameName ?? '',
        tagLine: p.tagLine ?? '',
        championId: p.championId || p.championPickIntent || null,
        side: 'ally',
        partySize: partySet.has(p.puuid) ? (this.party?.size ?? 0) : 0,
      }))
      const players = await this.aggregate(client, entries, cs.data.gameId ?? null)
      return {
        ok: true,
        phase,
        gameId: cs.data.gameId ?? null,
        queueId: cs.data.queueId ?? null,
        selfPuuid: myPuuid,
        teams: [{ side: 'ally', players }],
        enemyHidden: true,
        updatedAt,
        tookMs: Date.now() - t0,
      }
    }

    // 对局中：十人取自 gameflow session 的 gameData
    if (phase === 'InProgress') {
      const flow = await client.get<LcuGameflowSession>(endpoints.gameflowSession)
      const gd = flow.data?.gameData
      if (flow.status !== 200 || !gd?.gameId) {
        return fail(`对局会话读取失败（HTTP ${flow.status}）`, phase)
      }
      const gameId = gd.gameId
      const one = gd.teamOne ?? []
      const two = gd.teamTwo ?? []
      if (!one.length && !two.length) {
        return fail('对局名单尚未生成', phase, gameId)
      }
      const mineIsOne = one.some((p) => p.puuid === myPuuid)
      if (!mineIsOne && !two.some((p) => p.puuid === myPuuid)) {
        return fail('对局名单里找不到本人', phase, gameId)
      }
      // 开局初期 gameData 的队伍可能不满 5 人（身份不可见的玩家会被整条略去），
      // 用本局选人记录补齐（DEC-009）
      this.fillFromSelections(one, two, gd.playerChampionSelections ?? [])
      this.noteGame(gameId)

      const allyRaw = mineIsOne ? one : two
      const enemyRaw = mineIsOne ? two : one
      // 组队名单只在选人阶段读得到，这里按 gameId（或成员全部落在我方）沿用
      const remembered = this.party
      const partySet = new Set(
        remembered &&
          (remembered.gameId === gameId ||
            remembered.puuids.every((id) => allyRaw.some((p) => p.puuid === id)))
          ? remembered.puuids
          : []
      )
      const entries: RosterEntry[] = [
        ...allyRaw.map((p) => ({
          puuid: p.puuid,
          gameName: '',
          tagLine: '',
          championId: p.championId ?? null,
          side: 'ally' as const,
          partySize: partySet.has(p.puuid) ? partySet.size : 0,
        })),
        ...enemyRaw.map((p) => ({
          puuid: p.puuid,
          gameName: '',
          tagLine: '',
          championId: p.championId ?? null,
          side: 'enemy' as const,
        })),
      ]
      const queueId = typeof gd.queue === 'object' && gd.queue ? (gd.queue.id ?? null) : null
      const players = await this.aggregate(client, entries, gameId)
      // 十人名单齐了才值得落盘，记录后本局在下轮会出现在别人的「遇过」里
      this.recordEncounter(gameId, queueId, myPuuid, players)
      return {
        ok: true,
        phase,
        gameId,
        queueId,
        selfPuuid: myPuuid,
        teams: [
          { side: 'ally', players: players.filter((p) => p.side === 'ally') },
          { side: 'enemy', players: players.filter((p) => p.side === 'enemy') },
        ],
        enemyHidden: false,
        updatedAt,
        tookMs: Date.now() - t0,
      }
    }

    // 空闲阶段没有名单，但本人 puuid 仍要给出，前端据此标记「我」
    return { ...empty, phase, selfPuuid: myPuuid, tookMs: Date.now() - t0 }
  }

  /**
   * 按「名字#TAG」查某人的段位与近 10 场；传空串表示查自己。
   * 名字解析优先走 Riot ID 接口，失败再退化为按名字查（国服部分老号没有 TAG）。
   */
  async lookup(rawInput: string, puuidHint = ''): Promise<LookupResponse> {
    const t0 = Date.now()
    const updatedAt = new Date().toISOString()
    const input = rawInput.trim().replace(/＃/g, '#')
    const fail = (error: string): LookupResponse => ({
      ok: false,
      query: input,
      player: null,
      updatedAt,
      tookMs: Date.now() - t0,
      error,
    })

    const client = await this.ensureClient()
    if (!client) {
      const a = this.authState
      return fail(a && !a.ok ? a.message : '客户端不可用')
    }

    // 面板点名快捷查询会直接带上 puuid：跳过名字解析，既快也不会因重名/改名失败
    let puuid = puuidHint.trim()
    if (!puuid) {
      if (!input) {
        const me = await client.get<LcuSummoner>(endpoints.currentSummoner)
        if (me.status !== 200 || !me.data?.puuid) {
          return fail(`读取当前账号失败（HTTP ${me.status}）`)
        }
        puuid = me.data.puuid
      } else {
        const [gameName = '', tagLine = ''] = input.split('#')
        const found = await this.findPuuid(client, gameName.trim(), tagLine.trim())
        if ('error' in found) return fail(found.error)
        puuid = found.puuid
      }
    }

    await Promise.all([this.loadChampions(client), this.loadQueues(client)])
    const snapshot = await this.waitLimited(this.lookupSnapshot(client, puuid), 16_000)
    const name = await this.resolveName(client, puuid)
    return {
      ok: true,
      query: `${name.gameName}#${name.tagLine}`.replace(/#$/, ''),
      player: {
        puuid,
        gameName: name.gameName,
        tagLine: name.tagLine,
        profileIconId: name.profileIconId,
        side: 'ally',
        championId: null,
        championName: null,
        rank: snapshot.rank,
        rankState: snapshot.rankState,
        recent: snapshot.recent,
        partySize: 0,
        met: 0,
        metGames: [],
        state: snapshot.state,
        ...(snapshot.error ? { error: snapshot.error } : {}),
      },
      updatedAt,
      tookMs: Date.now() - t0,
    }
  }

  // —— 内部 ——

  /** 英雄头像：客户端本地资产，由桥接代理给前端（前端不直连 LCU） */
  championIcon(id: number): Promise<Buffer | null> {
    return this.asset(endpoints.championIcon(id))
  }

  /** 召唤师头像（资料图标） */
  profileIcon(id: number): Promise<Buffer | null> {
    return this.asset(endpoints.profileIcon(id))
  }

  /** 装备图标：客户端不提供「按 id 取图」，先用 items.json 的 iconPath 换真实路径 */
  async itemIcon(id: number): Promise<Buffer | null> {
    const path = await this.iconPath(endpoints.itemList, this.itemIcons, id)
    return path ? this.asset(path) : null
  }

  /** 召唤师技能图标：同装备，走 summoner-spells.json 的 iconPath */
  async spellIcon(id: number): Promise<Buffer | null> {
    const path = await this.iconPath(endpoints.spellList, this.spellIcons, id)
    return path ? this.asset(path) : null
  }

  /** 海克斯图标：清单自带完整路径（Cherry / Kiwi 两套），按路径取图 */
  async augmentIcon(id: number): Promise<Buffer | null> {
    const client = await this.ensureClient()
    if (!client) return null
    if (!this.augmentsLoaded) await this.loadAugments(client)
    const path = this.augments.get(id)?.iconPath
    return path ? this.asset(path) : null
  }

  /** 海克斯清单：id → 中文名 / 稀有度 / 小图标路径；只取一次，失败下次再试 */
  private async loadAugments(client: LcuClient): Promise<void> {
    if (this.augmentsLoaded) return
    const res = await client.get<LcuAugment[]>(endpoints.augmentList, 0, MATCH_HISTORY_TIMEOUT_MS)
    if (res.status !== 200 || !Array.isArray(res.data)) return
    for (const item of res.data) {
      if (!item?.id) continue
      this.augments.set(item.id, {
        name: item.nameTRA || item.name || '',
        rarity: normalizeRarity(item.rarity),
        iconPath: item.augmentSmallIconPath || item.iconLargePath || '',
      })
    }
    this.augmentsLoaded = this.augments.size > 0
  }

  /** 一局里某个玩家选到的海克斯：按 1..6 顺序，过滤 0 */
  private toAugments(part: LcuMatchParticipant | undefined): MatchAugment[] {
    const s = part?.stats ?? {}
    return [
      s.playerAugment1,
      s.playerAugment2,
      s.playerAugment3,
      s.playerAugment4,
      s.playerAugment5,
      s.playerAugment6,
    ]
      .filter((id): id is number => typeof id === 'number' && id > 0)
      .map((id) => {
        const meta = this.augments.get(id)
        return { id, name: meta?.name || `海克斯 ${id}`, rarity: meta?.rarity ?? '' }
      })
  }

  /** 图标清单：id → iconPath；清单本身只取一次，失败时下次请求再试 */
  private async iconPath(
    listPath: string,
    cache: Map<number, string>,
    id: number
  ): Promise<string | null> {
    const hit = cache.get(id)
    if (hit !== undefined) return hit || null
    const client = await this.ensureClient()
    if (!client) return null
    const res = await client.get<LcuIconAsset[]>(listPath)
    if (res.status === 200 && Array.isArray(res.data)) {
      for (const item of res.data) {
        if (item.id > 0 && item.iconPath) cache.set(item.id, item.iconPath)
      }
    }
    return cache.get(id) || null
  }

  private async asset(path: string): Promise<Buffer | null> {
    const cached = this.assetCache.get(path)
    if (cached) return cached
    const client = await this.ensureClient()
    if (!client) return null
    const res = await client.getRaw(path)
    if (res.status !== 200 || !res.body?.length) return null
    this.assetCache.set(path, res.body)
    return res.body
  }

  /** 单场对局详情；viewerPuuid 决定「我方/敌方」视角，缺省用当前登录账号 */
  async matchDetail(gameId: number, viewerPuuid?: string): Promise<MatchDetailResponse> {
    const t0 = Date.now()
    const updatedAt = new Date().toISOString()
    const fail = (error: string): MatchDetailResponse => ({
      ok: false,
      gameId,
      queueId: null,
      queueName: null,
      template: 'standard',
      durationSec: null,
      endedAt: null,
      teams: [],
      updatedAt,
      tookMs: Date.now() - t0,
      error,
    })

    const client = await this.ensureClient()
    if (!client) {
      const a = this.authState
      return fail(a && !a.ok ? a.message : '客户端不可用')
    }

    const res = await client.get<LcuMatchGame>(endpoints.matchDetail(gameId), 0, MATCH_HISTORY_TIMEOUT_MS)
    if (res.status !== 200 || !res.data) {
      return fail(`对局详情读取失败（HTTP ${res.status}${res.error ? '：' + res.error : ''}）`)
    }
    const game = res.data
    await this.loadChampions(client)
    await this.loadQueues(client)

    // 有海克斯的对局才去读 600 条的清单，常规对局不付这份开销
    const hasAugments = (game.participants ?? []).some((p) => {
      const s = p.stats ?? {}
      return [s.playerAugment1, s.playerAugment2, s.playerAugment3, s.playerAugment4, s.playerAugment5, s.playerAugment6]
        .some((id) => typeof id === 'number' && id > 0)
    })
    if (hasAugments) await this.loadAugments(client)

    let viewer = viewerPuuid?.trim() || ''
    if (!viewer) {
      const me = await client.get<LcuSummoner>(endpoints.currentSummoner)
      viewer = me.data?.puuid ?? ''
    }

    const identities = game.participantIdentities ?? []
    const participants = game.participants ?? []
    const viewerParticipantId = identities.find((i) => i.player?.puuid === viewer)?.participantId
    const viewerTeamId =
      participants.find((p) => p.participantId === viewerParticipantId)?.teamId ?? null

    const players = await Promise.all(
      identities.map(async (identity) => {
        const part = participants.find((p) => p.participantId === identity.participantId)
        const puuid = identity.player?.puuid ?? ''
        const name = puuid
          ? await this.resolveName(client, puuid)
          : {
              gameName: identity.player?.gameName ?? identity.player?.summonerName ?? '未知玩家',
              tagLine: identity.player?.tagLine ?? '',
              profileIconId: null,
            }
        const side: 'ally' | 'enemy' =
          viewerTeamId !== null && part?.teamId === viewerTeamId ? 'ally' : 'enemy'
        return this.toDetail(identity, part, name, side)
      })
    )

    const queueId = game.queueId ?? null
    return {
      ok: true,
      gameId,
      queueId,
      queueName: this.queueName(queueId),
      template:
        hasAugments || (queueId !== null && AUGMENT_QUEUES.has(queueId)) ? 'augments' : 'standard',
      durationSec: game.gameDuration ?? null,
      endedAt: game.gameCreation ? new Date(game.gameCreation).toISOString() : null,
      teams: [
        { side: 'ally', players: players.filter((p) => p.side === 'ally') },
        { side: 'enemy', players: players.filter((p) => p.side === 'enemy') },
      ],
      updatedAt,
      tookMs: Date.now() - t0,
    }
  }

  private toDetail(
    identity: LcuMatchIdentity,
    part: LcuMatchParticipant | undefined,
    name: { gameName: string; tagLine: string; profileIconId: number | null },
    side: 'ally' | 'enemy'
  ): MatchPlayerDetail {
    const s = part?.stats ?? {}
    const items = [s.item0, s.item1, s.item2, s.item3, s.item4, s.item5].filter(
      (id): id is number => typeof id === 'number' && id > 0
    )
    // 饰品（item6）单独给前端，界面右侧固定位置展示
    const trinket = typeof s.item6 === 'number' && s.item6 > 0 ? s.item6 : null
    const spells = [part?.spell1Id, part?.spell2Id].filter(
      (id): id is number => typeof id === 'number' && id > 0
    )
    return {
      puuid: identity.player?.puuid ?? '',
      gameName: name.gameName,
      tagLine: name.tagLine,
      profileIconId: name.profileIconId,
      side,
      championId: part?.championId ?? null,
      championName: this.championName(part?.championId ?? null),
      level: s.champLevel ?? 0,
      kills: s.kills ?? 0,
      deaths: s.deaths ?? 0,
      assists: s.assists ?? 0,
      cs: (s.totalMinionsKilled ?? 0) + (s.neutralMinionsKilled ?? 0),
      gold: s.goldEarned ?? 0,
      damage: s.totalDamageDealtToChampions ?? 0,
      vision: s.visionScore ?? 0,
      items,
      trinket,
      spells,
      augments: this.toAugments(part),
      win: s.win === true,
    }
  }

  private failStatus(updatedAt: string): StatusResponse {
    const a = this.authState
    const client: ClientState = a && !a.ok ? a.reason : 'error'
    return {
      client,
      phase: null,
      gameId: null,
      me: null,
      authVia: null,
      error: a && !a.ok ? a.message : '客户端不可用',
      updatedAt,
    }
  }

  private async ensureClient(force = false): Promise<LcuClient | null> {
    if (!force && this.client && Date.now() - this.authAt < 10_000) return this.client
    // 上次定位失败且刚试过：短时间内直接复用结论，避免每次轮询都起一次 PowerShell
    if (!force && !this.client && Date.now() - this.authAt < 3_000) return null
    const auth = resolveAuth(this.lockfilePaths)
    this.authState = auth
    this.authAt = Date.now()
    if (!auth.ok) {
      this.client = null
      return null
    }
    if (!this.client || this.client.port !== auth.port || this.client.token !== auth.token) {
      this.client = new LcuClient(auth)
      this.resetPlayerCaches()
    }
    return this.client
  }

  /** 换局时清空玩家缓存，避免串局 */
  private noteGame(gameId: number | null): void {
    if (gameId === null) return
    if (this.lastGameId !== null && this.lastGameId !== gameId) this.resetPlayerCaches()
    this.lastGameId = gameId
  }

  private resetPlayerCaches(): void {
    this.playerCache.clear()
    this.lookupCache.clear()
    this.inflight.clear()
    this.nameCache.clear()
  }

  private async loadChampions(client: LcuClient): Promise<void> {
    if (this.championsLoaded) return
    const res = await client.get<LcuChampionSummaryItem[]>(endpoints.championSummary)
    if (res.status === 200 && Array.isArray(res.data)) {
      for (const c of res.data) if (c.id > 0 && c.name) this.champions.set(c.id, c.name)
      this.championsLoaded = true
    }
  }

  private championName(id: number | null): string | null {
    if (!id) return null
    return this.champions.get(id) ?? null
  }

  private async loadQueues(client: LcuClient): Promise<void> {
    if (this.queuesLoaded) return
    const res = await client.get<LcuQueue[]>(endpoints.queueList)
    if (res.status === 200 && Array.isArray(res.data)) {
      for (const q of res.data) {
        const name = (q.shortName ?? '').trim() || (q.name ?? '').trim()
        if (q.id > 0 && name) this.queues.set(q.id, name)
      }
    }
    // 只有连不上（status 0）才值得下次再试；业务层失败就改用人工表，不再每轮重试
    if (res.status !== 0) this.queuesLoaded = true
  }

  /** 对局模式展示名：人工短名优先，LCU 队列表补空缺 */
  private queueName(id: number | null): string | null {
    if (id === null) return null
    return QUEUE_CN[id] ?? this.queues.get(id) ?? null
  }

  /**
   * 用本局 `playerChampionSelections` 补齐不满 5 人的队伍。
   * 该数组固定 10 条：前 5 条属于 teamOne、后 5 条属于 teamTwo；
   * 归属按「该 puuid 落在哪一半」判断，不依赖 gameData 里的先后顺序。
   */
  private fillFromSelections(
    one: LcuTeamPlayer[],
    two: LcuTeamPlayer[],
    selections: LcuChampionSelection[]
  ): void {
    if (selections.length !== 10) return
    if (one.length >= 5 && two.length >= 5) return
    const firstHalf = new Set(selections.slice(0, 5).map((s) => s.puuid))
    const known = new Set([...one, ...two].map((p) => p.puuid))
    for (const s of selections) {
      const puuid = s.puuid ?? ''
      if (!puuid || known.has(puuid)) continue
      const target = firstHalf.has(puuid) ? one : two
      if (target.length >= 5) continue
      target.push({ puuid, championId: s.championId, summonerId: 0 })
      known.add(puuid)
    }
  }

  /**
   * 大厅成员 = 本人这支预组队。LCU 没有「敌方队伍怎么分组」的数据，
   * 所以组队标记只能给我方，且只在选人阶段读得到（DEC-021）。
   */
  private async readParty(client: LcuClient): Promise<{ puuids: string[] } | null> {
    const res = await client.get<LcuLobbyMember[]>(endpoints.lobbyMembers)
    if (res.status !== 200 || !Array.isArray(res.data)) return null
    const puuids = res.data.map((m) => m?.puuid).filter((v): v is string => Boolean(v))
    return puuids.length ? { puuids } : null
  }

  private async aggregate(
    client: LcuClient,
    entries: RosterEntry[],
    excludeGameId: number | null = null
  ): Promise<PlayerCard[]> {
    const cards = await Promise.all(
      entries.map(async (entry) => {
        const [snapshot, resolved] = await Promise.all([
          this.waitLimited(this.snapshot(client, entry.puuid)),
          this.resolveName(client, entry.puuid),
        ])
        return {
          puuid: entry.puuid,
          gameName: entry.gameName || resolved.gameName,
          tagLine: entry.tagLine || resolved.tagLine,
          profileIconId: resolved.profileIconId,
          side: entry.side,
          championId: entry.championId,
          championName: this.championName(entry.championId),
          rank: snapshot.rank,
          rankState: snapshot.rankState,
          recent: snapshot.recent,
          partySize: entry.partySize ?? 0,
          met: 0,
          metGames: [] as EncounterRef[],
          state: snapshot.state,
          ...(snapshot.error ? { error: snapshot.error } : {}),
        }
      })
    )
    this.attachEncounters(cards, excludeGameId)
    return cards
  }

  /**
   * 给本局每个人都标上「本地记录里遇过几次」。
   * 数据只来自本机看到过的对局，与客户端是否下发敌方信息无关（DEC-022）。
   */
  private attachEncounters(players: PlayerCard[], excludeGameId: number | null): void {
    const hits = this.encounters.against(
      players.map((p) => p.puuid),
      excludeGameId
    )
    for (const player of players) {
      const summary = hits.get(player.puuid)
      player.met = summary?.total ?? 0
      player.metGames = (summary?.recent ?? []).map((hit) => this.toEncounterRef(hit))
    }
  }

  private toEncounterRef(hit: EncounterHit): EncounterRef {
    return {
      gameId: hit.gameId,
      recordedAt: hit.recordedAt,
      queueId: hit.queueId,
      queueName: this.queueName(hit.queueId),
      championId: hit.championId,
      championName: this.championName(hit.championId),
      ally: hit.ally,
    }
  }

  /**
   * 记录本局十人名单。同一局重复上报由 store 去重，
   * 名单比上次更全时会覆盖（开局初期可能不满十人）。
   */
  private recordEncounter(
    gameId: number,
    queueId: number | null,
    selfPuuid: string,
    players: PlayerCard[]
  ): void {
    const game: EncounterGame = {
      gameId,
      recordedAt: new Date().toISOString(),
      queueId,
      selfPuuid,
      players: players
        .filter((p) => p.puuid)
        .map((p) => ({
          puuid: p.puuid,
          gameName: p.gameName,
          tagLine: p.tagLine,
          championId: p.championId,
          ally: p.side === 'ally',
        })),
    }
    this.encounters.record(game)
  }

  /** 名字 → puuid：先是 Riot ID（名字+TAG），再退化到只按名字 */
  private async findPuuid(
    client: LcuClient,
    gameName: string,
    tagLine: string
  ): Promise<{ puuid: string } | { error: string }> {
    if (!gameName) return { error: '请输入召唤师名称（格式：名字#TAG）' }

    const attempts: string[] = []
    if (tagLine) attempts.push(endpoints.summonerAlias(gameName, tagLine))
    attempts.push(endpoints.summonerByName(tagLine ? `${gameName}#${tagLine}` : gameName))
    if (tagLine) attempts.push(endpoints.summonerByName(gameName))

    let lastStatus = 0
    for (const path of attempts) {
      const res = await client.get<LcuSummoner | LcuSummoner[]>(path)
      lastStatus = res.status
      const one = Array.isArray(res.data) ? res.data[0] : res.data
      if (res.status === 200 && one?.puuid) return { puuid: one.puuid }
    }
    const query = `${gameName}${tagLine ? '#' + tagLine : ''}`
    const notFound = lastStatus === 200 || lastStatus === 404 || lastStatus === 422
    return {
      error: notFound ? `找不到「${query}」，请确认名字与 TAG` : `查询失败（HTTP ${lastStatus}）`,
    }
  }

  private async resolveName(
    client: LcuClient,
    puuid: string
  ): Promise<{ gameName: string; tagLine: string; profileIconId: number | null }> {
    const cached = this.nameCache.get(puuid)
    if (cached) return cached
    const res = await client.get<LcuSummoner>(endpoints.summonerByPuuid(puuid))
    const value =
      res.status === 200 && res.data
        ? {
            gameName: res.data.gameName ?? '',
            tagLine: res.data.tagLine ?? '',
            profileIconId: res.data.profileIconId ?? null,
          }
        : { gameName: '未知玩家', tagLine: '', profileIconId: null }
    if (res.status === 200) this.nameCache.set(puuid, value)
    return value
  }

  /**
   * 等某个玩家的快照，但最多等 PLAYER_SOFT_WAIT_MS。
   * 超时先返回「读取中」，原请求不取消，成功后写进缓存，下一轮轮询就补上了。
   */
  private waitLimited(task: Promise<PlayerSnapshot>, limitMs = PLAYER_SOFT_WAIT_MS): Promise<PlayerSnapshot> {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ rank: null, rankState: 'loading', recent: [], state: 'loading' })
      }, limitMs)
      timer.unref()
      task.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (err: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({
            rank: null,
            rankState: 'error',
            recent: [],
            state: 'error',
            error: err.message,
          })
        }
      )
    })
  }

  private async snapshot(client: LcuClient, puuid: string): Promise<PlayerSnapshot> {
    const cached = this.playerCache.get(puuid)
    if (cached) {
      const ttl = cached.value.state === 'error' ? PLAYER_ERROR_TTL_MS : PLAYER_CACHE_TTL_MS
      if (Date.now() - cached.at < ttl) return cached.value
    }

    const running = this.inflight.get(puuid)
    if (running) return running

    const task = this.fetchSnapshot(client, puuid)
      .then((value) => {
        this.playerCache.set(puuid, { at: Date.now(), value })
        return value
      })
      .catch((err: Error) => ({
        rank: null,
        rankState: 'error' as RankState,
        recent: [],
        state: 'error' as PlayerState,
        error: err.message,
      }))
      .finally(() => {
        this.inflight.delete(puuid)
      })
    this.inflight.set(puuid, task)
    return task
  }

  private async fetchSnapshot(client: LcuClient, puuid: string): Promise<PlayerSnapshot> {
    const [rankRes, matchRes] = await Promise.all([
      client.get<LcuRankedStats>(endpoints.rankedStats(puuid)),
      client.get<LcuMatchList>(endpoints.matches(puuid, RECENT_GAMES), 1, MATCH_HISTORY_TIMEOUT_MS),
    ])

    const rank = rankRes.status === 200 ? parseRank(rankRes.data) : null
    // 查询失败 ≠ 无排位；未定级由 parseRank 给出 provisional 的 rank 对象
    const rankState: RankState =
      rankRes.status !== 200 ? 'error' : rank ? 'ok' : 'unranked'

    if (matchRes.status !== 200) {
      return {
        rank,
        rankState,
        recent: [],
        state: 'error',
        error: `战绩读取失败（HTTP ${matchRes.status}${matchRes.error ? '：' + matchRes.error : ''}）`,
      }
    }

    const games = matchRes.data?.games?.games ?? []
    if (matchRes.data?.platformId) this.notePlatform(matchRes.data.platformId)
    const recent = games
      .map((g) => this.toRecord(g, puuid))
      .filter((g): g is GameRecord => g !== null)
      .slice(0, RECENT_GAMES)

    // 接口正常但一场都没有 = 战绩已隐藏，与「取数失败」区分
    if (recent.length === 0) {
      return games.length === 0
        ? { rank, rankState, recent, state: 'hidden' }
        : { rank, rankState, recent, state: 'error', error: '战绩解析为空' }
    }
    return { rank, rankState, recent, state: 'ok' }
  }

  /** 按人查询用的快照：战绩分页拉到底，单独缓存 60 秒 */
  private async lookupSnapshot(client: LcuClient, puuid: string): Promise<PlayerSnapshot> {
    const cached = this.lookupCache.get(puuid)
    if (cached && Date.now() - cached.at < 60_000) return cached.value

    const [rankRes, matches] = await Promise.all([
      client.get<LcuRankedStats>(endpoints.rankedStats(puuid)),
      this.fetchAllMatches(client, puuid),
    ])
    const rank = rankRes.status === 200 ? parseRank(rankRes.data) : null
    const rankState: RankState =
      rankRes.status !== 200 ? 'error' : rank ? 'ok' : 'unranked'

    const value: PlayerSnapshot = {
      rank,
      rankState,
      recent: matches.records,
      state: matches.state,
      ...(matches.error ? { error: matches.error } : {}),
    }
    // 只缓存成功结果，失败下一轮还能重试
    if (matches.state === 'ok' || matches.state === 'hidden') {
      this.lookupCache.set(puuid, { at: Date.now(), value })
    }
    return value
  }

  /**
   * 尽量把历史战绩拉全：LCU 只给 50 场（且对别人常对 0..49 报 500，需逐级退让），
   * 拿到大区后改走 SGP 网关（能查几百场）。SGP 失败就保留 LCU 的结果。
   */
  private async fetchAllMatches(
    client: LcuClient,
    puuid: string
  ): Promise<{ records: GameRecord[]; state: PlayerState; platformId: string | null; error?: string }> {
    const started = Date.now()
    let out: GameRecord[] = []
    let lastStatus = 0
    let lastError = ''
    let platformId: string | null = null

    for (const size of LOOKUP_LCU_SIZES) {
      const res = await client.get<LcuMatchList>(
        endpoints.matchesRange(puuid, 0, size - 1),
        0,
        size === LOOKUP_LCU_SIZES[0] ? MATCH_HISTORY_TIMEOUT_MS : 5_000
      )
      lastStatus = res.status
      if (res.status !== 200) {
        lastError = `战绩读取失败（HTTP ${res.status}${res.error ? '：' + res.error : ''}）`
        continue
      }
      platformId = res.data?.platformId ?? null
      out = (res.data?.games?.games ?? [])
        .map((game) => this.toRecord(game, puuid))
        .filter((record): record is GameRecord => record !== null)
      break
    }

    if (platformId) this.notePlatform(platformId)
    // LCU 对某个玩家 503/500 时，只要记过大区，仍然能用 SGP 把战绩查出来
    const region = platformId ?? this.platformId
    if (region) {
      const sgp = await this.fetchSgpHistory(client, puuid, region, started)
      if (sgp.length > out.length) return { records: sgp, state: 'ok', platformId: region }
    }

    if (out.length === 0) {
      if (lastStatus !== 200) {
        return { records: [], state: 'error', platformId, error: lastError || '战绩读取失败' }
      }
      return { records: [], state: 'hidden', platformId }
    }
    return { records: out, state: 'ok', platformId }
  }

  /** 记住大区并落一份到临时目录，供下次启动直接用 SGP */
  private notePlatform(platformId: string): void {
    if (platformId === this.platformId) return
    this.platformId = platformId
    try {
      fs.writeFileSync(REGION_CACHE_FILE, platformId)
    } catch {
      // 写不进去只影响下次启动的兜底，不影响本次查询
    }
  }

  /** SGP 分页拉历史；任何一步失败都只返回已拿到的部分，由调用方与 LCU 结果比长度 */
  private async fetchSgpHistory(
    client: LcuClient,
    puuid: string,
    platformId: string,
    started: number
  ): Promise<GameRecord[]> {
    const host = sgpHost(platformId)
    if (!host) return []
    const tokenRes = await client.get<LcuEntitlements>(endpoints.entitlements)
    const token = tokenRes.data?.accessToken
    if (!token) return []

    const out: GameRecord[] = []
    const seen = new Set<number>()
    for (let start = 0; out.length < LOOKUP_MAX_GAMES; start += SGP_PAGE_SIZE) {
      const page = await fetchSgpMatches(host, token, puuid, start, SGP_PAGE_SIZE)
      const games = page?.games ?? []
      if (games.length === 0) break
      let added = 0
      for (const entry of games) {
        const record = entry.json ? this.fromSgpGame(entry.json, puuid) : null
        if (!record || seen.has(record.gameId)) continue
        seen.add(record.gameId)
        out.push(record)
        added += 1
      }
      if (added === 0) break
      if (games.length < SGP_PAGE_SIZE) break
      if (Date.now() - started >= LOOKUP_MAX_MS) break
    }
    return out
  }

  /** SGP 的 match-v5 扁平结构 → 与 LCU 一致的 GameRecord */
  private fromSgpGame(game: SgpMatchGame, puuid: string): GameRecord | null {
    const me = (game.participants ?? []).find((p) => p.puuid === puuid)
    if (!me || !game.gameId) return null
    const championId = me.championId ?? null
    const queueId = game.queueId ?? null
    return {
      gameId: game.gameId,
      win: me.win === true,
      championId,
      championName: this.championName(championId),
      kills: me.kills ?? 0,
      deaths: me.deaths ?? 0,
      assists: me.assists ?? 0,
      queueId,
      queueName: this.queueName(queueId),
      durationSec: game.gameDuration ?? null,
      endedAt: game.gameCreation ? new Date(game.gameCreation).toISOString() : null,
    }
  }

  private toRecord(game: LcuMatchGame, puuid: string): GameRecord | null {
    const identity = (game.participantIdentities ?? []).find(
      (i) => i.player?.puuid === puuid
    )
    if (!identity) return null
    const participant = (game.participants ?? []).find(
      (p) => p.participantId === identity.participantId
    )
    const stats = participant?.stats
    if (!participant || !stats) return null

    const championId = participant.championId ?? null
    const queueId = game.queueId ?? null
    return {
      gameId: game.gameId,
      win: stats.win === true,
      championId,
      championName: this.championName(championId),
      kills: stats.kills ?? 0,
      deaths: stats.deaths ?? 0,
      assists: stats.assists ?? 0,
      queueId,
      queueName: this.queueName(queueId),
      durationSec: game.gameDuration ?? null,
      endedAt: game.gameCreation ? new Date(game.gameCreation).toISOString() : null,
    }
  }
}
