/**
 * 订单服务
 * 简化版：订单ID唯一，通过API获取订单详情
 */

import { createLogger } from '../core/logger.js'
import {
    getOrders,
    getOrderCount,
    getOrderById,
    upsertOrder,
    updateOrderStatus,
    getEnabledAutoSellRules
} from '../db/index.js'
import { OrderStatus, ORDER_STATUS_TEXT } from '../types/order.types.js'
import { startWorkflowExecution } from './workflow.service.js'
import { selectAutoSellRule } from '../utils/autosell-rule-matcher.js'
import type { OrderRecord, OrderListParams, OrderDetailData } from '../types/order.types.js'
import type { GoofishClient } from '../websocket/client.js'

const logger = createLogger('Svc:Order')
const REFUND_TEXT_RE = /(退款|退回|售后)/
const DISCOUNT_TEXT_RE = /(discount|deduction|coupon|promotion|优惠|抵扣|立减|减免|返现|补贴)/i
const ORDER_DETAIL_RETRY_DELAYS_MS = [0, 1500, 4000, 10000, 60000] as const
const inFlightOrderDetailRequests = new Map<string, Promise<OrderDetailData | null>>()

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchOrderDetailWithRetry(
    client: GoofishClient,
    orderId: string
): Promise<any | null> {
    let lastDetail: any | null = null

    for (let attempt = 0; attempt < ORDER_DETAIL_RETRY_DELAYS_MS.length; attempt++) {
        const delayMs = ORDER_DETAIL_RETRY_DELAYS_MS[attempt]
        if (delayMs > 0) {
            logger.warn(
                `订单详情暂未就绪，${Math.round(delayMs / 1000)} 秒后重试: ${orderId} (${attempt + 1}/${ORDER_DETAIL_RETRY_DELAYS_MS.length})`
            )
            await sleep(delayMs)
        }

        lastDetail = await client.fetchOrderDetail(orderId)
        if (lastDetail?.data) {
            if (attempt > 0) {
                logger.info(`订单详情补拉成功: ${orderId}（第 ${attempt + 1} 次尝试）`)
            }
            return lastDetail
        }

        logger.warn(`订单详情响应为空: ${orderId}（第 ${attempt + 1} 次尝试）`)
    }

    return lastDetail
}

function extractTextValue(value: unknown): string | null {
    if (value === null || value === undefined) return null

    if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim()
        return text || null
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        for (const key of ['value', 'text', 'content', 'desc', 'displayText', 'display', 'label', 'name']) {
            const text = extractTextValue(record[key])
            if (text) return text
        }
    }

    return null
}

function pickFirstText(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        const text = extractTextValue(candidate)
        if (text) return text
    }
    return null
}

function normalizeAmountText(value: unknown): string | null {
    const text = extractTextValue(value)
    if (!text) return null

    const normalized = text.replace(/[￥¥,\s元]/g, '').trim()
    const match = normalized.match(/-?\d+(?:\.\d+)?/)
    return match?.[0] || null
}

function parseAmountNumber(value: string | null | undefined): number | null {
    if (!value) return null

    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function formatAmountNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function collectTextParts(value: unknown): string[] {
    if (value === null || value === undefined) return []

    if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim()
        return text ? [text] : []
    }

    if (Array.isArray(value)) {
        return value.flatMap(item => collectTextParts(item))
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>

        if (Array.isArray(record.descRichText)) {
            return collectTextParts(record.descRichText)
        }

        for (const key of ['text', 'value', 'content', 'desc', 'displayText', 'display', 'label', 'name', 'title']) {
            const parts = collectTextParts(record[key])
            if (parts.length > 0) {
                return parts
            }
        }
    }

    return []
}

function joinTextParts(value: unknown, separator = ' '): string | null {
    const parts = collectTextParts(value)
        .map(part => part.trim())
        .filter(Boolean)

    if (parts.length === 0) {
        return null
    }

    return parts.join(separator).replace(/\s+/g, ' ').trim()
}

