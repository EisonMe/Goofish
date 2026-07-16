/**
 * 订单数据仓库
 */

import { db } from './connection.js'
import { nowLocalString } from '../utils/date.js'
import { emitOrdersUpdated } from '../core/event-emitter.js'
import { createLogger } from '../core/logger.js'
import { getGroupItemIds } from '../services/item-group.service.js'
import type { OrderRecord, OrderListParams } from '../types/order.types.js'

const logger = createLogger('Db:Order')
const ORDER_TIME_EXPR = "COALESCE(NULLIF(o.order_time, ''), NULLIF(o.created_at, ''), o.updated_at)"

function buildOrderWhere(params: OrderListParams) {
    const { accountId, groupId, status, keyword, hasRefund, pendingRedelivery, orderTimeStart } = params
    const clauses: string[] = ['1=1']
    const sqlParams: any[] = []

    if (accountId) {
        clauses.push('o.account_id = ?')
        sqlParams.push(accountId)
    }

    if (groupId) {
        const groupItems = getGroupItemIds(groupId)
        if (groupItems.length === 0) {
            clauses.push('1 = 0')
        } else {
            const conditions = groupItems.map(() => '(o.item_id = ? AND o.account_id = ?)').join(' OR ')
            clauses.push(`(${conditions})`)
            for (const item of groupItems) {
                sqlParams.push(item.itemId, item.accountId)
            }
        }
    }

    if (status !== undefined) {
        clauses.push('o.status = ?')
        sqlParams.push(status)
    }

    if (keyword) {
        clauses.push(`(
            o.order_id LIKE ?
            OR COALESCE(o.item_title, '') LIKE ?
            OR COALESCE(o.buyer_nickname, '') LIKE ?
            OR COALESCE(o.buyer_user_id, '') LIKE ?
        )`)
        const like = `%${keyword.trim()}%`
        sqlParams.push(like, like, like, like)
    }

    if (hasRefund !== undefined) {
        if (hasRefund) {
            clauses.push('(o.status IN (8, 12) OR o.status_text LIKE ? OR COALESCE(o.has_refund, 0) = 1)')
            sqlParams.push('%退款%')
        } else {
            clauses.push('(o.status NOT IN (8, 12) AND COALESCE(o.status_text, "") NOT LIKE ? AND COALESCE(o.has_refund, 0) = 0)')
            sqlParams.push('%退款%')
        }
    }

    if (pendingRedelivery) {
        clauses.push(`(
            COALESCE(o.buy_amount, 1) - COALESCE((
                SELECT SUM(COALESCE(l.quantity, 1))
                FROM autosell_logs l
                WHERE l.order_id = o.order_id AND l.status = 'success'
            ), 0)
        ) > 0`)
    }

    if (orderTimeStart) {
        clauses.push(`${ORDER_TIME_EXPR} >= ?`)
        sqlParams.push(orderTimeStart)
    }

    return {
        whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
        sqlParams
    }
}

function hasOwnField<T extends object>(obj: T, key: keyof T): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key)
}

