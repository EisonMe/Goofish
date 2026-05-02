/**
 * 自动回复相关类型定义
 */

export type MatchType = 'exact' | 'contains' | 'regex' | 'ai';

export interface AutoReplyRule {
    id: number;
    name: string;
    enabled: boolean;
    priority: number;
    matchType: MatchType;
    matchPattern: string;
    replyContent: string;
    accountId: string | null;
    itemGroupId: number | null;
    itemGroupName?: string | null;
    excludeMatch: boolean;
    createdAt: string;
    updatedAt: string;
}