function containsRefundSignal(value: unknown): boolean {
    const text = joinTextParts(value) || extractTextValue(value)
    return Boolean(text && REFUND_TEXT_RE.test(text))
}

function extractRefundRelatedText(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        const parts = collectTextParts(candidate)
        const refundParts = parts.filter(part => REFUND_TEXT_RE.test(part))

        if (refundParts.length > 0) {
            return refundParts.join(' ').replace(/\s+/g, ' ').trim()
        }

        const text = joinTextParts(candidate)
        if (text && REFUND_TEXT_RE.test(text)) {
            return text
        }
    }

    return null
}

function positiveAmountText(value: unknown): string | null {
    const amount = parseAmountNumber(normalizeAmountText(value))
    if (amount === null || Math.abs(amount) <= 0) {
        return null
    }

    return formatAmountNumber(Math.abs(amount))
}

function sumAmountNumbers(values: number[]): number | null {
    if (values.length === 0) {
        return null
    }

    return values.reduce((sum, current) => sum + current, 0)
}

function formatSummedPositiveAmounts(values: number[]): string | null {
    const total = sumAmountNumbers(values)
    if (total === null || total <= 0) {
        return null
    }

    return formatAmountNumber(total)
}

function getBillLineAmounts(priceInfo: any): number[] {
    if (!Array.isArray(priceInfo?.billList)) {
        return []
    }

    return priceInfo.billList
        .map((item: any) => parseAmountNumber(normalizeAmountText(item?.value)))
        .filter((amount: number | null): amount is number => amount !== null)
}

function getStandaloneDiscountAmounts(priceInfo: any): number[] {
    if (!priceInfo || typeof priceInfo !== 'object') {
        return []
    }

    const amounts: number[] = []
    const seen = new Set<string>()

    for (const [key, value] of Object.entries(priceInfo as Record<string, unknown>)) {
        if (['amount', 'billList', 'softwareServiceFeeList', 'idleCoin'].includes(key)) {
            continue
        }

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue
        }

        const title = pickFirstText((value as any)?.title, (value as any)?.label, (value as any)?.name, key)
        const signalText = `${key} ${title || ''}`
        if (!DISCOUNT_TEXT_RE.test(signalText)) {
            continue
        }

        const rawValue = normalizeAmountText((value as any)?.value)
        const amount = parseAmountNumber(rawValue)
        if (amount === null || amount >= 0) {
            continue
        }

        const dedupeKey = `${title || key}|${rawValue}`
        if (seen.has(dedupeKey)) {
            continue
        }

        seen.add(dedupeKey)
        amounts.push(Math.abs(amount))
    }

    return amounts
}

function extractRefundAmountFromText(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        const text = joinTextParts(candidate)
        if (!text || !REFUND_TEXT_RE.test(text)) {
            continue
        }

        const amount = positiveAmountText(text)
        if (amount) {
            return amount
        }
    }

    return null
}

function findOrderInfoValue(orderInfoList: any[], titleKeywords: string[]): string | null {
    for (const item of orderInfoList) {
        const title = pickFirstText(item?.title, item?.label, item?.name, item?.key)
        if (!title) continue

        if (titleKeywords.some(keyword => title.includes(keyword))) {
            return pickFirstText(
                item?.value,
                item?.content,
                item?.desc,
                item?.text,
                item?.rightText
            )
        }
    }

    return null
}

// 获取订单列表
export function getOrderList(params: OrderListParams) {
    const orders = getOrders(params)
    const total = getOrderCount(params)
    return {
        orders,
        total,
        limit: params.limit || 50,
        offset: params.offset || 0
    }
}

// 获取单个订单
export function getOrder(orderId: string): OrderRecord | null {
    return getOrderById(orderId)
}

