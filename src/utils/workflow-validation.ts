import type { WorkflowNodeType } from '../types/workflow.types.js'

const MAX_BRANCH_OUTPUTS = 2
const BRANCHING_NODE_TYPES = new Set<WorkflowNodeType>(['condition', 'autoreply'])
const ALLOWED_BRANCH_OUTPUTS = new Set(['output_1', 'output_2'])
const VALID_NODE_TYPES = new Set<WorkflowNodeType>([
    'trigger',
    'autoreply',
    'delivery',
    'ship',
    'delay',
    'condition',
    'notify'
])

export interface WorkflowValidationResult {
    valid: boolean
    errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateWorkflowDefinition(definition: unknown): WorkflowValidationResult {
    const errors: string[] = []
    const nodeIds = new Set<string>()
    const nodeTypeById = new Map<string, WorkflowNodeType>()
    const outgoingCount = new Map<string, number>()
    const outgoingKeys = new Set<string>()
    let triggerCount = 0

    if (!isRecord(definition)) {
        return { valid: false, errors: ['流程配置必须是对象'] }
    }

    const nodes = definition.nodes
    const connections = definition.connections

    if (!Array.isArray(nodes) || !Array.isArray(connections)) {
        if (!Array.isArray(nodes)) {
            errors.push('流程 nodes 必须是数组')
        }
        if (!Array.isArray(connections)) {
            errors.push('流程 connections 必须是数组')
        }
        return { valid: false, errors }
    }

    if (nodes.length === 0) {
        errors.push('流程至少需要一个节点')
    }

    for (const [index, node] of nodes.entries()) {
        if (!isRecord(node)) {
            errors.push(`第 ${index + 1} 个节点格式无效`)
            continue
        }

        const nodeId = String(node.id || '').trim()
        if (!nodeId) {
            errors.push('流程存在空节点 ID')
            continue
        }

        if (nodeIds.has(nodeId)) {
            errors.push(`节点 ${nodeId} 重复`)
            continue
        }

        nodeIds.add(nodeId)
        const nodeType = String(node.type || '') as WorkflowNodeType
        if (!VALID_NODE_TYPES.has(nodeType)) {
            errors.push(`节点 ${nodeId} 类型无效`)
        } else {
            nodeTypeById.set(nodeId, nodeType)
            if (nodeType === 'trigger') triggerCount++
        }

        if (!isRecord(node.config)) {
            errors.push(`节点 ${nodeId} 的 config 必须是对象`)
        }
    }

    if (triggerCount !== 1) {
        errors.push('流程必须且只能包含一个触发节点')
    }

    for (const [index, connection] of connections.entries()) {
        if (!isRecord(connection)) {
            errors.push(`第 ${index + 1} 条连接格式无效`)
            continue
        }

        const fromNode = String(connection.fromNode || '').trim()
        const toNode = String(connection.toNode || '').trim()
        const fromOutput = String(connection.fromOutput || '').trim()
        const toInput = String(connection.toInput || '').trim()

        if (!fromNode || !toNode || !fromOutput || !toInput) {
            errors.push('流程存在不完整的连接配置')
            continue
        }

        if (!nodeIds.has(fromNode)) {
            errors.push(`连接起点节点不存在: ${fromNode}`)
        }

        if (!nodeIds.has(toNode)) {
            errors.push(`连接终点节点不存在: ${toNode}`)
        }

        const outgoingKey = `${fromNode}::${fromOutput}`
        if (outgoingKeys.has(outgoingKey)) {
            errors.push(`节点 ${fromNode} 的出口 ${fromOutput} 被重复使用`)
        } else {
            outgoingKeys.add(outgoingKey)
        }

        outgoingCount.set(fromNode, (outgoingCount.get(fromNode) || 0) + 1)

        const nodeType = nodeTypeById.get(fromNode)
        if (nodeType && BRANCHING_NODE_TYPES.has(nodeType) && !ALLOWED_BRANCH_OUTPUTS.has(fromOutput)) {
            errors.push(`分支节点 ${fromNode} 存在无效出口 ${fromOutput}`)
        }
    }

    for (const [nodeId, count] of outgoingCount.entries()) {
        const nodeType = nodeTypeById.get(nodeId)
        if (nodeType && BRANCHING_NODE_TYPES.has(nodeType) && count > MAX_BRANCH_OUTPUTS) {
            errors.push(`分支节点 ${nodeId} 最多只支持 ${MAX_BRANCH_OUTPUTS} 个出口`)
        }
    }

    return {
        valid: errors.length === 0,
        errors
    }
}
