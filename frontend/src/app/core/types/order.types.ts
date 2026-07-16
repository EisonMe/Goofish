/**
 * 订单相关类型定义
 */

export enum OrderStatus {
    PENDING_PAYMENT = 1,
    PENDING_SHIPMENT = 2,
    PENDING_RECEIPT = 3,
    COMPLETED = 4,
    CLOSED = 6,
    REFUND_REQUEST = 8,
    CLOSED_WITH_REFUND = 12,
}

export const ORDER_STATUS_TEXT: Record<number, string> = {
    0: '获取中',
    [OrderStatus.PENDING_PAYMENT]: '待付款',
    [OrderStatus.PENDING_SHIPMENT]: '待发货',
    [OrderStatus.PENDING_RECEIPT]: '待收货',
    [OrderStatus.COMPLETED]: '交易成功',
    [OrderStatus.CLOSED]: '已关闭',
    [OrderStatus.REFUND_REQUEST]: '退款中',
    [OrderStatus.CLOSED_WITH_REFUND]: '已退款',
}

export const ORDER_STATUS_CLASS: Record<number, string> = {
    0: 'badge-neutral',
    [OrderStatus.PENDING_PAYMENT]: 'badge-warning',
    [OrderStatus.PENDING_SHIPMENT]: 'badge-info',
    [OrderStatus.PENDING_RECEIPT]: 'badge-primary',
    [OrderStatus.COMPLETED]: 'badge-success',
    [OrderStatus.CLOSED]: 'badge-ghost',
    [OrderStatus.REFUND_REQUEST]: 'badge-error',
    [OrderStatus.CLOSED_WITH_REFUND]: 'badge-error',
}

export interface Order {
    id: number
    orderId: string
    accountId: string
    itemId: string | null
    itemTitle: string | null
    itemPicUrl: string | null
    price: string | null
    buyAmount?: number | null
    totalAmount?: string | null
    buyerPaidAmount?: string | null
    discountAmount?: string | null
    refundAmount?: string | null
    refundStatus?: string | null
    refundTime?: string | null
    hasRefund?: boolean
    buyerUserId: string | null
    buyerNickname: string | null
    chatId?: string | null
    status: number
    statusText: string
    orderTime: string
    payTime: string | null
    shipTime: string | null
    completeTime: string | null
    deliveredQuantity?: number
    remainingQuantity?: number
    createdAt: string
    updatedAt: string
}

export interface OrderListResponse {
    orders: Order[]
    total: number
    limit: number
    offset: number
}

export interface AutoSellDebugRuleSummary {
    id: number
    name: string
    triggerOn: 'paid' | 'confirmed'
    deliveryType: 'fixed' | 'stock' | 'api'
    workflowId: number | null
    matchPrice: string | null
    priceMin: string | null
    priceMax: string | null
}

export interface AutoSellDebugCandidate extends AutoSellDebugRuleSummary {
    selected: boolean
    priceMatched: boolean
    matchPriority: number
    matchLabel: string
}

export interface OrderAutoSellDebug {
    orderId: string
    accountId: string
    itemId: string | null
    itemTitle: string | null
    orderPrice: string | null
    orderStatus: number
    orderStatusText: string
    triggerOn: 'paid' | 'confirmed'
    actualLog: {
        id: number
        ruleId: number | null
        orderId: string
        accountId: string
        deliveryType: 'fixed' | 'stock' | 'api'
        content: string
        status: 'success' | 'failed'
        errorMessage: string | null
        createdAt: string
    } | null
    actualRule: AutoSellDebugRuleSummary | null
    expectedRule: AutoSellDebugRuleSummary | null
    workflowExecution: {
        id: number
        workflowId: number
        ruleId: number
        status: string
        createdAt: string
    } | null
    isMismatch: boolean
    summary: string
    candidates: AutoSellDebugCandidate[]
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
    triggerOn: 'paid' | 'confirmed'
    orderTime: string
    deliveredAt: string
    actualRule: AutoSellDebugRuleSummary | null
    expectedRule: AutoSellDebugRuleSummary | null
    summary: string
}
