#!/usr/bin/env node
// R1 全量探测脚本：一次运行尽量覆盖当前阶段所有可得信息（选人窗口很短，必须打满）
// 用法：
//   node scripts/lcu-probe.mjs                   # 全量探测 + 自动聚合当前名单
//   node scripts/lcu-probe.mjs --no-aggregate    # 只探测，不批量拉战绩（更快）
//   node scripts/lcu-probe.mjs --name=名字#TAG    # 额外验证按名解析他人并拉战绩
//   node scripts/lcu-probe.mjs --lockfile=D:\xx\lockfile
// 产物：所有原始响应写入 %TEMP%\lcu-probe-dump\<时间戳>\，避免控制台截断导致信息丢失
// 说明：本脚本只读，不修改客户端与游戏任何状态。

import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REQUEST_TIMEOUT = 8000
// 实测：请求区间写 0~49 会让冷 puuid 一次拉 50 场，十人并发直接压崩（7/10 超时）。
// 用 0~9 即可——冷缓存本就会忽略区间返回 20~50 场，稳定且够切出近 10 场。
const RECENT = 10

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=')
      return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]
    })
)

// 英雄 id → 名称，来自客户端本地资产（不联网）
const championNames = new Map()

function championLabel(id) {
  if (!id) return null
  const name = championNames.get(id)
  return name ? `${name}(${id})` : String(id)
}

// ---------- 产物落盘 ----------

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dumpDir = path.join(os.tmpdir(), 'lcu-probe-dump', stamp)

function dump(name, data) {
  try {
    fs.mkdirSync(dumpDir, { recursive: true })
    fs.writeFileSync(path.join(dumpDir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8')
  } catch (e) {
    console.log(`（写入 ${name}.json 失败：${e.message}）`)
  }
}

// ---------- 基础请求 ----------

function requestJson(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: 'GET', headers, rejectUnauthorized: false, timeout: REQUEST_TIMEOUT },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(body)
          } catch {
            /* 非 JSON 响应，保留原文 */
          }
          resolve({ status: res.statusCode, json, text: body.slice(0, 300) })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, error: 'timeout' })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.end()
  })
}

function lcuClient(port, token) {
  const auth = 'Basic ' + Buffer.from(`riot:${token}`).toString('base64')
  return (p) => requestJson(`https://127.0.0.1:${port}${p}`, { Authorization: auth, Accept: 'application/json' })
}

async function lcuGet(lcu, p, retries = 2) {
  // 十人并发时偶发超时（status 0），退避重试一次即可恢复
  let res = await lcu(p)
  for (let i = 0; i < retries && res.status === 0; i++) {
    await new Promise((r) => setTimeout(r, 500))
    res = await lcu(p)
  }
  return res
}

// ---------- 客户端定位 ----------

