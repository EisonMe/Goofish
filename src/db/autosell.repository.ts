/**
 * 自动发货数据仓库
 */

import { db } from './connection.js'
import type {
    DbAutoSellRule,
    DbStockItem,
    DbDeliveryLog,
    CreateAutoSellRuleParams,
    UpdateAutoSellRuleParams,
    AutoSellRule,
    StockItem,
    DeliveryLog
} from '../types/index.js'

// ========== 规则管理 ==========

// 转换数据库规则到业务对象
function toRule(row: any): AutoSellRule {
    return {
        id: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        itemId: row.item_id,
        accountId: row.account_id,
        deliveryType: row.delivery_type,
        deliveryContent: row.delivery_content,
        apiConfig: row.api_config ? JSON.parse(row.api_config) : null,
        triggerOn: row.trigger_on,
        workflowId: row.workflow_id || null,
        sharedStockRuleId: row.shared_stock_rule_id || null,
        matchPrice: row.match_price || null,
        priceMin: row.price_min || null,
        priceMax: row.price_max || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function resolveEffectiveStockRuleIdInternal(ruleId: number, visited = new Set<number>()): number {
    if (visited.has(ruleId)) {
        throw new Error('共享库存规则存在循环引用')
    }
    visited.add(ruleId)

    const row = db.prepare(`
        SELECT id, delivery_type, shared_stock_rule_id
        FROM autosell_rules
        WHERE id = ?
    `).get(ruleId) as Pick<DbAutoSellRule, 'id' | 'delivery_type' | 'shared_stock_rule_id'> | undefined

    if (!row) {
        throw new Error(`共享库存来源规则不存在: ${ruleId}`)
    }

    if (row.delivery_type !== 'stock' || !row.shared_stock_rule_id) {
        return row.id
    }

    return resolveEffectiveStockRuleIdInternal(row.shared_stock_rule_id, visited)
}

function validateSharedStockRule(sharedStockRuleId: number | null | undefined, selfRuleId?: number): number | null {
    if (!sharedStockRuleId) return null
    if (selfRuleId && sharedStockRuleId === selfRuleId) {
        throw new Error('共享库存来源不能是自己')
    }

    const sourceRule = getAutoSellRule(sharedStockRuleId)
    if (!sourceRule) {
        throw new Error('共享库存来源规则不存在')
    }
    if (sourceRule.deliveryType !== 'stock') {
        throw new Error('共享库存来源规则必须是库存发货类型')
    }

    const visited = selfRuleId ? new Set<number>([selfRuleId]) : new Set<number>()
    resolveEffectiveStockRuleIdInternal(sharedStockRuleId, visited)
    return sharedStockRuleId
}

function moveRuleStockToRule(sourceRuleId: number, targetRuleId: number) {
    if (sourceRuleId === targetRuleId) return 0

    const stmt = db.prepare(`
        UPDATE autosell_stock
        SET rule_id = ?
        WHERE rule_id = ?
    `)
    const result = stmt.run(targetRuleId, sourceRuleId)
    return result.changes
}

function getSharedStockDependentRules(sourceRuleId: number): AutoSellRule[] {
    const stmt = db.prepare(`
        SELECT *
        FROM autosell_rules
        WHERE shared_stock_rule_id = ?
        ORDER BY id ASC
    `)
    const rows = stmt.all(sourceRuleId) as DbAutoSellRule[]
    return rows.map(toRule)
}

// 获取所有规则
export function getAutoSellRules(): AutoSellRule[] {
    const stmt = db.prepare('SELECT * FROM autosell_rules ORDER BY id DESC')
    const rows = stmt.all() as DbAutoSellRule[]
    return rows.map(toRule)
}

// 获取启用的规则
export function getEnabledAutoSellRules(accountId?: string, itemId?: string): AutoSellRule[] {
    let sql = 'SELECT * FROM autosell_rules WHERE enabled = 1'
    const params: any[] = []

    if (accountId) {
        sql += ' AND (account_id IS NULL OR account_id = ?)'
        params.push(accountId)
    }
    if (itemId) {
        sql += ' AND (item_id IS NULL OR item_id = ?)'
        params.push(itemId)
    }

    sql += ' ORDER BY id ASC'
    const stmt = db.prepare(sql)
    const rows = stmt.all(...params) as DbAutoSellRule[]
    return rows.map(toRule)
}


// 获取单个规则
export function getAutoSellRule(id: number): AutoSellRule | undefined {
    const stmt = db.prepare('SELECT * FROM autosell_rules WHERE id = ?')
    const row = stmt.get(id) as DbAutoSellRule | undefined
    return row ? toRule(row) : undefined
}

// 创建规则
export function createAutoSellRule(rule: CreateAutoSellRuleParams): number {
    const sharedStockRuleId = rule.deliveryType === 'stock'
        ? validateSharedStockRule(rule.sharedStockRuleId)
        : null

    const stmt = db.prepare(`
        INSERT INTO autosell_rules (
            name, enabled, item_id, account_id, delivery_type, delivery_content,
            api_config, trigger_on, workflow_id, shared_stock_rule_id, match_price, price_min, price_max
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
        rule.name,
        rule.enabled !== false ? 1 : 0,
        rule.itemId || null,
        rule.accountId || null,
        rule.deliveryType,
        rule.deliveryContent || null,
        rule.apiConfig ? JSON.stringify(rule.apiConfig) : null,
        rule.triggerOn || 'paid',
        rule.workflowId || null,
        sharedStockRuleId,
        rule.matchPrice || null,
        rule.priceMin || null,
        rule.priceMax || null
    )
    return result.lastInsertRowid as number
}

// 更新规则
export function updateAutoSellRule(id: number, rule: UpdateAutoSellRuleParams): boolean {
    const existing = getAutoSellRule(id)
    if (!existing) return false
    const nextDeliveryType = rule.deliveryType ?? existing.deliveryType
    const sharedStockRuleId = nextDeliveryType === 'stock'
        ? validateSharedStockRule(
            rule.sharedStockRuleId !== undefined ? rule.sharedStockRuleId : existing.sharedStockRuleId,
            id
        )
        : null
    const targetStockRuleId = nextDeliveryType === 'stock' && sharedStockRuleId
        ? getEffectiveStockRuleId(sharedStockRuleId)
        : null

    const stmt = db.prepare(`
        UPDATE autosell_rules SET
            name = ?, enabled = ?, item_id = ?, account_id = ?,
            delivery_type = ?, delivery_content = ?, api_config = ?, trigger_on = ?, workflow_id = ?,
            shared_stock_rule_id = ?,
            match_price = ?, price_min = ?, price_max = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `)

    const updateTransaction = db.transaction(() => {
        stmt.run(
            rule.name ?? existing.name,
            rule.enabled !== undefined ? (rule.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
            rule.itemId !== undefined ? rule.itemId : existing.itemId,
            rule.accountId !== undefined ? rule.accountId : existing.accountId,
            rule.deliveryType ?? existing.deliveryType,
            rule.deliveryContent !== undefined ? rule.deliveryContent : existing.deliveryContent,
            rule.apiConfig !== undefined ? (rule.apiConfig ? JSON.stringify(rule.apiConfig) : null) : (existing.apiConfig ? JSON.stringify(existing.apiConfig) : null),
            rule.triggerOn ?? existing.triggerOn,
            rule.workflowId !== undefined ? rule.workflowId : existing.workflowId,
            sharedStockRuleId,
            rule.matchPrice !== undefined ? rule.matchPrice : existing.matchPrice,
            rule.priceMin !== undefined ? rule.priceMin : existing.priceMin,
            rule.priceMax !== undefined ? rule.priceMax : existing.priceMax,
            id
        )

        if (targetStockRuleId) {
            moveRuleStockToRule(id, targetStockRuleId)
        }
    })

    updateTransaction()
    return true
}

// 删除规则
export function deleteAutoSellRule(id: number): boolean {
    const dependentRules = getSharedStockDependentRules(id)
    if (dependentRules.length > 0) {
        const names = dependentRules.map(rule => rule.name).join('、')
        throw new Error(`请先解除这些规则的共享库存后再删除：${names}`)
    }

    const stmt = db.prepare('DELETE FROM autosell_rules WHERE id = ?')
    const result = stmt.run(id)
    return result.changes > 0
}

// 切换规则启用状态
export function toggleAutoSellRule(id: number): boolean {
    const stmt = db.prepare('UPDATE autosell_rules SET enabled = 1 - enabled, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    const result = stmt.run(id)
    return result.changes > 0
}

// ========== 库存管理 ==========

export function getEffectiveStockRuleId(ruleId: number): number {
    return resolveEffectiveStockRuleIdInternal(ruleId)
}

// 转换库存项
function toStockItem(row: DbStockItem): StockItem {
    return {
        id: row.id,
        ruleId: row.rule_id,
        content: row.content,
        used: row.used === 1,
        usedOrderId: row.used_order_id,
        createdAt: row.created_at,
        usedAt: row.used_at
    }
}

// 获取规则的库存
export function getStockItems(ruleId: number, includeUsed = false): StockItem[] {
    const effectiveRuleId = getEffectiveStockRuleId(ruleId)
    const sql = includeUsed
        ? 'SELECT * FROM autosell_stock WHERE rule_id = ? ORDER BY id ASC'
        : 'SELECT * FROM autosell_stock WHERE rule_id = ? AND used = 0 ORDER BY id ASC'
    const stmt = db.prepare(sql)
    const rows = stmt.all(effectiveRuleId) as DbStockItem[]
    return rows.map(toStockItem)
}

// 获取库存统计
export function getStockStats(ruleId: number): { total: number; used: number; available: number } {
    const effectiveRuleId = getEffectiveStockRuleId(ruleId)
    const stmt = db.prepare(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) as used
        FROM autosell_stock WHERE rule_id = ?
    `)
    const row = stmt.get(effectiveRuleId) as { total: number; used: number }
    return {
        total: row.total,
        used: row.used || 0,
        available: row.total - (row.used || 0)
    }
}

// 添加库存
export function addStockItems(ruleId: number, contents: string[]): number {
    const effectiveRuleId = getEffectiveStockRuleId(ruleId)
    const stmt = db.prepare('INSERT INTO autosell_stock (rule_id, content) VALUES (?, ?)')
    const insertMany = db.transaction((items: string[]) => {
        for (const content of items) {
            stmt.run(effectiveRuleId, content)
        }
        return items.length
    })
    return insertMany(contents)
}

// 取出一个库存（标记为已使用）
export function consumeStock(ruleId: number, orderId: string): StockItem | null {
    const effectiveRuleId = getEffectiveStockRuleId(ruleId)
    const consumeTransaction = db.transaction((ruleId: number, orderId: string) => {
        // 在事务中查询并锁定库存项
        const selectStmt = db.prepare('SELECT * FROM autosell_stock WHERE rule_id = ? AND used = 0 ORDER BY id ASC LIMIT 1')
        const row = selectStmt.get(ruleId) as DbStockItem | undefined
        if (!row) return null

        // 更新为已使用状态
        const updateStmt = db.prepare('UPDATE autosell_stock SET used = 1, used_order_id = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?')
        updateStmt.run(orderId, row.id)

        return row
    })

    const row = consumeTransaction(effectiveRuleId, orderId)
    if (!row) return null

    return toStockItem({ ...row, used: 1, used_order_id: orderId })
}

// 批量取出库存（事务内一次性锁定多条）
export function consumeStockBatch(ruleId: number, orderId: string, quantity: number): StockItem[] {
    const effectiveRuleId = getEffectiveStockRuleId(ruleId)
    const normalizedQuantity = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0

    if (normalizedQuantity <= 0) {
        return []
    }

    const consumeTransaction = db.transaction((targetRuleId: number, targetOrderId: string, targetQuantity: number) => {
        const selectStmt = db.prepare(`
            SELECT * FROM autosell_stock
            WHERE rule_id = ? AND used = 0
            ORDER BY id ASC
            LIMIT ?
        `)
        const rows = selectStmt.all(targetRuleId, targetQuantity) as DbStockItem[]

        if (rows.length < targetQuantity) {
            return [] as DbStockItem[]
        }

        const updateStmt = db.prepare(`
            UPDATE autosell_stock
            SET used = 1, used_order_id = ?, used_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `)

        for (const row of rows) {
            updateStmt.run(targetOrderId, row.id)
        }

        return rows
    })

    const rows = consumeTransaction(effectiveRuleId, orderId, normalizedQuantity)
    return rows.map(row => toStockItem({ ...row, used: 1, used_order_id: orderId }))
}

// 回滚已占用库存（发送失败等场景）
export function restoreStockItems(stockItemIds: number[], orderId?: string): number {
    const normalizedIds = [...new Set(
        stockItemIds
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id > 0)
    )]

    if (normalizedIds.length === 0) {
        return 0
    }

    const placeholders = normalizedIds.map(() => '?').join(', ')
    let sql = `
        UPDATE autosell_stock
        SET used = 0, used_order_id = NULL, used_at = NULL
        WHERE id IN (${placeholders}) AND used = 1
    `
    const params: Array<number | string> = [...normalizedIds]

    if (orderId) {
        sql += ' AND used_order_id = ?'
        params.push(orderId)
    }

    const result = db.prepare(sql).run(...params)
    return result.changes
}

// 清空规则库存
export function clearStock(ruleId: number, onlyUsed = false): number {
    const effectiveRuleId = getEffectiveStockRuleId(ruleId)
    const sql = onlyUsed
        ? 'DELETE FROM autosell_stock WHERE rule_id = ? AND used = 1'
        : 'DELETE FROM autosell_stock WHERE rule_id = ?'
    const stmt = db.prepare(sql)
    const result = stmt.run(effectiveRuleId)
    return result.changes
}

// ========== 发货记录 ==========

// 转换发货记录
function toDeliveryLog(row: DbDeliveryLog): DeliveryLog {
    return {
        id: row.id,
        ruleId: row.rule_id,
        orderId: row.order_id,
        accountId: row.account_id,
        deliveryType: row.delivery_type,
        content: row.content,
        quantity: row.quantity ?? 1,
        status: row.status as 'success' | 'failed',
        errorMessage: row.error_message,
        createdAt: row.created_at
    }
}

// 添加发货记录
export function addDeliveryLog(log: {
    ruleId?: number | null
    orderId: string
    accountId: string
    deliveryType: string
    content: string
    quantity?: number
    status: 'success' | 'failed'
    errorMessage?: string | null
}): number {
    const stmt = db.prepare(`
        INSERT INTO autosell_logs (rule_id, order_id, account_id, delivery_type, content, quantity, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
        log.ruleId || null,
        log.orderId,
        log.accountId,
        log.deliveryType,
        log.content,
        log.quantity ?? 1,
        log.status,
        log.errorMessage || null
    )
    return result.lastInsertRowid as number
}

// 获取发货记录
export function getDeliveryLogs(params: {
    ruleId?: number
    orderId?: string
    accountId?: string
    limit?: number
    offset?: number
}): { logs: DeliveryLog[]; total: number } {
    let whereClauses: string[] = []
    const queryParams: any[] = []

    if (params.ruleId) {
        whereClauses.push('rule_id = ?')
        queryParams.push(params.ruleId)
    }
    if (params.orderId) {
        whereClauses.push('order_id = ?')
        queryParams.push(params.orderId)
    }
    if (params.accountId) {
        whereClauses.push('account_id = ?')
        queryParams.push(params.accountId)
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM autosell_logs ${whereClause}`)
    const { total } = countStmt.get(...queryParams) as { total: number }

    const limit = params.limit || 50
    const offset = params.offset || 0
    const dataStmt = db.prepare(`SELECT * FROM autosell_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    const rows = dataStmt.all(...queryParams, limit, offset) as DbDeliveryLog[]

    return { logs: rows.map(toDeliveryLog), total }
}

// 获取订单最新发货记录
export function getLatestDeliveryLog(
    orderId: string,
    status?: 'success' | 'failed'
): DeliveryLog | null {
    let sql = 'SELECT * FROM autosell_logs WHERE order_id = ?'
    const params: any[] = [orderId]

    if (status) {
        sql += ' AND status = ?'
        params.push(status)
    }

    sql += ' ORDER BY id DESC LIMIT 1'
    const row = db.prepare(sql).get(...params) as DbDeliveryLog | undefined
    return row ? toDeliveryLog(row) : null
}

// 检查订单是否已发货
export function hasDelivered(orderId: string): boolean {
    return getDeliveredQuantity(orderId) > 0
}

// 获取订单累计成功发货数量
export function getDeliveredQuantity(orderId: string): number {
    const stmt = db.prepare(`
        SELECT SUM(COALESCE(quantity, 1)) as delivered
        FROM autosell_logs
        WHERE order_id = ? AND status = 'success'
    `)
    const row = stmt.get(orderId) as { delivered: number | null } | undefined
    return row?.delivered ?? 0
}
