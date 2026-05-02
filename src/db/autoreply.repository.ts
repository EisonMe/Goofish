/**
 * 自动回复规则数据仓库
 */

import { db } from './connection.js'
import type {
    DbAutoReplyRule,
    CreateAutoReplyRuleParams,
    UpdateAutoReplyRuleParams
} from '../types/index.js'

// 获取所有规则
export function getAutoReplyRules(): DbAutoReplyRule[] {
    const stmt = db.prepare(`
        SELECT r.*, g.name AS item_group_name
        FROM autoreply_rules r
        LEFT JOIN item_groups g ON g.id = r.item_group_id
        ORDER BY r.priority DESC,
                 CASE WHEN r.item_group_id IS NULL THEN 1 ELSE 0 END ASC,
                 r.id ASC
    `)
    return stmt.all() as DbAutoReplyRule[]
}

// 获取启用的规则
export function getEnabledAutoReplyRules(accountId?: string): DbAutoReplyRule[] {
    if (accountId) {
        const stmt = db.prepare(`
            SELECT r.*, g.name AS item_group_name
            FROM autoreply_rules r
            LEFT JOIN item_groups g ON g.id = r.item_group_id
            WHERE r.enabled = 1 AND (r.account_id IS NULL OR r.account_id = ?)
            ORDER BY r.priority DESC,
                     CASE WHEN r.item_group_id IS NULL THEN 1 ELSE 0 END ASC,
                     r.id ASC
        `)
        return stmt.all(accountId) as DbAutoReplyRule[]
    }
    const stmt = db.prepare(`
        SELECT r.*, g.name AS item_group_name
        FROM autoreply_rules r
        LEFT JOIN item_groups g ON g.id = r.item_group_id
        WHERE r.enabled = 1
        ORDER BY r.priority DESC,
                 CASE WHEN r.item_group_id IS NULL THEN 1 ELSE 0 END ASC,
                 r.id ASC
    `)
    return stmt.all() as DbAutoReplyRule[]
}

// 获取单个规则
export function getAutoReplyRule(id: number): DbAutoReplyRule | undefined {
    const stmt = db.prepare(`
        SELECT r.*, g.name AS item_group_name
        FROM autoreply_rules r
        LEFT JOIN item_groups g ON g.id = r.item_group_id
        WHERE r.id = ?
    `)
    return stmt.get(id) as DbAutoReplyRule | undefined
}

// 创建规则
export function createAutoReplyRule(rule: CreateAutoReplyRuleParams): number {
    const stmt = db.prepare(`
        INSERT INTO autoreply_rules (
            name, enabled, priority, match_type, match_pattern,
            reply_content, account_id, item_group_id, exclude_match
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
        rule.name,
        rule.enabled !== false ? 1 : 0,
        rule.priority || 0,
        rule.matchType,
        rule.matchPattern,
        rule.replyContent,
        rule.accountId || null,
        rule.itemGroupId ?? null,
        rule.excludeMatch ? 1 : 0
    )
    return result.lastInsertRowid as number
}

// 更新规则
export function updateAutoReplyRule(id: number, rule: UpdateAutoReplyRuleParams): boolean {
    const existing = getAutoReplyRule(id)
    if (!existing) return false

    const stmt = db.prepare(`
        UPDATE autoreply_rules SET
            name = ?, enabled = ?, priority = ?, match_type = ?,
            match_pattern = ?, reply_content = ?, account_id = ?, item_group_id = ?, exclude_match = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `)
    stmt.run(
        rule.name ?? existing.name,
        rule.enabled !== undefined ? (rule.enabled ? 1 : 0) : existing.enabled,
        rule.priority ?? existing.priority,
        rule.matchType ?? existing.match_type,
        rule.matchPattern ?? existing.match_pattern,
        rule.replyContent ?? existing.reply_content,
        rule.accountId !== undefined ? rule.accountId : existing.account_id,
        rule.itemGroupId !== undefined ? rule.itemGroupId : existing.item_group_id,
        rule.excludeMatch !== undefined ? (rule.excludeMatch ? 1 : 0) : (existing.exclude_match || 0),
        id
    )
    return true
}

// 删除规则
export function deleteAutoReplyRule(id: number): boolean {
    const stmt = db.prepare('DELETE FROM autoreply_rules WHERE id = ?')
    const result = stmt.run(id)
    return result.changes > 0
}

// 切换规则启用状态
export function toggleAutoReplyRule(id: number): boolean {
    const stmt = db.prepare('UPDATE autoreply_rules SET enabled = 1 - enabled, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    const result = stmt.run(id)
    return result.changes > 0
}
