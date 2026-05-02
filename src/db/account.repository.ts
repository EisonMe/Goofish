/**
 * 账号数据仓库
 */

import { db } from './connection.js'
import { createLogger } from '../core/logger.js'
import { nowLocalString } from '../utils/date.js'
import { emitAccountsUpdated } from '../core/event-emitter.js'
import type {
    Account,
    AccountStatus,
    UpsertAccountParams,
    UpdateAccountStatusParams
} from '../types/index.js'

const logger = createLogger('Db:Account')

// 获取所有启用的账号
export function getEnabledAccounts(): Account[] {
    const stmt = db.prepare(`
        SELECT id, cookies, user_id as userId, nickname, avatar, enabled, remark, 
               created_at as createdAt, updated_at as updatedAt
        FROM accounts WHERE enabled = 1
    `)
    return stmt.all() as Account[]
}

// 批量获取账号（按 ID 列表）
export function getAccountsByIds(ids: string[]): Map<string, Account> {
    const result = new Map<string, Account>()
    if (ids.length === 0) return result
    const stmt = db.prepare(`
        SELECT id, cookies, user_id as userId, nickname, avatar, enabled, remark,
               created_at as createdAt, updated_at as updatedAt
        FROM accounts WHERE id = ?
    `)
    for (const id of ids) {
        const account = stmt.get(id) as Account | null
        if (account) result.set(id, account)
    }
    return result
}

// 获取所有账号
export function getAllAccounts(): Account[] {
    const stmt = db.prepare(`
        SELECT id, cookies, user_id as userId, nickname, avatar, enabled, remark,
               created_at as createdAt, updated_at as updatedAt
        FROM accounts
    `)
    return stmt.all() as Account[]
}

// 获取单个账号
export function getAccount(id: string): Account | null {
    const stmt = db.prepare(`
        SELECT id, cookies, user_id as userId, nickname, avatar, enabled, remark,
               created_at as createdAt, updated_at as updatedAt
        FROM accounts WHERE id = ?
    `)
    return stmt.get(id) as Account | null
}

// 添加或更新账号
export function upsertAccount(account: UpsertAccountParams): boolean {
    try {
        const now = nowLocalString()
        const stmt = db.prepare(`
            INSERT INTO accounts (id, cookies, user_id, nickname, avatar, enabled, remark, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                cookies = excluded.cookies,
                user_id = COALESCE(excluded.user_id, user_id),
                nickname = COALESCE(excluded.nickname, nickname),
                avatar = COALESCE(excluded.avatar, avatar),
                enabled = COALESCE(excluded.enabled, enabled),
                remark = COALESCE(excluded.remark, remark),
                updated_at = excluded.updated_at
        `)
        stmt.run(
            account.id,
            account.cookies,
            account.userId || null,
            account.nickname || null,
            account.avatar || null,
            account.enabled !== false ? 1 : 0,
            account.remark || '',
            now
        )
        logger.info(`账号已保存: ${account.id}`)
        emitAccountsUpdated()
        return true
    } catch (e) {
        logger.error(`保存账号失败: ${e}`)
        return false
    }
}

// 更新账号用户信息
export function updateAccountUserInfo(id: string, nickname: string, avatar: string): boolean {
    try {
        const now = nowLocalString()
        const stmt = db.prepare(`
            UPDATE accounts SET nickname = ?, avatar = ?, updated_at = ? WHERE id = ?
        `)
        stmt.run(nickname, avatar, now, id)
        logger.info(`账号用户信息已更新: ${id} -> ${nickname}`)
        emitAccountsUpdated()
        return true
    } catch (e) {
        logger.error(`更新账号用户信息失败: ${e}`)
        return false
    }
}

// 更新账号 cookies
export function updateAccountCookies(id: string, cookies: string): boolean {
    try {
        const now = nowLocalString()
        const stmt = db.prepare(`
            UPDATE accounts SET cookies = ?, updated_at = ? WHERE id = ?
        `)
        stmt.run(cookies, now, id)
        logger.info(`账号 cookies 已更新: ${id}`)
        emitAccountsUpdated()
        return true
    } catch (e) {
        logger.error(`更新账号 cookies 失败: ${e}`)
        return false
    }
}

// 更新账号启用状态
export function updateAccountEnabled(id: string, enabled: boolean): boolean {
    try {
        const now = nowLocalString()
        const stmt = db.prepare(`
            UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?
        `)
        stmt.run(enabled ? 1 : 0, now, id)
        emitAccountsUpdated()
        return true
    } catch (e) {
        logger.error(`更新账号状态失败: ${e}`)
        return false
    }
}

// 删除账号
export function deleteAccount(id: string): boolean {
    try {
        const stmt = db.prepare('DELETE FROM accounts WHERE id = ?')
        stmt.run(id)
        logger.info(`账号已删除: ${id}`)
        emitAccountsUpdated()
        return true
    } catch (e) {
        logger.error(`删除账号失败: ${e}`)
        return false
    }
}

// 更新账号连接状态（只在连接状态变化时触发事件）
export function updateAccountStatus(status: UpdateAccountStatusParams): boolean {
    try {
        const now = nowLocalString()
        const hasErrorMessage = Object.prototype.hasOwnProperty.call(status, 'errorMessage')

        // 检查连接状态或错误信息是否变化
        const shouldEmit = status.connected !== undefined || hasErrorMessage
        let statusChanged = false

        if (shouldEmit) {
            const current = getAccountStatus(status.accountId)
            statusChanged = !current ||
                (status.connected !== undefined && current.connected !== status.connected) ||
                (hasErrorMessage && current.errorMessage !== status.errorMessage)
        }

        const stmt = db.prepare(`
            INSERT INTO account_status (account_id, connected, last_heartbeat, last_token_refresh, last_sync_timestamp, error_message, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
                connected = COALESCE(excluded.connected, connected),
                last_heartbeat = COALESCE(excluded.last_heartbeat, last_heartbeat),
                last_token_refresh = COALESCE(excluded.last_token_refresh, last_token_refresh),
                last_sync_timestamp = COALESCE(excluded.last_sync_timestamp, last_sync_timestamp),
                error_message = CASE WHEN ? THEN excluded.error_message ELSE error_message END,
                updated_at = excluded.updated_at
        `)
        stmt.run(
            status.accountId,
            status.connected !== undefined ? (status.connected ? 1 : 0) : null,
            status.lastHeartbeat || null,
            status.lastTokenRefresh || null,
            status.lastSyncTimestamp ?? null,
            status.errorMessage ?? null,
            now,
            hasErrorMessage ? 1 : 0
        )

        // 只在连接状态变化时触发事件
        if (statusChanged) {
            emitAccountsUpdated()
        }
        return true
    } catch (e) {
        logger.error(`更新账号状态失败: ${e}`)
        return false
    }
}

// 获取账号状态
export function getAccountStatus(accountId: string): AccountStatus | null {
    const stmt = db.prepare(`
        SELECT account_id as accountId, connected, last_heartbeat as lastHeartbeat,
               last_token_refresh as lastTokenRefresh, last_sync_timestamp as lastSyncTimestamp,
               error_message as errorMessage
        FROM account_status WHERE account_id = ?
    `)
    const result = stmt.get(accountId) as any
    if (result) {
        result.connected = !!result.connected
    }
    return result
}
