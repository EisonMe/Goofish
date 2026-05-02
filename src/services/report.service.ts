import { db, getAllAccounts, getAutoSellRules, getStockStats } from '../db/index.js'
import { getGroupItemIds } from './item-group.service.js'
import { createLogger } from '../core/logger.js'

const logger = createLogger('Svc:Report')

function toCSTDate(date: Date): string {
    const cst = new Date(date.getTime() + 8 * 3600 * 1000)
    return cst.toISOString().slice(0, 10)
}

const REVENUE_EXPR = `CAST(COALESCE(NULLIF(buyer_paid_amount, ''), NULLIF(total_amount, ''), NULLIF(price, ''), '0') AS REAL)`
const PAID_REVENUE_EXPR = `CASE
    WHEN COALESCE(NULLIF(pay_time, ''), '') != '' THEN ${REVENUE_EXPR}
    WHEN status IN (2, 3, 4, 8, 12) THEN ${REVENUE_EXPR}
    ELSE 0
END`
const REVENUE_TIME_EXPR = `COALESCE(NULLIF(pay_time, ''), NULLIF(order_time, ''), NULLIF(created_at, ''), updated_at)`
const REFUND_ORDER_EXPR = `(status IN (8, 12) OR status_text LIKE '%退款%' OR COALESCE(has_refund, 0) = 1 OR COALESCE(NULLIF(refund_status, ''), '') != '')`
const REFUND_AMOUNT_EXPR = `CASE
    WHEN ${REFUND_ORDER_EXPR} THEN
        CASE
            WHEN CAST(COALESCE(NULLIF(refund_amount, ''), '0') AS REAL) > 0
                 AND CAST(COALESCE(NULLIF(refund_amount, ''), '0') AS REAL) <= ${REVENUE_EXPR}
            THEN CAST(refund_amount AS REAL)
            ELSE ${REVENUE_EXPR}
        END
    ELSE 0
END`
const O_REVENUE_EXPR = `CAST(COALESCE(NULLIF(o.buyer_paid_amount, ''), NULLIF(o.total_amount, ''), NULLIF(o.price, ''), '0') AS REAL)`
const O_PAID_REVENUE_EXPR = `CASE
    WHEN COALESCE(NULLIF(o.pay_time, ''), '') != '' THEN ${O_REVENUE_EXPR}
    WHEN o.status IN (2, 3, 4, 8, 12) THEN ${O_REVENUE_EXPR}
    ELSE 0
END`
const O_REVENUE_TIME_EXPR = `COALESCE(NULLIF(o.pay_time, ''), NULLIF(o.order_time, ''), NULLIF(o.created_at, ''), o.updated_at)`
const O_REFUND_ORDER_EXPR = `(o.status IN (8, 12) OR o.status_text LIKE '%退款%' OR COALESCE(o.has_refund, 0) = 1 OR COALESCE(NULLIF(o.refund_status, ''), '') != '')`
const O_REFUND_AMOUNT_EXPR = `CASE
    WHEN ${O_REFUND_ORDER_EXPR} THEN
        CASE
            WHEN CAST(COALESCE(NULLIF(o.refund_amount, ''), '0') AS REAL) > 0
                 AND CAST(COALESCE(NULLIF(o.refund_amount, ''), '0') AS REAL) <= ${O_REVENUE_EXPR}
            THEN CAST(o.refund_amount AS REAL)
            ELSE ${O_REVENUE_EXPR}
        END
    ELSE 0
END`

function toLocalDateString(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function getRevenueDateRange(days: number): { startDate: string; endDate: string } {
    const normalizedDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - normalizedDays + 1)

    return {
        startDate: toLocalDateString(start),
        endDate: toLocalDateString(end)
    }
}

function createEmptyRevenueReport() {
    return {
        summary: {
            totalOrders: 0,
            successOrders: 0,
            refundOrders: 0,
            totalRevenue: 0,
            totalRefundAmount: 0,
            actualRevenue: 0,
            netIncome: 0,
            pendingConfirmAmount: 0,
            successRate: 0,
            refundRate: 0,
            avgOrderValue: 0
        },
        efficiency: {
            avgShipSeconds: null,
            medianShipSeconds: null,
            avgConfirmSeconds: null,
            avgShipText: '-',
            medianShipText: '-',
            avgConfirmText: '-'
        },
        daily: [],
        hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0 })),
        itemRanking: [],
        accountRanking: [],
        statusDistribution: []
    }
}

function getOrderPaidAmount(order: {
    status?: number | string | null
    pay_time?: string | null
    buyer_paid_amount?: string | null
    total_amount?: string | null
    price?: string | null
}): number {
    const paid = parseFloat(order.buyer_paid_amount || order.total_amount || order.price || '0') || 0
    if (paid <= 0) return 0

    if (order.pay_time) {
        return paid
    }

    const status = Number(order.status || 0)
    if ([2, 3, 4, 8, 12].includes(status)) {
        return paid
    }

    return 0
}

// ============ 1. 数据报表 — 日趋势 + 周趋势 + 月趋势 ============

