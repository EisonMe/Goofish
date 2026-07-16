/**
 * 流程执行引擎
 * 负责执行发货流程，支持自动回复节点等待用户确认
 */

import { createLogger } from '../core/logger.js'
import {
    getWorkflowById,
    getDefaultWorkflow,
    createWorkflowExecution,
    getWorkflowExecution,
    getWorkflowExecutionByOrderId,
    getWaitingExecutions,
    updateWorkflowExecution,
    getAutoSellRule,
    getOrderById,
    updateOrderStatus
} from '../db/index.js'
import { processAndSendAutoSell } from './autosell.service.js'
import { OrderStatus, ORDER_STATUS_TEXT } from '../types/order.types.js'
import { validateWorkflowDefinition } from '../utils/workflow-validation.js'
import type {
    Workflow,
    WorkflowDefinition,
    WorkflowNode,
    WorkflowExecution,
    WorkflowNodeType
} from '../types/workflow.types.js'
import type { GoofishClient } from '../websocket/client.js'

const logger = createLogger('Svc:Workflow')

interface ExecutionContext {
    orderId: string
    accountId: string
    itemId?: string
    ruleId: number
    client: GoofishClient
    buyerUserId?: string
    chatId?: string
}

function normalizeIdentifier(value: unknown): string | null {
    if (value === null || value === undefined) return null
    const text = String(value).trim()
    return text || null
}

function getExecutionReplyTarget(execution: WorkflowExecution): { chatId: string | null; buyerUserId: string | null } {
    const order = getOrderById(execution.orderId)

    return {
        chatId: normalizeIdentifier(execution.context?.chatId) || normalizeIdentifier(order?.chatId),
        buyerUserId: normalizeIdentifier(execution.context?.buyerUserId) || normalizeIdentifier(order?.buyerUserId)
    }
}

function matchesExecutionReplyTarget(
    execution: WorkflowExecution,
    chatId: string,
    buyerUserId: string
): boolean {
    const target = getExecutionReplyTarget(execution)

    if (!target.chatId && !target.buyerUserId) {
        logger.warn(`流程 ${execution.id} 缺少回复目标信息，跳过匹配以避免串单: order=${execution.orderId}`)
        return false
    }

    if (target.chatId && target.chatId !== chatId) {
        return false
    }

    if (target.buyerUserId && target.buyerUserId !== buyerUserId) {
        return false
    }

    return true
}

function parseOrderPrice(value: string | null | undefined): number | null {
    if (value === null || value === undefined) return null

    const normalized = String(value).trim().replace(/[￥¥,\s]/g, '')
    if (!normalized) return null

    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
}

function normalizeKeywords(value: unknown, fallback: string[] = []): string[] {
    const source = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : fallback

    const normalized = source
        .map(item => String(item ?? '').trim())
        .filter(Boolean)

    return normalized.length > 0 ? normalized : fallback
}

function getReplyMatchMode(value: unknown): 'exact' | 'contains' {
    return value === 'exact' ? 'exact' : 'contains'
}

function matchesReplyKeywords(
    message: string,
    keywords: string[],
    matchMode: 'exact' | 'contains'
): boolean {
    const normalizedMessage = message.trim().toLowerCase()
    if (!normalizedMessage || keywords.length === 0) return false

    if (matchMode === 'exact') {
        return keywords.some(keyword => normalizedMessage === keyword.toLowerCase())
    }

    return keywords.some(keyword => normalizedMessage.includes(keyword.toLowerCase()))
}

function buildOrderExpressionContext(context: ExecutionContext) {
    const order = getOrderById(context.orderId)
    const buyAmount = order?.buyAmount ?? 1

    return {
        id: order?.orderId || context.orderId,
        orderId: order?.orderId || context.orderId,
        goodsId: order?.itemId || context.itemId || null,
        itemId: order?.itemId || context.itemId || null,
        price: parseOrderPrice(order?.price),
        priceText: order?.price || null,
        unitPrice: parseOrderPrice(order?.price),
        unitPriceText: order?.price || null,
        totalAmount: parseOrderPrice(order?.totalAmount),
        totalAmountText: order?.totalAmount || null,
        buyerPaidAmount: parseOrderPrice(order?.buyerPaidAmount),
        buyerPaidAmountText: order?.buyerPaidAmount || null,
        discountAmount: parseOrderPrice(order?.discountAmount),
        discountAmountText: order?.discountAmount || null,
        refundAmount: parseOrderPrice(order?.refundAmount),
        refundAmountText: order?.refundAmount || null,
        buyAmount,
        quantity: buyAmount,
        itemTitle: order?.itemTitle || null,
        goodsName: order?.itemTitle || '',
        status: order?.status ?? null,
        statusText: order?.statusText || null,
        buyerUserId: order?.buyerUserId || context.buyerUserId || null,
        buyerNickname: order?.buyerNickname || null,
        buyerNick: order?.buyerNickname || '',
        buyerMessage: '',
        hasRefund: Boolean(order?.hasRefund),
        accountId: order?.accountId || context.accountId
    }
}

