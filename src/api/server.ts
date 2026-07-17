import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import fs from 'fs'
import path from 'path'

import { createLogger } from '../core/logger.js'
import { SERVER_CONFIG, ENV } from '../core/constants.js'
import { securityMiddleware } from './middlewares/index.js'
import {
    createAccountRoutes,
    createGoodsRoutes,
    createMessageRoutes,
    createStatusRoutes,
    createConversationRoutes,
    createLogsRoutes,
    createAutoReplyRoutes,
    createOrderRoutes,
    createAutoSellRoutes,
    createWorkflowRoutes,
    createReportRoutes,
    createItemGroupRoutes
} from './routes/index.js'
import { createDevMessageRoutes } from './routes/dev-messages.route.js'
import { closeWSClients, createWSPushHandler } from './routes/ws-push.route.js'
import type { ClientManager } from '../websocket/client.manager.js'

const logger = createLogger('Api:Server')
const apiLogger = createLogger('Api:Request')

let clientManager: ClientManager | null = null
let activeServer: ReturnType<typeof serve> | null = null

export function setClientManager(cm: ClientManager) {
    clientManager = cm
}

function getClientManager() {
    return clientManager
}

// WebSocket 相关
let upgradeWebSocket: ReturnType<typeof createNodeWebSocket>['upgradeWebSocket'] | null = null
let injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'] | null = null

export function createApp() {
    const app = new Hono()

    // 创建 WebSocket 支持
    const nodeWS = createNodeWebSocket({ app })
    upgradeWebSocket = nodeWS.upgradeWebSocket
    injectWebSocket = nodeWS.injectWebSocket

    app.use('*', cors())

    // 安全中间件 - 限制 API 只能从前端请求（排除 WebSocket）
    app.use('/api/*', securityMiddleware)

    // API 日志 - 只记录非 GET 请求，减少日志量
    app.use('/api/*', async (c, next) => {
        await next()
        if (c.req.method !== 'GET') {
            apiLogger.info(`${c.req.method} ${c.req.path}`)
        }
    })

    // WebSocket 推送端点
    app.get('/ws', upgradeWebSocket(() => createWSPushHandler(getClientManager)))

    // 挂载路由模块
    const statusRoutes = createStatusRoutes(getClientManager)
    app.route('/', statusRoutes)
    app.route('/api', statusRoutes)
    app.route('/api/status', statusRoutes)

    app.route('/api/accounts', createAccountRoutes(getClientManager))
    app.route('/api/goods', createGoodsRoutes(getClientManager))
    app.route('/api/messages', createMessageRoutes(getClientManager))
    app.route('/api/conversations', createConversationRoutes())
    app.route('/api/logs', createLogsRoutes())
    app.route('/api/autoreply', createAutoReplyRoutes())
    app.route('/api/orders', createOrderRoutes(getClientManager))
    app.route('/api/autosell', createAutoSellRoutes())
    app.route('/api/workflows', createWorkflowRoutes())
    app.route('/api/reports', createReportRoutes())
    app.route('/api/item-groups', createItemGroupRoutes())

    // 开发环境才注册调试路由
    if (ENV.IS_DEV) {
        app.route('/api/dev/messages', createDevMessageRoutes())
        logger.info('开发模式：已启用调试路由 /api/dev/messages')
    }

    // 兼容旧的发送消息接口
    app.post('/api/send', async (c) => {
        if (!clientManager) {
            return c.json({ error: 'ClientManager not initialized' }, 500)
        }
        const body = await c.req.json()
        const { accountId, chatId, toUserId, text } = body
        if (!accountId || !chatId || !toUserId || !text) {
            return c.json({ error: 'Missing accountId, chatId, toUserId or text' }, 400)
        }
        const client = clientManager.getClient(accountId)
        if (!client) {
            return c.json({ error: 'Account not connected' }, 400)
        }
        const success = await client.sendMessage(chatId, toUserId, text)
        return c.json({ success })
    })

    // 兼容旧的账号商品接口
    app.get('/api/accounts/:id/goods', async (c) => {
        const id = c.req.param('id')
        const page = c.req.query('page') || '1'
        const url = new URL(c.req.url)
        url.pathname = `/api/goods/account/${id}`
        return c.redirect(url.pathname + `?page=${page}`)
    })

    // 静态文件服务
    setupStaticFiles(app)

    return app
}

function setupStaticFiles(app: Hono) {
    const staticDir = path.resolve(process.cwd(), SERVER_CONFIG.STATIC_DIR)

    if (fs.existsSync(staticDir)) {
        app.use('/*', serveStatic({ root: staticDir }))

        app.get('*', (c) => {
            const indexPath = path.join(staticDir, 'index.html')
            if (fs.existsSync(indexPath)) {
                const html = fs.readFileSync(indexPath, 'utf-8')
                return c.html(html)
            }
            return c.text('Frontend not built', 404)
        })

        logger.info(`静态文件服务已启用: ${staticDir}`)
    } else {
        logger.warn(`静态目录不存在: ${staticDir}，请先构建前端`)
    }
}

export function startServer(port = SERVER_CONFIG.PORT): Promise<void> {
    if (activeServer) {
        return Promise.reject(new Error('API server is already running'))
    }

    const app = createApp()

    return new Promise((resolve, reject) => {
        let settled = false

        const server = serve({ fetch: app.fetch, port, hostname: SERVER_CONFIG.HOST }, () => {
            logger.info(`服务器启动在端口 ${port}`)
            logger.info(`访问 http://localhost:${port} 打开管理面板`)
            settled = true
            resolve()
        })
        activeServer = server

        server.once('error', (error) => {
            logger.error(`服务器启动失败: ${error}`)
            if (!settled) {
                activeServer = null
                settled = true
                reject(error)
            }
        })

        server.once('close', () => {
            if (activeServer === server) {
                activeServer = null
            }
        })

        // 注入 WebSocket 支持
        if (injectWebSocket) {
            injectWebSocket(server)
            logger.info('WebSocket 推送已启用')
        }
    })
}

export function stopServer(): Promise<void> {
    const server = activeServer
    if (!server) {
        return Promise.resolve()
    }

    activeServer = null
    closeWSClients()

    return new Promise((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(forceCloseTimer)
            if (error) reject(error)
            else resolve()
        }

        const forceCloseTimer = setTimeout(() => {
            const closeAllConnections = (server as typeof server & {
                closeAllConnections?: () => void
            }).closeAllConnections
            closeAllConnections?.call(server)
            finish()
        }, 2000)
        forceCloseTimer.unref()

        server.close((error) => {
            if (error) {
                logger.warn(`服务器关闭时发生错误: ${error}`)
            } else {
                logger.info('API 服务器已关闭')
            }
            finish(error)
        })
    })
}
