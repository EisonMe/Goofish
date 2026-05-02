/**
 * 自动发货服务
 */

import { createLogger } from '../core/logger.js'
import {
    getEnabledAutoSellRules,
    getAutoSellRule,
    getStockStats,
    consumeStock,
    consumeStockBatch,
    restoreStockItems,
    addDeliveryLog,
    getDeliveredQuantity,
    getOrderById
} from '../db/index.js'
import type { AutoSellRule, DeliveryResult, ApiConfig, StockItem } from '../types/index.js'
import { selectAutoSellRule } from '../utils/autosell-rule-matcher.js'

const logger = createLogger('Svc:AutoSell')

export interface ProcessAutoSellParams {
    accountId: string
    orderId: string
    itemId?: string
    triggerOn?: 'paid' | 'confirmed'
    orderPrice?: string | null
    ruleId?: number | null
}

export interface ProcessAutoSellResult extends DeliveryResult {
    ruleId?: number | null
    ruleName?: string
    deliveryType?: AutoSellRule['deliveryType'] | 'unknown'
}

function normalizeQuantity(value: unknown, fallback = 1): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback
    }
    return Math.max(1, Math.floor(parsed))
}

function formatBatchContent(contents: string[]): string {
    if (contents.length <= 1) {
        return contents[0] || ''
    }

    return contents.map((content, index) => `${index + 1}. ${content}`).join('\n')
}

function isNonEmptyContent(value: string | undefined): boolean {
    return Boolean(value && value.trim())
}

function normalizeReservedStockItemIds(stockItemIds: number[] | undefined): number[] {
    if (!stockItemIds?.length) {
        return []
    }

    return [...new Set(
        stockItemIds
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id > 0)
    )]
}

export function recordAutoSellDeliveryLog(data: {
    orderId: string
    accountId: string
    ruleId?: number | null
    deliveryType?: AutoSellRule['deliveryType'] | 'unknown'
    content?: string
    quantity?: number
    success: boolean
    errorMessage?: string | null
}) {
    addDeliveryLog({
        ruleId: data.ruleId ?? null,
        orderId: data.orderId,
        accountId: data.accountId,
        deliveryType: data.deliveryType || 'unknown',
        content: data.content || '',
        quantity: data.success ? normalizeQuantity(data.quantity ?? 1, 1) : 0,
        status: data.success ? 'success' : 'failed',
        errorMessage: data.errorMessage || null
    })
}

export function rollbackAutoSellReservation(
    orderId: string,
    result?: Pick<DeliveryResult, 'reservedStockItemIds'> | null
): number {
    const reservedStockItemIds = normalizeReservedStockItemIds(result?.reservedStockItemIds)
    if (reservedStockItemIds.length === 0) {
        return 0
    }

    const restoredCount = restoreStockItems(reservedStockItemIds, orderId)
    if (restoredCount > 0) {
        logger.warn(`Order ${orderId} rolled back ${restoredCount} reserved stock items`)
    }

    return restoredCount
}

/**
 * 通过 API 获取发货内容
 */
