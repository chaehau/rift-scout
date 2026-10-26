// 本地桥接服务：前端只与这里通信，不直连 LCU（DEC-002）

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { BoardService } from './board.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 开发期前端跑在 Vite 端口上，需要放开跨域
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  })
  res.end(text)
}

/** 读取 JSON 请求体（只给设置接口用，限制大小） */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 8192) throw new Error('请求体过大')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

/** 打包后的前端静态资源；同时服务 Web 形态与 Electron 窗口（DEC-011） */
async function serveStatic(root: string, pathname: string, res: http.ServerResponse): Promise<void> {
  const rel = decodeURIComponent(pathname)
  const file = path.join(root, path.normalize(rel))
  if (file !== root && !file.startsWith(root + path.sep)) {
    sendJson(res, 403, { ok: false, error: '不允许的路径' })
    return
  }
  try {
    const body = await fs.readFile(file)
    const ext = path.extname(file)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // 构建产物带 hash，可以长缓存；入口页必须每次校验
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(body)
    return
  } catch {
    // 前端是单页应用：找不到的路径一律回落到 index.html
  }
  try {
    const html = await fs.readFile(path.join(root, 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(html)
  } catch {
    sendJson(res, 404, { ok: false, error: '前端尚未构建：请先执行 npm run build:web' })
  }
}

export function startServer(
  port: number,
  lockfilePaths: string[] = [],
  staticDir?: string
): void {
  const service = new BoardService(lockfilePaths)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      })
      res.end()
      return
    }

    // 设置接口需要写：目前只开放 POST /api/settings，其余一律只读
    if (req.method === 'POST') {
      try {
        if (url.pathname !== '/api/settings') {
          sendJson(res, 405, { ok: false, error: `仅 /api/settings 支持 POST，收到 ${url.pathname}` })
          return
        }
        const body = (await readJson(req)) as { dataDir?: unknown }
        const dataDir = typeof body?.dataDir === 'string' ? body.dataDir : ''
        sendJson(res, 200, await service.setDataDir(dataDir))
      } catch (err) {
        sendJson(res, 400, { ok: false, error: (err as Error).message })
      }
      return
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: '仅支持 GET' })
      return
    }

    try {
      if (url.pathname === '/api/status') {
        sendJson(res, 200, await service.status())
        return
      }
      if (url.pathname === '/api/settings') {
        sendJson(res, 200, service.settings())
        return
      }
      if (url.pathname === '/api/board') {
        // refresh=1：用户手动刷新，绕过玩家缓存重新取数
        sendJson(res, 200, await service.board(url.searchParams.has('refresh')))
        return
      }
      if (url.pathname === '/api/lookup') {
        // name 供手输；puuid 供面板点名快捷查询（跳过名字解析，更稳）
        sendJson(
          res,
          200,
          await service.lookup(
            url.searchParams.get('name') ?? '',
            url.searchParams.get('puuid') ?? ''
          )
        )
        return
      }
      const match = url.pathname.match(/^\/api\/match\/(\d+)$/)
      if (match) {
        const puuid = url.searchParams.get('puuid') ?? undefined
        sendJson(res, 200, await service.matchDetail(Number(match[1]), puuid))
        return
      }
      // 客户端本地图片统一走这里代理：英雄头像 / 召唤师头像 / 装备 / 召唤师技能 / 海克斯
      const icon = url.pathname.match(
        /^\/api\/(champion|profile|item|spell|augment)-icon\/(\d+)\.(png|jpg)$/
      )
      if (icon) {
        const kind = icon[1]
        const id = Number(icon[2])
        const body =
          kind === 'champion'
            ? await service.championIcon(id)
            : kind === 'profile'
              ? await service.profileIcon(id)
              : kind === 'item'
                ? await service.itemIcon(id)
                : kind === 'spell'
                  ? await service.spellIcon(id)
                  : await service.augmentIcon(id)
        if (!body) {
          sendJson(res, 404, { ok: false, error: `图片 ${kind}-${id} 不可用` })
          return
        }
        res.writeHead(200, {
          'Content-Type': icon[3] === 'jpg' ? 'image/jpeg' : 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(body)
        return
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: `未知路径 ${url.pathname}` })
        return
      }
      if (staticDir) {
        await serveStatic(staticDir, url.pathname, res)
        return
      }
      sendJson(res, 404, { ok: false, error: `未知路径 ${url.pathname}` })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message })
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[bridge] 已启动：http://127.0.0.1:${port}`)
    console.log(`[bridge] 状态：/api/status    面板：/api/board`)
    if (staticDir) console.log(`[bridge] 界面：${staticDir}`)
  })

  server.on('error', (err: Error) => {
    console.error(`[bridge] 启动失败：${err.message}`)
    // 嵌在 Electron 里时不能让端口占用之类的问题直接把窗口进程带走
    if (process.env.LOL_EMBEDDED !== '1') process.exit(1)
  })
}