export function getRevenueReport(period: 'day' | 'week' | 'month' = 'day', days = 30, startDate?: string, endDate?: string, groupId?: number) {
    let whereClause = ''
    let params: any[] = []
    
    if (startDate && endDate) {
        whereClause = `substr(${REVENUE_TIME_EXPR}, 1, 10) BETWEEN ? AND ?`
        params = [startDate, endDate]
    } else {
        const range = getRevenueDateRange(days)
        whereClause = `substr(${REVENUE_TIME_EXPR}, 1, 10) BETWEEN ? AND ?`
        params = [range.startDate, range.endDate]
    }
    
    // 分组筛选
    let groupFilter = ''
    if (groupId) {
        const groupItems = getGroupItemIds(groupId)
        if (groupItems.length > 0) {
            const conditions = groupItems.map(() => '(item_id = ? AND account_id = ?)').join(' OR ')
            groupFilter = ` AND (${conditions})`
            groupItems.forEach(item => {
                params.push(item.itemId, item.accountId)
            })
        } else {
            return createEmptyRevenueReport()
        }
    }
    
    const orders = db.prepare(`
        SELECT ${REVENUE_TIME_EXPR} AS report_time,
               created_at, order_time, price, status, status_text, total_amount, buyer_paid_amount, account_id, item_title, item_id,
               pay_time, ship_time, complete_time, refund_amount
        FROM orders
        WHERE ${whereClause}${groupFilter}
        ORDER BY report_time ASC
    `).all(...params) as any[]

    const byItem = new Map<string, { title: string; count: number; revenue: number; refunds: number; refundAmount: number; netIncome: number; pendingConfirmAmount: number }>()
    const byAccount = new Map<string, { count: number; revenue: number; refunds: number; refundAmount: number; netIncome: number; pendingConfirmAmount: number }>()
    const byDay = new Map<string, { orders: number; revenue: number; success: number; refunds: number; refundAmount: number; netIncome: number; pendingConfirmAmount: number }>()
    const byStatus = new Map<string, number>()
    const byHour = new Map<number, number>()
    let totalRevenue = 0
    let totalRefundAmount = 0
    let totalOrders = orders.length
    let successOrders = 0
    let refundOrders = 0
    // 实际到账金额: 仅交易成功(status=4)的实付金额 - 该部分订单的退款金额
    let netIncome = 0

    // 发货效率
    let shipTimes: number[] = []
    let confirmTimes: number[] = []

    for (const o of orders) {
        const revenue = getOrderPaidAmount(o)
        const reportTime = o.report_time || o.pay_time || o.order_time || o.created_at || ''
        const day = reportTime.slice(0, 10)
        const hour = parseInt(reportTime.slice(11, 13)) || 0
        const isRefund = o.status === 8 || o.status === 12 || (o.status_text && o.status_text.includes('退款'))

        // 计算退款金额
        // status=8: 买家申请退款中，refund_amount 字段存的是编号而非金额，使用支付金额
        // status=12: 交易关闭（全额退款），refund_amount 可能是金额或编号
        // status=4: 交易成功有退款（部分退款），refund_amount 是退款金额
        let refundAmt = 0;
        if (isRefund) {
            if (o.status === 8) {
                // 买家申请退款中，使用支付金额
                refundAmt = revenue;
            } else {
                const refundGiven = parseFloat(o.refund_amount || '0') || 0;
                if (refundGiven > 0 && refundGiven <= revenue) {
                    refundAmt = refundGiven;
                } else {
                    refundAmt = revenue;
                }
            }
        }
        
        const dayData = byDay.get(day) || { orders: 0, revenue: 0, success: 0, refunds: 0, refundAmount: 0, netIncome: 0, pendingConfirmAmount: 0 }
        dayData.orders++
        dayData.revenue += revenue
        if (o.status === 3 || o.status === 4) { dayData.success++; successOrders++ }
        if (o.status === 4) {
            const dayPaid = getOrderPaidAmount(o)
            const dayRefund = parseFloat(o.refund_amount || '0') || 0
            dayData.netIncome += dayPaid - (dayRefund > 0 && dayRefund <= dayPaid ? dayRefund : 0)
        }
        if (isRefund) { dayData.refunds++; dayData.refundAmount += refundAmt; refundOrders++ }
        dayData.pendingConfirmAmount = (dayData.revenue - dayData.refundAmount) - dayData.netIncome
        byDay.set(day, dayData)

        const itemKey = o.item_title || '未知商品'
        const itemData = byItem.get(itemKey) || { title: itemKey, count: 0, revenue: 0, refunds: 0, refundAmount: 0, netIncome: 0, pendingConfirmAmount: 0 }
        itemData.count++
        itemData.revenue += revenue
        if (isRefund) { itemData.refunds++; itemData.refundAmount += refundAmt }
        if (o.status === 4) { const paid = getOrderPaidAmount(o); const ref = parseFloat(o.refund_amount || '0') || 0; itemData.netIncome += paid - (ref > 0 && ref <= paid ? ref : 0) }
        itemData.pendingConfirmAmount = (itemData.revenue - itemData.refundAmount) - itemData.netIncome
        byItem.set(itemKey, itemData)

        const accData = byAccount.get(o.account_id) || { count: 0, revenue: 0, refunds: 0, refundAmount: 0, netIncome: 0, pendingConfirmAmount: 0 }
        accData.count++
        accData.revenue += revenue
        if (isRefund) { accData.refunds++; accData.refundAmount += refundAmt }
        if (o.status === 4) { const paid = getOrderPaidAmount(o); const ref = parseFloat(o.refund_amount || '0') || 0; accData.netIncome += paid - (ref > 0 && ref <= paid ? ref : 0) }
        accData.pendingConfirmAmount = (accData.revenue - accData.refundAmount) - accData.netIncome
        byAccount.set(o.account_id, accData)

        byStatus.set(String(o.status), (byStatus.get(String(o.status)) || 0) + 1)
        byHour.set(hour, (byHour.get(hour) || 0) + 1)
        totalRevenue += revenue
        totalRefundAmount += refundAmt

        // 实际到账: 仅统计交易成功(status=4)的订单
        if (o.status === 4) {
            const successPaid = getOrderPaidAmount(o)
            let successRefund = 0
            const rawRefund = parseFloat(o.refund_amount || '0') || 0
            if (rawRefund > 0 && rawRefund <= successPaid) {
                successRefund = rawRefund
            }
            netIncome += successPaid - successRefund
        }

        // 发货效率
        if (o.pay_time && o.ship_time) {
            const pay = new Date(o.pay_time).getTime()
            const ship = new Date(o.ship_time).getTime()
            if (ship > pay) shipTimes.push((ship - pay) / 1000)
        }
        if (o.ship_time && o.complete_time) {
            const ship = new Date(o.ship_time).getTime()
            const complete = new Date(o.complete_time).getTime()
            if (complete > ship) confirmTimes.push((complete - ship) / 1000)
        }
    }

    const avgShip = shipTimes.length > 0 ? Math.round(shipTimes.reduce((a, b) => a + b, 0) / shipTimes.length) : null
    const medianShip = shipTimes.length > 0 ? shipTimes.sort((a, b) => a - b)[Math.floor(shipTimes.length / 2)] : null
    const avgConfirm = confirmTimes.length > 0 ? Math.round(confirmTimes.reduce((a, b) => a + b, 0) / confirmTimes.length) : null

    const actualRevenue = totalRevenue - totalRefundAmount
    const pendingConfirmAmount = actualRevenue - netIncome
    
    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => ({
        date,
        orders: d.orders,
        revenue: Math.round(d.revenue * 100) / 100,
        refundAmount: Math.round(d.refundAmount * 100) / 100,
        actualRevenue: Math.round((d.revenue - d.refundAmount) * 100) / 100,
        netIncome: Math.round(d.netIncome * 100) / 100,
        pendingConfirmAmount: Math.round(d.pendingConfirmAmount * 100) / 100,
        success: d.success,
        refunds: d.refunds,
        successRate: d.orders > 0 ? Math.round(d.success / d.orders * 100) : 0,
        refundRate: d.orders > 0 ? Math.round(d.refunds / d.orders * 100) : 0
    }))

    const hourly = Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        orders: byHour.get(h) || 0
    }))

    const itemRanking = [...byItem.values()].map(d => ({
        ...d,
        revenue: Math.round(d.revenue * 100) / 100,
        refundAmount: Math.round(d.refundAmount * 100) / 100,
        netIncome: Math.round(d.netIncome * 100) / 100,
        pendingConfirmAmount: Math.round(d.pendingConfirmAmount * 100) / 100,
        refundRate: d.count > 0 ? Math.round(d.refunds / d.count * 100) : 0
    })).sort((a, b) => b.netIncome - a.netIncome)
    const accountNicknameMap = new Map(getAllAccounts().map(account => [account.id, account.nickname || account.id]))
    const accountRanking = [...byAccount.entries()].map(([id, d]) => ({
        accountId: id,
        accountNickname: accountNicknameMap.get(id) || id,
        count: d.count,
        revenue: Math.round(d.revenue * 100) / 100,
        refundAmount: Math.round(d.refundAmount * 100) / 100,
        netIncome: Math.round(d.netIncome * 100) / 100,
        pendingConfirmAmount: Math.round(d.pendingConfirmAmount * 100) / 100,
        refunds: d.refunds,
        refundRate: d.count > 0 ? Math.round(d.refunds / d.count * 100) : 0
    })).sort((a, b) => b.netIncome - a.netIncome)

    return {
        summary: {
            totalOrders,
            successOrders,
            refundOrders,
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            totalRefundAmount: Math.round(totalRefundAmount * 100) / 100,
            actualRevenue: Math.round(actualRevenue * 100) / 100,
            netIncome: Math.round(netIncome * 100) / 100,
            pendingConfirmAmount: Math.round(pendingConfirmAmount * 100) / 100,
            successRate: totalOrders > 0 ? Math.round(successOrders / totalOrders * 100) : 0,
            refundRate: totalOrders > 0 ? Math.round(refundOrders / totalOrders * 100) : 0,
            avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders * 100) / 100 : 0
        },
        efficiency: {
            avgShipSeconds: avgShip,
            medianShipSeconds: medianShip != null ? Math.round(medianShip) : null,
            avgConfirmSeconds: avgConfirm,
            avgShipText: avgShip != null ? formatDuration(avgShip) : '-',
            medianShipText: medianShip != null ? formatDuration(Math.round(medianShip)) : '-',
            avgConfirmText: avgConfirm != null ? formatDuration(avgConfirm) : '-',
        },
        daily,
        hourly,
        itemRanking,
        accountRanking,
        statusDistribution: [...byStatus.entries()].map(([status, count]) => ({ status, count }))
    }
}

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}秒`
    if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`
    return `${Math.round(seconds / 3600 * 10) / 10}小时`
}