function evaluateConditionExpression(expression: string, orderContext: Record<string, unknown>): boolean {
    const evaluator = new Function(
        'order',
        `"use strict"; return Boolean(${expression});`
    ) as (order: Record<string, unknown>) => boolean

    return Boolean(evaluator(orderContext))
}

/**
 * 启动流程执行
 */
export async function startWorkflowExecution(
    workflowId: number | null,
    context: ExecutionContext
): Promise<{ success: boolean; error?: string }> {
    // 获取流程定义
    let workflow: Workflow | null
    if (workflowId) {
        workflow = getWorkflowById(workflowId)
    } else {
        workflow = getDefaultWorkflow()
    }

    if (!workflow) {
        // 没有流程定义，使用默认逻辑直接发货
        return executeDefaultFlow(context)
    }

    const validation = validateWorkflowDefinition(workflow.definition)
    if (!validation.valid) {
        const error = validation.errors[0] || '流程配置无效'
        logger.error(`流程 ${workflow.id} 配置无效: ${validation.errors.join(' | ')}`)
        return { success: false, error }
    }

    // 检查是否已有执行中的流程
    const existing = getWorkflowExecutionByOrderId(context.orderId)
    if (existing) {
        logger.info(`订单 ${context.orderId} 已有执行中的流程`)
        return { success: false, error: '流程已在执行中' }
    }

    // 找到触发节点
    const triggerNode = workflow.definition.nodes.find(n => n.type === 'trigger')
    if (!triggerNode) {
        logger.error(`流程 ${workflow.id} 没有触发节点`)
        return { success: false, error: '流程配置错误：缺少触发节点' }
    }

    // 创建执行记录
    const executionId = createWorkflowExecution({
        workflowId: workflow.id,
        orderId: context.orderId,
        accountId: context.accountId,
        ruleId: context.ruleId,
        currentNodeId: triggerNode.id,
        context: {
            itemId: context.itemId,
            buyerUserId: context.buyerUserId,
            chatId: context.chatId
        }
    })

    logger.info(`创建流程执行: ${executionId}, 订单: ${context.orderId}`)

    // 开始执行流程
    return executeFromNode(executionId, workflow.definition, triggerNode.id, context)
}

/**
 * 从指定节点开始执行流程（迭代实现，避免深嵌套栈溢出）
 */
async function executeFromNode(
    executionId: number,
    definition: WorkflowDefinition,
    nodeId: string,
    context: ExecutionContext
): Promise<{ success: boolean; error?: string }> {
    const MAX_STEPS = 100
    const MAX_DURATION_MS = 5 * 60 * 1000 // 5 分钟
    const startTime = Date.now()
    let currentNodeId = nodeId

    for (let step = 0; step < MAX_STEPS; step++) {
        if (Date.now() - startTime > MAX_DURATION_MS) {
            updateWorkflowExecution(executionId, { status: 'failed' })
            logger.warn(`流程执行超时 (${MAX_DURATION_MS / 1000}s): ${executionId}`)
            return { success: false, error: '流程执行超时' }
        }
        const node = definition.nodes.find(n => n.id === currentNodeId)
        if (!node) {
            updateWorkflowExecution(executionId, { status: 'failed' })
            return { success: false, error: `节点不存在: ${currentNodeId}` }
        }

        updateWorkflowExecution(executionId, {
            status: 'running',
            currentNodeId: currentNodeId
        })

        // 执行当前节点
        const result = await executeNode(executionId, node, context)

        if (!result.success) {
            updateWorkflowExecution(executionId, { status: 'failed' })
            return result
        }

        // 如果节点需要等待（如自动回复节点）
        if (result.waiting) {
            updateWorkflowExecution(executionId, {
                status: 'waiting',
                waitingForReply: true,
                expectedKeywords: result.expectedKeywords || null,
                context: {
                    itemId: context.itemId,
                    buyerUserId: context.buyerUserId,
                    chatId: context.chatId,
                    matchMode: result.matchMode || 'contains'
                }
            })
            return { success: true }
        }

        // 找到下一个节点
        const nextNodeId = findNextNode(definition, currentNodeId, result.output)
        if (!nextNodeId) {
            // 流程结束
            updateWorkflowExecution(executionId, { status: 'completed' })
            logger.info(`流程执行完成: ${executionId}`)
            return { success: true }
        }

        currentNodeId = nextNodeId
    }

    updateWorkflowExecution(executionId, { status: 'failed' })
    return { success: false, error: `流程执行超过最大步数 (${MAX_STEPS})` }
}

