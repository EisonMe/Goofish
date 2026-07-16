/**
 * 数据库连接管理
 */

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

import { DB_CONFIG } from '../core/constants.js'
import { createLogger } from '../core/logger.js'

const logger = createLogger('Db')

// 确保数据目录存在
const dbDir = path.join(process.cwd(), 'data')
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
}

const dbPath = path.join(process.cwd(), DB_CONFIG.PATH)
export const db = new Database(dbPath)

// 启用 WAL 模式提高并发性能
db.pragma('journal_mode = WAL')
// 设置 busy_timeout，避免并发访问时直接报 SQLITE_BUSY
db.pragma('busy_timeout = 5000')
// 启用外键约束
db.pragma('foreign_keys = ON')

export function closeDatabase() {
    db.close()
    logger.info('数据库连接已关闭')
}

export function getDbPath(): string {
    return dbPath
}
