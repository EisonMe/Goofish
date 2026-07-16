import path from 'path'
import { pathToFileURL } from 'url'

import { createLogger, cleanOldLogs, setLogLevel, LogLevel } from './core/logger.js'
import { ClientManager } from './websocket/index.js'
import { initDatabase, closeDatabase } from './db/index.js'
import { startServer, stopServer, setClientManager, messageStore, conversationStore } from './api/index.js'
import { fetchUserHead, handleOrderMessage, fetchAndUpdateOrderDetail } from './services/index.js'
import { SERVER_CONFIG, LOG_CONFIG } from './core/constants.js'

const logger = createLogger('App')

let clientManager: ClientManager | null = null
let databaseInitialized = false
let started = false
let shutdownPromise: Promise<void> | null = null

export async function main() {
    if (started) return
    started = true

    // 设置日志级别
    setLogLevel(LOG_CONFIG.LEVEL as LogLevel)

    // 清理过期日志
    cleanOldLogs(LOG_CONFIG.RETENTION_DAYS)

    logger.info('启动闲鱼多账号WebSocket客户端...')

    // 初始化数据库
    initDatabase()
    databaseInitialized = true

    // 创建客户端管理器
    clientManager = new ClientManager(async (accountId, msg) => {
        logger.info(`收到新消息: ${msg.senderName}: ${msg.content}`)
        messageStore.add(msg)
        conversationStore.addIncoming(accountId, msg)

        if (msg.orderId) {
            logger.info(`订单线索消息: orderId=${msg.orderId}${msg.isOrderMessage ? '（订单状态消息）' : '（普通消息提取）'}`)
            handleOrderMessage(accountId, msg.orderId, msg.chatId)
            fetchOrderDetailAsync(accountId, msg.orderId)
        }

        // 异步获取用户头像（不阻塞消息处理）
        fetchUserAvatarAsync(accountId, msg.chatId, msg.senderId)
    })

    // 设置 API 客户端管理器引用
    setClientManager(clientManager)

    // 启动 API 服务器
    await startServer(SERVER_CONFIG.PORT)

    // 从数据库加载并启动所有启用的账号
    await clientManager.startAll()

    logger.info('系统已启动，等待消息...')
}

export function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise

    shutdownPromise = (async () => {
        logger.info('正在关闭应用服务...')
        clientManager?.stopAll()
        clientManager = null

        await stopServer()

        if (databaseInitialized) {
            closeDatabase()
            databaseInitialized = false
        }

        started = false
        logger.info('应用服务已关闭')
    })().finally(() => {
        shutdownPromise = null
    })

    return shutdownPromise
}

// 异步获取用户头像
async function fetchUserAvatarAsync(accountId: string, chatId: string, userId: string) {
    try {
        const { userHead } = await fetchUserHead(accountId, userId)

        if (userHead?.avatar) {
            conversationStore.updateUserAvatar(accountId, chatId, userHead.avatar)
        }
    } catch (e) {
        logger.debug(`获取用户头像失败: ${e}`)
    }
}

// 异步获取订单详情
async function fetchOrderDetailAsync(accountId: string, orderId: string) {
    try {
        const client = clientManager?.getClient(accountId)
        if (!client) {
            logger.warn(`获取订单详情失败: 账号 ${accountId} 客户端不存在`)
            return
        }
        await fetchAndUpdateOrderDetail(client, orderId)
    } catch (e) {
        logger.debug(`获取订单详情失败: ${e}`)
    }
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
const pm2EntryPath = process.env.pm_exec_path
    ? pathToFileURL(path.resolve(process.env.pm_exec_path)).href
    : ''
const isDirectRun = entryPath === import.meta.url || pm2EntryPath === import.meta.url

if (isDirectRun) {
    const handleSignal = async (signal: string) => {
        logger.info(`收到 ${signal} 信号，正在断开连接...`)
        try {
            await shutdown()
            process.exit(0)
        } catch (error) {
            logger.error(`关闭服务失败: ${error}`)
            process.exit(1)
        }
    }

    process.once('SIGINT', () => void handleSignal('SIGINT'))
    process.once('SIGTERM', () => void handleSignal('SIGTERM'))

    main().catch((e) => {
        logger.error(`程序异常: ${e}`)
        void shutdown().finally(() => process.exit(1))
    })
}