/**
 * 执行单个节点
 */
async function executeNode(
    executionId: number,
    node: WorkflowNode,
    context: ExecutionContext
): Promise<{
    success: boolean
    error?: string
    waiting?: boolean
    expectedKeywords?: string[]
    matchMode?: 'exact' | 'contains'
    output?: string
}> {
    logger.debug(`执行节点: ${node.id} (${node.type})`)

    switch (node.type) {
        case 'trigger':
            // 触发节点，直接通过
            return { success: true, output: 'output_1' }

        case 'delivery':
            // 发货节点 - 发送发货内容
            return executeDeliveryNode(node, context)

        case 'ship':
            // 标记发货节点 - 调用平台 API
            return executeShipNode(node, context)

        case 'autoreply':
            // 自动回复节点，需要等待用户确认
            return executeAutoReplyNode(node, context)

        case 'delay':
            // 延迟节点
            return executeDelayNode(node)

        case 'condition':
            // 条件节点
            return executeConditionNode(node, context)

        case 'notify':
            // 通知节点 - 发送消息给买家
            return executeNotifyNode(node, context)

        default:
            return { success: false, error: `未知节点类型: ${node.type}` }
    }
}

/**
 * 执行发货节点 - 发送发货内容给买家
 */
async function executeDeliveryNode(
    node: WorkflowNode,
    context: ExecutionContext
): Promise<{ success: boolean; error?: string; output?: string }> {
    const rule = getAutoSellRule(context.ruleId)
    if (!rule) {
        return { success: false, error: '发货规则不存在' }
    }

    if (!context.chatId || !context.buyerUserId) {
        logger.warn(`发货节点缺少 chatId 或 buyerUserId，终止执行: ${context.orderId}`)
        return { success: false, error: '订单缺少 chatId 或买家ID，请先刷新订单详情后重试' }
    }

    const result = await processAndSendAutoSell(
        {
            accountId: context.accountId,
            orderId: context.orderId,
            itemId: context.itemId,
            ruleId: rule.id,
            triggerOn: rule.triggerOn
        },
        content => context.client.sendMessage(context.chatId!, context.buyerUserId!, content)
    )

    if (!result.success) {
        return { success: false, error: result.error }
    }

    logger.info(`发货消息已发送: ${context.orderId}`)

    return { success: true, output: 'output_1' }
}

/**
 * 执行标记发货节点 - 调用平台 API 标记发货
 */
async function executeShipNode(
    node: WorkflowNode,
    context: ExecutionContext
): Promise<{ success: boolean; error?: string; output?: string }> {
    // 获取发货方式，默认虚拟发货
    const deliveryMode = node.config.deliveryMode || 'virtual'

    let shipResult: { success: boolean; error?: string }

    if (deliveryMode === 'freeshipping') {
        // 免拼发货需要 itemId 和 buyerId
        if (!context.itemId || !context.buyerUserId) {
            logger.warn(`免拼发货缺少参数: itemId=${context.itemId}, buyerUserId=${context.buyerUserId}`)
            // 降级为虚拟发货
            shipResult = await context.client.confirmShipment(context.orderId)
            logger.info(`订单降级为虚拟发货: ${context.orderId}`)
        } else {
            shipResult = await context.client.freeShipping(
                context.orderId,
                context.itemId,
                context.buyerUserId
            )
            logger.info(`订单免拼发货: ${context.orderId}`)
        }
    } else {
        // 虚拟发货（确认发货）
        shipResult = await context.client.confirmShipment(context.orderId)
        logger.info(`订单虚拟发货: ${context.orderId}`)
    }

    if (!shipResult.success) {
        return { success: false, error: shipResult.error || '标记发货失败' }
    }

    const localOrder = getOrderById(context.orderId)
    if (!localOrder || localOrder.status < OrderStatus.PENDING_RECEIPT) {
        updateOrderStatus(
            context.orderId,
            OrderStatus.PENDING_RECEIPT,
            ORDER_STATUS_TEXT[OrderStatus.PENDING_RECEIPT],
            'ship_time'
        )
    }

    return { success: true, output: 'output_1' }
}

