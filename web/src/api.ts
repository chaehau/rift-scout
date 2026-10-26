import type {
  BoardResponse,
  LookupResponse,
  MatchDetailResponse,
  SettingsResponse,
  StatusResponse,
} from './types'
import {
  mockBoard,
  mockLookup,
  mockMatchDetail,
  mockSaveSettings,
  mockSettings,
  mockStatus,
} from './mock'

const params = new URLSearchParams(location.search)
const mockKind = import.meta.env.DEV ? params.get('mock') : null

/** 取英雄头像：走桥接代理，前端不直连 LCU */
export function iconUrl(id: number | null | undefined): string {
  return id ? `/api/champion-icon/${id}.png` : ''
}

/** 召唤师头像（资料图标） */
export function profileIconUrl(id: number | null | undefined): string {
  return id ? `/api/profile-icon/${id}.jpg` : ''
}

/** 装备图标 */
export function itemIconUrl(id: number): string {
  return `/api/item-icon/${id}.png`
}

/** 召唤师技能图标 */
export function spellIconUrl(id: number): string {
  return `/api/spell-icon/${id}.png`
}

/** 海克斯图标（斗魂 / 海克斯大乱斗） */
export function augmentIconUrl(id: number): string {
  return `/api/augment-icon/${id}.png`
}

/** 轻量状态：只看客户端连通性与当前阶段，不查任何人的战绩 */
export async function fetchStatus(): Promise<StatusResponse> {
  if (mockKind) {
    await new Promise((r) => setTimeout(r, 60))
    if (mockKind === 'offline') throw new Error('无法连接 http://127.0.0.1:8737')
    return mockStatus(mockKind)
  }
  const res = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`桥接服务返回 ${res.status}`)
  return (await res.json()) as StatusResponse
}

/** 面板数据；refresh=true 时绕过桥接侧玩家缓存（用户手动刷新） */
export async function fetchBoard(refresh = false): Promise<BoardResponse> {
  if (mockKind) {
    await new Promise((r) => setTimeout(r, 120))
    if (mockKind === 'offline') throw new Error('无法连接 http://127.0.0.1:8737')
    return mockBoard(mockKind)
  }
  // 超时兜底：选人阶段客户端很忙，请求可能长时间无响应
  const res = await fetch(`/api/board${refresh ? '?refresh=1' : ''}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`桥接服务返回 ${res.status}`)
  return (await res.json()) as BoardResponse
}

/** 按「名字#TAG」查历史战绩；name 为空表示查自己。puuid 已知时直接按它查，省掉名字解析 */
export async function fetchLookup(name: string, puuid = ''): Promise<LookupResponse> {
  if (mockKind) {
    await new Promise((r) => setTimeout(r, 120))
    if (mockKind === 'offline') throw new Error('无法连接 http://127.0.0.1:8737')
    return mockLookup(name)
  }
  const params = new URLSearchParams({ name })
  if (puuid) params.set('puuid', puuid)
  const res = await fetch(`/api/lookup?${params.toString()}`, {
    cache: 'no-store',
    // 冷缓存首取可能要几秒，留够余量
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`桥接服务返回 ${res.status}`)
  return (await res.json()) as LookupResponse
}

/** 单场对局详情；puuid 决定「我方/敌方」视角 */
export async function fetchMatchDetail(gameId: number, puuid: string): Promise<MatchDetailResponse> {
  if (mockKind) {
    await new Promise((r) => setTimeout(r, 160))
    if (mockKind === 'offline') throw new Error('无法连接 http://127.0.0.1:8737')
    return mockMatchDetail(gameId, puuid)
  }
  const query = puuid ? `?puuid=${encodeURIComponent(puuid)}` : ''
  const res = await fetch(`/api/match/${gameId}${query}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`桥接服务返回 ${res.status}`)
  return (await res.json()) as MatchDetailResponse
}

/** 读取本地记录的保存位置与已记录局数 */
export async function fetchSettings(): Promise<SettingsResponse> {
  if (mockKind) {
    await new Promise((r) => setTimeout(r, 80))
    if (mockKind === 'offline') throw new Error('无法连接 http://127.0.0.1:8737')
    return mockSettings()
  }
  const res = await fetch('/api/settings', { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`桥接服务返回 ${res.status}`)
  return (await res.json()) as SettingsResponse
}

/** 保存新的保存位置；dataDir 为空表示恢复默认 */
export async function saveSettings(dataDir: string): Promise<SettingsResponse> {
  if (mockKind) {
    await new Promise((r) => setTimeout(r, 120))
    if (mockKind === 'offline') throw new Error('无法连接 http://127.0.0.1:8737')
    return mockSaveSettings(dataDir)
  }
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataDir }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`桥接服务返回 ${res.status}`)
  return (await res.json()) as SettingsResponse
}
