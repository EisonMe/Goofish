import WebSocket from 'ws'

import { WS_CONFIG, WS_HEADERS, API_ENDPOINTS } from '../core/constants.js'
import { createLogger } from '../core/logger.js'
import { CookiesManager } from '../core/cookies.manager.js'
import { generateDeviceId, generateMid, generateSign } from '../utils/crypto.js'
import { nowLocalString } from '../utils/date.js'
import { TokenManager } from './token.js'
import { getOrders, getAccountStatus, updateAccountStatus } from '../db/index.js'
import { sendMessage } from './message.sender.js'
import { processWebSocketMessage } from './message.receiver.js'
import { fetchAndUpdateOrderDetail } from '../services/order.service.js'
import type { MessageCallback } from '../types/index.js'

const logger = createLogger('Ws:Client')
const SYNC_CURSOR_GRACE_MS = 2 * 60 * 1000
const SYNC_CURSOR_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

export class GoofishClient {
    private _accountId: string
    private myId: string
    private deviceId: string
    private ws: WebSocket | null = null
    private tokenManager: TokenManager
    private running = false
    private connectionFailures = 0
    private heartbeatTimer: NodeJS.Timeout | null = null
    private tokenRefreshTimer: NodeJS.Timeout | null = null
    private reconnectTimer: NodeJS.Timeout | null = null
    private networkCheckTimer: NodeJS.Timeout | null = null
    private lastHeartbeatTime: number = 0
    private onMessage?: MessageCallback
    private hasConnectedOnce = false
    private recoveringOrders = false

    constructor(accountId: string, onMessage?: MessageCallback) {
        this._accountId = accountId
        this.onMessage = onMessage

        // 从数据库获取 cookies 验证
        const userId = CookiesManager.getUserId(accountId)
        if (!userId) throw new Error("Cookie中缺少必需的'unb'字段或账号不存在")

        this.myId = userId
        this.deviceId = generateDeviceId(this.myId)
        this.tokenManager = new TokenManager(accountId, this.deviceId)

        logger.info(`[${this._accountId}] 客户端初始化完成，用户ID: ${this.myId}`)
    }

    get accountId(): string {
        return this._accountId
    }