/**
 * 执行自动回复节点（等待用户确认）
 */
async function executeAutoReplyNode(
    node: WorkflowNode,
    context: ExecutionContext
): Promise<{
    success: boolean
    error?: string
    waiting?: boolean
    expectedKeywords?: string[]
    matchMode?: 'exact' | 'contains'
}> {
    // 发送提示消息
    const promptMessage = node.config.promptMessage
    if (promptMessage) {
        if (!context.chatId || !context.buyerUserId) {
            logger.warn(`等待回复节点缺少 chatId 或 buyerUserId，无法发送提示消息: ${context.orderId}`)
        } else {
            await context.client.sendMessage(
                context.chatId,
                context.buyerUserId,
                promptMessage
            )
            logger.info(`已发送提示消息: ${context.orderId}`)
        }
    }

    // 获取关键词配置
    const fallbackKeywords = ['确认', '同意', '好的', 'ok']
    const keywords = normalizeKeywords(
        node.config.keywords || node.config.expectedKeywords,
        fallbackKeywords
    )
    const matchMode = getReplyMatchMode(node.config.matchMode)

    logger.info(`等待用户确认: ${context.orderId}, 关键词: ${keywords.join(',')}`)

    return {
        success: true,
        waiting: true,
        expectedKeywords: keywords,
        matchMode
    }
}

/**
 * 执行延迟节点
 */
async function executeDelayNode(
    node: WorkflowNode
): Promise<{ success: boolean; output?: string }> {
    let delayMs: number

    if (node.config.delayMode === 'random') {
        // 浮动时间模式
        const minMs = node.config.delayMinMs || 0
        const maxMs = node.config.delayMaxMs || 10000
        delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
        logger.debug(`延迟节点: 浮动模式, 范围 ${minMs}-${maxMs}ms, 实际 ${delayMs}ms`)
    } else {
        // 固定时间模式
        delayMs = node.config.delayMs || (node.config.delaySeconds || 0) * 1000
        logger.debug(`延迟节点: 固定模式, ${delayMs}ms`)
    }

    if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    return { success: true, output: 'output_1' }
}

/**
 * 执行条件节点
 */
async function executeConditionNode(
    node: WorkflowNode,
    context: ExecutionContext
): Promise<{ success: boolean; error?: string; output?: string }> {
    const expression = (node.config.expression || node.config.condition || '').trim()
    if (!expression) {
        logger.warn(`条件节点未配置表达式: ${node.id}`)
        return { success: true, output: 'output_1' }
    }

    try {
        const orderContext = buildOrderExpressionContext(context)
        const passed = evaluateConditionExpression(expression, orderContext)

        logger.info(`条件节点判断: ${context.orderId}, ${expression} => ${passed}`)
        return { success: true, output: passed ? 'output_1' : 'output_2' }
    } catch (e: any) {
        logger.error(`条件节点执行失败: ${node.id} - ${e.message}`)
        return { success: false, error: `条件表达式执行失败: ${e.message}` }
    }
}

/**
 * 执行通知节点 - 发送消息给买家
 */
async function executeNotifyNode(
    node: WorkflowNode,
    context: ExecutionContext
): Promise<{ success: boolean; error?: string; output?: string }> {
    const message = node.config.message
    if (!message) {
        logger.warn(`通知节点没有配置消息内容: ${node.id}`)
        return { success: true, output: 'output_1' }
    }

    if (!context.chatId || !context.buyerUserId) {
        logger.warn(`通知节点缺少 chatId 或 buyerUserId: ${context.orderId}`)
        return { success: true, output: 'output_1' }
    }

    const sendResult = await context.client.sendMessage(
        context.chatId,
        context.buyerUserId,
        message
    )

    if (!sendResult) {
        return { success: false, error: '发送通知消息失败' }
    }

    logger.info(`通知消息已发送: ${context.orderId}`)
    return { success: true, output: 'output_1' }
}