async function fetchFromApi(config: ApiConfig, context: Record<string, string>): Promise<string> {
    let url = config.url
    let body = config.body

    // 替换变量
    for (const [key, value] of Object.entries(context)) {
        const placeholder = `{{${key}}}`
        url = url.replace(new RegExp(placeholder, 'g'), value)
        if (body) {
            body = body.replace(new RegExp(placeholder, 'g'), value)
        }
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...config.headers
    }

    // 定义重试参数
    const maxRetries = 3
    const retryDelay = 1000 // 1秒

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            logger.debug(`[尝试 ${attempt + 1}/${maxRetries}] 调用 API: ${url}`)
            
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), config.timeout || 30000) // 默认30秒超时

            const response = await fetch(url, {
                method: config.method,
                headers,
                body: config.method === 'POST' ? body : undefined,
                signal: controller.signal
            })

            clearTimeout(timeoutId)

            if (!response.ok) {
                throw new Error(`API 请求失败: ${response.status} ${response.statusText}`)
            }

            const data = await response.json()

            // 从响应中提取内容
            if (config.responseField) {
                const fields = config.responseField.split('.')
                let result = data
                for (const field of fields) {
                    result = result?.[field]
                }
                if (result === undefined) {
                    throw new Error(`响应中未找到字段: ${config.responseField}`)
                }
                return String(result)
            }

            return typeof data === 'string' ? data : JSON.stringify(data)
        } catch (e: any) {
            logger.warn(`API 调用失败 (尝试 ${attempt + 1}/${maxRetries}): ${e.message}`)
            
            // 如果是最后一次尝试，抛出错误
            if (attempt === maxRetries - 1) {
                throw e
            }
            
            // 等待一段时间后重试
            await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)))
        }
    }

    throw new Error('API 调用失败，已达到最大重试次数')
}


/**
 * 执行发货
 */
async function executeDelivery(
    rule: AutoSellRule,
    orderId: string,
    context: Record<string, string>,
    quantity = 1
): Promise<DeliveryResult> {
    const normalizedQuantity = normalizeQuantity(quantity)

    switch (rule.deliveryType) {
        case 'fixed':
            if (!rule.deliveryContent) {
                return { success: false, error: '未配置发货内容' }
            }
            return {
                success: true,
                content: rule.deliveryContent,
                deliveredQuantity: normalizedQuantity
            }

        case 'stock': {
            const stocks = normalizedQuantity === 1
                ? (() => {
                    const stock = consumeStock(rule.id, orderId)
                    return stock ? [stock] : []
                })()
                : consumeStockBatch(rule.id, orderId, normalizedQuantity)

            if (stocks.length < normalizedQuantity) {
                return { success: false, error: '库存不足' }
            }
                return {
                    success: true,
                    content: formatBatchContent(stocks.map((stock: StockItem) => stock.content)),
                    deliveredQuantity: stocks.length,
                    reservedStockItemIds: stocks.map((stock: StockItem) => stock.id)
                }
        }

        case 'api': {
            if (!rule.apiConfig) {
                return { success: false, error: '未配置 API' }
            }
            try {
                const contents: string[] = []

                for (let index = 0; index < normalizedQuantity; index++) {
                    const content = await fetchFromApi(rule.apiConfig, {
                        ...context,
                        quantity: '1',
                        batchQuantity: String(normalizedQuantity),
                        itemIndex: String(index + 1)
                    })
                    contents.push(content)
                }

                return {
                    success: true,
                    content: formatBatchContent(contents),
                    deliveredQuantity: contents.length
                }
            } catch (e: any) {
                return { success: false, error: e.message }
            }
        }

        default:
            return { success: false, error: '未知发货类型' }
    }
}

/**
 * 处理订单自动发货
 */
