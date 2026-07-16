import { Component, OnInit, signal, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { ICONS } from '../../shared/icons';
import { DialogService } from '../../shared/dialog';
import { AutoSellService, AccountService, GoodsService, WorkflowService } from '../../core/services';
import { CodeEditorComponent } from '../../components/code-editor/code-editor.component';
import type {
    AutoSellRule, DeliveryType, TriggerOn, ApiConfig, Account, GoodsItem, StockItem, StockStats,
    Workflow
} from '../../core/types';

@Component({
    selector: 'app-bot-autosell',
    imports: [LucideAngularModule, FormsModule, CodeEditorComponent],
    templateUrl: './bot-autosell.html',
    styleUrl: './bot-autosell.css',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class BotAutosellComponent implements OnInit {
    private readonly service = inject(AutoSellService);
    private readonly accountService = inject(AccountService);
    private readonly goodsService = inject(GoodsService);
    private readonly workflowService = inject(WorkflowService);
    private readonly dialog = inject(DialogService);
    private readonly router = inject(Router);
    readonly icons = ICONS;

    rules = signal<AutoSellRule[]>([]);
    workflows = signal<Workflow[]>([]);
    loading = signal(false);
    saving = signal(false);
    editingRule = signal<AutoSellRule | null>(null);
    showStockModal = signal(false);
    stockRuleId = signal<number | null>(null);
    stockItems = signal<StockItem[]>([]);
    stockStats = signal<StockStats | null>(null);
    loadingStock = signal(false);
    showUsedStock = signal(false);

    // 库存编辑
    stockContent = signal('');
    editingRuleStock = computed(() => {
        const rule = this.editingRule();
        if (!rule) return { total: 0, available: 0 };
        return {
            total: rule.stockCount || 0,
            available: (rule.stockCount || 0) - (rule.usedCount || 0)
        };
    });
    stockContentCount = computed(() => {
        const content = this.stockContent();
        if (!content.trim()) return 0;
        return content.split('\n').filter(line => line.trim()).length;
    });

    // 账号和商品
    accounts = signal<Account[]>([]);
    allGoods = signal<GoodsItem[]>([]);
    loadingGoods = signal(false);
    goodsSearch = signal('');
    showGoodsDropdown = signal(false);

    filteredGoods = computed(() => {
        const search = this.goodsSearch().toLowerCase();
        const accountId = this.formData().accountId;
        let goods = this.allGoods();

        if (accountId) {
            goods = goods.filter(g => g.accountId === accountId);
        }
        if (search) {
            goods = goods.filter(g =>
                g.title.toLowerCase().includes(search) ||
                g.id.includes(search)
            );
        }
        return goods;
    });

    selectedGoods = computed(() => {
        const itemId = this.formData().itemId;
        if (!itemId) return null;
        return this.allGoods().find(g => g.id === itemId) || null;
    });

    sharedStockSourceOptions = computed(() => {
        const currentRuleId = this.editingRule()?.id ?? null;

        return this.rules().filter(rule => {
            if (rule.deliveryType !== 'stock') return false;
            if (rule.id === currentRuleId) return false;
            return true;
        });
    });

    selectedSharedStockSource = computed(() => {
        const sourceRuleId = this.formData().sharedStockRuleId;
        if (!sourceRuleId) return null;
        return this.rules().find(rule => rule.id === sourceRuleId) || null;
    });

    stockModalRule = computed(() => {
        const ruleId = this.stockRuleId();
        if (!ruleId) return null;
        return this.rules().find(rule => rule.id === ruleId) || null;
    });

    stockModalSharedSource = computed(() => {
        const sourceRuleId = this.stockModalRule()?.sharedStockRuleId;
        if (!sourceRuleId) return null;
        return this.rules().find(rule => rule.id === sourceRuleId) || null;
    });

    formData = signal({
        name: '',
        enabled: true,
        itemId: null as string | null,
        accountId: null as string | null,
        matchPrice: '',
        priceMin: '',
        priceMax: '',
        deliveryType: 'fixed' as DeliveryType,
        deliveryContent: '',
        triggerOn: 'paid' as TriggerOn,
        workflowId: null as number | null,
        sharedStockRuleId: null as number | null,
        apiUrl: '',
        apiMethod: 'GET' as 'GET' | 'POST',
        apiHeaders: '',
        apiBody: '',
        apiResponseField: ''
    });

    deliveryTypes = [
        { value: 'fixed', label: '固定文本' },
        { value: 'stock', label: '库存发货' },
        { value: 'api', label: 'API取货' }
    ];

    triggerOptions = [
        { value: 'paid', label: '待发货' },
        { value: 'confirmed', label: '待收货' }
    ];

    ngOnInit() {
        this.loadRules();
        this.loadWorkflows();
        void this.initializeAccountsAndGoods();
    }

    private async initializeAccountsAndGoods() {
        await this.loadAccounts();
        await this.loadAllGoods();
    }

    async loadWorkflows() {
        try {
            const res = await this.workflowService.getWorkflows();
            this.workflows.set(res.workflows);
        } catch (e) {
            console.error('加载流程失败', e);
        }
    }

    async loadAccounts() {
        try {
            const res = await this.accountService.getAccounts();
            const enabledAccounts = res.accounts.filter(a => a.enabled);
            this.accounts.set(enabledAccounts);
            return enabledAccounts;
        } catch (e) {
            console.error('加载账号失败', e);
            return [] as Account[];
        }
    }

    async loadAllGoods() {
        this.loadingGoods.set(true);
        try {
            const selectedAccountId = this.formData().accountId;
            const accounts = this.accounts().length > 0 ? this.accounts() : await this.loadAccounts();

            if (selectedAccountId) {
                const account = accounts.find(item => item.id === selectedAccountId) || null;
                this.allGoods.set(await this.fetchGoodsForAccount(selectedAccountId, account?.nickname || undefined));
                return;
            }

            const merged = new Map<string, GoodsItem>();

            for (const account of accounts) {
                const items = await this.fetchGoodsForAccount(account.id, account.nickname || undefined);
                for (const goods of items) {
                    if (!goods.id || !goods.accountId) continue;
                    merged.set(`${goods.accountId}::${goods.id}`, goods);
                }
            }

            this.allGoods.set(Array.from(merged.values()));
        } catch (e) {
            console.error('加载商品失败', e);
        } finally {
            this.loadingGoods.set(false);
        }
    }

    private async fetchGoodsForAccount(accountId: string, accountNickname?: string): Promise<GoodsItem[]> {
        const merged = new Map<string, GoodsItem>();
        let page = 1;

        while (true) {
            const res = await this.goodsService.getAccountGoods(accountId, page);
            const items = (res.items || []).map(goods => ({
                ...goods,
                accountId,
                accountNickname: goods.accountNickname || accountNickname
            }));

            for (const goods of items) {
                if (goods.id) {
                    merged.set(goods.id, goods);
                }
            }

            if (!res.nextPage || items.length === 0) {
                break;
            }

            page += 1;
        }

        return Array.from(merged.values());
    }

    async loadRules() {
        this.loading.set(true);
        try {
            const res = await this.service.getRules();
            this.rules.set(res.rules);
        } catch (e) {
            console.error('加载规则失败', e);
        } finally {
            this.loading.set(false);
        }
    }

    onEdit(rule: AutoSellRule) {
        this.editingRule.set(rule);
        const apiConfig = rule.apiConfig;
        this.formData.set({
            name: rule.name,
            enabled: rule.enabled,
            itemId: rule.itemId,
            accountId: rule.accountId,
            matchPrice: rule.matchPrice || '',
            priceMin: rule.priceMin || '',
            priceMax: rule.priceMax || '',
            deliveryType: rule.deliveryType,
            deliveryContent: rule.deliveryContent || '',
            triggerOn: rule.triggerOn,
            workflowId: rule.workflowId,
            sharedStockRuleId: rule.sharedStockRuleId,
            apiUrl: apiConfig?.url || '',
            apiMethod: apiConfig?.method || 'GET',
            apiHeaders: apiConfig?.headers ? JSON.stringify(apiConfig.headers, null, 2) : '',
            apiBody: apiConfig?.body || '',
            apiResponseField: apiConfig?.responseField || ''
        });
        this.goodsSearch.set('');
        this.stockContent.set('');
    }

    cancelEdit() {
        this.editingRule.set(null);
        this.resetForm();
    }

    resetForm() {
        this.formData.set({
            name: '',
            enabled: true,
            itemId: null,
            accountId: null,
            matchPrice: '',
            priceMin: '',
            priceMax: '',
            deliveryType: 'fixed',
            deliveryContent: '',
            triggerOn: 'paid',
            workflowId: null,
            sharedStockRuleId: null,
            apiUrl: '',
            apiMethod: 'GET',
            apiHeaders: '',
            apiBody: '',
            apiResponseField: ''
        });
        this.goodsSearch.set('');
        this.stockContent.set('');
    }

    private hasSharedStockSource(ruleId: number | null | undefined): boolean {
        if (!ruleId) return false;
        return this.sharedStockSourceOptions().some(rule => rule.id === ruleId);
    }

    private ensureSharedStockSelectionValid() {
        const data = this.formData();
        if (data.deliveryType !== 'stock') {
            if (data.sharedStockRuleId !== null) {
                this.formData.update(form => ({ ...form, sharedStockRuleId: null }));
            }
            return;
        }

        if (data.sharedStockRuleId && !this.hasSharedStockSource(data.sharedStockRuleId)) {
            this.formData.update(form => ({ ...form, sharedStockRuleId: null }));
        }
    }

    updateField<K extends keyof ReturnType<typeof this.formData>>(
        field: K,
        value: ReturnType<typeof this.formData>[K]
    ) {
        this.formData.update(f => ({ ...f, [field]: value }));
        if (field === 'accountId') {
            this.formData.update(f => ({ ...f, itemId: null }));
            this.goodsSearch.set('');
            void this.loadAllGoods();
        }
        if (field === 'accountId' || field === 'deliveryType' || field === 'sharedStockRuleId') {
            this.ensureSharedStockSelectionValid();
        }
    }

    selectGoods(goods: GoodsItem) {
        this.formData.update(f => ({
            ...f,
            itemId: goods.id,
            accountId: goods.accountId || null
        }));
        this.goodsSearch.set('');
        this.showGoodsDropdown.set(false);
        this.ensureSharedStockSelectionValid();
    }

    clearGoodsSelection() {
        this.formData.update(f => ({ ...f, itemId: null }));
        this.goodsSearch.set('');
        this.ensureSharedStockSelectionValid();
    }

    onGoodsSearchFocus() {
        this.showGoodsDropdown.set(true);
    }

    onGoodsSearchBlur() {
        setTimeout(() => this.showGoodsDropdown.set(false), 200);
    }

    onStockFileSelect(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const text = reader.result as string;
            const current = this.stockContent();
            if (current.trim()) {
                this.stockContent.set(current + '\n' + text);
            } else {
                this.stockContent.set(text);
            }
        };
        reader.readAsText(file, 'utf-8');
        input.value = '';
    }

    getGoodsTitle(itemId: string): string {
        const goods = this.allGoods().find(g => g.id === itemId);
        return goods?.title || itemId;
    }

    getRuleName(ruleId: number | null | undefined): string {
        if (!ruleId) return '-';
        return this.rules().find(rule => rule.id === ruleId)?.name || `规则 #${ruleId}`;
    }

    private getErrorMessage(error: any): string {
        return error?.error?.error || error?.error?.message || error?.message || '操作失败';
    }

    private normalizePriceInput(value: string): string | null {
        const normalized = value.trim().replace(/[￥¥,\s]/g, '');
        return normalized || null;
    }

    private isValidPriceInput(value: string | null): boolean {
        return value === null || /^\d+(?:\.\d{1,2})?$/.test(value);
    }

    private toComparablePrice(value: string | null): number | null {
        return value === null ? null : Number(value);
    }

    getPriceMatchLabel(rule: AutoSellRule): string {
        if (rule.matchPrice) {
            return `精确 ¥${rule.matchPrice}`;
        }

        if (rule.priceMin || rule.priceMax) {
            const min = rule.priceMin ?? '不限';
            const max = rule.priceMax ?? '不限';
            return `区间 ${min} ~ ${max}`;
        }

        return '全部金额';
    }

    async saveRule() {
        const data = this.formData();
        if (!data.name) {
            await this.dialog.alert('提示', '请输入规则名称');
            return;
        }
        if (!data.itemId) {
            await this.dialog.alert('提示', '请选择商品');
            return;
        }

        const matchPrice = this.normalizePriceInput(data.matchPrice);
        const priceMin = this.normalizePriceInput(data.priceMin);
        const priceMax = this.normalizePriceInput(data.priceMax);

        if (!this.isValidPriceInput(matchPrice) || !this.isValidPriceInput(priceMin) || !this.isValidPriceInput(priceMax)) {
            await this.dialog.alert('提示', '金额格式不正确，请输入最多 2 位小数');
            return;
        }

        if (matchPrice && (priceMin || priceMax)) {
            await this.dialog.alert('提示', '精确金额和价格区间二选一即可');
            return;
        }

        if (priceMin && priceMax && this.toComparablePrice(priceMin)! > this.toComparablePrice(priceMax)!) {
            await this.dialog.alert('提示', '最低金额不能大于最高金额');
            return;
        }

        let apiConfig: ApiConfig | null = null;
        if (data.deliveryType === 'api') {
            if (!data.apiUrl) {
                await this.dialog.alert('提示', '请输入 API 地址');
                return;
            }
            let headers: Record<string, string> | undefined;
            if (data.apiHeaders) {
                try {
                    headers = JSON.parse(data.apiHeaders);
                } catch {
                    await this.dialog.alert('错误', 'Headers 格式不正确，请使用 JSON 格式');
                    return;
                }
            }
            apiConfig = {
                url: data.apiUrl,
                method: data.apiMethod,
                headers,
                body: data.apiBody || undefined,
                responseField: data.apiResponseField || undefined
            };
        }

        if (data.deliveryType === 'fixed' && !data.deliveryContent) {
            await this.dialog.alert('提示', '请输入发货内容');
            return;
        }

        const payload: Partial<AutoSellRule> = {
            name: data.name,
            enabled: data.enabled,
            itemId: data.itemId,
            accountId: data.accountId,
            deliveryType: data.deliveryType,
            deliveryContent: data.deliveryType === 'fixed' ? data.deliveryContent : null,
            apiConfig,
            triggerOn: data.triggerOn,
            workflowId: data.workflowId,
            sharedStockRuleId: data.deliveryType === 'stock' ? data.sharedStockRuleId : null,
            matchPrice,
            priceMin,
            priceMax
        };

        this.saving.set(true);
        try {
            const editing = this.editingRule();
            let ruleId: number;
            if (editing) {
                await this.service.updateRule(editing.id, payload);
                ruleId = editing.id;
            } else {
                const res = await this.service.createRule(payload);
                ruleId = res.id!;
            }

            if (data.deliveryType === 'stock' && !data.sharedStockRuleId && this.stockContent().trim()) {
                const contents = this.stockContent()
                    .split('\n')
                    .map(s => s.trim())
                    .filter(Boolean);
                if (contents.length > 0) {
                    await this.service.addStock(ruleId, contents);
                }
            }

            this.cancelEdit();
            await this.loadRules();
        } catch (e) {
            console.error('保存失败', e);
            await this.dialog.alert('错误', this.getErrorMessage(e));
        } finally {
            this.saving.set(false);
        }
    }

    async toggleRule(rule: AutoSellRule) {
        await this.service.toggleRule(rule.id);
        await this.loadRules();
    }

    async deleteRule(rule: AutoSellRule) {
        const confirmed = await this.dialog.confirm('确认删除', `确定要删除规则 "${rule.name}" 吗？`);
        if (!confirmed) return;
        try {
            await this.service.deleteRule(rule.id);
            await this.loadRules();
        } catch (e) {
            console.error('删除规则失败', e);
            await this.dialog.alert('错误', this.getErrorMessage(e));
        }
    }

    // 库存管理
    async openStockModal(ruleId: number) {
        this.stockRuleId.set(ruleId);
        this.showUsedStock.set(false);
        this.showStockModal.set(true);
        await this.loadStockItems();
    }

    closeStockModal() {
        this.showStockModal.set(false);
        this.stockRuleId.set(null);
        this.stockItems.set([]);
        this.stockStats.set(null);
    }

    async loadStockItems() {
        const ruleId = this.stockRuleId();
        if (!ruleId) return;

        this.loadingStock.set(true);
        try {
            const res = await this.service.getStock(ruleId, this.showUsedStock());
            this.stockItems.set(res.items);
            this.stockStats.set(res.stats);
        } catch (e) {
            console.error('加载库存失败', e);
        } finally {
            this.loadingStock.set(false);
        }
    }

    async toggleShowUsed() {
        this.showUsedStock.update(v => !v);
        await this.loadStockItems();
    }

    async clearStock(ruleId: number, onlyUsed: boolean) {
        const msg = onlyUsed ? '确定要清空已使用的库存吗？' : '确定要清空所有库存吗？';
        const confirmed = await this.dialog.confirm('确认清空', msg);
        if (!confirmed) return;

        try {
            const res = await this.service.clearStock(ruleId, onlyUsed);
            await this.loadRules();
            if (this.showStockModal()) {
                await this.loadStockItems();
            }
            await this.dialog.alert('成功', `已清空 ${res.count} 条库存`);
        } catch (e) {
            console.error('清空库存失败', e);
            await this.dialog.alert('错误', this.getErrorMessage(e));
        }
    }

    getDeliveryTypeLabel(type: DeliveryType): string {
        return this.deliveryTypes.find(t => t.value === type)?.label || type;
    }

    getTriggerLabel(trigger: TriggerOn): string {
        return this.triggerOptions.find(t => t.value === trigger)?.label || trigger;
    }

    getWorkflowName(workflowId: number | null): string {
        if (!workflowId) return '默认流程';
        const workflow = this.workflows().find(w => w.id === workflowId);
        return workflow?.name || '默认流程';
    }

    goToWorkflowPage() {
        this.router.navigate(['/workflow']);
    }
}
