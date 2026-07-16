import { Component, OnInit, OnDestroy, signal, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { Subscription } from 'rxjs';

import { ICONS } from '../../shared/icons';
import { DialogService } from '../../shared/dialog';
import { OrderService, AccountService, WSPushService, ItemGroupService } from '../../core/services';
import { ORDER_STATUS_TEXT, ORDER_STATUS_CLASS, OrderStatus } from '../../core/types';
import type { Order, Account, OrderAutoSellDebug, AutoSellAnomalyItem, AutoSellDebugRuleSummary } from '../../core/types';

type RefundFilterValue = 'all' | 'only' | 'none';
const ANOMALY_SCAN_LIMIT = 50;

@Component({
    selector: 'app-goofish-orders',
    imports: [LucideAngularModule, FormsModule],
    templateUrl: './goofish-orders.html',
    styleUrl: './goofish-orders.css',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class GoofishOrdersComponent implements OnInit, OnDestroy {
    private readonly orderService = inject(OrderService);
    private readonly accountService = inject(AccountService);
    private readonly wsPushService = inject(WSPushService);
    private readonly itemGroupService = inject(ItemGroupService);
    private readonly cdr = inject(ChangeDetectorRef);
    private readonly dialog = inject(DialogService);
    private wsSubscription: Subscription | null = null;

    readonly icons = ICONS;
    readonly Math = Math;
    readonly OrderStatus = OrderStatus;

    orders = signal<Order[]>([]);
    accounts = signal<Account[]>([]);
    groups = signal<any[]>([]);
    loading = signal(false);
    refreshing = signal<string | null>(null);
    shipping = signal<string | null>(null);
    redelivering = signal<string | null>(null);
    deleting = signal<string | null>(null);
    diagnosing = signal<string | null>(null);
    checkingAnomalies = signal(false);
    exportingSupplementSheet = signal(false);
    refreshingAll = signal(false);
    refreshingRecentDays = signal<number | null>(null);
    anomalies = signal<AutoSellAnomalyItem[]>([]);
    anomaliesTotal = signal(0);
    anomalyPanelVisible = signal(false);

    // 筛选
    selectedAccountId = signal('');
    selectedGroupId = signal(0);
    selectedStatus = signal<number | ''>('');
    keyword = signal('');
    refundFilter = signal<RefundFilterValue>('all');
    pendingRedeliveryOnly = signal(false);

    // 分页
    total = signal(0);
    offset = signal(0);
    limit = 20;

    // 手动获取订单
    manualOrderId = signal('');
    manualAccountId = signal('');
    fetching = signal(false);

    statusOptions = [
        { value: '', label: '全部状态' },
        { value: 0, label: '获取中' },
        { value: OrderStatus.PENDING_PAYMENT, label: '待付款' },
        { value: OrderStatus.PENDING_SHIPMENT, label: '待发货' },
        { value: OrderStatus.PENDING_RECEIPT, label: '待收货' },
        { value: OrderStatus.COMPLETED, label: '交易成功' },
        { value: OrderStatus.CLOSED, label: '已关闭' }
    ];

    ngOnInit() {
        this.loadAccounts();
        this.loadGroups();
        this.loadOrders();
        this.subscribeWS();
    }

    ngOnDestroy() {
        this.wsSubscription?.unsubscribe();
        this.wsPushService.unsubscribeOrders();
    }

    private subscribeWS() {
        this.syncOrderWSSubscription();
        this.wsSubscription = this.wsPushService.orders$.subscribe((data) => {
            this.orders.set(data.orders);
            this.total.set(data.total);
            this.cdr.detectChanges();
        });
    }

    private syncOrderWSSubscription() {
        this.wsPushService.subscribeOrders(this.buildOrderSubscriptionParams());
    }

    async loadAccounts() {
        try {
            const res = await this.accountService.getAccounts();
            this.accounts.set(res.accounts);
        } catch (e) {
            console.error('加载账号列表失败', e);
        }
    }

    async loadGroups() {
        try {
            const data = await this.itemGroupService.getGroups();
            this.groups.set(Array.isArray(data) ? data : []);
        } catch (e) {
            console.error('加载商品分组失败', e);
        }
    }

    async loadOrders() {
        this.loading.set(true);
        try {
            const res = await this.orderService.getOrders({
                ...this.buildOrderFilters(),
                limit: this.limit,
                offset: this.offset()
            });
            this.orders.set(res.orders);
            this.total.set(res.total);
        } catch (e) {
            console.error('加载订单列表失败', e);
        } finally {
            this.loading.set(false);
        }
    }

    onFilterChange() {
        this.offset.set(0);
        this.syncOrderWSSubscription();
        this.loadOrders();
    }

    resetFilters() {
        this.selectedAccountId.set('');
        this.selectedGroupId.set(0);
        this.selectedStatus.set('');
        this.keyword.set('');
        this.refundFilter.set('all');
        this.pendingRedeliveryOnly.set(false);
        this.onFilterChange();
    }

    async refreshOrder(order: Order) {
        this.refreshing.set(order.orderId);
        try {
            const res = await this.orderService.refreshOrder(order.orderId);
            if (res.success && res.order) {
                this.orders.update(list =>
                    list.map(o => o.orderId === order.orderId ? res.order! : o)
                );
            }
        } catch (e) {
            console.error('刷新订单失败', e);
        } finally {
            this.refreshing.set(null);
        }
    }

    async refreshAllOrders() {
        if (this.refreshingAll()) return;
        const confirmed = await this.dialog.confirm('刷新全部订单', '将刷新所有活跃订单的最新状态，可能需要一点时间，确定继续？');
        if (!confirmed) return;

        this.refreshingAll.set(true);
        try {
            const res = await this.orderService.refreshAllOrders();
            if (res.success && res.summary) {
                const s = res.summary;
                await this.dialog.alert('刷新完成',
                    `共 ${s.total} 个活跃订单\n已刷新: ${s.refreshed}\n失败: ${s.failed}\n跳过(账号未连接): ${s.skipped}`);
                this.loadOrders();
            } else {
                await this.dialog.alert('刷新失败', res.error || '未知错误');
            }
        } catch (e) {
            console.error('批量刷新订单失败', e);
            await this.dialog.alert('刷新失败', this.getErrorMessage(e));
        } finally {
            this.refreshingAll.set(false);
        }
    }

    async refreshRecentOrders(days: number) {
        if (this.refreshingRecentDays()) return;

        const confirmed = await this.dialog.confirm(
            `刷新最近${days}天订单`,
            `将按下单时间刷新最近 ${days} 天内的订单详情，可能需要一点时间，确定继续？`
        );
        if (!confirmed) return;

        this.refreshingRecentDays.set(days);
        try {
            const res = await this.orderService.refreshRecentOrders(days);
            if (res.success && res.summary) {
                const s = res.summary;
                await this.dialog.alert(
                    '刷新完成',
                    `共 ${s.total} 个订单\n已刷新: ${s.refreshed}\n失败: ${s.failed}\n跳过(账号未连接): ${s.skipped}`
                );
                this.loadOrders();
            } else {
                await this.dialog.alert('刷新失败', res.error || '未知错误');
            }
        } catch (e) {
            console.error(`刷新最近 ${days} 天订单失败`, e);
            await this.dialog.alert('刷新失败', this.getErrorMessage(e));
        } finally {
            this.refreshingRecentDays.set(null);
        }
    }

    private getErrorMessage(error: unknown): string {
        if (!error) return '未知错误';

        if (typeof error === 'string') {
            return error;
        }

        if (typeof error === 'object') {
            const record = error as Record<string, unknown>;
            const nested = record['error'];

            if (nested && typeof nested === 'object') {
                const nestedRecord = nested as Record<string, unknown>;
                if (typeof nestedRecord['error'] === 'string') {
                    return nestedRecord['error'];
                }
                if (typeof nestedRecord['message'] === 'string') {
                    return nestedRecord['message'];
                }
            }

            if (typeof record['message'] === 'string') {
                return record['message'];
            }
            if (typeof record['statusText'] === 'string' && record['statusText']) {
                return record['statusText'];
            }
        }

        return String(error);
    }

    async redeliverMissing(order: Order) {
        if (!this.canRedeliver(order)) return;

        const confirmed = await this.dialog.confirmHtml(
            '补发缺失内容',
            `<div class="space-y-2">
                <p>订单号: <span class="text-primary font-mono font-bold">${order.orderId}</span></p>
                <p>商品: ${order.itemTitle || '未知商品'}</p>
                <p>买家: ${order.buyerNickname || order.buyerUserId || '-'}</p>
                <p>当前进度: 已发 <span class="font-bold">${this.getDeliveredQuantity(order)}</span> / ${this.getBuyAmount(order)}，待补 <span class="font-bold text-warning">${this.getRemainingQuantity(order)}</span></p>
                <p class="pt-2">只会补发缺失的内容，不会重复确认发货。</p>
            </div>`
        );
        if (!confirmed) return;

        this.redelivering.set(order.orderId);
        try {
            const res = await this.orderService.redeliverMissing(order.orderId);
            if (res.success) {
                await this.loadOrders();
                await this.dialog.alert(
                    '补发成功',
                    `已补发 ${res.deliveredQuantity ?? 0} 份，剩余 ${res.remainingQuantity ?? 0} 份`
                );
            } else {
                await this.dialog.alert('补发失败', res.error || '补发失败');
            }
        } catch (e) {
            console.error('补发缺失内容失败', e);
            await this.dialog.alert('补发失败', '补发缺失内容失败，请稍后重试');
        } finally {
            this.redelivering.set(null);
        }
    }

    async shipOrder(order: Order) {
        const confirmed = await this.dialog.confirmHtml(
            '确认发货',
            `<div class="space-y-2">
                <p>订单号: <span class="text-primary font-mono font-bold">${order.orderId}</span></p>
                <p>商品: ${order.itemTitle || '未知商品'}</p>
                <p>买家: ${order.buyerNickname || order.buyerUserId || '-'}</p>
                <p>金额: <span class="font-bold">¥${order.price || '-'}</span></p>
                <p>下单时间: ${this.formatTime(order.orderTime)}</p>
                <p class="pt-2">确定要发货吗？</p>
            </div>`
        );
        if (!confirmed) return;

        this.shipping.set(order.orderId);
        try {
            const res = await this.orderService.shipOrder(order.orderId);
            if (res.success && res.order) {
                this.orders.update(list =>
                    list.map(o => o.orderId === order.orderId ? res.order! : o)
                );
            } else {
                await this.dialog.alert('发货失败', res.error || '发货失败');
            }
        } catch (e) {
            console.error('发货失败', e);
            await this.dialog.alert('发货失败', '发货失败，请稍后重试');
        } finally {
            this.shipping.set(null);
        }
    }

    async freeShipOrder(order: Order) {
        const confirmed = await this.dialog.confirmHtml(
            '确认免拼发货',
            `<div class="space-y-2">
                <p>订单号: <span class="text-primary font-mono font-bold">${order.orderId}</span></p>
                <p>商品: ${order.itemTitle || '未知商品'}</p>
                <p>买家: ${order.buyerNickname || order.buyerUserId || '-'}</p>
                <p>金额: <span class="font-bold">¥${order.price || '-'}</span></p>
                <p>下单时间: ${this.formatTime(order.orderTime)}</p>
                <p class="pt-2">确定要免拼发货吗？</p>
            </div>`
        );
        if (!confirmed) return;

        this.shipping.set(order.orderId);
        try {
            const res = await this.orderService.freeShipOrder(order.orderId);
            if (res.success && res.order) {
                this.orders.update(list =>
                    list.map(o => o.orderId === order.orderId ? res.order! : o)
                );
            } else {
                await this.dialog.alert('免拼发货失败', res.error || '免拼发货失败');
            }
        } catch (e) {
            console.error('免拼发货失败', e);
            await this.dialog.alert('免拼发货失败', '免拼发货失败，请稍后重试');
        } finally {
            this.shipping.set(null);
        }
    }

    async deleteOrder(order: Order) {
        const confirmed = await this.dialog.confirm(
            '删除订单',
            `确定要删除此订单记录吗？\n\n⚠️ 删除后无法找回，只能通过官方App查看历史订单记录。`
        );
        if (!confirmed) return;

        this.deleting.set(order.orderId);
        try {
            const res = await this.orderService.deleteOrder(order.orderId);
            if (res.success) {
                this.orders.update(list => list.filter(o => o.orderId !== order.orderId));
                this.total.update(t => t - 1);
            } else {
                await this.dialog.alert('删除失败', res.error || '删除失败');
            }
        } catch (e) {
            console.error('删除订单失败', e);
            await this.dialog.alert('删除失败', '删除订单失败，请稍后重试');
        } finally {
            this.deleting.set(null);
        }
    }

    async fetchManualOrder() {
        const orderId = this.manualOrderId().trim();
        const accountId = this.manualAccountId();
        if (!orderId || !accountId) return;

        this.fetching.set(true);
        try {
            const res = await this.orderService.fetchOrder(accountId, orderId);
            if (res.success) {
                this.manualOrderId.set('');
            } else {
                await this.dialog.alert('获取订单失败', res.error || '获取订单失败');
            }
        } catch (e) {
            console.error('获取订单失败', e);
        } finally {
            this.fetching.set(false);
        }
    }

    prevPage() {
        if (this.offset() > 0) {
            this.offset.update(o => Math.max(0, o - this.limit));
            this.syncOrderWSSubscription();
            this.loadOrders();
        }
    }

    nextPage() {
        if (this.offset() + this.limit < this.total()) {
            this.offset.update(o => o + this.limit);
            this.syncOrderWSSubscription();
            this.loadOrders();
        }
    }

    getStatusText(status: number): string {
        return ORDER_STATUS_TEXT[status] || '未知';
    }

    getStatusClass(status: number): string {
        return ORDER_STATUS_CLASS[status] || 'badge-ghost';
    }

    formatTime(time: string | null): string {
        if (!time) return '-';
        return new Date(time).toLocaleString('zh-CN');
    }

    getAccountNickname(accountId: string): string {
        const account = this.accounts().find(a => a.id === accountId);
        return account?.nickname || accountId;
    }

    getBuyAmount(order: Order): number {
        const value = Number(order.buyAmount ?? 1);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    }

    getDeliveredQuantity(order: Order): number {
        const value = Number(order.deliveredQuantity ?? 0);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }

    getRemainingQuantity(order: Order): number {
        const value = Number(order.remainingQuantity);
        if (Number.isFinite(value) && value >= 0) {
            return Math.floor(value);
        }

        return Math.max(this.getBuyAmount(order) - this.getDeliveredQuantity(order), 0);
    }

    hasDeliveryGap(order: Order): boolean {
        return this.getRemainingQuantity(order) > 0;
    }

    canRedeliver(order: Order): boolean {
        if (!this.hasDeliveryGap(order) || this.hasRefund(order)) {
            return false;
        }

        return [
            OrderStatus.PENDING_SHIPMENT,
            OrderStatus.PENDING_RECEIPT,
            OrderStatus.COMPLETED
        ].includes(order.status);
    }

    hasRefund(order: Order): boolean {
        if (order.hasRefund) return true;
        if (order.refundStatus) return true;
        // status=8(申请退款) 或 status=12(交易关闭有退款) 或 statusText含"退款"
        if (order.status === 8 || order.status === 12) return true;
        if (order.statusText && order.statusText.includes('退款')) return true;

        const refundAmount = Number(order.refundAmount ?? 0);
        return Number.isFinite(refundAmount) && refundAmount > 0;
    }

    getDeliveryProgressText(order: Order): string {
        const total = this.getBuyAmount(order);
        const delivered = this.getDeliveredQuantity(order);
        const remaining = this.getRemainingQuantity(order);

        if (total <= 1 && remaining <= 0 && delivered <= 1) {
            return '';
        }

        if (remaining > 0) {
            return `已发 ${delivered}/${total}，待补 ${remaining}`;
        }

        return `已发 ${delivered}/${total}`;
    }

    getRefundSummary(order: Order): string {
        const parts: string[] = [];

        if (order.refundStatus) {
            parts.push(order.refundStatus);
        }
        if (order.refundAmount) {
            parts.push(`退款 ¥${order.refundAmount}`);
        }

        return parts.join(' / ') || '已退款';
    }

    focusOrder(orderId: string) {
        this.keyword.set(orderId);
        this.onFilterChange();
    }

    async showAutoSellDebugByOrderId(orderId: string) {
        this.diagnosing.set(orderId);
        try {
            const debug = await this.orderService.getAutoSellDebug(orderId);
            await this.dialog.alertHtml('自动发货诊断', this.buildDebugHtml(debug), '关闭');
        } catch (e) {
            console.error('获取自动发货诊断失败', e);
            await this.dialog.alert('错误', '获取自动发货诊断失败');
        } finally {
            this.diagnosing.set(null);
        }
    }

    private escapeHtml(value: string | null | undefined): string {
        return String(value ?? '-')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private getRulePriceText(rule: AutoSellDebugRuleSummary | null): string {
        if (!rule) return '-';
        if (rule.matchPrice) return `精确 ¥${rule.matchPrice}`;
        if (rule.priceMin || rule.priceMax) return `区间 ${rule.priceMin ?? '不限'} ~ ${rule.priceMax ?? '不限'}`;
        return '全部金额';
    }

    private buildDebugHtml(debug: OrderAutoSellDebug): string {
        const candidateHtml = debug.candidates.length > 0
            ? debug.candidates.map(candidate => `
                <tr>
                    <td class="py-1 pr-3">${candidate.selected ? '✅' : ''}</td>
                    <td class="py-1 pr-3 font-medium">${this.escapeHtml(candidate.name)}</td>
                    <td class="py-1 pr-3">${this.escapeHtml(candidate.triggerOn)}</td>
                    <td class="py-1 pr-3">${this.escapeHtml(this.getRulePriceText(candidate))}</td>
                    <td class="py-1 pr-3">${this.escapeHtml(candidate.matchLabel)}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="5" class="py-2 text-base-content/50">当前没有可用候选规则</td></tr>';

        return `
            <div class="space-y-3 text-sm">
                <div class="rounded-lg p-3 ${debug.isMismatch ? 'bg-error/10 text-error-content' : 'bg-success/10 text-success-content'}">
                    <div class="font-medium">${this.escapeHtml(debug.summary)}</div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div class="bg-base-200 rounded-lg p-3 space-y-1">
                        <div><span class="opacity-60">订单号：</span><span class="font-mono">${this.escapeHtml(debug.orderId)}</span></div>
                        <div><span class="opacity-60">商品：</span>${this.escapeHtml(debug.itemTitle)}</div>
                        <div><span class="opacity-60">金额：</span>¥${this.escapeHtml(debug.orderPrice)}</div>
                        <div><span class="opacity-60">状态：</span>${this.escapeHtml(debug.orderStatusText)}</div>
                        <div><span class="opacity-60">触发阶段：</span>${this.escapeHtml(debug.triggerOn)}</div>
                    </div>
                    <div class="bg-base-200 rounded-lg p-3 space-y-1">
                        <div><span class="opacity-60">实际命中：</span>${this.escapeHtml(debug.actualRule?.name || '未发货')}</div>
                        <div><span class="opacity-60">实际金额规则：</span>${this.escapeHtml(this.getRulePriceText(debug.actualRule))}</div>
                        <div><span class="opacity-60">当前应命中：</span>${this.escapeHtml(debug.expectedRule?.name || '无匹配规则')}</div>
                        <div><span class="opacity-60">当前应命中金额：</span>${this.escapeHtml(this.getRulePriceText(debug.expectedRule))}</div>
                        <div><span class="opacity-60">流程执行：</span>${this.escapeHtml(debug.workflowExecution ? `${debug.workflowExecution.id} / ${debug.workflowExecution.status}` : '无')}</div>
                    </div>
                </div>
                <div>
                    <div class="font-medium mb-2">候选规则</div>
                    <div class="overflow-x-auto">
                        <table class="table table-xs">
                            <thead>
                                <tr>
                                    <th></th>
                                    <th>规则</th>
                                    <th>触发</th>
                                    <th>金额</th>
                                    <th>匹配结果</th>
                                </tr>
                            </thead>
                            <tbody>${candidateHtml}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }

    private buildAnomaliesHtml(items: AutoSellAnomalyItem[], total: number): string {
        if (total === 0) {
            return `<div class="text-sm text-success">最近没有扫描到错发订单。</div>`;
        }

        const listHtml = items.map(item => `
            <div class="border border-error/20 rounded-lg p-3">
                <div class="font-medium">${this.escapeHtml(item.orderId)}</div>
                <div class="text-xs opacity-70 mt-1">${this.escapeHtml(item.itemTitle)} / ¥${this.escapeHtml(item.orderPrice)}</div>
                <div class="mt-2 text-sm">实际：<span class="font-medium">${this.escapeHtml(item.actualRule?.name || '-')}</span></div>
                <div class="text-sm">应发：<span class="font-medium">${this.escapeHtml(item.expectedRule?.name || '-')}</span></div>
                <div class="text-xs opacity-70 mt-2">${this.escapeHtml(item.summary)}</div>
            </div>
        `).join('');

        return `
            <div class="space-y-3">
                <div class="text-sm">共发现 <span class="font-bold text-error">${total}</span> 笔疑似错发（按当前规则配置推算）。</div>
                <div class="space-y-2 max-h-96 overflow-y-auto">${listHtml}</div>
            </div>
        `;
    }

    async showAutoSellDebug(order: Order) {
        await this.showAutoSellDebugByOrderId(order.orderId);
    }

    async scanAutoSellAnomalies() {
        this.checkingAnomalies.set(true);
        try {
            const res = await this.orderService.getAutoSellAnomalies(ANOMALY_SCAN_LIMIT);
            this.anomalies.set(res.anomalies);
            this.anomaliesTotal.set(res.total);
            this.anomalyPanelVisible.set(true);
        } catch (e) {
            console.error('排查错发订单失败', e);
            await this.dialog.alert('错误', '排查错发订单失败');
        } finally {
            this.checkingAnomalies.set(false);
        }
    }

    async exportAutoSellSupplementSheet() {
        this.exportingSupplementSheet.set(true);
        try {
            const fileName = await this.orderService.exportAutoSellSupplementSheet(1000);
            await this.dialog.alert('导出成功', `补发清单已开始下载：${fileName}`);
        } catch (e) {
            console.error('导出补发清单失败', e);
            await this.dialog.alert('错误', '导出补发清单失败');
        } finally {
            this.exportingSupplementSheet.set(false);
        }
    }

    private buildOrderFilters() {
        return {
            accountId: this.selectedAccountId() || undefined,
            groupId: this.selectedGroupId() || undefined,
            status: this.selectedStatus() === '' ? undefined : this.selectedStatus() as number,
            keyword: this.keyword().trim() || undefined,
            hasRefund: this.refundFilter() === 'all'
                ? undefined
                : this.refundFilter() === 'only',
            pendingRedelivery: this.pendingRedeliveryOnly() || undefined
        };
    }

    private buildOrderSubscriptionParams() {
        return {
            ...this.buildOrderFilters(),
            limit: this.limit,
            offset: this.offset()
        };
    }
}