function parseClientArgs(cmdline) {
  const port = cmdline.match(/--app-port=(\d+)/)?.[1]
  const token = cmdline.match(/--remoting-auth-token=([^\s"]+)/)?.[1]
  return port && token ? { port: Number(port), token, via: '进程参数' } : null
}

function fromProcess() {
  // 优先 PowerShell CIM（同用户进程通常无需管理员）
  try {
    const script =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
      'Get-CimInstance Win32_Process -Filter "Name=\'LeagueClientUx.exe\'" | Select-Object -ExpandProperty CommandLine'
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
    })
    for (const line of out.split(/\r?\n/)) {
      const hit = parseClientArgs(line)
      if (hit) return hit
    }
  } catch {
    /* 继续尝试下一种方式 */
  }

  // 备用：wmic（Win11 可能已移除）
  try {
    const out = execFileSync('wmic', ['process', 'where', "name='LeagueClientUx.exe'", 'get', 'commandline', '/value'], {
      encoding: 'utf8',
      timeout: 15000,
    })
    const hit = parseClientArgs(out)
    if (hit) return hit
  } catch {
    /* 忽略 */
  }

  return null
}

function parseLockfile(content) {
  // 格式：LeagueClient:PID:PORT:PASSWORD:https
  const parts = content.trim().split(':')
  if (parts.length < 4) return null
  const port = Number(parts[2])
  const token = parts[3]
  return Number.isFinite(port) && token ? { port, token, via: 'lockfile' } : null
}

function fromLockfile() {
  const candidates = [
    args.lockfile,
    process.env.LOL_LOCKFILE,
    'C:\\Riot Games\\League of Legends\\lockfile',
    'C:\\WeGameApps\\英雄联盟\\LeagueClient\\lockfile',
    'D:\\WeGameApps\\英雄联盟\\LeagueClient\\lockfile',
    'C:\\Program Files\\腾讯游戏\\英雄联盟\\LeagueClient\\lockfile',
  ].filter(Boolean)

  for (const p of candidates) {
    try {
      const parsed = parseLockfile(fs.readFileSync(p, 'utf8'))
      if (parsed) return { ...parsed, via: `${parsed.via} ${p}` }
    } catch {
      /* 该候选不存在，继续 */
    }
  }
  return null
}

// ---------- 输出工具 ----------

function isAdmin() {
  // 国服客户端常以更高权限运行；非管理员会读不到它的命令行，这里先自报状态
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

function title(n, text) {
  console.log(`\n=== ${n}. ${text} ===`)
}

function brief(value, max = 600) {
  const s = JSON.stringify(value, null, 2) ?? String(value)
  return s.length > max ? s.slice(0, max) + ' …(截断)' : s
}

function keysOf(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).join(', ') : ''
}

// ---------- 数据解析 ----------

function gamesOf(res) {
  return res.json?.games?.games ?? res.json?.games ?? []
}

function pickParticipant(game, puuid) {
  const identity = (game.participantIdentities || []).find((i) => i.player?.puuid === puuid)
  return (game.participants || []).find((p) => p.participantId === identity?.participantId) || {}
}

function summarizeGame(game, puuid) {
  const me = pickParticipant(game, puuid)
  const s = me.stats || {}
  return {
    对局ID: game.gameId,
    开始时间: game.gameCreation ? new Date(game.gameCreation).toLocaleString('zh-CN') : null,
    时长分钟: game.gameDuration ? Math.round(game.gameDuration / 60) : null,
    模式: game.gameMode ?? null,
    队列: game.queueId ?? null,
    英雄: championLabel(me.championId),
    结果: s.win === true ? '胜' : s.win === false ? '负' : null,
    KDA: `${s.kills ?? '?'}/${s.deaths ?? '?'}/${s.assists ?? '?'}`,
  }
}

function recentForm(games, puuid) {
  let win = 0
  let loss = 0
  let k = 0
  let d = 0
  let a = 0
  for (const g of games) {
    const s = pickParticipant(g, puuid).stats || {}
    if (s.win === true) win++
    else if (s.win === false) loss++
    k += s.kills ?? 0
    d += s.deaths ?? 0
    a += s.assists ?? 0
  }
  const n = games.length || 1
  return {
    近10场: `${win}胜${loss}负`,
    场均KDA: `${(k / n).toFixed(1)}/${(d / n).toFixed(1)}/${(a / n).toFixed(1)}`,
  }
}

function rankLabel(json) {
  if (!json) return '查询失败'
  const entry = json.queueMap?.RANKED_SOLO_5x5 ?? json.highestRankedEntry ?? null
  if (!entry) return '无排位'
  // tier 为空串 = 本赛季未定级（isProvisional），与「没有排位记录」要分开
  if (!entry.tier) return entry.isProvisional ? '未定级' : '无排位'
  return `${entry.tier} ${entry.division ?? ''} ${entry.leaguePoints ?? 0}LP`.trim()
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// ---------- 名单解析 ----------

function fromGameflowSession(json) {
  const gd = json?.gameData || {}
  const teamOne = gd.teamOne || []
  const teamTwo = gd.teamTwo || []
  return {
    teamOne,
    teamTwo,
    all: [...teamOne, ...teamTwo],
    picks: gd.playerChampionSelections || [],
  }
}

function fromChampSelect(json) {
  const map = (list) =>
    (list || []).map((m) => ({
      cellId: m.cellId ?? null,
      puuid: m.puuid ?? null,
      summonerId: m.summonerId ?? null,
      championId: m.championId ?? null,
      championPickIntent: m.championPickIntent ?? null,
      assignedPosition: m.assignedPosition ?? '',
      team: m.team ?? null,
    }))
  return { myTeam: map(json?.myTeam), theirTeam: map(json?.theirTeam) }
}

// ---------- 聚合 ----------

async function aggregate(lcu, list, myPuuid) {
  const t0 = Date.now()
  const rows = await mapLimit(list, 5, async (p) => {
    const [h, r, s] = await Promise.all([
      lcuGet(lcu, `/lol-match-history/v1/products/lol/${p.puuid}/matches?begIndex=0&endIndex=${RECENT - 1}`),
      lcuGet(lcu, `/lol-ranked/v1/ranked-stats/${p.puuid}`),
      lcuGet(lcu, `/lol-summoner/v2/summoners/puuid/${p.puuid}`),
    ])
    const tag = p.puuid.slice(0, 8)
    dump(`player-${tag}-match`, h.json ?? { status: h.status, error: h.error, text: h.text })
    dump(`player-${tag}-rank`, r.json ?? { status: r.status, error: r.error, text: r.text })
    dump(`player-${tag}-summoner`, s.json ?? { status: s.status, error: s.error, text: s.text })

    const all = gamesOf(h)
    const games = all.slice(0, RECENT)
    const name = s.status === 200 ? `${s.json.gameName}#${s.json.tagLine}` : '未知'
    // 产品要求：逐场展示该场胜负、所用英雄、该场 KDA，不能只给汇总裁剪
    const 逐场 = games.map((g) => {
      const part = pickParticipant(g, p.puuid)
      const st = part.stats || {}
      const result = st.win === true ? '胜' : st.win === false ? '负' : '?'
      const champ = championNames.get(part.championId) ?? `#${part.championId ?? '?'}`
      return `${result} ${champ} ${st.kills ?? 0}/${st.deaths ?? 0}/${st.assists ?? 0}`
    })
    return {
      队: p.team,
      我: p.puuid === myPuuid ? '★' : '',
      召唤师: name,
      puuid: p.puuid,
      本局英雄: championLabel(p.championId || p.championPickIntent),
      段位: r.status === 200 ? rankLabel(r.json) : '查询失败',
      返回场次: all.length,
      取用场次: games.length,
      ...(games.length ? recentForm(games, p.puuid) : { 近10场: '战绩不可见', 场均KDA: '—' }),
      逐场,
      HTTP: `${h.status}/${r.status}/${s.status}`,
    }
  })
  return { rows, cost: Date.now() - t0 }
}

// ---------- 主流程 ----------

async function main() {
  title(1, '客户端定位')
  console.log(`当前会话管理员权限：${isAdmin() ? '是' : '否（若客户端以管理员运行，将读不到其命令行）'}`)
  const client = fromProcess() || fromLockfile()
  if (!client) {
    console.log('未找到运行中的英雄联盟客户端。')
    console.log('请启动客户端并登录后重试；若客户端已启动，可用 --lockfile=<安装目录>\\lockfile 指定。')
    process.exitCode = 1
    return
  }
  console.log(`定位成功：端口 ${client.port}（来源：${client.via}），口令已获取（${client.token.length} 位）`)
  const lcu = lcuClient(client.port, client.token)

  title(2, 'LCU 连通性与当前账号')
  const self = await lcu('/lol-summoner/v1/current-summoner')
  if (self.status !== 200 || !self.json) {
    console.log(`失败：HTTP ${self.status} ${self.error ?? self.text ?? ''}`)
    process.exitCode = 1
    return
  }
  const me = self.json
  dump('summoner-self', me)
  console.log(`当前账号：${me.gameName ?? me.displayName ?? '?'}#${me.tagLine ?? ''}  puuid=${me.puuid}`)
  console.log(`召唤师等级：${me.summonerLevel ?? '?'}  顶层字段：${keysOf(me)}`)

  // 英雄 id → 名称：客户端自带资产，避免联网（红线：不联网取数）
  const champions = await lcu('/lol-game-data/assets/v1/champion-summary.json')
  if (champions.status === 200 && Array.isArray(champions.json)) {
    for (const c of champions.json) if (c.id > 0 && c.name) championNames.set(c.id, c.name)
    dump('champion-summary', champions.json)
    console.log(`英雄名映射：HTTP 200，共 ${championNames.size} 个（客户端本地资产，无需联网）`)
  } else {
    console.log(`英雄名映射不可用（HTTP ${champions.status}），逐场只显示英雄 ID`)
  }

  title(3, '游戏阶段 gameflow-phase')
  const phase = await lcu('/lol-gameflow/v1/gameflow-phase')
  const phaseName = phase.json ?? phase.error ?? phase.status
  console.log(`阶段：${phaseName}`)
  const inChampSelect = phaseName === 'ChampSelect'
  const inGame = phaseName === 'InProgress'

  title(4, 'gameflow session（名单主数据源）')
  const flow = await lcu('/lol-gameflow/v1/session')
  dump('gameflow-session', flow.json ?? { status: flow.status, error: flow.error, text: flow.text })
  const gs = fromGameflowSession(flow.json)
  const flowGameId = flow.json?.gameData?.gameId ?? null
  const flowGamePhase = flow.json?.gameData?.phase ?? null
  let flowPlayers = gs.all
  if (flow.status === 200 && flow.json) {
    console.log(`顶层字段：${keysOf(flow.json)}`)
    console.log(`gameData 字段：${keysOf(flow.json.gameData)}`)
    console.log(`gameData.gameId=${flowGameId ?? '无'}  gameData.phase=${flowGamePhase ?? '无'}  外层 phase=${flow.json.phase ?? '?'}`)
    console.log(`teamOne ${gs.teamOne.length} 人 / teamTwo ${gs.teamTwo.length} 人 / playerChampionSelections ${gs.picks.length} 条`)
    if (flowPlayers.length) {
      console.log(`含 puuid：${flowPlayers.filter((p) => p.puuid).length}/${flowPlayers.length}`)
      console.log('队伍成员字段：' + keysOf(flowPlayers[0]))
      const mineInOne = gs.teamOne.some((p) => p.puuid === me.puuid)
      const mineInTwo = gs.teamTwo.some((p) => p.puuid === me.puuid)
      console.log(`本人在：${mineInOne ? 'teamOne' : mineInTwo ? 'teamTwo' : '不在这两队里（异常）'}`)
      console.log('首个玩家原始数据：\n' + brief(flowPlayers[0], 1200))
    } else {
      // 选人阶段 gameData 为空是正常的，此处打印阶段便于确认
      console.log(`gameData 为空（当前阶段 ${flow.json.phase ?? phaseName}），属正常`)
    }
    if (gs.picks.length) console.log('playerChampionSelections 首条：\n' + brief(gs.picks[0], 600))
  } else {
    console.log(`不可用（HTTP ${flow.status}）：不在选人/对局阶段属正常`)
  }

  title(5, '选人会话 champ-select/session（敌方身份重点看这里）')
  const champSelect = await lcu('/lol-champ-select/v1/session')
  dump('champ-select-session', champSelect.json ?? { status: champSelect.status, error: champSelect.error, text: champSelect.text })
  let cs = { myTeam: [], theirTeam: [] }
  if (champSelect.status === 200 && champSelect.json) {
    const raw = champSelect.json
    cs = fromChampSelect(raw)
    console.log(`顶层字段：${keysOf(raw)}`)
    console.log(`localPlayerCellId=${raw.localPlayerCellId ?? '?'}  timer=${brief(raw.timer, 200)}`)
    console.log(`myTeam ${cs.myTeam.length} 人 / theirTeam ${cs.theirTeam.length} 人`)
    console.log(`myTeam 条目字段：${raw.myTeam?.[0] ? keysOf(raw.myTeam[0]) : '无'}`)
    console.log(`theirTeam 条目字段：${raw.theirTeam?.[0] ? keysOf(raw.theirTeam[0]) : '无'}`)
    console.log(`myTeam 含 puuid：${cs.myTeam.filter((m) => m.puuid).length}/${cs.myTeam.length}`)
    console.log(`theirTeam 含 puuid：${cs.theirTeam.filter((m) => m.puuid).length}/${cs.theirTeam.length}`)
    const vis = [...new Set((raw.theirTeam || []).map((m) => m.nameVisibilityType))]
    if (vis.length) console.log(`theirTeam 可见性：${vis.join(',')}（HIDDEN 表示官方就不给敌方身份）`)
    console.log(`myTeam：\n${brief(cs.myTeam, 1600)}`)
    console.log(`theirTeam：\n${brief(cs.theirTeam, 1600)}`)
    if (raw.theirTeam?.[0]) console.log('theirTeam 首条原始数据：\n' + brief(raw.theirTeam[0], 900))
    console.log(`myTeamBans=${(raw.myTeamBans || []).length} theirTeamBans=${(raw.theirTeamBans || []).length}`)
    const actionTypes = (raw.actions || []).flat().map((a) => a.type)
    console.log(`actions 组数=${(raw.actions || []).length} 类型=${[...new Set(actionTypes)].join(',') || '无'}`)
    // 选人阶段 gameData 可能仍是上一局的残留：用 gameId 与选人会话比对
    if (inChampSelect && flowPlayers.length && flowGameId && raw.gameId && flowGameId !== raw.gameId) {
      console.log(
        `⚠ gameflow session 的 gameData 是上一局残留（gameId ${flowGameId} ≠ 本局 ${raw.gameId}，gameData.phase=${flowGamePhase ?? '?'}），选人阶段不可使用`
      )
    }
  } else {
    console.log(`当前不在选人阶段（HTTP ${champSelect.status}）`)
  }

  title(6, '游戏内 Live Client Data (127.0.0.1:2999)')
  const live = await requestJson('https://127.0.0.1:2999/liveclientdata/allgamedata')
  dump('liveclientdata', live.json ?? { status: live.status, error: live.error, text: live.text })
  let livePlayers = []
  if (live.status === 200 && live.json) {
    livePlayers = live.json.allPlayers || []
    console.log(`对局中：共 ${livePlayers.length} 名玩家，顶层字段：${keysOf(live.json)}`)
    const game = live.json.gameData || {}
    console.log(`模式=${game.gameMode ?? '?'} 队列=${game.queueId ?? '?'} 已进行=${game.gameTime ?? '?'}s`)
    if (livePlayers[0]) console.log('玩家对象字段：' + keysOf(livePlayers[0]))
    console.log(
      brief(
        livePlayers.map((p) => ({
          riotId: p.riotId ?? null,
          championName: p.championName,
          team: p.team,
          position: p.position ?? null,
          isBot: p.isBot ?? null,
          scores: p.scores ?? null,
        })),
        2200
      )
    )
    // 2999 没有 puuid：只能作为名字/英雄的交叉校验来源
    console.log(`2999 是否含 puuid：${livePlayers.some((p) => 'puuid' in p) ? '是' : '否（需用 LCU 名单换 puuid）'}`)
  } else {
    console.log(`对局内接口不可用（HTTP ${live.status} ${live.error ?? ''}）：未在游戏中属正常`)
  }

  title(7, '召唤师名 → puuid（验证「查别人」）')
  let targetPuuid = me.puuid
  if (args.name && typeof args.name === 'string') {
    const byName = await lcu(`/lol-summoner/v1/summoners?name=${encodeURIComponent(args.name)}`)
    if (byName.status === 200 && byName.json?.puuid) {
      targetPuuid = byName.json.puuid
      console.log(`解析成功：${byName.json.gameName ?? args.name}#${byName.json.tagLine ?? ''}  puuid=${targetPuuid}`)
    } else {
      console.log(`解析失败：HTTP ${byName.status} ${brief(byName.json ?? byName.text, 300)}`)
    }
  } else {
    console.log('未传 --name，跳过（可用 --name=名字#TAG 验证他人）')
  }

  title(8, `战绩 match-history（请求 0~${RECENT - 1}，冷缓存会多返回再切片）`)
  const history = await lcuGet(
    lcu,
    `/lol-match-history/v1/products/lol/${targetPuuid}/matches?begIndex=0&endIndex=${RECENT - 1}`
  )
  dump('match-history-target', history.json ?? { status: history.status, error: history.error, text: history.text })
  let games = []
  if (history.status === 200 && history.json) {
    games = gamesOf(history)
    console.log(`返回 ${games.length} 场（请求 0~${RECENT - 1}；冷缓存会忽略区间，属已知现象）`)
    if (games.length) {
      console.log('对局对象字段：' + keysOf(games[0]))
      console.log(brief(summarizeGame(games[0], targetPuuid), 900))
      console.log(`近 ${Math.min(RECENT, games.length)} 场：\n` + brief(recentForm(games.slice(0, RECENT), targetPuuid), 400))
    } else {
      console.log('战绩为空：可能已隐藏战绩或该玩家近期无对局')
      console.log(brief(history.json, 500))
    }
  } else {
    console.log(`失败：HTTP ${history.status} ${brief(history.json ?? history.text, 300)}`)
  }

  title(9, '段位')
  const rankOther = await lcu(`/lol-ranked/v1/ranked-stats/${targetPuuid}`)
  console.log(`ranked-stats/{puuid}：HTTP ${rankOther.status}  解析=${rankLabel(rankOther.json)}`)
  if (rankOther.status === 200) {
    dump('rank-target', rankOther.json)
    console.log('顶层字段：' + keysOf(rankOther.json))
    console.log('queueMap 键：' + keysOf(rankOther.json.queueMap))
    console.log('queueMap.RANKED_SOLO_5x5：\n' + brief(rankOther.json.queueMap?.RANKED_SOLO_5x5, 700))
  }
  const rankSelf = await lcu('/lol-ranked/v1/current-ranked-stats')
  console.log(`current-ranked-stats（本人）：HTTP ${rankSelf.status}  解析=${rankLabel(rankSelf.json)}`)

  const peer = flowPlayers.find((p) => p.puuid && p.puuid !== me.puuid) || cs.myTeam.find((p) => p.puuid && p.puuid !== me.puuid)
  if (peer) {
    const [rankPeer, sumPeer] = await Promise.all([
      lcu(`/lol-ranked/v1/ranked-stats/${peer.puuid}`),
      lcu(`/lol-summoner/v2/summoners/puuid/${peer.puuid}`),
    ])
    console.log(`\n他人 ranked-stats：HTTP ${rankPeer.status}  解析=${rankLabel(rankPeer.json)}`)
    console.log(`他人 summoners/v2：HTTP ${sumPeer.status} ${brief(sumPeer.json ?? sumPeer.text, 300)}`)
  }

  // 选人阶段只信 champ-select（gameData 可能是上一局残留）；对局阶段用十人名单
  const roster =
    inChampSelect && cs.myTeam.length
      ? cs.myTeam.map((p) => ({ ...p, team: '己方' }))
      : flowPlayers.length
        ? [
            ...gs.teamOne.map((p) => ({ ...p, team: 'teamOne' })),
            ...gs.teamTwo.map((p) => ({ ...p, team: 'teamTwo' })),
          ]
        : cs.myTeam.map((p) => ({ ...p, team: '己方' }))

  if (!args['no-aggregate'] && roster.length) {
    title(10, `名单聚合（${roster.length} 人：战绩+段位+召唤师，5 并发）`)
    const { rows, cost } = await aggregate(lcu, roster, me.puuid)
    dump('aggregate', rows)
    for (const r of rows) {
      console.log(`\n[${r.队}] ${r.我}${r.召唤师}  段位=${r.段位}  本局英雄=${r.本局英雄 ?? '未选'}`)
      console.log(`  近10场=${r.近10场}  场均KDA=${r.场均KDA}  返回${r.返回场次}场  HTTP=${r.HTTP}`)
      console.log(`  逐场（最新在前）：${r.逐场.join(' | ') || '无'}`)
    }
    console.log(`\n耗时 ${cost} ms（${rows.length} 人 × 3 请求）`)
    const hidden = rows.filter((r) => r.近10场 === '战绩不可见')
    if (hidden.length) console.log(`战绩不可见：${hidden.map((r) => r.召唤师).join('、')}`)
  } else if (roster.length) {
    console.log(`\n（已跳过聚合；当前名单 ${roster.length} 人）`)
  } else {
    console.log('\n当前没有可聚合的名单（不在选人/对局阶段）')
  }

  title(11, '结论提示')
  const checks = [
    ['客户端定位', true, true],
    ['LCU 鉴权', self.status === 200, true],
    ['gameflow', phase.status === 200, true],
    ['gameflow session 十人名单', inGame && flowPlayers.length === 10, inGame],
    ['选人会话', champSelect.status === 200, inChampSelect],
    ['选人 myTeam 带 puuid', cs.myTeam.length > 0 && cs.myTeam.every((m) => m.puuid), inChampSelect],
    ['选人 theirTeam 身份可见', cs.theirTeam.length > 0 && cs.theirTeam.some((m) => m.puuid), 'expect-hidden'],
    ['对局内接口 2999', live.status === 200, inGame],
    ['战绩接口', games.length > 0, true],
    ['段位接口', rankOther.status === 200 || rankSelf.status === 200, true],
  ]
  for (const [name, ok, expected] of checks) {
    const label = ok
      ? '[通过]'
      : expected === 'expect-hidden'
        ? '[预期隐藏]'
        : expected
          ? '[未通过]'
          : '[本阶段不适用]'
    console.log(`${label} ${name}`)
  }
  console.log(`\n原始响应已写入：${dumpDir}`)
  console.log('说明：标「本阶段不适用」的项只有在选人/对局阶段才会通过，属正常现象。')
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exitCode = 1
})