function normalizeAccountError(error?: string | null): string | null {
    if (!error) return null
    if (error.includes('FAIL_SYS_SESSION_EXPIRED') || error.includes('Session过期')) {
        return '刷新码失效'
    }
    return error
}

function getOrderStatusLabel(status: number | string | null | undefined, statusText?: string | null): string {
    const text = statusText || ''
    if (text.includes('退款')) return text
    if (Number(status || 0) === 7 && text) return text

    switch (Number(status || 0)) {
        case 1: return '待付款'
        case 2: return '待发货'
        case 3: return '已发货/待确认'
        case 4: return '交易成功'
        case 6: return '交易关闭'
        case 7: return '待评价'
        case 8: return '退款中'
        case 12: return '退款/关闭'
        default: return text || `未知状态(${status ?? '-'})`
    }
}

// ============ 2. 销售概览 ============

export function getSalesOverview() {
    const today = toCSTDate(new Date())
    const yesterday = toCSTDate(new Date(Date.now() - 86400000))

    const queryDay = (date: string) => {
        const row = db.prepare(`
            SELECT COUNT(*) as orders,
                   COALESCE(SUM(${PAID_REVENUE_EXPR}), 0) as revenue,
                   SUM(CASE WHEN status = 3 OR status = 4 THEN 1 ELSE 0 END) as success,
                   SUM(CASE WHEN status IN (8, 12) OR status_text LIKE '%退款%' THEN 1 ELSE 0 END) as refunds
            FROM orders WHERE substr(created_at, 1, 10) = ?
        `).get(date) as any
        return {
            orders: row?.orders || 0,
            revenue: Math.round((row?.revenue || 0) * 100) / 100,
            success: row?.success || 0,
            refunds: row?.refunds || 0
        }
    }

    const queryRange = (from: string) => {
        const row = db.prepare(`
            SELECT COUNT(*) as orders,
                   COALESCE(SUM(${PAID_REVENUE_EXPR}), 0) as revenue,
                   SUM(CASE WHEN status = 3 OR status = 4 THEN 1 ELSE 0 END) as success,
                   SUM(CASE WHEN status IN (8, 12) OR status_text LIKE '%退款%' THEN 1 ELSE 0 END) as refunds
            FROM orders WHERE substr(created_at, 1, 10) >= ?
        `).get(from) as any
        return {
            orders: row?.orders || 0,
            revenue: Math.round((row?.revenue || 0) * 100) / 100,
            success: row?.success || 0,
            refunds: row?.refunds || 0
        }
    }

    const now = new Date()
    const cstDay = new Date(now.getTime() + 8 * 3600 * 1000)
    const dayOfWeek = cstDay.getUTCDay() || 7
    const weekStart = toCSTDate(new Date(now.getTime() - (dayOfWeek - 1) * 86400000))
    const monthStart = today.slice(0, 7) + '-01'

    const todayData = queryDay(today)
    const yesterdayData = queryDay(yesterday)
    const weekData = queryRange(weekStart)
    const monthData = queryRange(monthStart)

    const accountStats = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled FROM accounts`).get() as any
    const connStats = db.prepare(`SELECT SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) as connected FROM account_status`).get() as any
    const pendingShip = db.prepare(`SELECT COUNT(*) as cnt FROM orders WHERE status IN (1, 2) AND pay_time IS NOT NULL`).get() as any

    const todayStartMs = new Date(today + 'T00:00:00+08:00').getTime()
    const todayMsgs = db.prepare(`SELECT COUNT(*) as cnt FROM conversation_messages WHERE created_at >= ?`).get(todayStartMs) as any

    // 近7天日均订单和收入
    const week7 = queryRange(toCSTDate(new Date(Date.now() - 6 * 86400000)))
    const avgDailyOrders = Math.round(week7.orders / 7 * 10) / 10
    const avgDailyRevenue = Math.round(week7.revenue / 7 * 100) / 100

    // 自动发货成功率（近7天）
    const autoDelivery = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
        FROM autosell_logs WHERE created_at >= datetime('now', '+8 hours', '-7 days')
    `).get() as any

    return {
        today: todayData,
        yesterday: yesterdayData,
        thisWeek: weekData,
        thisMonth: monthData,
        accounts: {
            total: accountStats?.total || 0,
            enabled: accountStats?.enabled || 0,
            connected: connStats?.connected || 0
        },
        pendingShipments: pendingShip?.cnt || 0,
        todayMessages: todayMsgs?.cnt || 0,
        trends: {
            ordersChange: yesterdayData.orders > 0
                ? Math.round((todayData.orders - yesterdayData.orders) / yesterdayData.orders * 100)
                : todayData.orders > 0 ? 100 : 0,
            revenueChange: yesterdayData.revenue > 0
                ? Math.round((todayData.revenue - yesterdayData.revenue) / yesterdayData.revenue * 100)
                : todayData.revenue > 0 ? 100 : 0
        },
        averages: {
            dailyOrders: avgDailyOrders,
            dailyRevenue: avgDailyRevenue
        },
        delivery: {
            total: autoDelivery?.total || 0,
            success: autoDelivery?.success || 0,
            rate: autoDelivery?.total > 0
                ? Math.round((autoDelivery.success || 0) / autoDelivery.total * 100) : 0
        }
    }
}

