import type { AutoSellRule, TriggerOn } from '../types/index.js'

const PRICE_PATTERN = /^-?\d+(?:\.\d{1,2})?$/

export function parsePriceToCents(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null

    const normalized = String(value).trim().replace(/[￥¥,\s]/g, '')
    if (!normalized) return null
    if (!PRICE_PATTERN.test(normalized)) return null

    const negative = normalized.startsWith('-')
    const unsigned = negative ? normalized.slice(1) : normalized
    const [integerPart, decimalPart = ''] = unsigned.split('.')

    const cents = Number(integerPart) * 100 + Number((decimalPart + '00').slice(0, 2))
    return negative ? -cents : cents
}

function getRulePriceMatchPriority(rule: AutoSellRule, orderPrice: string | number | null | undefined): number {
    const orderPriceCents = parsePriceToCents(orderPrice)
    const exactPriceCents = parsePriceToCents(rule.matchPrice)

    if (exactPriceCents !== null) {
        return orderPriceCents !== null && orderPriceCents === exactPriceCents ? 300 : -1
    }

    const minPriceCents = parsePriceToCents(rule.priceMin)
    const maxPriceCents = parsePriceToCents(rule.priceMax)

    if (minPriceCents !== null || maxPriceCents !== null) {
        if (orderPriceCents === null) return -1
        if (minPriceCents !== null && orderPriceCents < minPriceCents) return -1
        if (maxPriceCents !== null && orderPriceCents > maxPriceCents) return -1
        return 200
    }

    return 100
}

export function getAutoSellRuleMatchPriority(
    rule: AutoSellRule,
    orderPrice: string | number | null | undefined
): number {
    return getRulePriceMatchPriority(rule, orderPrice)
}

export function selectAutoSellRule(
    rules: AutoSellRule[],
    triggerOn: TriggerOn,
    orderPrice?: string | number | null
): AutoSellRule | undefined {
    const candidates = rules.filter(rule => rule.triggerOn === triggerOn)

    let matchedRule: AutoSellRule | undefined
    let matchedPriority = -1

    for (const rule of candidates) {
        const priority = getRulePriceMatchPriority(rule, orderPrice)
        if (priority > matchedPriority) {
            matchedRule = rule
            matchedPriority = priority
        }
    }

    return matchedRule
}