// 处理订单消息：仅记录订单ID，详情通过API获取
export function handleOrderMessage(accountId: string, orderId: string, chatId?: string): void {
    logger.info(`收到订单消息: ${orderId}`)

    // 检查订单是否已存在
    const existing = getOrderById(orderId)
    if (!existing) {
        // 创建订单占位记录
        upsertOrder({
            orderId,
            accountId,
            status: 0,
            statusText: '获取中...',
            chatId
        })
        logger.info(`新订单记录已创建: ${orderId}`)
    } else if (chatId && !existing.chatId) {
        // 更新 chatId
        upsertOrder({
            ...existing,
            chatId
        })
    }
}

// 通过 API 获取订单详情并更新数据库
export async function fetchAndUpdateOrderDetail(
    client: GoofishClient,
    orderId: string,
    options?: {
        triggerAutoSell?: boolean
    }
): Promise<OrderDetailData | null> {
    const requestKey = `${client.accountId}:${orderId}`
    const existingRequest = inFlightOrderDetailRequests.get(requestKey)
    if (existingRequest) {
        logger.debug(`复用进行中的订单详情请求: ${orderId}`)
        return existingRequest
    }

    const requestPromise = (async () => {
        try {
            const triggerAutoSellEnabled = options?.triggerAutoSell !== false
            const detail = await fetchOrderDetailWithRetry(client, orderId)
            if (!detail?.data) {
                logger.warn(`订单详情最终仍为空，停止本轮处理: ${orderId}`)
                return null
            }

            const data = detail.data

            // 解析订单信息
            const orderInfoVO = data.components?.find((c: any) => c.render === 'orderInfoVO')?.data
            const orderStatusVO = data.components?.find((c: any) => c.render === 'orderStatusVO')?.data
            const orderStatusInfo = orderStatusVO?.orderStatusInfo
            const itemInfo = orderInfoVO?.itemInfo
            const orderInfoList = orderInfoVO?.orderInfoList || []
            const priceInfo = orderInfoVO?.priceInfo || {}

            // 提取字段
            const buyerNickname = findOrderInfoValue(orderInfoList, ['买家昵称'])
            const orderTime = findOrderInfoValue(orderInfoList, ['下单时间'])
            const payTime = findOrderInfoValue(orderInfoList, ['付款时间'])
            const shipTime = findOrderInfoValue(orderInfoList, ['发货时间'])
            const completeTime = findOrderInfoValue(orderInfoList, ['成交时间'])

            const itemIdStr = data.itemId ? String(data.itemId) : undefined
            const buyerUserIdStr = data.peerUserId ? String(data.peerUserId) : undefined
            const status = data.status
            const statusText = data.utArgs?.orderMainTitle || ORDER_STATUS_TEXT[status] || '未知状态'

            const itemTitle = itemInfo?.title
            const itemPicUrl = itemInfo?.itemMainPictCdnUrl
            const price = normalizeAmountText(
                pickFirstText(
                    itemInfo?.price,
                    itemInfo?.unitPrice,
                    priceInfo?.unitPrice?.value,
                    priceInfo?.unitPrice,
                    priceInfo?.price?.value,
                    priceInfo?.price,
                    priceInfo?.amount?.value,
                    priceInfo?.amount
                )
            )
            const rawBuyAmount = itemInfo?.buyAmount ?? itemInfo?.quantity ?? 1
            const parsedBuyAmount = Number(rawBuyAmount)
            const buyAmount = Number.isFinite(parsedBuyAmount) && parsedBuyAmount > 0
                ? Math.floor(parsedBuyAmount)
                : 1
            const billLineAmounts = getBillLineAmounts(priceInfo)
            const totalAmountFromBill = formatSummedPositiveAmounts(
                billLineAmounts.filter(amount => amount > 0)
            )
            const discountAmountFromBill = formatSummedPositiveAmounts(
                billLineAmounts.filter(amount => amount < 0).map(amount => Math.abs(amount))
            )
            const discountAmountFromStandalone = formatSummedPositiveAmounts(
                getStandaloneDiscountAmounts(priceInfo)
            )
            const totalAmount = totalAmountFromBill || normalizeAmountText(
                pickFirstText(
                    priceInfo?.totalAmount?.value,
                    priceInfo?.totalAmount,
                    priceInfo?.totalFee?.value,
                    priceInfo?.totalFee,
                    priceInfo?.price?.value,
                    priceInfo?.price,
                    itemInfo?.price,
                    price
                )
            )
            let buyerPaidAmount = normalizeAmountText(pickFirstText(
                priceInfo?.buyerPaidAmount?.value,
                priceInfo?.buyerPaidAmount,
                priceInfo?.actualPay?.value,
                priceInfo?.actualPay,
                priceInfo?.payAmount?.value,
                priceInfo?.payAmount,
                priceInfo?.realPay?.value,
                priceInfo?.realPay,
                data?.actualFee?.value,
                data?.actualFee,
                orderInfoVO?.actualFee?.value,
                orderInfoVO?.actualFee,
                findOrderInfoValue(orderInfoList, ['实付款', '买家实付', '实际支付', '实付金额']),
                priceInfo?.amount?.value,
                priceInfo?.amount
            ))
            let discountAmount = discountAmountFromBill || positiveAmountText(pickFirstText(
                priceInfo?.discountAmount?.value,
                priceInfo?.discountAmount,
                priceInfo?.discount?.value,
                priceInfo?.discount,
                priceInfo?.promotionAmount?.value,
                priceInfo?.promotionAmount,
                orderInfoVO?.discountAmount?.value,
                orderInfoVO?.discountAmount,
                findOrderInfoValue(orderInfoList, ['优惠金额', '优惠', '立减', '减免'])
            )) || discountAmountFromStandalone

            const orderStatusRefundText = extractRefundRelatedText(
                data?.refundStatus,
                orderInfoVO?.refundStatus,
                findOrderInfoValue(orderInfoList, ['退款状态', '售后状态']),
                data?.utArgs?.orderStatusName,
                orderStatusInfo?.descRichText,
                orderStatusInfo?.desc,
                orderStatusInfo?.title,
                data?.utArgs?.orderMainTitle,
                priceInfo?.amount?.descRichText,
                priceInfo?.amount?.desc
            )

            const refundAmount = positiveAmountText(pickFirstText(
                data?.refundAmount?.value,
                data?.refundAmount,
                orderInfoVO?.refundAmount?.value,
                orderInfoVO?.refundAmount,
                priceInfo?.refundAmount?.value,
                priceInfo?.refundAmount,
                findOrderInfoValue(orderInfoList, ['退款金额', '已退款'])
            )) || extractRefundAmountFromText(orderStatusInfo?.descRichText, orderStatusInfo?.desc)
                || (containsRefundSignal(priceInfo?.amount?.descRichText) ? positiveAmountText(priceInfo?.amount?.value) : null)

            const refundStatus = orderStatusRefundText
            const refundTime = pickFirstText(
                data?.refundTime,
                orderInfoVO?.refundTime,
                findOrderInfoValue(orderInfoList, ['退款时间', '退款成功时间', '售后时间'])
            ) || (containsRefundSignal(orderStatusRefundText)
                ? findOrderInfoValue(orderInfoList, ['交易关闭时间'])
                : null)

            const totalAmountNumber = parseAmountNumber(totalAmount)
            const buyerPaidAmountNumber = parseAmountNumber(buyerPaidAmount)
            const discountAmountNumber = parseAmountNumber(discountAmount)

            if (!discountAmount && totalAmountNumber !== null && buyerPaidAmountNumber !== null) {
                const computedDiscount = totalAmountNumber - buyerPaidAmountNumber
                if (computedDiscount > 0) {
                    discountAmount = formatAmountNumber(computedDiscount)
                }
            }

            if (!buyerPaidAmount && totalAmountNumber !== null && discountAmountNumber !== null) {
                const computedPaid = totalAmountNumber - discountAmountNumber
                if (computedPaid >= 0) {
                    buyerPaidAmount = formatAmountNumber(computedPaid)
                }
            }

            const refundAmountNumber = parseAmountNumber(refundAmount)
            const hasRefund = Boolean(
                refundStatus ||
                refundTime ||
                containsRefundSignal(data?.utArgs?.orderMainTitle) ||
                containsRefundSignal(data?.utArgs?.orderStatusName) ||
                containsRefundSignal(orderStatusInfo?.descRichText) ||
                containsRefundSignal(priceInfo?.amount?.descRichText) ||
                (refundAmountNumber !== null && refundAmountNumber > 0)
            )

            logger.info(`订单详情: ${orderId}, 状态=${statusText}, 商品=${itemTitle}`)

            // 获取旧订单状态
            const oldOrder = getOrderById(orderId)
            const oldStatus = oldOrder?.status

            upsertOrder({
                orderId,
                accountId: client.accountId,
                itemId: itemIdStr,
                itemTitle,
                itemPicUrl,
                price,
                buyAmount,
                totalAmount,
                buyerPaidAmount,
                discountAmount,
                refundAmount,
                refundStatus,
                refundTime,
                hasRefund,
                buyerUserId: buyerUserIdStr,
                buyerNickname,
                status,
                statusText,
                orderTime: orderTime || undefined,
                payTime,
                shipTime,
                completeTime
            })

            // 检查是否需要触发自动发货
            if (triggerAutoSellEnabled) {
                if (status === OrderStatus.PENDING_SHIPMENT && oldStatus !== OrderStatus.PENDING_SHIPMENT) {
                    // 订单变为待发货状态，触发自动发货
                    await triggerAutoSell(client, orderId, itemIdStr, buyerUserIdStr, 'paid', price)
                } else if (status === OrderStatus.PENDING_RECEIPT && oldStatus !== OrderStatus.PENDING_RECEIPT) {
                    // 订单变为待收货状态，触发确认收货后的自动发货
                    await triggerAutoSell(client, orderId, itemIdStr, buyerUserIdStr, 'confirmed', price)
                }
            } else {
                logger.debug(`订单 ${orderId} 已更新详情（跳过自动发货触发）`)
            }

            return data
        } catch (e) {
            logger.error(`获取订单详情失败: ${orderId} - ${e}`)
            return null
        } finally {
            inFlightOrderDetailRequests.delete(requestKey)
        }
    })()

    inFlightOrderDetailRequests.set(requestKey, requestPromise)
    return requestPromise
}