    getAccountId(): string {
        return this._accountId
    }

    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN
    }

    isRunning(): boolean {
        return this.running
    }

    getUserId(): string {
        return this.myId
    }

    async sendMessage(chatId: string, toUserId: string, text: string): Promise<boolean> {
        if (!this.ws) return false
        return sendMessage({
            accountId: this._accountId,
            myId: this.myId,
            ws: this.ws,
            chatId,
            toUserId,
            text
        })
    }

    // 获取订单详情
    async fetchOrderDetail(orderId: string): Promise<any> {
        try {
            const cookiesStr = CookiesManager.getCookies(this._accountId)
            if (!cookiesStr) {
                logger.error(`[${this._accountId}] 无法获取 cookies`)
                return null
            }

            const h5Token = CookiesManager.getH5Token(this._accountId)
            if (!h5Token) {
                logger.warn(`[${this._accountId}] h5Token 为空，尝试刷新 token`)
            }

            const timestamp = Date.now().toString()
            const dataVal = JSON.stringify({ tid: orderId })
            const sign = generateSign(timestamp, h5Token, dataVal)

            logger.debug(`[${this._accountId}] 订单API请求 - orderId: ${orderId}, h5Token: ${h5Token ? h5Token.substring(0, 8) + '...' : '空'}`)

            const params = new URLSearchParams({
                jsv: '2.7.2',
                appKey: WS_CONFIG.SIGN_APP_KEY,
                t: timestamp,
                sign,
                v: '1.0',
                type: 'originaljson',
                accountSite: 'xianyu',
                dataType: 'json',
                timeout: '20000',
                api: 'mtop.idle.web.trade.order.detail',
                sessionOption: 'AutoLoginOnly'
            })

            const res = await fetch(`${API_ENDPOINTS.ORDER_DETAIL}?${params}`, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'content-type': 'application/x-www-form-urlencoded',
                    'origin': 'https://www.goofish.com',
                    'referer': 'https://www.goofish.com/',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'cookie': cookiesStr
                },
                body: `data=${encodeURIComponent(dataVal)}`
            })

            CookiesManager.handleResponseCookies(this._accountId, res)
            const resJson = await res.json()

            if (resJson?.ret?.some((r: string) => r.includes('SUCCESS'))) {
                logger.info(`[${this._accountId}] 获取订单详情成功: ${orderId}`)
                return resJson
            }

            const retMsg = resJson?.ret?.join(', ') || '未知错误'
            logger.warn(`[${this._accountId}] 获取订单详情失败: ${retMsg}`)

            if (retMsg.includes('TOKEN') || retMsg.includes('FAIL_SYS_SESSION_EXPIRED')) {
                logger.warn(`[${this._accountId}] Token 可能已过期，请尝试刷新账号`)
            }

            return null
        } catch (e) {
            logger.error(`[${this._accountId}] 获取订单详情异常: ${e}`)
            return null
        }
    }

    // 确认发货（虚拟发货/无需物流）
    async confirmShipment(orderId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const cookiesStr = CookiesManager.getCookies(this._accountId)
            if (!cookiesStr) {
                return { success: false, error: '无法获取 cookies' }
            }

            const h5Token = CookiesManager.getH5Token(this._accountId)
            if (!h5Token) {
                return { success: false, error: 'h5Token 为空' }
            }

            const timestamp = Date.now().toString()
            const dataVal = JSON.stringify({
                orderId,
                tradeText: '',
                picList: [],
                newUnconsign: true
            })
            const sign = generateSign(timestamp, h5Token, dataVal)

            const params = new URLSearchParams({
                jsv: '2.7.2',
                appKey: WS_CONFIG.SIGN_APP_KEY,
                t: timestamp,
                sign,
                v: '1.0',
                type: 'originaljson',
                accountSite: 'xianyu',
                dataType: 'json',
                timeout: '20000',
                api: 'mtop.taobao.idle.logistic.consign.dummy',
                sessionOption: 'AutoLoginOnly'
            })

            logger.info(`[${this._accountId}] 确认发货请求 - orderId: ${orderId}`)

            const res = await fetch(`${API_ENDPOINTS.CONFIRM_SHIPMENT}?${params}`, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'content-type': 'application/x-www-form-urlencoded',
                    'origin': 'https://www.goofish.com',
                    'referer': 'https://www.goofish.com/',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'cookie': cookiesStr
                },
                body: `data=${encodeURIComponent(dataVal)}`
            })

            CookiesManager.handleResponseCookies(this._accountId, res)
            const resJson = await res.json()

            if (resJson?.ret?.some((r: string) => r.includes('SUCCESS'))) {
                logger.info(`[${this._accountId}] 确认发货成功: ${orderId}`)
                return { success: true }
            }

            const retMsg = resJson?.ret?.join(', ') || '未知错误'
            logger.warn(`[${this._accountId}] 确认发货失败: ${retMsg}`)
            return { success: false, error: retMsg }
        } catch (e) {
            logger.error(`[${this._accountId}] 确认发货异常: ${e}`)
            return { success: false, error: String(e) }
        }
    }

    // 免拼发货
    async freeShipping(orderId: string, itemId: string, buyerId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const cookiesStr = CookiesManager.getCookies(this._accountId)
            if (!cookiesStr) {
                return { success: false, error: '无法获取 cookies' }
            }

            const h5Token = CookiesManager.getH5Token(this._accountId)
            if (!h5Token) {
                return { success: false, error: 'h5Token 为空' }
            }

            const timestamp = Date.now().toString()
            const dataVal = JSON.stringify({
                bizOrderId: orderId,
                itemId,
                buyerId
            })
            const sign = generateSign(timestamp, h5Token, dataVal)

            const params = new URLSearchParams({
                jsv: '2.7.2',
                appKey: WS_CONFIG.SIGN_APP_KEY,
                t: timestamp,
                sign,
                v: '1.0',
                type: 'originaljson',
                accountSite: 'xianyu',
                dataType: 'json',
                timeout: '20000',
                api: 'mtop.idle.groupon.activity.seller.freeshipping',
                sessionOption: 'AutoLoginOnly'
            })

            logger.info(`[${this._accountId}] 免拼发货请求 - orderId: ${orderId}, itemId: ${itemId}, buyerId: ${buyerId}`)

            const res = await fetch(`${API_ENDPOINTS.FREE_SHIPPING}?${params}`, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'content-type': 'application/x-www-form-urlencoded',
                    'origin': 'https://www.goofish.com',
                    'referer': 'https://www.goofish.com/',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'cookie': cookiesStr
                },
                body: `data=${encodeURIComponent(dataVal)}`
            })

            CookiesManager.handleResponseCookies(this._accountId, res)
            const resJson = await res.json()

            if (resJson?.ret?.some((r: string) => r.includes('SUCCESS'))) {
                logger.info(`[${this._accountId}] 免拼发货成功: ${orderId}`)
                return { success: true }
            }

            const retMsg = resJson?.ret?.join(', ') || '未知错误'
            logger.warn(`[${this._accountId}] 免拼发货失败: ${retMsg}`)
            return { success: false, error: retMsg }
        } catch (e) {
            logger.error(`[${this._accountId}] 免拼发货异常: ${e}`)
            return { success: false, error: String(e) }
        }
    }

    private startHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
        }

        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                const msg = { lwp: '/!', headers: { mid: generateMid() } }
                this.ws.send(JSON.stringify(msg))
                this.lastHeartbeatTime = Date.now()
                logger.debug(`[${this._accountId}] 心跳已发送`)
                updateAccountStatus({ accountId: this._accountId, lastHeartbeat: nowLocalString() })
            } else if (this.running) {
                logger.warn(`[${this._accountId}] 心跳发送失败，连接已关闭，尝试重连`)
                this.tryReconnect()
            }
        }, WS_CONFIG.HEARTBEAT_INTERVAL * 1000)
    }

    private startNetworkCheck() {
        if (this.networkCheckTimer) {
            clearInterval(this.networkCheckTimer)
        }

        this.networkCheckTimer = setInterval(() => {
            if (!this.running || !this.isConnected() || this.lastHeartbeatTime <= 0) {
                return
            }

            const now = Date.now()
            const heartbeatTimeout = WS_CONFIG.HEARTBEAT_INTERVAL * 3 * 1000
            if (now - this.lastHeartbeatTime > heartbeatTimeout) {
                logger.warn(`[${this._accountId}] 心跳超时，可能网络已断开，尝试重连`)
                this.tryReconnect()
            }
        }, 30000)
    }

    private tryReconnect() {
        if (!this.running) {
            return
        }

        if (this.reconnectTimer) {
            return
        }

        if (this.connectionFailures >= WS_CONFIG.MAX_RECONNECT_ATTEMPTS) {
            this.running = false
            logger.error(`[${this._accountId}] 达到最大重连尝试次数，停止重连`)
            updateAccountStatus({ accountId: this._accountId, connected: false, errorMessage: '达到最大重连尝试次数' })
            return
        }

        this.connectionFailures++
        const maxDelay = 60000
        const delay = Math.min(
            WS_CONFIG.RECONNECT_DELAY * Math.pow(1.5, Math.min(this.connectionFailures - 1, 5)),
            maxDelay
        )

        logger.info(`[${this._accountId}] ${Math.round(delay / 1000)}秒后尝试重连 (${this.connectionFailures}/${WS_CONFIG.MAX_RECONNECT_ATTEMPTS})`)

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null
            if (!this.running) {
                return
            }

            try {
                logger.info(`[${this._accountId}] 开始重连...`)
                this.cleanup()
                const success = await this.connect()
                if (success) {
                    logger.info(`[${this._accountId}] 重连成功`)
                    this.connectionFailures = 0
                    return
                }

                logger.error(`[${this._accountId}] 重连失败`)
                this.tryReconnect()
            } catch (e) {
                logger.error(`[${this._accountId}] 重连异常: ${e}`)
                this.tryReconnect()
            }
        }, delay)
    }

    private startTokenRefresh() {
        this.tokenRefreshTimer = setInterval(async () => {
            if (this.running) {
                logger.info(`[${this._accountId}] 开始定时刷新Token...`)
                const token = await this.tokenManager.refresh()
                if (token) {
                    logger.info(`[${this._accountId}] Token刷新成功`)
                    updateAccountStatus({ accountId: this._accountId, lastTokenRefresh: nowLocalString(), errorMessage: '' })
                } else {
                    const errorMessage = this.tokenManager.getLastError() || 'Token刷新失败'
                    logger.warn(`[${this._accountId}] Token刷新失败: ${errorMessage}`)
                    updateAccountStatus({ accountId: this._accountId, connected: false, errorMessage })
                }
            }
        }, WS_CONFIG.TOKEN_REFRESH_INTERVAL * 1000)
        logger.info(`[${this._accountId}] Token刷新定时器已启动，间隔: ${WS_CONFIG.TOKEN_REFRESH_INTERVAL}秒`)
    }

    private getSyncAckTimestampMs(isReconnect: boolean): number {
        const now = Date.now()
        const lastSyncTimestamp = getAccountStatus(this._accountId)?.lastSyncTimestamp

        if (!lastSyncTimestamp || !Number.isFinite(lastSyncTimestamp) || lastSyncTimestamp <= 0) {
            return now
        }

        const baseTimestamp = isReconnect
            ? Math.max(0, lastSyncTimestamp - SYNC_CURSOR_GRACE_MS)
            : lastSyncTimestamp

        return Math.max(baseTimestamp, now - SYNC_CURSOR_MAX_LOOKBACK_MS)
    }

    private async initConnection(isReconnect: boolean) {
        if (!this.ws) return

        let token = this.tokenManager.getToken()
        if (!token) {
            logger.info(`[${this._accountId}] 首次连接，正在获取Token...`)
            token = await this.tokenManager.refresh()
            if (!token) {
                const errorMessage = this.tokenManager.getLastError() || '获取Token失败，无法完成注册'
                logger.error(`[${this._accountId}] ${errorMessage}`)
                updateAccountStatus({ accountId: this._accountId, connected: false, errorMessage })
                throw new Error(errorMessage)
            }
        }

        const regMsg = {
            lwp: '/reg',
            headers: {
                'cache-header': 'app-key token ua wv',
                'app-key': WS_CONFIG.APP_KEY,
                'token': token,
                'ua': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'dt': 'j', 'wv': 'im:3,au:3,sy:6', 'sync': '0,0;0;0;',
                'did': this.deviceId, 'mid': generateMid()
            }
        }
        this.ws.send(JSON.stringify(regMsg))
        logger.info(`[${this._accountId}] 注册消息已发送`)

        await new Promise(r => setTimeout(r, 1000))

        const syncTimestamp = this.getSyncAckTimestampMs(isReconnect)
        const syncMsg = {
            lwp: '/r/SyncStatus/ackDiff',
            headers: { mid: generateMid() },
            body: [{
                pipeline: 'sync', tooLong2Tag: 'PNM,1', channel: 'sync',
                topic: 'sync', highPts: 0, pts: syncTimestamp * 1000, seq: 0, timestamp: syncTimestamp
            }]
        }
        this.ws.send(JSON.stringify(syncMsg))
        updateAccountStatus({ accountId: this._accountId, lastSyncTimestamp: syncTimestamp })
        logger.info(`[${this._accountId}] 连接注册完成，同步起点: ${new Date(syncTimestamp).toLocaleString('zh-CN', { hour12: false })}${isReconnect ? '（重连补偿）' : ''}`)
    }

    private sendAck(headers: any) {
        if (this.ws?.readyState !== WebSocket.OPEN) return
        const ack = {
            code: 200,
            headers: { mid: headers?.mid || generateMid(), sid: headers?.sid || '' }
        }
        this.ws.send(JSON.stringify(ack))
    }

    private getRecentOrderStart(days: number): string {
        const date = new Date()
        date.setDate(date.getDate() - days)
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const hours = String(date.getHours()).padStart(2, '0')
        const minutes = String(date.getMinutes()).padStart(2, '0')
        const seconds = String(date.getSeconds()).padStart(2, '0')
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
    }

    private async recoverRecentOrdersAfterReconnect() {
        if (this.recoveringOrders) {
            return
        }

        this.recoveringOrders = true

        try {
            const recentOrders = getOrders({
                accountId: this._accountId,
                orderTimeStart: this.getRecentOrderStart(1),
                limit: 200,
                offset: 0
            })

            if (recentOrders.length === 0) {
                logger.info(`[${this._accountId}] 重连后最近1天无本地订单，跳过补单`)
                return
            }

            let refreshed = 0
            for (const order of recentOrders) {
                const detail = await fetchAndUpdateOrderDetail(this, order.orderId)
                if (detail) {
                    refreshed++
                }
                await new Promise(resolve => setTimeout(resolve, 100))
            }

            logger.info(`[${this._accountId}] 重连后订单回补完成：${refreshed}/${recentOrders.length}，已允许状态变化补触发自动发货`)
        } catch (e) {
            logger.error(`[${this._accountId}] 重连后订单回补失败: ${e}`)
        } finally {
            this.recoveringOrders = false
        }
    }

    async connect(): Promise<boolean> {
        return new Promise((resolve) => {
            let settled = false
            let connectionEstablished = false

            const finish = (result: boolean) => {
                if (settled) {
                    return
                }
                settled = true
                resolve(result)
            }

            try {
                logger.info(`[${this._accountId}] 正在连接 WebSocket...`)
                this.ws = new WebSocket(WS_CONFIG.URL, { headers: WS_HEADERS })

                const connectionTimeout = setTimeout(() => {
                    logger.error(`[${this._accountId}] 连接超时`)
                    this.cleanup()
                    updateAccountStatus({ accountId: this._accountId, connected: false, errorMessage: '连接超时' })
                    finish(false)
                }, 30000)

                this.ws.on('open', async () => {
                    clearTimeout(connectionTimeout)
                    connectionEstablished = true
                    const hadSyncCursor = Boolean(getAccountStatus(this._accountId)?.lastSyncTimestamp)
                    const isReconnect = this.hasConnectedOnce || hadSyncCursor
                    this.hasConnectedOnce = true
                    this.lastHeartbeatTime = Date.now()
                    logger.info(`[${this._accountId}] WebSocket 连接已建立`)
                    this.connectionFailures = 0
                    updateAccountStatus({ accountId: this._accountId, connected: true, errorMessage: '' })

                    try {
                        await this.initConnection(isReconnect)
                        this.startHeartbeat()
                        this.startTokenRefresh()
                        this.startNetworkCheck()
                        if (isReconnect) {
                            void this.recoverRecentOrdersAfterReconnect()
                        }
                        finish(true)
                    } catch (e) {
                        logger.error(`[${this._accountId}] 初始化连接失败: ${e}`)
                        this.cleanup()
                        updateAccountStatus({ accountId: this._accountId, connected: false, errorMessage: String(e) })
                        finish(false)
                    }
                })

                this.ws.on('message', async (data) => {
                    try {
                        const msgData = JSON.parse(data.toString())
                        await processWebSocketMessage(
                            msgData,
                            {
                                accountId: this._accountId,
                                myId: this.myId,
                                client: this,
                                onMessage: this.onMessage,
                                onAutoReply: (chatId, senderId, content) => this.sendMessage(chatId, senderId, content)
                            },
                            (headers) => this.sendAck(headers)
                        )
                    } catch (e) {
                        logger.error(`[${this._accountId}] 解析消息失败: ${e}`)
                    }
                })

                this.ws.on('close', (code, reason) => {
                    clearTimeout(connectionTimeout)
                    const reasonText = typeof reason === 'string' ? reason : reason?.toString() || ''
                    logger.warn(`[${this._accountId}] WebSocket 连接关闭: ${code} - ${reasonText}`)
                    this.cleanup(false)
                    this.lastHeartbeatTime = 0
                    updateAccountStatus({ accountId: this._accountId, connected: false })

                    if (!connectionEstablished) {
                        finish(false)
                        return
                    }

                    if (this.running) {
                        this.tryReconnect()
                    }
                })

                this.ws.on('error', (err) => {
                    clearTimeout(connectionTimeout)
                    logger.error(`[${this._accountId}] WebSocket 错误: ${err.message}`)
                    updateAccountStatus({ accountId: this._accountId, connected: false, errorMessage: err.message })
                    if (!connectionEstablished) {
                        this.cleanup()
                        finish(false)
                    }
                })
            } catch (e) {
                logger.error(`[${this._accountId}] 连接失败: ${e}`)
                this.cleanup()
                updateAccountStatus({ accountId: this._accountId, connected: false, errorMessage: String(e) })
                finish(false)
            }
        })
    }

    private cleanup(closeSocket = true) {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
        if (this.tokenRefreshTimer) {
            clearInterval(this.tokenRefreshTimer)
            this.tokenRefreshTimer = null
        }
        if (this.networkCheckTimer) {
            clearInterval(this.networkCheckTimer)
            this.networkCheckTimer = null
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        if (closeSocket && this.ws) {
            try {
                this.ws.close()
            } catch (e) {
                logger.warn(`[${this._accountId}] 关闭WebSocket连接时发生错误: ${e}`)
            } finally {
                this.ws = null
            }
        } else if (!closeSocket) {
            this.ws = null
        }
    }

    disconnect() {
        this.running = false
        this.connectionFailures = 0
        this.lastHeartbeatTime = 0
        this.cleanup()
        updateAccountStatus({ accountId: this._accountId, connected: false })
        logger.info(`[${this._accountId}] 客户端已断开连接`)
    }

    async run() {
        this.running = true
        const connected = await this.connect()
        if (!connected) {
            this.running = false
            logger.error(`[${this._accountId}] 初次连接失败，未加入运行队列`)
            return false
        }

        return true
    }
}
