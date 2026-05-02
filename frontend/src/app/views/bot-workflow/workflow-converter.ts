import type { WorkflowConnection, WorkflowDefinition, WorkflowNode } from '../../core/types';
import { NODE_TYPES, type MindMapNode } from './node-configs';

const DEFAULT_INPUT = 'input_1';
const DEFAULT_OUTPUT = 'output_1';
const SECONDARY_OUTPUT = 'output_2';
export const MAX_BRANCH_OUTPUTS = 2;
const BRANCHING_NODE_TYPES = new Set(['condition', 'autoreply']);
const BRANCH_OUTPUTS = [DEFAULT_OUTPUT, SECONDARY_OUTPUT] as const;

function cloneConfig(config: Record<string, any> | undefined): Record<string, any> {
    if (!config) return {};
    return JSON.parse(JSON.stringify(config));
}

function getTypeColors(type: string) {
    const typeConfig = NODE_TYPES[type as keyof typeof NODE_TYPES];
    return {
        fillColor: typeConfig?.color,
        borderColor: typeConfig?.color,
        fontColor: '#ffffff'
    };
}

function createMindMapNode(node: WorkflowNode, edgeFromOutput?: string): MindMapNode {
    return {
        data: {
            text: node.name,
            uid: node.id,
            nodeType: node.type,
            config: cloneConfig(node.config),
            edgeFromOutput,
            ...getTypeColors(node.type)
        },
        children: []
    };
}

function getOutputOrder(output: string | undefined): number {
    if (!output || output === DEFAULT_OUTPUT) return 0;
    if (output === SECONDARY_OUTPUT) return 1;
    return 2;
}

function getRootNode(definition: WorkflowDefinition): WorkflowNode | undefined {
    const incoming = new Set(definition.connections.map(connection => connection.toNode));

    return definition.nodes.find(node => node.type === 'trigger')
        ?? definition.nodes.find(node => !incoming.has(node.id))
        ?? definition.nodes[0];
}

function buildOutgoingMap(connections: WorkflowConnection[]): Map<string, WorkflowConnection[]> {
    const outgoingMap = new Map<string, WorkflowConnection[]>();

    connections.forEach((connection) => {
        const existing = outgoingMap.get(connection.fromNode) ?? [];
        existing.push(connection);
        outgoingMap.set(connection.fromNode, existing);
    });

    outgoingMap.forEach(list => {
        list.sort((left, right) => getOutputOrder(left.fromOutput) - getOutputOrder(right.fromOutput));
    });

    return outgoingMap;
}

function buildMindMapTree(
    nodeId: string,
    nodeMap: Map<string, WorkflowNode>,
    outgoingMap: Map<string, WorkflowConnection[]>,
    edgeFromOutput?: string,
    path = new Set<string>()
): MindMapNode | null {
    const workflowNode = nodeMap.get(nodeId);
    if (!workflowNode) return null;

    const mindMapNode = createMindMapNode(workflowNode, edgeFromOutput);
    if (path.has(nodeId)) {
        return mindMapNode;
    }

    const nextPath = new Set(path);
    nextPath.add(nodeId);

    mindMapNode.children = (outgoingMap.get(nodeId) ?? [])
        .map(connection => buildMindMapTree(connection.toNode, nodeMap, outgoingMap, connection.fromOutput, nextPath))
        .filter((child): child is MindMapNode => Boolean(child));

    return mindMapNode;
}

function inferEdgeFromOutput(parentType: string | undefined, child: MindMapNode, siblingIndex: number): string {
    const explicitOutput = child.data.edgeFromOutput?.trim();
    if (explicitOutput) {
        return explicitOutput;
    }

    const text = child.data.text?.trim().toUpperCase();
    if (text?.startsWith('ELSE')) {
        return SECONDARY_OUTPUT;
    }

    if (BRANCHING_NODE_TYPES.has(parentType ?? '')) {
        if (siblingIndex === 1) {
            return SECONDARY_OUTPUT;
        }
        if (siblingIndex > 1) {
            throw new Error('分支节点最多只支持 2 个输出分支');
        }
    }

    return DEFAULT_OUTPUT;
}

function inferBranchOutputs(nodeName: string, children: MindMapNode[]): string[] {
    if (children.length > MAX_BRANCH_OUTPUTS) {
        throw new Error(`分支节点“${nodeName || '未命名节点'}”最多只支持 ${MAX_BRANCH_OUTPUTS} 个分支`);
    }

    const outputs = new Array<string>(children.length);
    const usedOutputs = new Set<string>();

    children.forEach((child, index) => {
        const explicitOutput = child.data.edgeFromOutput?.trim();
        if (!explicitOutput) {
            return;
        }

        if (!BRANCH_OUTPUTS.includes(explicitOutput as typeof BRANCH_OUTPUTS[number])) {
            throw new Error(`分支节点“${nodeName || '未命名节点'}”存在无效出口 ${explicitOutput}`);
        }

        if (usedOutputs.has(explicitOutput)) {
            throw new Error(`分支节点“${nodeName || '未命名节点'}”存在重复出口 ${explicitOutput}`);
        }

        outputs[index] = explicitOutput;
        usedOutputs.add(explicitOutput);
    });

    children.forEach((child, index) => {
        if (outputs[index]) {
            return;
        }

        const text = child.data.text?.trim().toUpperCase();
        const preferredOutput = text?.startsWith('ELSE') ? SECONDARY_OUTPUT : DEFAULT_OUTPUT;
        const inferredOutput = !usedOutputs.has(preferredOutput)
            ? preferredOutput
            : BRANCH_OUTPUTS.find(output => !usedOutputs.has(output));

        if (!inferredOutput) {
            throw new Error(`分支节点“${nodeName || '未命名节点'}”最多只支持 ${MAX_BRANCH_OUTPUTS} 个分支`);
        }

        outputs[index] = inferredOutput;
        usedOutputs.add(inferredOutput);
    });

    return outputs;
}

