import { Hono } from 'hono'
import {
    getRevenueReport,
    getSalesOverview,
    getHotItems,
    getRefundReport,
    getServiceEfficiency,
    getGroupPerformanceReport,
    getAutoSellReport,
    getAccountPerformanceReport,
    getOrderStatusReport,
    getBuyerQualityReport
} from '../../services/report.service.js'

export function createReportRoutes() {
    const router = new Hono()

    // 数据报表
    router.get('/revenue', (c) => {
        const period = (c.req.query('period') || 'day') as 'day' | 'week' | 'month'
        const days = parseInt(c.req.query('days') || '30') || 30
        const startDate = c.req.query('startDate') || undefined
        const endDate = c.req.query('endDate') || undefined
        const groupId = c.req.query('groupId') ? parseInt(c.req.query('groupId') || '0') : undefined
        return c.json(getRevenueReport(period, days, startDate, endDate, groupId))
    })

    // 销售概览
    router.get('/overview', (c) => {
        return c.json(getSalesOverview())
    })

    // 热门商品
    router.get('/hot-items', (c) => {
        const limit = parseInt(c.req.query('limit') || '20') || 20
        const groupId = c.req.query('groupId') ? parseInt(c.req.query('groupId') || '0') : undefined
        return c.json(getHotItems(limit, groupId))
    })

    // 退款分析
    router.get('/refunds', (c) => {
        const days = parseInt(c.req.query('days') || '30') || 30
        const groupId = c.req.query('groupId') ? parseInt(c.req.query('groupId') || '0') : undefined
        return c.json(getRefundReport(days, groupId))
    })

    // 客服效率
    router.get('/service', (c) => {
        const days = parseInt(c.req.query('days') || '7') || 7
        return c.json(getServiceEfficiency(days))
    })

    // 商品分组经营分析
    router.get('/groups', (c) => {
        const days = parseInt(c.req.query('days') || '30') || 30
        return c.json(getGroupPerformanceReport(days))
    })

    // 自动发货健康度
    router.get('/autosell', (c) => {
        const days = parseInt(c.req.query('days') || '7') || 7
        return c.json(getAutoSellReport(days))
    })

    // 账号经营分析
    router.get('/accounts', (c) => {
        const days = parseInt(c.req.query('days') || '30') || 30
        return c.json(getAccountPerformanceReport(days))
    })

    // 订单状态分布
    router.get('/status', (c) => {
        const days = parseInt(c.req.query('days') || '30') || 30
        return c.json(getOrderStatusReport(days))
    })

    // 买家复购/客户质量
    router.get('/buyers', (c) => {
        const days = parseInt(c.req.query('days') || '90') || 90
        return c.json(getBuyerQualityReport(days))
    })

    return router
}