// ============ 3. 商品分组经营分析 ============

export function getGroupPerformanceReport(days = 30) {
    const range = getRevenueDateRange(days)
    const rows = db.prepare(`
        SELECT
            g.id AS groupId,
            g.name AS groupName,
            COUNT(DISTINCT i.id) AS itemCount,
            COUNT(o.id) AS orderCount,
            COALESCE(SUM(${O_PAID_REVENUE_EXPR}), 0) AS revenue,
            COALESCE(SUM(${O_REFUND_AMOUNT_EXPR}), 0) AS refundAmount,
            SUM(CASE WHEN o.status = 4 THEN 1 ELSE 0 END) AS completedOrders,
            SUM(CASE WHEN ${O_REFUND_ORDER_EXPR} THEN 1 ELSE 0 END) AS refundOrders,
            COALESCE(SUM(CASE WHEN o.status = 4 THEN ${O_PAID_REVENUE_EXPR} - ${O_REFUND_AMOUNT_EXPR} ELSE 0 END), 0) AS netIncome,
            MAX(${O_REVENUE_TIME_EXPR}) AS lastOrderTime
        FROM item_groups g
        LEFT JOIN item_group_items i ON i.group_id = g.id
        LEFT JOIN orders o
            ON o.item_id = i.item_id
           AND o.account_id = i.account_id
           AND substr(${O_REVENUE_TIME_EXPR}, 1, 10) BETWEEN ? AND ?
        GROUP BY g.id, g.name
        ORDER BY netIncome DESC, revenue DESC, orderCount DESC
    `).all(range.startDate, range.endDate) as any[]

    const groups = rows.map(row => {
        const revenue = Number(row.revenue || 0)
        const refundAmount = Number(row.refundAmount || 0)
        const netIncome = Number(row.netIncome || 0)
        const orderCount = Number(row.orderCount || 0)
        const refundOrders = Number(row.refundOrders || 0)

        return {
            groupId: row.groupId,
            groupName: row.groupName,
            itemCount: Number(row.itemCount || 0),
            orderCount,
            completedOrders: Number(row.completedOrders || 0),
            refundOrders,
            revenue: Math.round(revenue * 100) / 100,
            refundAmount: Math.round(refundAmount * 100) / 100,
            actualRevenue: Math.round((revenue - refundAmount) * 100) / 100,
            netIncome: Math.round(netIncome * 100) / 100,
            refundRate: orderCount > 0 ? Math.round(refundOrders / orderCount * 100) : 0,
            avgOrderValue: orderCount > 0 ? Math.round(revenue / orderCount * 100) / 100 : 0,
            lastOrderTime: row.lastOrderTime || null
        }
    })

    const summary = groups.reduce((acc, group) => {
        acc.groupCount += 1
        acc.itemCount += group.itemCount
        acc.orderCount += group.orderCount
        acc.revenue += group.revenue
        acc.refundAmount += group.refundAmount
        acc.netIncome += group.netIncome
        acc.refundOrders += group.refundOrders
        return acc
    }, {
        groupCount: 0,
        itemCount: 0,
        orderCount: 0,
        revenue: 0,
        refundAmount: 0,
        netIncome: 0,
        refundOrders: 0
    })

    return {
        range,
        summary: {
            ...summary,
            revenue: Math.round(summary.revenue * 100) / 100,
            refundAmount: Math.round(summary.refundAmount * 100) / 100,
            netIncome: Math.round(summary.netIncome * 100) / 100,
            refundRate: summary.orderCount > 0 ? Math.round(summary.refundOrders / summary.orderCount * 100) : 0
        },
        groups
    }
}

// ============ 4. 自动发货健康度 ============