function inferChildOutputs(parent: MindMapNode): string[] {
    const children = parent.children || [];
    if (!BRANCHING_NODE_TYPES.has(parent.data.nodeType || '')) {
        return children.map((child, index) => inferEdgeFromOutput(parent.data.nodeType, child, index));
    }

    return inferBranchOutputs(parent.data.text || '', children);
}

export function findBranchOverflowNode(data: MindMapNode | null): {
    nodeName: string;
    childCount: number;
} | null {
    if (!data) return null;

    const nodeType = data.data.nodeType || 'delivery';
    const children = data.children || [];
    if (BRANCHING_NODE_TYPES.has(nodeType) && children.length > MAX_BRANCH_OUTPUTS) {
        return {
            nodeName: data.data.text || '未命名节点',
            childCount: children.length
        };
    }

    for (const child of children) {
        const overflow = findBranchOverflowNode(child);
        if (overflow) {
            return overflow;
        }
    }

    return null;
}

function ensureUniqueNodeId(candidate: string | undefined, usedIds: Set<string>, indexRef: { current: number }): string {
    const baseId = (candidate && candidate.trim()) || 'node';
    let nextId = baseId;

    while (usedIds.has(nextId)) {
        indexRef.current += 1;
        nextId = `${baseId}_${indexRef.current}`;
    }

    usedIds.add(nextId);
    return nextId;
}

// default empty mind-map root
export function getDefaultMindMapData(): MindMapNode {
    return {
        data: {
            text: '\u8ba2\u5355\u89e6\u53d1',
            uid: 'trigger',
            nodeType: 'trigger',
            ...getTypeColors('trigger')
        },
        children: []
    };
}

// default workflow template: trigger -> delivery -> ship
export function getDefaultWorkflowTemplate(): MindMapNode {
    return {
        data: {
            text: '\u8ba2\u5355\u89e6\u53d1',
            uid: 'trigger',
            nodeType: 'trigger',
            ...getTypeColors('trigger')
        },
        children: [
            {
                data: {
                    text: '\u53d1\u8d27',
                    uid: 'delivery_1',
                    nodeType: 'delivery',
                    edgeFromOutput: DEFAULT_OUTPUT,
                    ...getTypeColors('delivery')
                },
                children: [
                    {
                        data: {
                            text: '\u6807\u8bb0\u53d1\u8d27',
                            uid: 'ship_1',
                            nodeType: 'ship',
                            edgeFromOutput: DEFAULT_OUTPUT,
                            ...getTypeColors('ship')
                        }
                    }
                ]
            }
        ]
    };
}

// WorkflowDefinition -> MindMapNode
export function definitionToMindMap(definition: WorkflowDefinition): MindMapNode {
    if (!definition?.nodes?.length) {
        return getDefaultMindMapData();
    }

    const nodeMap = new Map(definition.nodes.map(node => [node.id, node]));
    const rootNode = getRootNode(definition);
    if (!rootNode) {
        return getDefaultMindMapData();
    }

    const mindMap = buildMindMapTree(rootNode.id, nodeMap, buildOutgoingMap(definition.connections));
    return mindMap ?? getDefaultMindMapData();
}

// MindMapNode -> WorkflowDefinition
export function mindMapToDefinition(data: MindMapNode | null): WorkflowDefinition {
    if (!data) {
        return { nodes: [], connections: [] };
    }

    const nodes: WorkflowDefinition['nodes'] = [];
    const connections: WorkflowDefinition['connections'] = [];
    const usedIds = new Set<string>();
    const indexRef = { current: 0 };

    const traverse = (
        node: MindMapNode,
        parentId?: string,
        parentType?: string,
        siblingIndex = 0,
        resolvedOutput?: string
    ) => {
        const id = ensureUniqueNodeId(node.data.uid, usedIds, indexRef);
        const nodeType = (node.data.nodeType || 'delivery') as WorkflowNode['type'];

        nodes.push({
            id,
            type: nodeType,
            name: node.data.text,
            config: cloneConfig(node.data.config),
            posX: 0,
            posY: 0
        });

        if (parentId) {
            connections.push({
                fromNode: parentId,
                fromOutput: resolvedOutput ?? inferEdgeFromOutput(parentType, node, siblingIndex),
                toNode: id,
                toInput: DEFAULT_INPUT
            });
        }

        const childOutputs = inferChildOutputs(node);
        node.children?.forEach((child, index) => {
            traverse(child, id, nodeType, index, childOutputs[index]);
        });
    };

    traverse(data);
    return { nodes, connections };
}
