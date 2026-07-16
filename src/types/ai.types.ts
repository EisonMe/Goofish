export interface AIReplyLogRecord {
    id: number
    accountId: string
    chatId: string | null
    buyerUserId: string | null
    buyerName: string | null
    ruleName: string | null
    inputMessage: string
    replyContent: string | null
    model: string | null
    globalPrompt: string | null
    rulePrompt: string | null
    finalSystemPrompt: string | null
    toolCalls: string | null
    toolResults: string | null
    errorMessage: string | null
    createdAt: string
}

export interface CreateAIReplyLogParams {
    accountId: string
    chatId?: string | null
    buyerUserId?: string | null
    buyerName?: string | null
    ruleName?: string | null
    inputMessage: string
    replyContent?: string | null
    model?: string | null
    globalPrompt?: string | null
    rulePrompt?: string | null
    finalSystemPrompt?: string | null
    toolCalls?: string | null
    toolResults?: string | null
    errorMessage?: string | null
}
