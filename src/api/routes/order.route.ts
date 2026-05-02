/**
 * 订单 API 路由
 */

import { Hono } from 'hono'

import { getOrderList, getOrder, fetchAndUpdateOrderDetail } from '../../services/order.service.js'
import { getOrders } from '../../db/order.repository.js'
import { processAutoSell, recordAutoSellDeliveryLog, rollbackAutoSellReservation } from '../../services/autosell.service.js'
import {
    exportAutoSellSupplementSheetCsv,
    getAutoSellAnomalies,
    getOrderAutoSellDebug
} from '../../services/autosell-debug.service.js'
import { getAutoSellRule, getLatestDeliveryLog } from '../../db/index.js'
import { updateOrderStatus, deleteOrder } from '../../db/order.repository.js'
import { OrderStatus, ORDER_STATUS_TEXT } from '../../types/order.types.js'
import type { ClientManager } from '../../websocket/client.manager.js'

function parseBooleanQuery(value: string | undefined): boolean | undefined {
    if (value === undefined) {
        return undefined
    }

    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false
    }

    return undefined
}

function toLocalDateTimeString(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function getDaysAgoLocalString(days: number): string {
    const date = new Date()
    date.setDate(date.getDate() - days)
    return toLocalDateTimeString(date)
}

async function refreshOrdersByList(
    orders: Array<{ orderId: string; accountId: string }>,
    getClientManager: () => ClientManager | null,
    options?: { triggerAutoSell?: boolean }
) {
    const clientManager = getClientManager()
    if (!clientManager) {
        return { error: 'ClientManager 未初始化' as const }
    }

    let refreshed = 0
    let failed = 0
    let skipped = 0
    const errors: string[] = []

    for (const order of orders) {
        const client = clientManager.getClient(order.accountId)
        if (!client) {
            skipped++
            continue
        }

        try {
            const detail = await fetchAndUpdateOrderDetail(client, order.orderId, options)
            if (detail) {
                refreshed++
            } else {
                failed++
                errors.push(`${order.orderId}: 获取详情为空`)
            }
        } catch (e: any) {
            failed++
            errors.push(`${order.orderId}: ${e.message}`)
        }

        await new Promise(r => setTimeout(r, 100))
    }

    return {
        success: true as const,
        summary: {
            total: orders.length,
            refreshed,
            failed,
            skipped,
            errors: errors.slice(0, 10)
        }
    }
}

export function createOrderRoutes(getClientManager: () => ClientManager | null) {
    const app = new Hono()

    // 获取订单列表
    app.get('/', async (c) => {
        const accountId = c.req.query('accountId')
        const groupId = c.req.query('groupId')
        const status = c.req.query('status')
        const keyword = c.req.query('keyword')
        const hasRefund = parseBooleanQuery(c.req.query('hasRefund'))
        const pendingRedelivery = parseBooleanQuery(c.req.query('pendingRedelivery'))
        const orderTimeStart = c.req.query('orderTimeStart')?.trim()
        const limit = parseInt(c.req.query('limit') || '50')
        const offset = parseInt(c.req.query('offset') || '0')

        const result = getOrderList({
            accountId: accountId || undefined,
            groupId: groupId ? parseInt(groupId) : undefined,
            status: status ? parseInt(status) : undefined,
            keyword: keyword?.trim() || undefined,
            hasRefund,
            pendingRedelivery,
            orderTimeStart: orderTimeStart || undefined,
            limit,
            offset
        })

        return c.json(result)
    })

    // 自动发货异常排查
    app.get('/autosell/anomalies', async (c) => {
        const limit = parseInt(c.req.query('limit') || '20')
        const result = getAutoSellAnomalies(limit)
        return c.json(result)
    })

    // 导出错发补发清单
    app.get('/autosell/anomalies/export', async (c) => {
        const limit = parseInt(c.req.query('limit') || '1000')
        const result = exportAutoSellSupplementSheetCsv(limit)

        c.header('Content-Type', 'text/csv; charset=utf-8')
        const safeFilename = result.filename.replace(/["\\]/g, '_')
            c.header('Content-Disposition', `attachment; filename="${safeFilename}"`)
        c.header('X-Export-Total', String(result.total))
        return c.body(result.csv)
    })

    // 批量回填订单实付/退款字段（仅刷新详情，不触发自动发货）
    app.post('/backfill-financials', async (c) => {
        const body = await c.req.json().catch(() => ({})) as {
            accountId?: string
            limit?: number
            orderIds?: string[]
        }

        const accountId = body.accountId?.trim()
        if (!accountId) {
            return c.json({ error: '缺少 accountId' }, 400)
        }

        const clientManager = getClientManager()
        if (!clientManager) {
            return c.json({ error: 'ClientManager 未初始化' }, 500)
        }

        const client = clientManager.getClient(accountId)
        if (!client) {
            return c.json({ error: '账号未连接' }, 400)
        }

        const explicitOrderIds = Array.isArray(body.orderIds)
            ? [...new Set(body.orderIds.map(id => String(id).trim()).filter(Boolean))]
            : []
        const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 200)
        const targetOrderIds = explicitOrderIds.length > 0
            ? explicitOrderIds
            : getOrderList({ accountId, limit, offset: 0 }).orders.map(order => order.orderId)

        if (targetOrderIds.length === 0) {
            return c.json({
                success: true,
                total: 0,
                updated: 0,
                failed: 0,
                failedOrderIds: []
            })
        }

        let updated = 0
        let failed = 0
        const failedOrderIds: string[] = []

        for (const orderId of targetOrderIds) {
            const detail = await fetchAndUpdateOrderDetail(client, orderId, { triggerAutoSell: false })
            if (detail) {
                updated++
            } else {
                failed++
                failedOrderIds.push(orderId)
            }
        }

        return c.json({
            success: true,
            total: targetOrderIds.length,
            updated,
            failed,
            failedOrderIds
        })
    })

    // 获取单个订单
    app.get('/:orderId', async (c) => {
        const orderId = c.req.param('orderId')
        const order = getOrder(orderId)

        if (!order) {
            return c.json({ error: '订单不存在' }, 404)
        }

        return c.json({ order })
    })

    // 查看订单自动发货命中详情
    app.get('/:orderId/autosell-debug', async (c) => {
        const orderId = c.req.param('orderId')
        const result = getOrderAutoSellDebug(orderId)

        if (!result) {
            return c.json({ error: '订单不存在' }, 404)
        }

        return c.json(result)
    })

    // 刷新订单详情
    app.post('/:orderId/refresh', async (c) => {
        const orderId = c.req.param('orderId')
        const clientManager = getClientManager()

        if (!clientManager) {
            return c.json({ error: 'ClientManager 未初始化' }, 500)
        }

        const localOrder = getOrder(orderId)
        if (!localOrder) {
            return c.json({ error: '订单不存在' }, 404)
        }

        const client = clientManager.getClient(localOrder.accountId)
        if (!client) {
            return c.json({ error: '账号未连接' }, 400)
        }

        const detail = await fetchAndUpdateOrderDetail(client, orderId)
        if (!detail) {
            return c.json({ error: '获取订单详情失败' }, 500)
        }

        const updatedOrder = getOrder(orderId)
        return c.json({ success: true, order: updatedOrder })
    })

    // 补发当前订单剩余未发货内容（不会再次确认发货）
    app.post('/:orderId/redeliver-missing', async (c) => {
        const orderId = c.req.param('orderId')
        const clientManager = getClientManager()

        if (!clientManager) {
            return c.json({ error: 'ClientManager 未初始化' }, 500)
        }

        const localOrder = getOrder(orderId)
        if (!localOrder) {
            return c.json({ error: '订单不存在' }, 404)
        }

        if (!localOrder.chatId || !localOrder.buyerUserId) {
            return c.json({ error: '订单缺少 chatId 或买家ID，请先刷新订单详情' }, 400)
        }

        const client = clientManager.getClient(localOrder.accountId)
        if (!client) {
            return c.json({ error: '账号未连接' }, 400)
        }

        await fetchAndUpdateOrderDetail(client, orderId)
        const refreshedOrder = getOrder(orderId)
        if (!refreshedOrder) {
            return c.json({ error: '刷新订单后未找到订单' }, 500)
        }

        if (!refreshedOrder.chatId || !refreshedOrder.buyerUserId) {
            return c.json({ error: '刷新后订单仍缺少 chatId 或买家ID，请稍后再试' }, 400)
        }

        const latestSuccessLog = getLatestDeliveryLog(orderId, 'success')
        const latestLog = latestSuccessLog || getLatestDeliveryLog(orderId)
        const originalRule = latestLog?.ruleId ? getAutoSellRule(latestLog.ruleId) : undefined
        const result = await processAutoSell({
            accountId: refreshedOrder.accountId,
            orderId,
            itemId: refreshedOrder.itemId || undefined,
            ruleId: originalRule?.id ?? latestLog?.ruleId ?? null,
            triggerOn: originalRule?.triggerOn
                ?? (refreshedOrder.status >= OrderStatus.PENDING_RECEIPT ? 'confirmed' : 'paid'),
            orderPrice: refreshedOrder.price
        })

        if (!result.success || !result.content) {
            return c.json({
                success: false,
                error: result.error || '补发失败',
                deliveredQuantity: result.deliveredQuantity,
                remainingQuantity: result.remainingQuantity
            }, 400)
        }

        const sendResult = await client.sendMessage(
            refreshedOrder.chatId!,
            refreshedOrder.buyerUserId!,
            result.content
        )

        if (!sendResult) {
            rollbackAutoSellReservation(orderId, result)
            recordAutoSellDeliveryLog({
                orderId,
                accountId: refreshedOrder.accountId,
                ruleId: result.ruleId,
                deliveryType: result.deliveryType,
                content: result.content,
                success: false,
                errorMessage: '发送发货消息失败'
            })
            return c.json({ success: false, error: '补发内容已生成，但发送消息失败' }, 500)
        }

        recordAutoSellDeliveryLog({
            orderId,
            accountId: refreshedOrder.accountId,
            ruleId: result.ruleId,
            deliveryType: result.deliveryType,
            content: result.content,
            quantity: result.deliveredQuantity,
            success: true
        })

        return c.json({
            success: true,
            order: getOrder(orderId),
            deliveredQuantity: result.deliveredQuantity,
            remainingQuantity: result.remainingQuantity,
            content: result.content
        })
    })

    // 通过账号获取订单详情
    app.post('/fetch', async (c) => {
        const body = await c.req.json()
        const { accountId, orderId } = body

        if (!accountId || !orderId) {
            return c.json({ error: '缺少 accountId 或 orderId' }, 400)
        }

        const clientManager = getClientManager()
        if (!clientManager) {
            return c.json({ error: 'ClientManager 未初始化' }, 500)
        }

        const client = clientManager.getClient(accountId)
        if (!client) {
            return c.json({ error: '账号未连接' }, 400)
        }

        const detail = await fetchAndUpdateOrderDetail(client, orderId)
        if (!detail) {
            return c.json({ error: '获取订单详情失败' }, 500)
        }

        const order = getOrder(orderId)
        return c.json({ success: true, order })
    })

    // 确认发货
    app.post('/:orderId/ship', async (c) => {
        const orderId = c.req.param('orderId')
        const clientManager = getClientManager()

        if (!clientManager) {
            return c.json({ error: 'ClientManager 未初始化' }, 500)
        }

        const localOrder = getOrder(orderId)
        if (!localOrder) {
            return c.json({ error: '订单不存在' }, 404)
        }

        if (localOrder.status !== OrderStatus.PENDING_SHIPMENT) {
            return c.json({ error: '只有待发货状态的订单才能执行发货' }, 400)
        }

        const client = clientManager.getClient(localOrder.accountId)
        if (!client) {
            return c.json({ error: '账号未连接' }, 400)
        }

        const result = await client.confirmShipment(orderId)
        if (result.success) {
            updateOrderStatus(orderId, OrderStatus.PENDING_RECEIPT, ORDER_STATUS_TEXT[OrderStatus.PENDING_RECEIPT], 'ship_time')
            const updatedOrder = getOrder(orderId)
            return c.json({ success: true, order: updatedOrder })
        }

        return c.json({ success: false, error: result.error }, 500)
    })

    // 免拼发货
    app.post('/:orderId/freeship', async (c) => {
        const orderId = c.req.param('orderId')
        const clientManager = getClientManager()

        if (!clientManager) {
            return c.json({ error: 'ClientManager 未初始化' }, 500)
        }

        const localOrder = getOrder(orderId)
        if (!localOrder) {
            return c.json({ error: '订单不存在' }, 404)
        }

        if (localOrder.status !== OrderStatus.PENDING_SHIPMENT) {
            return c.json({ error: '只有待发货状态的订单才能执行发货' }, 400)
        }

        if (!localOrder.itemId || !localOrder.buyerUserId) {
            return c.json({ error: '订单缺少商品ID或买家ID，请先刷新订单详情' }, 400)
        }

        const client = clientManager.getClient(localOrder.accountId)
        if (!client) {
            return c.json({ error: '账号未连接' }, 400)
        }

        const result = await client.freeShipping(orderId, localOrder.itemId, localOrder.buyerUserId)
        if (result.success) {
            updateOrderStatus(orderId, OrderStatus.PENDING_RECEIPT, ORDER_STATUS_TEXT[OrderStatus.PENDING_RECEIPT], 'ship_time')
            const updatedOrder = getOrder(orderId)
            return c.json({ success: true, order: updatedOrder })
        }

        return c.json({ success: false, error: result.error }, 500)
    })

    // 删除订单记录
    app.delete('/:orderId', async (c) => {
        const orderId = c.req.param('orderId')

        const localOrder = getOrder(orderId)
        if (!localOrder) {
            return c.json({ error: '订单不存在' }, 404)
        }

        const success = deleteOrder(orderId)
        if (success) {
            return c.json({ success: true, message: '订单记录已删除' })
        }

        return c.json({ success: false, error: '删除失败' }, 500)
    })

    // 一键刷新所有订单状态
    app.post('/refresh-all', async (c) => {
        // 获取所有需要刷新的活跃订单（status 0-4），不限分页
        const orders = getOrders({ status: undefined, limit: 99999, offset: 0 })
        const activeOrders = orders.filter(o => o.status >= 0 && o.status <= 4)

        const result = await refreshOrdersByList(activeOrders, getClientManager)
        if ('error' in result) {
            return c.json({ error: result.error }, 500)
        }

        return c.json(result)
    })

    // 按最近下单时间刷新订单详情（仅刷新详情，不触发自动发货）
    app.post('/refresh-recent', async (c) => {
        const body = await c.req.json().catch(() => ({})) as { days?: number }
        const days = Math.floor(Number(body.days))

        if (!Number.isFinite(days) || days <= 0) {
            return c.json({ error: 'days 必须是大于 0 的整数' }, 400)
        }

        const targetOrders = getOrders({
            orderTimeStart: getDaysAgoLocalString(days),
            limit: 99999,
            offset: 0
        })

        const result = await refreshOrdersByList(targetOrders, getClientManager, { triggerAutoSell: false })
        if ('error' in result) {
            return c.json({ error: result.error }, 500)
        }

        return c.json(result)
    })

    return app
}
