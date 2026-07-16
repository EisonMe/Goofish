import { db, getAutoSellRule, getEnabledAutoSellRules, getOrderById } from '../db/index.js'
import { OrderStatus } from '../types/order.types.js'
import type { AutoSellRule, DeliveryLog, OrderRecord, TriggerOn } from '../types/index.js'
import { getAutoSellRuleMatchPriority, selectAutoSellRule } from '../utils/autosell-rule-matcher.js'

interface RuleSummary {
    id: number
    name: string
    triggerOn: TriggerOn
    deliveryType: AutoSellRule['deliveryType']
    workflowId: number | null
    matchPrice: string | null
    priceMin: string | null
    priceMax: string | null
}

interface WorkflowExecutionSummary {
    id: number
    workflowId: number
    ruleId: number
    status: string
    createdAt: string
}

interface DebugCandidate extends RuleSummary {
    selected: boolean
    priceMatched: boolean
    matchPriority: number
    matchLabel: string
}

export interface OrderAutoSellDebugResult {
    orderId: string
    accountId: string
    itemId: string | null
    itemTitle: string | null
    orderPrice: string | null
    orderStatus: number
    orderStatusText: string
    triggerOn: TriggerOn
    actualLog: DeliveryLog | null
    actualRule: RuleSummary | null
    expectedRule: RuleSummary | null
    workflowExecution: WorkflowExecutionSummary | null
    isMismatch: boolean
    summary: string
    candidates: DebugCandidate[]
}

export interface AutoSellAnomalyItem {
    orderId: string
    accountId: string
    buyerUserId: string | null
    buyerNickname: string | null
    itemId: string | null
    itemTitle: string | null
    orderPrice: string | null
    orderStatus: number
    orderStatusText: string
    triggerOn: TriggerOn
    orderTime: string
    deliveredAt: string
    actualRule: RuleSummary | null
    expectedRule: RuleSummary | null
    summary: string
}

export interface AutoSellSupplementSheetItem extends AutoSellAnomalyItem {
    expectedRulePriceText: string
    actualRulePriceText: string
    suggestion: string
}

function toRuleSummary(rule: AutoSellRule | null | undefined): RuleSummary | null {
    if (!rule) return null

    return {
        id: rule.id,
        name: rule.name,
        triggerOn: rule.triggerOn,
        deliveryType: rule.deliveryType,
        workflowId: rule.workflowId,
        matchPrice: rule.matchPrice,
        priceMin: rule.priceMin,
        priceMax: rule.priceMax
    }
}

