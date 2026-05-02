import type { WorkflowDefinition, WorkflowNodeType } from '../types/workflow.types.js'

const MAX_BRANCH_OUTPUTS = 2
const BRANCHING_NODE_TYPES = new Set<WorkflowNodeType>(['condition', 'autoreply'])
const ALLOWED_BRANCH_OUTPUTS = new Set(['output_1', 'output_2'])

export interface WorkflowValidationResult {
    valid: boolean
    errors: string[]
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowValidationResult {
    const errors: string[] = []
    const nodeIds = new Set<string>()
    const nodeTypeById = new Map<string, WorkflowNodeType>()
    const outgoingCount = new Map<string, number>()
    const outgoingKeys = new Set<string>()

    for (const node of definition.nodes) {
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
        nodeTypeById.set(nodeId, node.type)
    }

    for (const connection of definition.connections) {
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