export async function processAutoSell(params: ProcessAutoSellParams): Promise<ProcessAutoSellResult> {
    const {
        accountId,
        orderId,
        itemId,
        triggerOn = 'paid',
        orderPrice,
        ruleId
    } = params

    try {
        const order = getOrderById(orderId)
        let matchedRule = ruleId ? getAutoSellRule(ruleId) : undefined

        if (!matchedRule) {
            const rules = getEnabledAutoSellRules(accountId, itemId)
            matchedRule = selectAutoSellRule(rules, triggerOn, orderPrice ?? order?.price ?? null)
        }

        if (!matchedRule) {
            logger.debug(`订单 ${orderId} 无匹配的自动发货规则`)
            return { success: false, error: '无匹配规则' }
        }

        const orderQuantity = normalizeQuantity(order?.buyAmount, 1)
        const deliveredQuantity = getDeliveredQuantity(orderId)
        const remainingQuantity = Math.max(orderQuantity - deliveredQuantity, 0)

        if (remainingQuantity <= 0) {
            logger.info(`订单 ${orderId} 已全部发货，跳过`)
            return {
                success: false,
                error: '订单已全部发货',
                ruleName: matchedRule.name,
                deliveredQuantity,
                remainingQuantity: 0
            }
        }

        // 检查库存类型的库存是否充足
        if (matchedRule.deliveryType === 'stock') {
            const stats = getStockStats(matchedRule.id)
            if (stats.available < remainingQuantity) {
                logger.warn(`规则 "${matchedRule.name}" 库存不足，需要 ${remainingQuantity}，可用 ${stats.available}`)
                const failureResult: ProcessAutoSellResult = {
                    success: false,
                    error: `库存不足（需要 ${remainingQuantity}，可用 ${stats.available}）`,
                    ruleId: matchedRule.id,
                    deliveryType: matchedRule.deliveryType,
                    ruleName: matchedRule.name,
                    deliveredQuantity,
                    remainingQuantity
                }
                recordAutoSellDeliveryLog({
                    orderId,
                    accountId,
                    ruleId: matchedRule.id,
                    deliveryType: matchedRule.deliveryType,
                    success: false,
                    errorMessage: failureResult.error
                })
                return failureResult
            }
        }

        // 执行发货
        const context = {
            orderId,
            accountId,
            itemId: itemId || '',
            quantity: String(remainingQuantity),
            totalQuantity: String(orderQuantity),
            deliveredQuantity: String(deliveredQuantity),
            remainingQuantity: String(remainingQuantity)
        }
        const result = await executeDelivery(matchedRule, orderId, context, remainingQuantity)
        const successQuantity = normalizeQuantity(
            result.deliveredQuantity ?? remainingQuantity,
            remainingQuantity
        )

        if (result.success) {
            if (!isNonEmptyContent(result.content)) {
                const errorMessage = '发货内容为空'
                rollbackAutoSellReservation(orderId, result)
                logger.error(`订单 ${orderId} 自动发货失败: ${errorMessage}`)
                recordAutoSellDeliveryLog({
                    orderId,
                    accountId,
                    ruleId: matchedRule.id,
                    deliveryType: matchedRule.deliveryType,
                    success: false,
                    errorMessage
                })
                return {
                    success: false,
                    error: errorMessage,
                    ruleId: matchedRule.id,
                    deliveryType: matchedRule.deliveryType,
                    ruleName: matchedRule.name,
                    deliveredQuantity,
                    remainingQuantity
                }
            }

            logger.info(`订单 ${orderId} 发货内容生成成功，等待发送消息: ${matchedRule.name}`)
            return {
                ...result,
                ruleId: matchedRule.id,
                ruleName: matchedRule.name,
                deliveryType: matchedRule.deliveryType,
                deliveredQuantity: successQuantity,
                remainingQuantity: Math.max(remainingQuantity - successQuantity, 0)
            }
        }

        rollbackAutoSellReservation(orderId, result)
        logger.error(`订单 ${orderId} 自动发货失败: ${result.error}`)
        recordAutoSellDeliveryLog({
            orderId,
            accountId,
            ruleId: matchedRule.id,
            deliveryType: matchedRule.deliveryType,
            content: result.content || '',
            success: false,
            errorMessage: result.error
        })

        return {
            ...result,
            ruleId: matchedRule.id,
            deliveryType: matchedRule.deliveryType,
            ruleName: matchedRule.name,
            deliveredQuantity,
            remainingQuantity
        }
    } catch (error: any) {
        logger.error(`处理订单 ${orderId} 自动发货时发生异常: ${error.message}`)
        recordAutoSellDeliveryLog({
            orderId,
            accountId,
            deliveryType: 'unknown',
            success: false,
            errorMessage: error.message
        })
        return {
            success: false,
            error: error.message,
            deliveryType: 'unknown'
        }
    }
}

/**
 * 获取规则的库存状态
 */
export function getRuleStockStatus(ruleId: number) {
    return getStockStats(ruleId)
}