export function getAutoSellReport(days = 7) {
    const range = getRevenueDateRange(days)
    const logs = db.prepare(`
        SELECT l.*, r.name AS rule_name
        FROM autosell_logs l
        LEFT JOIN autosell_rules r ON r.id = l.rule_id
        WHERE substr(l.created_at, 1, 10) BETWEEN ? AND ?
        ORDER BY l.id DESC
    `).all(range.startDate, range.endDate) as any[]

    const total = logs.length
    const success = logs.filter(log => log.status === 'success').length
    const failed = logs.filter(log => log.status === 'failed').length
    const deliveredQuantity = logs
        .filter(log => log.status === 'success')
        .reduce((sum, log) => sum + (Number(log.quantity || 0) || 0), 0)

    const byRuleMap = new Map<number | string, any>()
    const byErrorMap = new Map<string, number>()
    const dailyMap = new Map<string, { total: number; success: number; failed: number }>()

    for (const log of logs) {
        const ruleKey = log.rule_id ?? 'unknown'
        const ruleData = byRuleMap.get(ruleKey) || {
            ruleId: log.rule_id,
            ruleName: log.rule_name || '未知规则',
            total: 0,
            success: 0,
            failed: 0,
            quantity: 0
        }
        ruleData.total++
        if (log.status === 'success') {
            ruleData.success++
            ruleData.quantity += Number(log.quantity || 0) || 0
        } else {
            ruleData.failed++
            const reason = log.error_message || '未知错误'
            byErrorMap.set(reason, (byErrorMap.get(reason) || 0) + 1)
        }
        byRuleMap.set(ruleKey, ruleData)

        const day = String(log.created_at || '').slice(0, 10)
        const dayData = dailyMap.get(day) || { total: 0, success: 0, failed: 0 }
        dayData.total++
        if (log.status === 'success') dayData.success++
        if (log.status === 'failed') dayData.failed++
        dailyMap.set(day, dayData)
    }

    const rules = getAutoSellRules()
    const stockPools = rules
        .filter(rule => rule.deliveryType === 'stock')
        .map(rule => {
            const stats = getStockStats(rule.id)
            const relatedRules = rules.filter(candidate =>
                candidate.id === rule.id || candidate.sharedStockRuleId === rule.id
            )
            const relatedItemIds = new Set(relatedRules.map(candidate => candidate.itemId).filter(Boolean))
            const dailyUsage = deliveredQuantity > 0 ? deliveredQuantity / Math.max(days, 1) : 0
            return {
                ruleId: rule.id,
                ruleName: rule.name,
                total: stats.total,
                used: stats.used,
                available: stats.available,
                relatedRuleCount: relatedRules.length,
                relatedItemCount: relatedItemIds.size,
                estimatedDays: dailyUsage > 0 ? Math.floor(stats.available / dailyUsage * 10) / 10 : null
            }
        })
        .sort((a, b) => a.available - b.available)

    const byRule = [...byRuleMap.values()].map(rule => ({
        ...rule,
        successRate: rule.total > 0 ? Math.round(rule.success / rule.total * 100) : 0
    })).sort((a, b) => b.failed - a.failed || b.total - a.total)

    return {
        range,
        summary: {
            total,
            success,
            failed,
            deliveredQuantity,
            successRate: total > 0 ? Math.round(success / total * 100) : 0
        },
        byRule,
        byError: [...byErrorMap.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count),
        daily: [...dailyMap.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([date, data]) => ({ date, ...data })),
        stockPools
    }
}

// ============ 5. 账号经营分析 ============

export function getAccountPerformanceReport(days = 30) {
    const range = getRevenueDateRange(days)
    const rows = db.prepare(`
        SELECT
            a.id AS accountId,
            a.nickname AS accountNickname,
            a.enabled AS enabled,
            s.connected AS connected,
            s.error_message AS errorMessage,
            s.last_heartbeat AS lastHeartbeat,
            COUNT(o.id) AS orderCount,
            COALESCE(SUM(${O_PAID_REVENUE_EXPR}), 0) AS revenue,
            COALESCE(SUM(${O_REFUND_AMOUNT_EXPR}), 0) AS refundAmount,
            SUM(CASE WHEN o.status = 4 THEN 1 ELSE 0 END) AS completedOrders,
            SUM(CASE WHEN ${O_REFUND_ORDER_EXPR} THEN 1 ELSE 0 END) AS refundOrders,
            COALESCE(SUM(CASE WHEN o.status = 4 THEN ${O_PAID_REVENUE_EXPR} - ${O_REFUND_AMOUNT_EXPR} ELSE 0 END), 0) AS netIncome,
            COUNT(DISTINCT o.item_id) AS activeItems,
            MAX(${O_REVENUE_TIME_EXPR}) AS lastOrderTime
        FROM accounts a
        LEFT JOIN account_status s ON s.account_id = a.id
        LEFT JOIN orders o
            ON o.account_id = a.id
           AND substr(${O_REVENUE_TIME_EXPR}, 1, 10) BETWEEN ? AND ?
        GROUP BY a.id
        ORDER BY netIncome DESC, revenue DESC, orderCount DESC
    `).all(range.startDate, range.endDate) as any[]

    const autoRows = db.prepare(`
        SELECT account_id AS accountId,
               COUNT(*) AS total,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               COALESCE(SUM(CASE WHEN status = 'success' THEN quantity ELSE 0 END), 0) AS deliveredQuantity
        FROM autosell_logs
        WHERE substr(created_at, 1, 10) BETWEEN ? AND ?
        GROUP BY account_id
    `).all(range.startDate, range.endDate) as any[]

    const autoMap = new Map(autoRows.map(row => [row.accountId, row]))
    const accounts = rows.map(row => {
        const revenue = Number(row.revenue || 0)
        const refundAmount = Number(row.refundAmount || 0)
        const orderCount = Number(row.orderCount || 0)
        const refundOrders = Number(row.refundOrders || 0)
        const auto = autoMap.get(row.accountId) || {}
        const autoTotal = Number(auto.total || 0)
        const autoSuccess = Number(auto.success || 0)
        const errorMessage = normalizeAccountError(row.errorMessage)
        const connected = !!row.connected

        return {
            accountId: row.accountId,
            accountNickname: row.accountNickname || row.accountId,
            enabled: !!row.enabled,
            connected,
            offline: !!row.enabled && (!connected || !!errorMessage),
            errorMessage,
            lastHeartbeat: row.lastHeartbeat || null,
            orderCount,
            completedOrders: Number(row.completedOrders || 0),
            refundOrders,
            revenue: Math.round(revenue * 100) / 100,
            refundAmount: Math.round(refundAmount * 100) / 100,
            actualRevenue: Math.round((revenue - refundAmount) * 100) / 100,
            netIncome: Math.round(Number(row.netIncome || 0) * 100) / 100,
            pendingConfirmAmount: Math.round(((revenue - refundAmount) - Number(row.netIncome || 0)) * 100) / 100,
            activeItems: Number(row.activeItems || 0),
            refundRate: orderCount > 0 ? Math.round(refundOrders / orderCount * 100) : 0,
            avgOrderValue: orderCount > 0 ? Math.round(revenue / orderCount * 100) / 100 : 0,
            lastOrderTime: row.lastOrderTime || null,
            autoSell: {
                total: autoTotal,
                success: autoSuccess,
                failed: Number(auto.failed || 0),
                deliveredQuantity: Number(auto.deliveredQuantity || 0),
                successRate: autoTotal > 0 ? Math.round(autoSuccess / autoTotal * 100) : 0
            }
        }
    })

    const summary = accounts.reduce((acc, account) => {
        acc.accountCount += 1
        if (account.enabled) acc.enabledCount += 1
        if (account.connected) acc.connectedCount += 1
        if (account.offline) acc.offlineCount += 1
        acc.orderCount += account.orderCount
        acc.refundOrders += account.refundOrders
        acc.revenue += account.revenue
        acc.refundAmount += account.refundAmount
        acc.netIncome += account.netIncome
        acc.pendingConfirmAmount += account.pendingConfirmAmount
        acc.autoTotal += account.autoSell.total
        acc.autoSuccess += account.autoSell.success
        return acc
    }, {
        accountCount: 0,
        enabledCount: 0,
        connectedCount: 0,
        offlineCount: 0,
        orderCount: 0,
        refundOrders: 0,
        revenue: 0,
        refundAmount: 0,
        netIncome: 0,
        pendingConfirmAmount: 0,
        autoTotal: 0,
        autoSuccess: 0
    })

    return {
        range,
        summary: {
            ...summary,
            revenue: Math.round(summary.revenue * 100) / 100,
            refundAmount: Math.round(summary.refundAmount * 100) / 100,
            netIncome: Math.round(summary.netIncome * 100) / 100,
            pendingConfirmAmount: Math.round(summary.pendingConfirmAmount * 100) / 100,
            refundRate: summary.orderCount > 0 ? Math.round(summary.refundOrders / summary.orderCount * 100) : 0,
            autoSellSuccessRate: summary.autoTotal > 0 ? Math.round(summary.autoSuccess / summary.autoTotal * 100) : 0
        },
        accounts
    }
}