function getDeliveredQuantityMap(orderIds: string[]): Map<string, number> {
    if (orderIds.length === 0) {
        return new Map()
    }

    const placeholders = orderIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        SELECT order_id, SUM(COALESCE(quantity, 1)) AS delivered_quantity
        FROM autosell_logs
        WHERE status = 'success' AND order_id IN (${placeholders})
        GROUP BY order_id
    `).all(...orderIds) as Array<{ order_id: string; delivered_quantity: number | null }>

    return new Map(
        rows.map(row => [row.order_id, Number(row.delivered_quantity ?? 0) || 0])
    )
}

function mapBaseRowsToOrders(rows: any[]): OrderRecord[] {
    const deliveredQuantityMap = getDeliveredQuantityMap(rows.map(row => row.order_id))

    return rows.map(row => mapRowToOrder({
        ...row,
        delivered_quantity: deliveredQuantityMap.get(row.order_id) ?? 0
    }))
}

function runOrderListQuery(
    whereClause: string,
    sqlParams: any[],
    limit: number,
    offset: number,
    orderBy: string
): OrderRecord[] {
    const sql = `
        SELECT o.*
        FROM orders o
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
    `

    const rows = db.prepare(sql).all(...sqlParams, limit, offset) as any[]
    return mapBaseRowsToOrders(rows)
}

// 获取订单列表
export function getOrders(params: OrderListParams = {}): OrderRecord[] {
    const { limit = 50, offset = 0 } = params
    const { whereClause, sqlParams } = buildOrderWhere(params)

    try {
        return runOrderListQuery(whereClause, sqlParams, limit, offset, `${ORDER_TIME_EXPR} DESC, o.id DESC`)
    } catch (error) {
        logger.warn(`订单列表按下单时间查询失败，降级为按 id 查询: ${error}`)
        return runOrderListQuery(whereClause, sqlParams, limit, offset, 'o.id DESC')
    }
}

// 获取订单总数
export function getOrderCount(params: OrderListParams = {}): number {
    const { whereClause, sqlParams } = buildOrderWhere(params)
    const sql = `
        SELECT COUNT(*) AS count
        FROM orders o
        ${whereClause}
    `
    const row = db.prepare(sql).get(...sqlParams) as { count: number }
    return row.count
}

// 根据订单 ID 获取订单
export function getOrderById(orderId: string): OrderRecord | null {
    const row = db.prepare(`
        SELECT o.*
        FROM orders o
        WHERE o.order_id = ?
        LIMIT 1
    `).get(orderId) as any

    if (!row) return null

    const deliveredQuantityMap = getDeliveredQuantityMap([orderId])
    return mapRowToOrder({
        ...row,
        delivered_quantity: deliveredQuantityMap.get(orderId) ?? 0
    })
}

export function getLatestOrderByChatId(accountId: string, chatId: string): OrderRecord | null {
    const row = db.prepare(`
        SELECT o.*
        FROM orders o
        WHERE o.account_id = ? AND o.chat_id = ?
        ORDER BY COALESCE(NULLIF(o.updated_at, ''), NULLIF(o.created_at, ''), o.order_time) DESC, o.id DESC
        LIMIT 1
    `).get(accountId, chatId) as any

    if (!row) return null

    const deliveredQuantityMap = getDeliveredQuantityMap([row.order_id])
    return mapRowToOrder({
        ...row,
        delivered_quantity: deliveredQuantityMap.get(row.order_id) ?? 0
    })
}

// 创建或更新订单
export function upsertOrder(order: Partial<OrderRecord> & { orderId: string; accountId: string }): void {
    const now = nowLocalString()
    const hasTotalAmount = hasOwnField(order, 'totalAmount')
    const hasBuyerPaidAmount = hasOwnField(order, 'buyerPaidAmount')
    const hasDiscountAmount = hasOwnField(order, 'discountAmount')
    const hasRefundAmount = hasOwnField(order, 'refundAmount')
    const hasRefundStatus = hasOwnField(order, 'refundStatus')
    const hasRefundTime = hasOwnField(order, 'refundTime')

    db.prepare(`
        INSERT INTO orders (
            order_id, account_id, item_id, item_title, item_pic_url,
            price, buy_amount, total_amount, buyer_paid_amount, discount_amount,
            refund_amount, refund_status, refund_time, has_refund,
            buyer_user_id, buyer_nickname, chat_id, status, status_text,
            order_time, pay_time, ship_time, complete_time, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
            item_id = COALESCE(excluded.item_id, item_id),
            item_title = COALESCE(excluded.item_title, item_title),
            item_pic_url = COALESCE(excluded.item_pic_url, item_pic_url),
            price = COALESCE(excluded.price, price),
            buy_amount = COALESCE(excluded.buy_amount, buy_amount),
            total_amount = CASE WHEN ? THEN excluded.total_amount ELSE total_amount END,
            buyer_paid_amount = CASE WHEN ? THEN excluded.buyer_paid_amount ELSE buyer_paid_amount END,
            discount_amount = CASE WHEN ? THEN excluded.discount_amount ELSE discount_amount END,
            refund_amount = CASE WHEN ? THEN excluded.refund_amount ELSE refund_amount END,
            refund_status = CASE WHEN ? THEN excluded.refund_status ELSE refund_status END,
            refund_time = CASE WHEN ? THEN excluded.refund_time ELSE refund_time END,
            has_refund = COALESCE(excluded.has_refund, has_refund),
            buyer_user_id = COALESCE(excluded.buyer_user_id, buyer_user_id),
            buyer_nickname = COALESCE(excluded.buyer_nickname, buyer_nickname),
            chat_id = COALESCE(excluded.chat_id, chat_id),
            status = COALESCE(excluded.status, status),
            status_text = COALESCE(excluded.status_text, status_text),
            order_time = COALESCE(excluded.order_time, order_time),
            pay_time = COALESCE(excluded.pay_time, pay_time),
            ship_time = COALESCE(excluded.ship_time, ship_time),
            complete_time = COALESCE(excluded.complete_time, complete_time),
            updated_at = excluded.updated_at
    `).run(
        order.orderId,
        order.accountId,
        order.itemId || null,
        order.itemTitle || null,
        order.itemPicUrl || null,
        order.price || null,
        order.buyAmount ?? null,
        order.totalAmount ?? null,
        order.buyerPaidAmount ?? null,
        order.discountAmount ?? null,
        order.refundAmount ?? null,
        order.refundStatus ?? null,
        order.refundTime ?? null,
        order.hasRefund === undefined ? null : (order.hasRefund ? 1 : 0),
        order.buyerUserId || null,
        order.buyerNickname || null,
        order.chatId || null,
        order.status ?? 1,
        order.statusText || null,
        order.orderTime || now,
        order.payTime || null,
        order.shipTime || null,
        order.completeTime || null,
        now,
        now,
        hasTotalAmount ? 1 : 0,
        hasBuyerPaidAmount ? 1 : 0,
        hasDiscountAmount ? 1 : 0,
        hasRefundAmount ? 1 : 0,
        hasRefundStatus ? 1 : 0,
        hasRefundTime ? 1 : 0
    )

    emitOrdersUpdated()
}

// 更新订单状态
export function updateOrderStatus(
    orderId: string,
    status: number,
    statusText: string,
    timeField?: 'pay_time' | 'ship_time' | 'complete_time'
): void {
    const now = nowLocalString()

    let sql = 'UPDATE orders SET status = ?, status_text = ?, updated_at = ?'
    const params: any[] = [status, statusText, now]

    if (timeField) {
        sql += `, ${timeField} = ?`
        params.push(now)
    }

    sql += ' WHERE order_id = ?'
    params.push(orderId)

    db.prepare(sql).run(...params)
    emitOrdersUpdated()
}

// 删除订单
export function deleteOrder(orderId: string): boolean {
    const result = db.prepare('DELETE FROM orders WHERE order_id = ?').run(orderId)
    if (result.changes > 0) {
        emitOrdersUpdated()
    }
    return result.changes > 0
}

// 行数据映射
function mapRowToOrder(row: any): OrderRecord {
    const deliveredQuantity = Number(row.delivered_quantity ?? 0) || 0
    const buyAmount = row.buy_amount ?? 1

    return {
        id: row.id,
        orderId: row.order_id,
        accountId: row.account_id,
        itemId: row.item_id,
        itemTitle: row.item_title,
        itemPicUrl: row.item_pic_url,
        price: row.price,
        buyAmount,
        totalAmount: row.total_amount,
        buyerPaidAmount: row.buyer_paid_amount,
        discountAmount: row.discount_amount,
        refundAmount: row.refund_amount,
        refundStatus: row.refund_status,
        refundTime: row.refund_time,
        hasRefund: Boolean(row.has_refund) || row.status === 8 || row.status === 12 || (row.status_text && row.status_text.includes('退款')),
        buyerUserId: row.buyer_user_id,
        buyerNickname: row.buyer_nickname,
        chatId: row.chat_id,
        status: row.status,
        statusText: row.status_text,
        orderTime: row.order_time,
        payTime: row.pay_time,
        shipTime: row.ship_time,
        completeTime: row.complete_time,
        deliveredQuantity,
        remainingQuantity: Math.max(Number(row.remaining_quantity ?? (buyAmount ?? 1) - deliveredQuantity) || 0, 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}
