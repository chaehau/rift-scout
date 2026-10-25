import path from 'node:path'
import { startServer } from './server.ts'

const port = Number(process.env.PORT ?? 8737)
// 可选：手工指定 lockfile（客户端装在非常规目录时用）
const lockfilePaths = process.env.LOL_LOCKFILE ? [process.env.LOL_LOCKFILE] : []
// 打包后的前端（npm run build:web）；目录不存在时只提供 /api
const staticDir = process.env.LOL_WEB_DIR ?? path.resolve(import.meta.dirname, '../web/dist')

startServer(port, lockfilePaths, staticDir)
