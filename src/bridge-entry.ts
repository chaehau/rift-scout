// Electron 内嵌入口：端口、前端目录由主进程通过环境变量传入
import { startServer } from './server.ts'

const port = Number(process.env.PORT ?? 8737)
const lockfilePaths = process.env.LOL_LOCKFILE ? [process.env.LOL_LOCKFILE] : []

startServer(port, lockfilePaths, process.env.LOL_WEB_DIR)
