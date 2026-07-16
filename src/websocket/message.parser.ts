import { decodeMessagePack } from '../utils/msgpack.js'
import { createLogger } from '../core/logger.js'
import type { ChatMessage } from '../types/index.js'

const logger = createLogger('Ws:Parser')

// 纯系统提示消息（不需要处理的）
const SYSTEM_MESSAGES = [
    '[不想宝贝被砍价?设置不砍价回复  ]',
    'AI正在帮你回复消息，不错过每笔订单',
    '发来一条消息',
    '发来一条新消息',
    '快给ta一个评价吧~',
    '快给ta一个评价吧～',
    '卖家人不错？送Ta闲鱼小红花'
]

// 订单状态消息（需要捕获但不触发自动回复）
const ORDER_STATUS_MESSAGES = [
    '[我已拍下，待付款]',
    '[我已付款，等待你发货]',
    '[已付款，待发货]',
    '[记得及时发货]',
    '[你已发货]',
    '[你已发货，请等待买家确认收货]',
    '[买家确认收货，交易成功]',
    '[你已确认收货，交易成功]',
    '[你关闭了订单，钱款已原路退返]',
    '[未付款，买家关闭了订单]',
    '[记得及时确认收货]',
    '记得及时发货',
    '已发货',
    '有蚂蚁森林能量可领'
]

export function isSystemMessage(content: string): boolean {
    return SYSTEM_MESSAGES.includes(content)
}

export function isOrderStatusMessage(content: string): boolean {
    return ORDER_STATUS_MESSAGES.some(msg => content.includes(msg))
}

function extractOrderIdFromUrl(url: unknown): string | undefined {
    if (typeof url !== "string" || !url) return undefined

    const match = url.match(/(?:orderId|bizOrderId|[?&]id)=(\d{15,})/)
    return match ? match[1] : undefined
}

export function decryptSyncData(data: string): any | null {
    // 先尝试 MessagePack 解码（这是主要格式）
    try {
        const result = decodeMessagePack(data)
        if (result && typeof result === 'object') {
            // 检查是否是有效的聊天消息结构
            const msg1 = result['1'] || result[1]
            if (msg1 && typeof msg1 === 'object') {
                const msg10 = msg1['10'] || msg1[10]
                if (msg10 && typeof msg10 === 'object' && 'reminderContent' in msg10) {
                    return result
                }
            }
        }
    } catch (e) {
        logger.debug(`MessagePack解密失败: ${e}`)
    }

    // 尝试 base64 + JSON
    try {
        const decoded = Buffer.from(data, 'base64').toString('utf-8')
        const parsed = JSON.parse(decoded)
        if (typeof parsed === 'object') {
            if ('chatType' in parsed) return null // 系统消息
            return parsed
        }
    } catch {
        // 忽略 JSON 解析失败
    }

    return null
}

