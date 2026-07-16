import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'

const logsDir = path.resolve(process.cwd(), 'logs')
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LOG_FILE_RE = /^\d{8}_\d{6}\.log$/
const LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR'])
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000
const MAX_READ_BYTES = 2 * 1024 * 1024

function getShanghaiDateStr(): string {
    const now = new Date()
    const offset = 8 * 60
    const localTime = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + offset * 60000)

    const y = localTime.getFullYear()
    const m = String(localTime.getMonth() + 1).padStart(2, '0')
    const d = String(localTime.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

function parseLimit(value: string | undefined, defaultLimit: number): number {
    const parsed = Number.parseInt(value || '', 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit
    return Math.min(parsed, MAX_LIMIT)
}

function parseLevel(value: string | undefined): string | null {
    if (!value || value === 'ALL') return null
    return LEVELS.has(value) ? value : '__INVALID__'
}

function resolveDayDir(date: string): string | null {
    if (!DATE_RE.test(date)) return null

    const dayDir = path.resolve(logsDir, date)
    return dayDir.startsWith(logsDir + path.sep) ? dayDir : null
}

function resolveLogFile(date: string, file: string): string | null {
    if (!LOG_FILE_RE.test(file)) return null

    const dayDir = resolveDayDir(date)
    if (!dayDir) return null

    const filePath = path.resolve(dayDir, file)
    return filePath.startsWith(dayDir + path.sep) ? filePath : null
}

function readTail(filePath: string): string {
    const stat = fs.statSync(filePath)
    const bytesToRead = Math.min(stat.size, MAX_READ_BYTES)
    const start = Math.max(0, stat.size - bytesToRead)
    const fd = fs.openSync(filePath, 'r')

    try {
        const buffer = Buffer.alloc(bytesToRead)
        fs.readSync(fd, buffer, 0, bytesToRead, start)
        let content = buffer.toString('utf-8')

        if (start > 0) {
            const firstNewline = content.indexOf('\n')
            content = firstNewline >= 0 ? content.slice(firstNewline + 1) : ''
        }

        return content
    } finally {
        fs.closeSync(fd)
    }
}

function readLogContent(filePath: string, level: string | null, maxLines: number) {
    const content = readTail(filePath)
    let lines = content.split('\n').filter(l => l.trim())

    if (level) {
        lines = lines.filter(l => l.includes(`| ${level} `))
    }

    const total = lines.length
    lines = lines.slice(-maxLines)

    return {
        lines,
        total,
        filtered: total > maxLines
    }
}

export function createLogsRoutes() {
    const app = new Hono()

    // 获取日志日期列表
    app.get('/dates', (c) => {
        try {
            if (!fs.existsSync(logsDir)) {
                return c.json({ dates: [] })
            }
            const entries = fs.readdirSync(logsDir, { withFileTypes: true })
            const dates = entries
                .filter(e => e.isDirectory() && DATE_RE.test(e.name))
                .map(e => e.name)
                .sort((a, b) => b.localeCompare(a))
            return c.json({ dates })
        } catch {
            return c.json({ error: '获取日志日期失败' }, 500)
        }
    })

    // 获取指定日期的日志文件列表
    app.get('/files/:date', (c) => {
        try {
            const date = c.req.param('date')
            const dayDir = resolveDayDir(date)
            if (!dayDir) {
                return c.json({ error: '无效的日志日期' }, 400)
            }

            if (!fs.existsSync(dayDir)) {
                return c.json({ files: [] })
            }

            const files = fs.readdirSync(dayDir)
                .filter(f => LOG_FILE_RE.test(f))
                .map(f => {
                    const stat = fs.statSync(path.join(dayDir, f))
                    return { name: f, size: stat.size, mtime: stat.mtimeMs }
                })
                .sort((a, b) => b.mtime - a.mtime)
            return c.json({ files })
        } catch {
            return c.json({ error: '获取日志文件列表失败' }, 500)
        }
    })

    // 获取日志文件内容
    app.get('/content/:date/:file', (c) => {
        try {
            const date = c.req.param('date')
            const file = c.req.param('file')
            const level = parseLevel(c.req.query('level'))
            const maxLines = parseLimit(c.req.query('limit'), DEFAULT_LIMIT)
            const filePath = resolveLogFile(date, file)

            if (!filePath || level === '__INVALID__') {
                return c.json({ error: '无效的日志查询参数' }, 400)
            }

            if (!fs.existsSync(filePath)) {
                return c.json({ error: '日志文件不存在' }, 404)
            }

            return c.json(readLogContent(filePath, level, maxLines))
        } catch {
            return c.json({ error: '读取日志文件失败' }, 500)
        }
    })

    // 获取当前运行日志（实时）
    app.get('/current', (c) => {
        try {
            const level = parseLevel(c.req.query('level'))
            const maxLines = parseLimit(c.req.query('limit'), 100)

            if (level === '__INVALID__') {
                return c.json({ error: '无效的日志等级' }, 400)
            }

            const dateStr = getShanghaiDateStr()
            const dayDir = resolveDayDir(dateStr)
            if (!dayDir || !fs.existsSync(dayDir)) {
                return c.json({ lines: [], total: 0, file: null, date: dateStr })
            }

            const files = fs.readdirSync(dayDir)
                .filter(f => LOG_FILE_RE.test(f))
                .map(f => ({ name: f, mtime: fs.statSync(path.join(dayDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)

            if (files.length === 0) {
                return c.json({ lines: [], total: 0, file: null, date: dateStr })
            }

            const latestFile = files[0].name
            const filePath = path.join(dayDir, latestFile)
            const content = readLogContent(filePath, level, maxLines)

            return c.json({ ...content, file: latestFile, date: dateStr })
        } catch {
            return c.json({ error: '读取当前日志失败' }, 500)
        }
    })

    return app
}