// ============ 6. 订单状态分布 ============

export function getOrderStatusReport(days = 30) {
    const range = getRevenueDateRange(days)
    const rows = db.prepare(`
        SELECT o.status,
               o.status_text AS statusText,
               COUNT(*) AS orderCount,
               COALESCE(SUM(${O_PAID_REVENUE_EXPR}), 0) AS revenue,
               COALESCE(SUM(${O_REFUND_AMOUNT_EXPR}), 0) AS refundAmount,
               COALESCE(SUM(CASE WHEN o.status = 4 THEN ${O_PAID_REVENUE_EXPR} - ${O_REFUND_AMOUNT_EXPR} ELSE 0 END), 0) AS netIncome,
               COUNT(DISTINCT o.account_id) AS accountCount,
               COUNT(DISTINCT o.item_id) AS itemCount
        FROM orders o
        WHERE substr(${O_REVENUE_TIME_EXPR}, 1, 10) BETWEEN ? AND ?
        GROUP BY o.status, o.status_text
        ORDER BY orderCount DESC
    `).all(range.startDate, range.endDate) as any[]

    const groups = rows.map(row => {
        const revenue = Number(row.revenue || 0)
        const refundAmount = Number(row.refundAmount || 0)
        return {
            status: row.status,
            statusText: row.statusText || '',
            label: getOrderStatusLabel(row.status, row.statusText),
            orderCount: Number(row.orderCount || 0),
            revenue: Math.round(revenue * 100) / 100,
            refundAmount: Math.round(refundAmount * 100) / 100,
            actualRevenue: Math.round((revenue - refundAmount) * 100) / 100,
            netIncome: Math.round(Number(row.netIncome || 0) * 100) / 100,
            accountCount: Number(row.accountCount || 0),
            itemCount: Number(row.itemCount || 0)
        }
    })

    const dailyRows = db.prepare(`
        SELECT substr(${O_REVENUE_TIME_EXPR}, 1, 10) AS date,
               o.status,
               o.status_text AS statusText,
               COUNT(*) AS count
        FROM orders o
        WHERE substr(${O_REVENUE_TIME_EXPR}, 1, 10) BETWEEN ? AND ?
        GROUP BY date, o.status, o.status_text
        ORDER BY date ASC
    `).all(range.startDate, range.endDate) as any[]

    const dailyMap = new Map<string, any>()
    for (const row of dailyRows) {
        const date = row.date || ''
        const data = dailyMap.get(date) || { date, total: 0, success: 0, pendingShip: 0, shipped: 0, refund: 0, closed: 0, other: 0 }
        const count = Number(row.count || 0)
        data.total += count
        const status = Number(row.status || 0)
        const text = String(row.statusText || '')
        if (status === 4) data.success += count
        else if (status === 2) data.pendingShip += count
        else if (status === 3 || status === 10) data.shipped += count
        else if (status === 8 || status === 12 || text.includes('退款')) data.refund += count
        else if (status === 6) data.closed += count
        else data.other += count
        dailyMap.set(date, data)
    }

    const summary = groups.reduce((acc, group) => {
        acc.totalOrders += group.orderCount
        acc.revenue += group.revenue
        acc.refundAmount += group.refundAmount
        acc.netIncome += group.netIncome
        const status = Number(group.status || 0)
        const text = String(group.statusText || '')
        if (status === 4) acc.successOrders += group.orderCount
        if (status === 2) acc.pendingShipments += group.orderCount
        if (status === 3 || status === 10) acc.pendingConfirmOrders += group.orderCount
        if (status === 8 || status === 12 || text.includes('退款')) acc.refundOrders += group.orderCount
        if (status === 6) acc.closedOrders += group.orderCount
        return acc
    }, {
        totalOrders: 0,
        successOrders: 0,
        pendingShipments: 0,
        pendingConfirmOrders: 0,
        refundOrders: 0,
        closedOrders: 0,
        revenue: 0,
        refundAmount: 0,
        netIncome: 0
    })

    return {
        range,
        summary: {
            ...summary,
            revenue: Math.round(summary.revenue * 100) / 100,
            refundAmount: Math.round(summary.refundAmount * 100) / 100,
            netIncome: Math.round(summary.netIncome * 100) / 100,
            refundRate: summary.totalOrders > 0 ? Math.round(summary.refundOrders / summary.totalOrders * 100) : 0,
            successRate: summary.totalOrders > 0 ? Math.round(summary.successOrders / summary.totalOrders * 100) : 0
        },
        groups,
        daily: [...dailyMap.values()]
    }
}

// ============ 7. 买家复购/客户质量 ============

