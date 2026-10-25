// 仅开发期使用：不依赖真实对局预览四种界面状态（?mock=ingame|champselect|idle|denied|notrunning）

import type {
  BoardResponse,
  GameRecord,
  LookupResponse,
  MatchAugment,
  MatchDetailResponse,
  MatchPlayerDetail,
  PlayerCard,
  RankInfo,
  StatusResponse,
} from './types'

const CHAMPS = [29, 222, 76, 24, 51, 805, 893, 106, 202, 30, 103, 157, 64, 268, 555]

const QUEUES: Array<[number, string]> = [
  [420, '单双排'],
  [440, '灵活排'],
  [450, '大乱斗'],
  [2400, '海克斯乱斗'],
  [400, '匹配'],
  [2450, '海克斯乱斗(经典)'],
]

function rand(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function gamesFor(seed: number, mainChamp: number, count = 10): GameRecord[] {
  const r = rand(seed)
  return Array.from({ length: count }, (_, i) => {
    const championId = r() > 0.55 ? mainChamp : CHAMPS[Math.floor(r() * CHAMPS.length)]
    const [queueId, queueName] = QUEUES[Math.floor(r() * QUEUES.length)]
    return {
      gameId: 401159000000 + seed * 100 + i,
      win: r() > 0.45,
      championId,
      championName: null,
      kills: Math.floor(r() * 15),
      deaths: Math.floor(r() * 10),
      assists: Math.floor(r() * 30),
      queueId,
      queueName,
      durationSec: 1200 + Math.floor(r() * 600),
      endedAt: null,
    }
  })
}

function rank(tier: string, division: string, lp: number): RankInfo {
  return {
    queue: 'RANKED_SOLO_5x5',
    tier,
    division,
    lp,
    wins: 20 + lp,
    losses: 15,
    provisional: false,
    label: `${tier} ${division} ${lp}LP`,
  }
}

const unranked = (): RankInfo => ({
  queue: 'RANKED_SOLO_5x5',
  tier: '',
  division: '',
  lp: 0,
  wins: 0,
  losses: 0,
  provisional: true,
  label: '未定级',
})

interface Seed {
  name: string
  tag: string
  champion: number
  /** 资料图标 id（召唤师头像） */
  icon: number
  rank: RankInfo | null
  state?: 'ok' | 'hidden' | 'error'
}

// 全部为虚构玩家名，避免把真实对局里的召唤师名带进仓库
const ALLY: Seed[] = [
  { name: '示例玩家01', tag: '10001', champion: 222, icon: 29, rank: rank('EMERALD', 'III', 27) },
  { name: '示例玩家02', tag: '10002', champion: 76, icon: 4568, rank: rank('GOLD', 'I', 47) },
  { name: '示例玩家03', tag: '10003', champion: 24, icon: 5212, rank: rank('PLATINUM', 'IV', 17) },
  { name: '示例玩家04', tag: '10004', champion: 51, icon: 907, rank: unranked(), state: 'hidden' },
  { name: '示例玩家05', tag: '10005', champion: 59, icon: 1387, rank: rank('EMERALD', 'IV', 7) },
]

const ENEMY: Seed[] = [
  { name: '示例玩家06', tag: '20001', champion: 29, icon: 3554, rank: rank('BRONZE', 'III', 87) },
  { name: '示例玩家07', tag: '20002', champion: 412, icon: 3789, rank: unranked() },
  { name: '示例玩家08', tag: '20003', champion: 161, icon: 502, rank: unranked() },
  { name: '示例玩家09', tag: '20004', champion: 36, icon: 616, rank: rank('GOLD', 'III', 23) },
  { name: '示例玩家10', tag: '20005', champion: 30, icon: 4218, rank: null },
]

function toCard(seed: Seed, index: number, side: 'ally' | 'enemy', gameCount = 10): PlayerCard {
  const state = seed.state ?? 'ok'
  return {
    puuid: `${side}-${index}`,
    gameName: seed.name,
    tagLine: seed.tag,
    profileIconId: seed.icon,
    side,
    championId: seed.champion,
    championName: null,
    rank: seed.rank,
    rankState: seed.rank ? 'ok' : 'unranked',
    recent: state === 'ok' ? gamesFor(index + (side === 'ally' ? 3 : 11), seed.champion, gameCount) : [],
    state,
  }
}

export function mockLookup(name: string): LookupResponse {
  const key = name.trim()
  const pool = [...ALLY, ...ENEMY]
  // 空输入代表「查自己」
  const hit = !key
    ? ALLY[0]
    : pool.find((s) => key === `${s.name}#${s.tag}` || key === s.name)
  const updatedAt = new Date().toISOString()
  if (!hit) {
    return {
      ok: false,
      query: key,
      player: null,
      updatedAt,
      tookMs: 96,
      error: `找不到「${key}」，请确认名字与 TAG`,
    }
  }
  return {
    ok: true,
    query: `${hit.name}#${hit.tag}`,
    // 查询他人时展示尽量多的历史（真实后端也是分页拉到底）
    player: toCard(hit, 0, 'ally', 40),
    updatedAt,
    tookMs: 142,
  }
}

const MOCK_ITEMS = [3153, 6672, 3006, 3031, 3072, 3047, 3089]
const MOCK_SPELLS: Array<[number, number]> = [
  [4, 12],
  [4, 14],
  [7, 4],
  [3, 4],
  [11, 4],
]

/** 海克斯（真实 id / 中文名，取自 cherry-augments.json） */
const MOCK_AUGMENTS: MatchAugment[] = [
  { id: 3116, name: '将他们放倒倒倒', rarity: 'gold' },
  { id: 1058, name: '秘术冲拳', rarity: 'prismatic' },
  { id: 1029, name: '虚幻武器', rarity: 'gold' },
  { id: 3131, name: '屹立不倒', rarity: 'gold' },
  { id: 2129, name: '地形专家', rarity: 'gold' },
]

/** 单场详情（仅开发期预览用）：双方十人、胜负与各项数据 */
export function mockMatchDetail(gameId: number, puuid: string): MatchDetailResponse {
  const viewerIsEnemy = puuid.startsWith('enemy')
  const allySeeds = viewerIsEnemy ? ENEMY : ALLY
  const enemySeeds = viewerIsEnemy ? ALLY : ENEMY
  const r = rand((gameId % 99991) || 7)
  const allyWin = r() > 0.45
  const durationSec = 1200 + Math.floor(r() * 900)

  const build = (seed: Seed, i: number, side: 'ally' | 'enemy', win: boolean): MatchPlayerDetail => ({
    puuid: `${side}-${i}`,
    gameName: seed.name,
    tagLine: seed.tag,
    profileIconId: seed.icon,
    side,
    championId: seed.champion,
    championName: null,
    level: 10 + Math.floor(r() * 8),
    kills: Math.floor(r() * 15),
    deaths: Math.floor(r() * 10),
    assists: Math.floor(r() * 25),
    cs: Math.floor(r() * 260),
    gold: 7000 + Math.floor(r() * 12000),
    damage: 4000 + Math.floor(r() * 26000),
    vision: Math.floor(r() * 40),
    items: MOCK_ITEMS.slice(0, 4 + Math.floor(r() * 3)),
    trinket: MOCK_ITEMS[MOCK_ITEMS.length - 1],
    spells: MOCK_SPELLS[i % MOCK_SPELLS.length],
    // 海克斯大乱斗模板：每人 3–4 个海克斯（真实 id / 中文名，走真实清单的图标代理）
    augments: MOCK_AUGMENTS.slice(i % 2, (i % 2) + 3 + (i % 2)),
    win,
  })

  return {
    ok: true,
    gameId,
    queueId: 2400,
    queueName: '海克斯乱斗',
    template: 'augments',
    durationSec,
    endedAt: new Date(Date.now() - Math.floor(r() * 86400000)).toISOString(),
    teams: [
      { side: 'ally', players: allySeeds.map((s, i) => build(s, i, 'ally', allyWin)) },
      { side: 'enemy', players: enemySeeds.map((s, i) => build(s, i, 'enemy', !allyWin)) },
    ],
    updatedAt: new Date().toISOString(),
    tookMs: 168,
  }
}

export function mockBoard(kind: string): BoardResponse {
  const base: BoardResponse = {
    ok: true,
    phase: 'InProgress',
    gameId: 401160143927,
    queueId: 2400,
    selfPuuid: 'ally-0',
    teams: [],
    enemyHidden: false,
    updatedAt: new Date().toISOString(),
    tookMs: 486,
  }

  if (kind === 'champselect') {
    return {
      ...base,
      phase: 'ChampSelect',
      teams: [{ side: 'ally', players: ALLY.map((s, i) => toCard(s, i, 'ally')) }],
      enemyHidden: true,
      tookMs: 512,
    }
  }
  if (kind === 'warming') {
    return {
      ...base,
      ok: false,
      phase: 'InProgress',
      teams: [],
      error: '对局名单尚未生成',
    }
  }
  if (kind === 'idle') {
    return { ...base, phase: 'None', gameId: null, queueId: null, selfPuuid: null, teams: [] }
  }
  if (kind === 'denied') {
    return {
      ...base,
      ok: false,
      phase: 'access_denied',
      gameId: null,
      queueId: null,
      teams: [],
      error:
        '检测到客户端进程，但当前权限不足（国服客户端常以管理员运行）。请以管理员身份重新启动本程序。',
    }
  }
  if (kind === 'notrunning') {
    return {
      ...base,
      ok: false,
      phase: 'not_running',
      gameId: null,
      queueId: null,
      teams: [],
      error: '未检测到英雄联盟客户端，请先启动客户端并登录。',
    }
  }
  return {
    ...base,
    teams: [
      { side: 'ally', players: ALLY.map((s, i) => toCard(s, i, 'ally')) },
      { side: 'enemy', players: ENEMY.map((s, i) => toCard(s, i, 'enemy')) },
    ],
  }
}

/** 轻量状态轮询（mock 版）：只反映阶段，不返回任何战绩 */
export function mockStatus(kind: string): StatusResponse {
  const base: StatusResponse = {
    client: 'connected',
    phase: kind === 'champselect' ? 'ChampSelect' : kind === 'idle' ? 'None' : 'InProgress',
    gameId: kind === 'idle' ? null : 401160143927,
    me: { puuid: 'ally-0', gameName: '示例玩家01', tagLine: '10001' },
    authVia: '进程参数',
    updatedAt: new Date().toISOString(),
  }
  if (kind === 'denied') {
    return { ...base, client: 'access_denied', phase: null, gameId: null, me: null, error: '当前权限不足' }
  }
  if (kind === 'notrunning') {
    return { ...base, client: 'not_running', phase: null, gameId: null, me: null }
  }
  return base
}
