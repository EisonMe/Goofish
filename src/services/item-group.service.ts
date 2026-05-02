import { db } from '../db/index.js'
import { createLogger } from '../core/logger.js'
import { getAllAccounts } from '../db/account.repository.js'
import { fetchAllGoodsForAccount } from './goods.service.js'

const logger = createLogger('Svc:ItemGroup')

// 获取所有分组
export function getGroups() {
    const groups = db.prepare(`
        SELECT g.id, g.name, g.description, g.created_at,
               (SELECT COUNT(*) FROM item_group_items WHERE group_id = g.id) as item_count
        FROM item_groups g
        ORDER BY g.created_at DESC
    `).all() as any[]
    return groups
}

// 获取分组详情（包含商品列表）
export function getGroupById(id: number) {
    const group = db.prepare(`
        SELECT id, name, description, created_at
        FROM item_groups WHERE id = ?
    `).get(id) as any
    
    if (!group) return null
    
    const items = db.prepare(`
        SELECT i.id, i.item_id, i.item_title, i.account_id, a.nickname AS account_nickname, i.created_at
        FROM item_group_items i
        LEFT JOIN accounts a ON a.id = i.account_id
        WHERE i.group_id = ?
        ORDER BY i.item_title
    `).all(id) as any[]
    
    return { ...group, items }
}

// 创建分组
export function createGroup(name: string, description?: string) {
    const result = db.prepare(`
        INSERT INTO item_groups (name, description)
        VALUES (?, ?)
    `).run(name, description || null)
    
    logger.info(`创建商品分组: ${name}`)
    return { id: result.lastInsertRowid, name, description }
}

// 更新分组
export function updateGroup(id: number, name: string, description?: string) {
    const existing = db.prepare('SELECT id FROM item_groups WHERE id = ?').get(id)
    if (!existing) throw new Error('分组不存在')
    
    db.prepare(`
        UPDATE item_groups SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(name, description || null, id)
    
    logger.info(`更新商品分组: ${id}`)
    return getGroupById(id)
}

// 删除分组
export function deleteGroup(id: number) {
    db.prepare('DELETE FROM item_group_items WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM item_groups WHERE id = ?').run(id)
    logger.info(`删除商品分组: ${id}`)
    return { success: true }
}

// 添加商品到分组
export function addItemsToGroup(groupId: number, items: { itemId: string; itemTitle: string; accountId: string }[]) {
    const existing = db.prepare('SELECT id FROM item_groups WHERE id = ?').get(groupId)
    if (!existing) throw new Error('分组不存在')
    
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO item_group_items (group_id, item_id, item_title, account_id)
        VALUES (?, ?, ?, ?)
    `)
    
    let added = 0
    for (const item of items) {
        const result = stmt.run(groupId, item.itemId, item.itemTitle, item.accountId)
        if (result.changes > 0) added++
    }
    
    logger.info(`添加 ${added} 个商品到分组 ${groupId}`)
    return { added, total: items.length }
}

// 从分组移除商品
export function removeItemFromGroup(groupId: number, itemId: string, accountId: string) {
    db.prepare(`
        DELETE FROM item_group_items 
        WHERE group_id = ? AND item_id = ? AND account_id = ?
    `).run(groupId, itemId, accountId)
    
    logger.info(`从分组 ${groupId} 移除商品 ${itemId}`)
    return { success: true }
}

// 获取分组内的商品ID列表（用于报表筛选）
export function getGroupItemIds(groupId: number): { itemId: string; accountId: string }[] {
    const items = db.prepare(`
        SELECT item_id as itemId, account_id as accountId
        FROM item_group_items WHERE group_id = ?
    `).all(groupId) as { itemId: string; accountId: string }[]
    return items
}

// 获取所有可用商品（从订单中提取，用于选择加入分组）
export async function getAvailableItems() {
    const accounts = getAllAccounts()
    const accountNicknameMap = new Map(accounts.map(account => [account.id, account.nickname || null]))
    const orderItems = db.prepare(`
        SELECT item_id, item_title, MAX(item_pic_url) as item_pic_url, account_id, 
               COUNT(*) as order_count,
               MAX(created_at) as last_order
        FROM orders 
        WHERE item_id IS NOT NULL AND item_id != ''
        GROUP BY item_id, account_id
        ORDER BY order_count DESC
    `).all() as any[]

    const orderItemMap = new Map<string, any>()
    for (const item of orderItems) {
        item.account_nickname = accountNicknameMap.get(item.account_id) || null
        orderItemMap.set(`${item.account_id}::${item.item_id}`, item)
    }

    const mergedItems = new Map<string, any>()

    for (const account of accounts) {
        if (!account.cookies) {
            continue
        }

        const result = await fetchAllGoodsForAccount(account.id, account.id)
        if (result.fetchFailed) {
            logger.warn(`账号 ${account.id} 商品拉取失败，商品分组可用商品将仅回退历史订单`) 
            continue
        }

        for (const goods of result.items) {
            if (!goods.id) continue

            const key = `${account.id}::${goods.id}`
            const orderInfo = orderItemMap.get(key)

            mergedItems.set(key, {
                item_id: goods.id,
                item_title: goods.title || orderInfo?.item_title || '',
                item_pic_url: goods.picUrl || orderInfo?.item_pic_url || null,
                account_id: account.id,
                order_count: orderInfo?.order_count || 0,
                last_order: orderInfo?.last_order || null,
                account_nickname: account.nickname || null
            })
        }
    }

    for (const item of orderItems) {
        const key = `${item.account_id}::${item.item_id}`
        if (!mergedItems.has(key)) {
            mergedItems.set(key, item)
        }
    }

    return Array.from(mergedItems.values()).sort((a, b) => {
        const orderCountDiff = Number(b.order_count || 0) - Number(a.order_count || 0)
        if (orderCountDiff !== 0) return orderCountDiff

        const lastOrderA = a.last_order ? new Date(a.last_order).getTime() : 0
        const lastOrderB = b.last_order ? new Date(b.last_order).getTime() : 0
        if (lastOrderB !== lastOrderA) return lastOrderB - lastOrderA

        return String(a.item_title || '').localeCompare(String(b.item_title || ''), 'zh-Hans-CN')
    })
}

export function matchItemGroupForItem(accountId: string, itemId?: string | null): number | null {
    const normalizedItemId = String(itemId || '').trim()
    if (!accountId || !normalizedItemId) return null

    const row = db.prepare(`
        SELECT group_id
        FROM item_group_items
        WHERE account_id = ? AND item_id = ?
        ORDER BY id ASC
        LIMIT 1
    `).get(accountId, normalizedItemId) as { group_id: number } | undefined

    return row?.group_id ?? null
}