export function getBuyerQualityReport(days = 90) {
    const range = getRevenueDateRange(days)
    const rows = db.prepare(`
        SELECT COALESCE(NULLIF(buyer_user_id, ''), buyer_nickname, '未知买家') AS buyerKey,
               MAX(buyer_nickname) AS buyerNickname,
               COUNT(*) AS orderCount,
               COUNT(DISTINCT item_id) AS itemCount,
               COUNT(DISTINCT account_id) AS accountCount,
               COALESCE(SUM(${PAID_REVENUE_EXPR}), 0) AS revenue,
               COALESCE(SUM(${REFUND_AMOUNT_EXPR}), 0) AS refundAmount,
               SUM(CASE WHEN status = 4 THEN 1 ELSE 0 END) AS completedOrders,
               SUM(CASE WHEN ${REFUND_ORDER_EXPR} THEN 1 ELSE 0 END) AS refundOrders,
               COALESCE(SUM(CASE WHEN status = 4 THEN ${PAID_REVENUE_EXPR} - ${REFUND_AMOUNT_EXPR} ELSE 0 END), 0) AS netIncome,
               MIN(${REVENUE_TIME_EXPR}) AS firstOrderTime,
               MAX(${REVENUE_TIME_EXPR}) AS lastOrderTime
        FROM orders
        WHERE substr(${REVENUE_TIME_EXPR}, 1, 10) BETWEEN ? AND ?
        GROUP BY buyerKey
        ORDER BY orderCount DESC, netIncome DESC
    `).all(range.startDate, range.endDate) as any[]

    const buyers = rows.map(row => {
        const revenue = Number(row.revenue || 0)
        const refundAmount = Number(row.refundAmount || 0)
        const orderCount = Number(row.orderCount || 0)
        const refundOrders = Number(row.refundOrders || 0)
        return {
            buyerKey: row.buyerKey,
            buyerNickname: row.buyerNickname || row.buyerKey,
            orderCount,
            itemCount: Number(row.itemCount || 0),
            accountCount: Number(row.accountCount || 0),
            completedOrders: Number(row.completedOrders || 0),
            refundOrders,
            revenue: Math.round(revenue * 100) / 100,
            refundAmount: Math.round(refundAmount * 100) / 100,
            actualRevenue: Math.round((revenue - refundAmount) * 100) / 100,
            netIncome: Math.round(Number(row.netIncome || 0) * 100) / 100,
            avgOrderValue: orderCount > 0 ? Math.round(revenue / orderCount * 100) / 100 : 0,
            refundRate: orderCount > 0 ? Math.round(refundOrders / orderCount * 100) : 0,
            repeatBuyer: orderCount >= 2,
            highRisk: orderCount >= 2 && refundOrders / orderCount >= 0.5,
            firstOrderTime: row.firstOrderTime || null,
            lastOrderTime: row.lastOrderTime || null
        }
    })

    const summary = buyers.reduce((acc, buyer) => {
        acc.buyerCount += 1
        if (buyer.repeatBuyer) acc.repeatBuyerCount += 1
        if (buyer.highRisk) acc.highRiskBuyerCount += 1
        acc.orderCount += buyer.orderCount
        acc.refundOrders += buyer.refundOrders
        acc.revenue += buyer.revenue
        acc.netIncome += buyer.netIncome
        return acc
    }, {
        buyerCount: 0,
        repeatBuyerCount: 0,
        highRiskBuyerCount: 0,
        orderCount: 0,
        refundOrders: 0,
        revenue: 0,
        netIncome: 0
    })

    const repeatBuyers = buyers.filter(buyer => buyer.repeatBuyer)
    const highRiskBuyers = buyers.filter(buyer => buyer.highRisk)
    const topBuyers = [...buyers].sort((a, b) => b.orderCount - a.orderCount || b.netIncome - a.netIncome).slice(0, 30)

    return {
        range,
        summary: {
            ...summary,
            revenue: Math.round(summary.revenue * 100) / 100,
            netIncome: Math.round(summary.netIncome * 100) / 100,
            repeatRate: summary.buyerCount > 0 ? Math.round(summary.repeatBuyerCount / summary.buyerCount * 100) : 0,
            refundRate: summary.orderCount > 0 ? Math.round(summary.refundOrders / summary.orderCount * 100) : 0,
            avgOrdersPerBuyer: summary.buyerCount > 0 ? Math.round(summary.orderCount / summary.buyerCount * 10) / 10 : 0
        },
        topBuyers,
        repeatBuyers,
        highRiskBuyers
    }
}

// ============ 8. 热门商品 ============

export function getHotItems(limit = 20, groupId?: number) {
    let params: any[] = []
    let groupFilter = ''
    if (groupId) {
        const groupItems = getGroupItemIds(groupId)
        if (groupItems.length > 0) {
            const conditions = groupItems.map(() => '(item_id = ? AND account_id = ?)').join(' OR ')
            groupFilter = ` WHERE (${conditions})`
            groupItems.forEach(item => {
                params.push(item.itemId, item.accountId)
            })
        } else {
            return []
        }
    }
    params.push(limit)
    const rows = db.prepare(`
        SELECT item_title as title, item_id, account_id,
               COUNT(*) as orderCount,
               SUM(CASE WHEN status = 3 OR status = 4 THEN 1 ELSE 0 END) as successCount,
               SUM(CASE WHEN status IN (8, 12) OR status_text LIKE '%退款%' THEN 1 ELSE 0 END) as refundCount,
               COALESCE(SUM(${PAID_REVENUE_EXPR}), 0) as totalRevenue,
               MIN(created_at) as firstOrder,
               MAX(created_at) as lastOrder,
               AVG(CASE WHEN ${PAID_REVENUE_EXPR} > 0 THEN ${PAID_REVENUE_EXPR} END) as avgPrice
        FROM orders${groupFilter}
        GROUP BY item_id, account_id
        ORDER BY orderCount DESC
        LIMIT ?
    `).all(...params) as any[]

    return rows.map(r => ({
        title: r.title || '未知商品',
        itemId: r.item_id,
        accountId: r.account_id,
        orderCount: r.orderCount,
        successCount: r.successCount,
        refundCount: r.refundCount || 0,
        successRate: r.orderCount > 0 ? Math.round(r.successCount / r.orderCount * 100) : 0,
        refundRate: r.orderCount > 0 ? Math.round((r.refundCount || 0) / r.orderCount * 100) : 0,
        totalRevenue: Math.round(r.totalRevenue * 100) / 100,
        avgPrice: r.avgPrice ? Math.round(r.avgPrice * 100) / 100 : 0,
        firstOrder: r.firstOrder,
        lastOrder: r.lastOrder
    }))
}

// ============ 5. 退款分析 ============

