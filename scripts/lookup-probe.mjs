// 临时探测：LCU 用「名字#TAG」查 puuid 的可用端点（需提权运行）
import fs from 'node:fs'
import https from 'node:https'
import { resolveAuth } from '../src/lcu.ts'

const auth = resolveAuth([])
const out = { auth: auth.ok ? { port: auth.port, via: auth.via } : auth, results: [] }

function call(method, path, payload) {
  return new Promise((resolve) => {
    const body = payload ? JSON.stringify(payload) : null
    const req = https.request(
      {
        host: '127.0.0.1',
        port: auth.port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`riot:${auth.token}`).toString('base64'),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 600) })
        )
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }))
    if (body) req.write(body)
    req.end()
  })
}

if (auth.ok) {
  // 用法：node scripts/lookup-probe.mjs "名字#TAG"
  const ridArg = process.argv[2] ?? '示例玩家#00000'
  const cases = [
    ['target', ridArg],
    ['target-name', ridArg.split('#')[0]],
    ['ghost', '不存在的名字#00000'],
  ]
  for (const [label, rid] of cases) {
    const name = rid.split('#')[0]
    const tag = rid.split('#')[1] ?? ''
    const probes = [
      ['summoners?name=full', 'GET', `/lol-summoner/v1/summoners/?name=${encodeURIComponent(rid)}`, null],
      ['summoners?name=name', 'GET', `/lol-summoner/v1/summoners/?name=${encodeURIComponent(name)}`, null],
      ['aliases?name&tagLine', 'GET', `/lol-summoner/v1/summoner-aliases?name=${encodeURIComponent(name)}&tagLine=${encodeURIComponent(tag)}`, null],
      ['aliases?name=full', 'GET', `/lol-summoner/v1/summoner-aliases?name=${encodeURIComponent(rid)}`, null],
      ['v2/summoners/names', 'POST', '/lol-summoner/v2/summoners/names', [rid]],
    ]
    for (const [name2, method, path, payload] of probes) {
      const r = await call(method, path, payload)
      out.results.push({ label, probe: name2, path, status: r.status, body: r.body })
    }
  }
}

fs.writeFileSync(process.env.OUT ?? 'lookup-probe.json', JSON.stringify(out, null, 2), 'utf8')