function getLatestDeliveryLog(orderId: string): DeliveryLog | null {
    const row = db.prepare(`
        SELECT id, rule_id, order_id, account_id, delivery_type, content, quantity, status, error_message, created_at
        FROM autosell_logs
        WHERE order_id = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(orderId) as any

    if (!row) return null

    return {
        id: row.id,
        ruleId: row.rule_id,
        orderId: row.order_id,
        accountId: row.account_id,
        deliveryType: row.delivery_type,
        content: row.content,
        quantity: row.quantity ?? 1,
        status: row.status,
        errorMessage: row.error_message,
        createdAt: row.created_at
    }
}

function getLatestWorkflowExecution(orderId: string): WorkflowExecutionSummary | null {
    const row = db.prepare(`
        SELECT id, workflow_id, rule_id, status, created_at
        FROM workflow_executions
        WHERE order_id = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(orderId) as any

    if (!row) return null

    return {
        id: row.id,
        workflowId: row.workflow_id,
        ruleId: row.rule_id,
        status: row.status,
        createdAt: row.created_at
    }
}

function getDebugTriggerOn(order: OrderRecord, actualRule: AutoSellRule | null, rules: AutoSellRule[]): TriggerOn {
    if (actualRule) return actualRule.triggerOn

    const hasConfirmedRule = rules.some(rule => rule.triggerOn === 'confirmed')
    if (order.status >= OrderStatus.PENDING_RECEIPT && hasConfirmedRule) {
        return 'confirmed'
    }

    return 'paid'
}

function getCandidateMatchLabel(rule: AutoSellRule, orderPrice: string | null): string {
    const priority = getAutoSellRuleMatchPriority(rule, orderPrice)

    if (rule.matchPrice) {
        return priority >= 0 ? `精确金额命中 ¥${rule.matchPrice}` : `精确金额不匹配 ¥${rule.matchPrice}`
    }

    if (rule.priceMin || rule.priceMax) {
        const min = rule.priceMin ?? '不限'
        const max = rule.priceMax ?? '不限'
        return priority >= 0 ? `区间命中 ${min} ~ ${max}` : `区间不匹配 ${min} ~ ${max}`
    }

    return '未设置金额条件'
}

function getRulePriceText(rule: RuleSummary | null): string {
    if (!rule) return '-'
    if (rule.matchPrice) return `精确 ¥${rule.matchPrice}`
    if (rule.priceMin || rule.priceMax) return `区间 ${rule.priceMin ?? '不限'} ~ ${rule.priceMax ?? '不限'}`
    return '全部金额'
}

function buildSupplementSuggestion(item: AutoSellAnomalyItem): string {
    if (item.expectedRule) {
        return `建议按规则「${item.expectedRule.name}」补发，并复核该订单是否已人工处理`
    }

    return '当前没有可自动推断的补发规则，请人工核对'
}

function buildSummary(
    order: OrderRecord,
    triggerOn: TriggerOn,
    actualRule: AutoSellRule | null,
    expectedRule: AutoSellRule | undefined,
    actualLog: DeliveryLog | null
): { isMismatch: boolean; summary: string } {
    if (!actualLog) {
        if (expectedRule) {
            return {
                isMismatch: false,
                summary: `当前配置下，这笔 ${triggerOn} 自动发货会命中规则「${expectedRule.name}」。`
            }
        }

        return {
            isMismatch: false,
            summary: `当前配置下，这笔订单在 ${triggerOn} 阶段没有匹配到自动发货规则。`
        }
    }

    if (!actualRule && expectedRule) {
        return {
            isMismatch: true,
            summary: `这笔订单实际发货日志存在，但对应历史规则已找不到；当前配置下应命中「${expectedRule.name}」。`
        }
    }

    if (actualRule && expectedRule && actualRule.id === expectedRule.id) {
        return {
            isMismatch: false,
            summary: `这笔订单当前配置下应命中「${expectedRule.name}」，实际发货也是它。`
        }
    }

    if (actualRule && expectedRule && actualRule.id !== expectedRule.id) {
        return {
            isMismatch: true,
            summary: `这笔订单金额是 ¥${order.price || '-'}，当前配置下应命中「${expectedRule.name}」，但实际发货命中的是「${actualRule.name}」。`
        }
    }

    if (actualRule && !expectedRule) {
        return {
            isMismatch: true,
            summary: `这笔订单实际发货命中「${actualRule.name}」，但按当前配置已经没有对应的匹配规则。`
        }
    }

    return {
        isMismatch: false,
        summary: '这笔订单暂未发现自动发货匹配异常。'
    }
}

function buildCandidates(rules: AutoSellRule[], triggerOn: TriggerOn, orderPrice: string | null, expectedRule?: AutoSellRule): DebugCandidate[] {
    return rules
        .filter(rule => rule.triggerOn === triggerOn)
        .map(rule => {
            const matchPriority = getAutoSellRuleMatchPriority(rule, orderPrice)
            return {
                ...toRuleSummary(rule)!,
                selected: expectedRule?.id === rule.id,
                priceMatched: matchPriority >= 0,
                matchPriority,
                matchLabel: getCandidateMatchLabel(rule, orderPrice)
            }
        })
        .sort((a, b) => {
            if (b.matchPriority !== a.matchPriority) return b.matchPriority - a.matchPriority
            return a.id - b.id
        })
}

export function getOrderAutoSellDebug(orderId: string): OrderAutoSellDebugResult | null {
    const order = getOrderById(orderId)
    if (!order) return null

    const rules = getEnabledAutoSellRules(order.accountId, order.itemId || undefined)
    const actualLog = getLatestDeliveryLog(orderId)
    const actualRule = actualLog?.ruleId ? getAutoSellRule(actualLog.ruleId) || null : null
    const triggerOn = getDebugTriggerOn(order, actualRule, rules)
    const expectedRule = selectAutoSellRule(rules, triggerOn, order.price)
    const workflowExecution = getLatestWorkflowExecution(orderId)
    const { isMismatch, summary } = buildSummary(order, triggerOn, actualRule, expectedRule, actualLog)

    return {
        orderId: order.orderId,
        accountId: order.accountId,
        itemId: order.itemId,
        itemTitle: order.itemTitle,
        orderPrice: order.price,
        orderStatus: order.status,
        orderStatusText: order.statusText,
        triggerOn,
        actualLog,
        actualRule: toRuleSummary(actualRule),
        expectedRule: toRuleSummary(expectedRule),
        workflowExecution,
        isMismatch,
        summary,
        candidates: buildCandidates(rules, triggerOn, order.price, expectedRule)
    }
}

export function getAutoSellAnomalies(limit = 20): { anomalies: AutoSellAnomalyItem[]; total: number } {
    const rows = db.prepare(`
        SELECT
            o.order_id,
            o.account_id,
            o.item_id,
            o.item_title,
            o.price,
            o.status,
            o.status_text,
            l.rule_id,
            l.created_at AS delivered_at
        FROM orders o
        INNER JOIN (
            SELECT order_id, MAX(id) AS max_id
            FROM autosell_logs
            WHERE status = 'success'
            GROUP BY order_id
        ) latest ON latest.order_id = o.order_id
        INNER JOIN autosell_logs l ON l.id = latest.max_id
        ORDER BY l.id DESC
    `).all() as any[]

    const anomalies: AutoSellAnomalyItem[] = []

    for (const row of rows) {
        const order = getOrderById(row.order_id)
        if (!order) continue

        const actualRule = row.rule_id ? getAutoSellRule(row.rule_id) || null : null
        const rules = getEnabledAutoSellRules(order.accountId, order.itemId || undefined)
        const triggerOn = getDebugTriggerOn(order, actualRule, rules)
        const expectedRule = selectAutoSellRule(rules, triggerOn, order.price)
        const { isMismatch, summary } = buildSummary(order, triggerOn, actualRule, expectedRule, {
            id: 0,
            ruleId: row.rule_id,
            orderId: row.order_id,
            accountId: row.account_id,
            deliveryType: actualRule?.deliveryType || 'fixed',
            content: '',
            quantity: 1,
            status: 'success',
            errorMessage: null,
            createdAt: row.delivered_at
        })

        if (!isMismatch) continue

        anomalies.push({
            orderId: order.orderId,
            accountId: order.accountId,
            buyerUserId: order.buyerUserId,
            buyerNickname: order.buyerNickname,
            itemId: order.itemId,
            itemTitle: order.itemTitle,
            orderPrice: order.price,
            orderStatus: order.status,
            orderStatusText: order.statusText,
            triggerOn,
            orderTime: order.orderTime,
            deliveredAt: row.delivered_at,
            actualRule: toRuleSummary(actualRule),
            expectedRule: toRuleSummary(expectedRule),
            summary
        })
    }

    return {
        anomalies: anomalies.slice(0, limit),
        total: anomalies.length
    }
}

export function getAutoSellSupplementSheet(limit = 1000): { items: AutoSellSupplementSheetItem[]; total: number } {
    const { anomalies, total } = getAutoSellAnomalies(limit)

    const items = anomalies.map(item => ({
        ...item,
        expectedRulePriceText: getRulePriceText(item.expectedRule),
        actualRulePriceText: getRulePriceText(item.actualRule),
        suggestion: buildSupplementSuggestion(item)
    }))

    return { items, total }
}

function escapeCsvValue(value: string | null | undefined): string {
    const text = String(value ?? '')
    if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`
    }
    return text
}

export function exportAutoSellSupplementSheetCsv(limit = 1000): { filename: string; csv: string; total: number } {
    const { items, total } = getAutoSellSupplementSheet(limit)

    const headers = [
        '订单号',
        '账号ID',
        '买家昵称',
        '买家ID',
        '商品ID',
        '商品标题',
        '订单金额',
        '订单状态',
        '触发阶段',
        '下单时间',
        '实际发货时间',
        '实际规则ID',
        '实际规则名',
        '实际规则金额条件',
        '应补发规则ID',
        '应补发规则名',
        '应补发金额条件',
        '补发建议',
        '异常说明'
    ]

    const rows = items.map(item => [
        item.orderId,
        item.accountId,
        item.buyerNickname,
        item.buyerUserId,
        item.itemId,
        item.itemTitle,
        item.orderPrice,
        item.orderStatusText,
        item.triggerOn,
        item.orderTime,
        item.deliveredAt,
        item.actualRule?.id ? String(item.actualRule.id) : '',
        item.actualRule?.name || '',
        item.actualRulePriceText,
        item.expectedRule?.id ? String(item.expectedRule.id) : '',
        item.expectedRule?.name || '',
        item.expectedRulePriceText,
        item.suggestion,
        item.summary
    ])

    const csv = [
        '\uFEFF' + headers.join(','),
        ...rows.map(row => row.map(value => escapeCsvValue(value)).join(','))
    ].join('\n')

    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const filename = `autosell-supplement-sheet-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`

    return { filename, csv, total }
}
