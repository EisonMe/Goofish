/**
 * 自动回复服务
 */

import { createLogger } from '../core/logger.js'
import { getEnabledAutoReplyRules, getLatestOrderByChatId } from '../db/index.js'
import { generateAIReply, type AIContext } from './ai.service.js'
import { matchItemGroupForItem } from './item-group.service.js'
import type { ChatMessage, DbAutoReplyRule, AutoReplyResult } from '../types/index.js'

const logger = createLogger('Svc:AutoReply')

/**
 * 检查消息是否匹配自动回复规则
 */
export async function checkAutoReply(
    accountId: string,
    msg: ChatMessage,
    context?: { userName?: string; itemTitle?: string }
): Promise<AutoReplyResult> {
    try {
        const rules = getEnabledAutoReplyRules(accountId)
        const itemContext = resolveItemContext(accountId, msg, context)

        // 分离普通规则和排除匹配规则
        const normalRules = rules.filter(r => !r.exclude_match && matchRuleItemGroup(r, itemContext.itemGroupId))
        const excludeRules = rules.filter(r => r.exclude_match && matchRuleItemGroup(r, itemContext.itemGroupId))

        // 构建 AI 上下文，包含买家信息用于工具调用
        const aiContext: AIContext = {
            userName: context?.userName || msg.senderName,
            itemTitle: itemContext.itemTitle,
            accountId,
            buyerUserId: msg.senderId,
            chatId: msg.chatId
        }

        // 先检查普通规则
        for (const rule of normalRules) {
            try {
                // AI 规则特殊处理
                if (rule.match_type === 'ai') {
                    if (matchAITrigger(rule, msg.content)) {
                        const rulePrompt = rule.reply_content || undefined
                        const aiReply = await generateAIReply(msg.content, aiContext, rulePrompt)
                        if (aiReply) {
                            logger.info(`[${accountId}] AI 回复: ${msg.content} -> ${aiReply}`)
                            return {
                                matched: true,
                                ruleName: rule.name,
                                replyContent: aiReply,
                                isAI: true
                            }
                        }
                    }
                    continue
                }

                // 普通规则匹配
                if (matchRule(rule, msg.content)) {
                    logger.info(`[${accountId}] 消息匹配规则 "${rule.name}": ${msg.content} -> ${rule.reply_content}`)
                    return {
                        matched: true,
                        ruleName: rule.name,
                        replyContent: rule.reply_content
                    }
                }
            } catch (error: any) {
                logger.error(`[${accountId}] 处理规则 "${rule.name}" 时发生异常: ${error.message}`)
                // 继续处理下一个规则
                continue
            }
        }

        // 普通规则都没匹配，选择最高优先级的一条兜底规则
        const fallbackRule = excludeRules[0]
        if (fallbackRule) {
            try {
                if (fallbackRule.match_type === 'ai') {
                    const rulePrompt = fallbackRule.reply_content || undefined
                    const aiReply = await generateAIReply(msg.content, aiContext, rulePrompt)
                    if (aiReply) {
                        logger.info(`[${accountId}] AI 排除匹配回复: ${msg.content} -> ${aiReply}`)
                        return {
                            matched: true,
                            ruleName: fallbackRule.name,
                            replyContent: aiReply,
                            isAI: true
                        }
                    }
                } else if (fallbackRule.reply_content) {
                    logger.info(`[${accountId}] 排除匹配规则 "${fallbackRule.name}": ${msg.content} -> ${fallbackRule.reply_content}`)
                    return {
                        matched: true,
                        ruleName: fallbackRule.name,
                        replyContent: fallbackRule.reply_content
                    }
                }
            } catch (error: any) {
                logger.error(`[${accountId}] 处理排除规则 "${fallbackRule.name}" 时发生异常: ${error.message}`)
            }
        }

        return { matched: false }
    } catch (error: any) {
        logger.error(`[${accountId}] 检查自动回复时发生异常: ${error.message}`)
        return { matched: false }
    }
}

function resolveItemContext(
    accountId: string,
    msg: ChatMessage,
    context?: { userName?: string; itemTitle?: string }
): { itemId?: string; itemTitle?: string; itemGroupId: number | null } {
    const order = msg.chatId ? getLatestOrderByChatId(accountId, msg.chatId) : null
    const itemId = msg.itemId || order?.itemId || undefined
    const itemTitle = context?.itemTitle || msg.itemTitle || order?.itemTitle || undefined
    const itemGroupId = matchItemGroupForItem(accountId, itemId)

    return {
        itemId,
        itemTitle,
        itemGroupId
    }
}

function matchRuleItemGroup(rule: DbAutoReplyRule, itemGroupId: number | null): boolean {
    if (!rule.item_group_id) {
        return true
    }

    return itemGroupId === rule.item_group_id
}

/**
 * 检查是否触发 AI 回复
 */
function matchAITrigger(rule: DbAutoReplyRule, content: string): boolean {
    const pattern = rule.match_pattern.trim()

    // 空模式表示匹配所有消息
    if (!pattern || pattern === '*') {
        return true
    }

    // 支持关键词列表（逗号分隔）
    const keywords = pattern.split(',').map(k => k.trim()).filter(Boolean)
    if (keywords.length === 0) {
        return true
    }

    const text = content.trim().toLowerCase()
    return keywords.some(kw => text.includes(kw.toLowerCase()))
}

/**
 * 检查内容是否匹配规则
 */
function matchRule(rule: DbAutoReplyRule, content: string): boolean {
    const pattern = rule.match_pattern
    const text = content.trim()

    switch (rule.match_type) {
        case 'exact':
            return text === pattern
        case 'contains':
            return text.includes(pattern)
        case 'regex':
            try {
                const regex = new RegExp(pattern, 'i')
                return regex.test(text)
            } catch (e) {
                logger.warn(`规则 "${rule.name}" 的正则表达式无效: ${pattern}`)
                return false
            }
        default:
            return false
    }
}

/**
 * 获取匹配类型的显示名称
 */
export function getMatchTypeName(type: string): string {
    switch (type) {
        case 'exact': return '精确匹配'
        case 'contains': return '包含关键词'
        case 'regex': return '正则表达式'
        case 'ai': return 'AI 回复'
        default: return type
    }
}