/**
 * 找到下一个节点
 */
function findNextNode(
    definition: WorkflowDefinition,
    currentNodeId: string,
    outputKey?: string
): string | null {
    const output = outputKey || 'output_1'
    const connection = definition.connections.find(
        c => c.fromNode === currentNodeId && c.fromOutput === output
    )
    return connection?.toNode || null
}

/**
 * 执行默认流程（无自定义流程时）
 */
async function executeDefaultFlow(
    context: ExecutionContext
): Promise<{ success: boolean; error?: string }> {
    // 直接调用自动发货
    const rule = getAutoSellRule(context.ruleId)
    if (!rule) {
        return { success: false, error: '发货规则不存在' }
    }

    if (!context.chatId || !context.buyerUserId) {
        logger.warn(`默认流程缺少 chatId 或 buyerUserId，终止执行: ${context.orderId}`)
        return { success: false, error: '订单缺少 chatId 或买家ID，请先刷新订单详情后重试' }
    }

    const result = await processAndSendAutoSell(
        {
            accountId: context.accountId,
            orderId: context.orderId,
            itemId: context.itemId,
            ruleId: rule.id,
            triggerOn: rule.triggerOn
        },
        content => context.client.sendMessage(context.chatId!, context.buyerUserId!, content)
    )

    if (!result.success) {
        return { success: false, error: result.error }
    }

    // 标记发货（仅待发货触发时）
    if (rule.triggerOn === 'paid') {
        const shipResult = await context.client.confirmShipment(context.orderId)
        if (!shipResult.success) {
            return { success: false, error: shipResult.error || '标记发货失败' }
        }

        const localOrder = getOrderById(context.orderId)
        if (!localOrder || localOrder.status < OrderStatus.PENDING_RECEIPT) {
            updateOrderStatus(
                context.orderId,
                OrderStatus.PENDING_RECEIPT,
                ORDER_STATUS_TEXT[OrderStatus.PENDING_RECEIPT],
                'ship_time'
            )
        }
    }

    return { success: true }
}

/**
 * 处理用户回复，继续执行等待中的流程
 */
export async function handleUserReply(
    accountId: string,
    chatId: string,
    buyerUserId: string,
    message: string,
    client: GoofishClient
): Promise<boolean> {
    // 获取该账号等待中的流程执行
    const waitingExecutions = getWaitingExecutions(accountId)

    // 记录匹配候选，帮助排查串单
    if (waitingExecutions.length > 1) {
        logger.warn(`[${accountId}] 存在 ${waitingExecutions.length} 个等待执行，buyerUserId=${buyerUserId} chatId=${chatId}`)
    }

    for (const execution of waitingExecutions) {
        if (!matchesExecutionReplyTarget(execution, chatId, buyerUserId)) {
            continue
        }

        const keywords = normalizeKeywords(execution.expectedKeywords || [])
        const matchMode = getReplyMatchMode(execution.context?.matchMode)
        const matched = matchesReplyKeywords(message, keywords, matchMode)

        if (matched) {
            logger.info(`用户回复匹配，继续执行流程: ${execution.id}, orderId=${execution.orderId}, updated_at=${execution.updatedAt}`)

            // 获取流程定义
            const workflow = getWorkflowById(execution.workflowId)
            if (!workflow) continue

            // 更新状态
            updateWorkflowExecution(execution.id, {
                waitingForReply: false,
                expectedKeywords: null
            })

            // 找到下一个节点并继续执行
            const nextNodeId = findNextNode(
                workflow.definition,
                execution.currentNodeId!,
                'output_1'
            )

            if (nextNodeId) {
                const context: ExecutionContext = {
                    orderId: execution.orderId,
                    accountId: execution.accountId,
                    ruleId: execution.ruleId,
                    client,
                    chatId,
                    buyerUserId,
                    itemId: execution.context?.itemId
                }

                await executeFromNode(
                    execution.id,
                    workflow.definition,
                    nextNodeId,
                    context
                )
            } else {
                updateWorkflowExecution(execution.id, { status: 'completed' })
            }

            return true
        }
    }

    return false
}