export function extractChatMessage(message: any, myId: string): ChatMessage | null {
    try {
        // 检查消息结构
        if (!message || typeof message !== 'object') return null

        // 支持两种消息结构：数字键和字符串键
        const msg1 = message['1'] || message[1]
        if (!msg1 || typeof msg1 !== 'object') return null

        const msg10 = msg1['10'] || msg1[10]
        if (!msg10 || typeof msg10 !== 'object') return null

        const createTime = parseInt(msg1['5'] || msg1[5] || '0')
        const senderName = msg10.senderNick || msg10.reminderTitle || '未知用户'
        const senderId = msg10.senderUserId || 'unknown'
        const content = msg10.reminderContent || ''
        const msg3 = msg1['3'] || msg1[3]

        let itemId: string | undefined = undefined
        let itemTitle: string | undefined = undefined
        if (msg3 && typeof msg3 === 'object') {
            if (msg3.itemId != null) {
                itemId = String(msg3.itemId)
            }
            if (msg3.itemTitle != null) {
                itemTitle = String(msg3.itemTitle)
            }
        }

        // 提取 chatId
        const chatIdRaw = msg1['2'] || msg1[2] || ''
        const chatId = String(chatIdRaw).includes('@') ? String(chatIdRaw).split('@')[0] : String(chatIdRaw)

        // 提取 API 消息 ID 和订单信息 (从 extJson 中)
        let msgId: string | undefined
        let orderId: string | undefined
        let orderStatus: string | undefined
        try {
            const extJson = msg10.extJson
            if (extJson) {
                const ext = JSON.parse(extJson)
                msgId = ext.messageId || ext.msg_id
                // updateKey 格式有两种:
                // 1. orderId:contentType:taskName:num (如 3142117850666220888:20:BUYER_CONFIRM:74)
                // 2. sessionId:orderId:contentType:taskName:num (如 56627074402:3142117850666220888:100:REMIND:26)
                if (ext.updateKey) {
                    const parts = ext.updateKey.split(':')
                    for (const part of parts) {
                        if (/^\d{15,}$/.test(part)) {
                            orderId = part
                            break
                        }
                    }
                }
            }
        } catch {
            // 忽略解析失败
        }

        // 从 bizTag 提取订单状态
        try {
            const bizTag = msg10.bizTag
            if (bizTag) {
                const tag = JSON.parse(bizTag)
                orderStatus = tag.taskName
            }
        } catch {
            // 忽略解析失败
        }

        // 从 reminderUrl 提取订单ID（备用方案）
        if (!orderId && msg10.reminderUrl) {
            const urlMatch = msg10.reminderUrl.match(/orderId=(\d+)/)
            if (urlMatch) {
                orderId = urlMatch[1]
            }

            if (!itemId) {
                const itemMatch = msg10.reminderUrl.match(/[?&]itemId=(\d+)/)
                if (itemMatch) {
                    itemId = itemMatch[1]
                }
            }
        }

        // 从消息内容的 dxCard/tip 中提取订单ID（备用方案）
        if (!orderId) {
            try {
                const msg6 = msg1['6'] || msg1[6]
                if (msg6) {
                    const msg63 = msg6['3'] || msg6[3]
                    if (msg63) {
                        const cardJson = msg63['5'] || msg63[5]
                        if (cardJson) {
                            const card = JSON.parse(cardJson)
                            // 从 tip.argInfo.args.orderId 提取（蚂蚁森林能量等消息）
                            const tipOrderId = card?.tip?.argInfo?.args?.orderId
                            if (tipOrderId && /^\d{15,}$/.test(tipOrderId)) {
                                orderId = tipOrderId
                            }
                            // 从各类卡片 URL 提取订单 ID，兼容 IM 卡片、工作台通知和动态卡片
                            if (!orderId) {
                                orderId = extractOrderIdFromUrl(card?.dxCard?.item?.main?.targetUrl)
                            }
                            if (!orderId) {
                                orderId = extractOrderIdFromUrl(card?.dxCard?.item?.main?.exContent?.button?.targetUrl)
                            }
                            if (!orderId) {
                                orderId = extractOrderIdFromUrl(card?.dxCard?.item?.main?.exContent?.button?.intent?.page?.pcJumpUrl)
                            }
                            if (!orderId) {
                                orderId = extractOrderIdFromUrl(card?.dxCard?.item?.main?.exContent?.button?.intent?.page?.jumpUrl)
                            }
                            if (!orderId) {
                                orderId = extractOrderIdFromUrl(card?.dynamicOperation?.changeContent?.dxCard?.item?.main?.targetUrl)
                            }
                            if (!orderId) {
                                orderId = extractOrderIdFromUrl(card?.dynamicOperation?.changeContent?.dxCard?.item?.main?.exContent?.button?.targetUrl)
                            }
                        }
                    }
                }
            } catch {
                // 忽略解析失败
            }
        }

        const msgTime = createTime
            ? new Date(createTime).toLocaleString('zh-CN', { hour12: false })
            : new Date().toLocaleString('zh-CN', { hour12: false })

        // 检查是否是订单状态消息
        const isOrderMessage = isOrderStatusMessage(content)

        // 过滤自己的消息（但订单状态消息除外，因为可能是系统发送的）
        if (senderId === myId && !isOrderMessage) {
            logger.debug(`[${msgTime}] 忽略自己发送的消息`)
            return null
        }

        // 过滤纯系统消息（不包含有用信息的）
        if (isSystemMessage(content)) {
            logger.debug(`[${msgTime}] 系统消息不处理: ${content}`)
            return null
        }

        // 过滤空消息
        if (!content || content.trim() === '') {
            logger.debug(`[${msgTime}] 忽略空消息`)
            return null
        }

        // 订单状态消息特殊日志
        if (isOrderMessage && orderId) {
            logger.info(`[${msgTime}] 订单状态消息 - 订单ID: ${orderId}, 状态: ${orderStatus || content}`)
        }

        return {
            senderId,
            senderName,
            msgTime,
            content,
            chatId,
            itemId,
            itemTitle,
            msgId,
            timestamp: createTime || Date.now(),
            raw: message,
            orderId,
            orderStatus,
            isOrderMessage
        }
    } catch (e) {
        logger.error(`提取聊天消息失败: ${e}`)
        return null
    }
}