/**
 * 触发自动发货（通过流程引擎）
 */
async function triggerAutoSell(
    client: GoofishClient,
    orderId: string,
    itemId: string | undefined,
    buyerUserId: string | undefined,
    triggerOn: 'paid' | 'confirmed',
    orderPrice?: string | null
): Promise<void> {
    try {
        // 获取匹配的规则
        const rules = getEnabledAutoSellRules(client.accountId, itemId)
        const matchedRule = selectAutoSellRule(rules, triggerOn, orderPrice)

        if (!matchedRule) {
            logger.debug(`订单 ${orderId} 无匹配的自动发货规则`)
            return
        }

        // 从订单记录获取 chatId
        const order = getOrderById(orderId)
        const chatId = order?.chatId || undefined

        // 启动流程执行
        const result = await startWorkflowExecution(matchedRule.workflowId, {
            orderId,
            accountId: client.accountId,
            itemId,
            ruleId: matchedRule.id,
            client,
            buyerUserId,
            chatId
        })

        if (!result.success) {
            if (result.error !== '流程已在执行中') {
                logger.warn(`自动发货流程启动失败: ${orderId} - ${result.error}`)
            }
        } else {
            logger.info(`自动发货流程已启动: ${orderId}, 规则: ${matchedRule.name}`)
        }
    } catch (e) {
        logger.error(`触发自动发货异常: ${orderId} - ${e}`)
    }
}