export function getRefundReport(days = 30, groupId?: number) {
    let params: any[] = [days]
    let groupFilter = ''
    if (groupId) {
        const groupItems = getGroupItemIds(groupId)
        if (groupItems.length > 0) {
            const conditions = groupItems.map(() => '(item_id = ? AND account_id = ?)').join(' OR ')
            groupFilter = ` AND (${conditions})`
            groupItems.forEach(item => {
                params.push(item.itemId, item.accountId)
            })
        } else {
            return {
                summary: {
                    totalOrders: 0,
                    refundCount: 0,
                    refundRate: 0,
                    totalRefundAmount: 0
                },
                daily: [],
                byReason: [],
                byItem: []
            }
        }
    }
    const allOrders = db.prepare(`
        SELECT created_at, order_id, account_id, item_title, price,
               total_amount, buyer_paid_amount, refund_amount, refund_status, refund_time, status, status_text,
               has_refund
        FROM orders
        WHERE created_at >= datetime('now', '+8 hours', '-' || ? || ' days')${groupFilter}
        ORDER BY created_at ASC
    `).all(...params) as any[]

    const refundOrders = allOrders.filter((r: any) =>
        r.status === 8 || r.status === 12 ||
        (r.status_text && r.status_text.includes('退款')) ||
        r.has_refund || (r.refund_status && r.refund_status !== '')
    )
    const totalOrders = allOrders.length

    const byDay = new Map<string, { refunds: number; amount: number; orders: number }>()
    const byReason = new Map<string, number>()
    const byItem = new Map<string, { title: string; refunds: number; amount: number }>()
    let totalRefundAmount = 0

    for (const o of refundOrders) {
        const day = (o.created_at || '').slice(0, 10)
        const paid = parseFloat(o.buyer_paid_amount || o.total_amount || o.price || '0') || 0
        const refundGiven = parseFloat(o.refund_amount || '0') || 0
        // status=8 时 refund_amount 是编号，用支付金额
        // status=12 时如果 refund_amount 不合理也用支付金额
        let refundAmt = 0
        if (o.status === 8) {
            refundAmt = paid
        } else if (refundGiven > 0 && refundGiven <= paid) {
            refundAmt = refundGiven
        } else {
            refundAmt = paid
        }
        totalRefundAmount += refundAmt

        const dayData = byDay.get(day) || { refunds: 0, amount: 0, orders: 0 }
        dayData.refunds++
        dayData.amount += refundAmt
        byDay.set(day, dayData)

        const reason = o.refund_status || o.status_text || '未分类'
        byReason.set(reason, (byReason.get(reason) || 0) + 1)

        const itemKey = o.item_title || '未知商品'
        const itemData = byItem.get(itemKey) || { title: itemKey, refunds: 0, amount: 0 }
        itemData.refunds++
        itemData.amount += refundAmt
        byItem.set(itemKey, itemData)
    }

    for (const o of allOrders) {
        const day = (o.created_at || '').slice(0, 10)
        const dayData = byDay.get(day)
        if (dayData) dayData.orders++
    }

    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => ({
        date,
        orders: d.orders,
        refunds: d.refunds,
        refundRate: d.orders > 0 ? Math.round(d.refunds / d.orders * 100) : 0,
        amount: Math.round(d.amount * 100) / 100
    }))

    const itemRefunds = [...byItem.values()].sort((a, b) => b.refunds - a.refunds)

    return {
        summary: {
            totalOrders,
            refundCount: refundOrders.length,
            refundRate: totalOrders > 0 ? Math.round(refundOrders.length / totalOrders * 100) : 0,
            totalRefundAmount: Math.round(totalRefundAmount * 100) / 100
        },
        daily,
        byReason: [...byReason.entries()].map(([reason, count]) => ({ reason, count })),
        byItem: itemRefunds
    }
}

// ============ 6. 客服效率 ============

export function getServiceEfficiency(days = 7) {
    const autoReplyStats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
               SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting
        FROM workflow_executions
        WHERE created_at >= datetime('now', '+8 hours', '-' || ? || ' days')
    `).get(days) as any

    const daysAgoMs = Date.now() - days * 86400000
    const msgRows = db.prepare(`
        SELECT created_at, direction
        FROM conversation_messages
        WHERE created_at >= ?
    `).all(daysAgoMs) as any[]

    const wfStats = db.prepare(`
        SELECT status, COUNT(*) as count
        FROM workflow_executions
        WHERE created_at >= datetime('now', '+8 hours', '-' || ? || ' days')
        GROUP BY status
    `).all(days) as any[]

    // 按天 + 按小时
    const byDay = new Map<string, { inbound: number; outbound: number }>()
    const byHour = new Map<number, { inbound: number; outbound: number }>()

    for (const row of msgRows) {
        const ts = typeof row.created_at === 'number' ? row.created_at : parseInt(row.created_at) || 0
        if (ts <= 0) continue
        const d = new Date(ts + 8 * 3600 * 1000)
        const day = d.toISOString().slice(0, 10)
        const hour = parseInt(d.toISOString().slice(11, 13)) || 0

        const dayData = byDay.get(day) || { inbound: 0, outbound: 0 }
        if (row.direction === 'in') dayData.inbound++; else dayData.outbound++
        byDay.set(day, dayData)

        const hourData = byHour.get(hour) || { inbound: 0, outbound: 0 }
        if (row.direction === 'in') hourData.inbound++; else hourData.outbound++
        byHour.set(hour, hourData)
    }

    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => ({
        date,
        inbound: d.inbound,
        outbound: d.outbound,
        total: d.inbound + d.outbound,
        autoReplyRate: d.inbound > 0 ? Math.round(d.outbound / d.inbound * 100) : 0
    }))

    const hourly = Array.from({ length: 24 }, (_, h) => {
        const d = byHour.get(h) || { inbound: 0, outbound: 0 }
        return { hour: h, inbound: d.inbound, outbound: d.outbound, total: d.inbound + d.outbound }
    })

    // 库存使用情况
    const stockStats = db.prepare(`
        SELECT COUNT(*) as total, SUM(used) as used, COUNT(*) - SUM(used) as available
        FROM autosell_stock
    `).get() as any

    return {
        summary: {
            workflowTotal: autoReplyStats?.total || 0,
            workflowCompleted: autoReplyStats?.completed || 0,
            workflowFailed: autoReplyStats?.failed || 0,
            workflowWaiting: autoReplyStats?.waiting || 0,
            completionRate: autoReplyStats?.total > 0
                ? Math.round((autoReplyStats.completed || 0) / autoReplyStats.total * 100) : 0,
            failureRate: autoReplyStats?.total > 0
                ? Math.round((autoReplyStats.failed || 0) / autoReplyStats.total * 100) : 0,
            totalMessages: msgRows.length,
            inboundMessages: msgRows.filter((r: any) => r.direction === 'in').length,
            outboundMessages: msgRows.filter((r: any) => r.direction !== 'in').length
        },
        workflowExecution: wfStats.map((s: any) => ({
            status: s.status,
            count: s.count
        })),
        stock: {
            total: stockStats?.total || 0,
            used: stockStats?.used || 0,
            available: stockStats?.available || 0,
            usageRate: stockStats?.total > 0
                ? Math.round((stockStats.used || 0) / stockStats.total * 100) : 0
        },
        daily,
        hourly
    }
}
