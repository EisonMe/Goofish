import { Component, OnInit, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ICONS } from '../../shared/icons';
import { ItemGroupService } from '../../core/services/item-group.service';
import { GoodsService } from '../../core/services';
import type { GoodsItem } from '../../core/types';

@Component({
    selector: 'app-item-groups',
    standalone: true,
    imports: [CommonModule, LucideAngularModule, FormsModule],
    template: `
        <div class="space-y-6 p-1">
            <div class="flex justify-between items-center">
                <h2 class="text-xl font-bold flex items-center gap-2">
                    <lucide-icon [img]="icons.Package" class="w-5 h-5"></lucide-icon>
                    商品分组管理
                </h2>
                <button class="btn btn-primary btn-sm" (click)="showCreateModal = true">
                    <lucide-icon [img]="icons.Plus" class="w-4 h-4"></lucide-icon>新建分组
                </button>
            </div>

            <!-- 分组列表 -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                @for (group of groups(); track group.id) {
                    <div class="card bg-base-100 shadow">
                        <div class="card-body p-4">
                            <h3 class="card-title text-base">{{ group.name }}</h3>
                            <p class="text-sm text-gray-500">{{ group.description || '暂无描述' }}</p>
                            <div class="flex justify-between items-center mt-2">
                                <span class="badge badge-sm">{{ group.item_count || 0 }} 个商品</span>
                                <div class="flex gap-1">
                                    <button class="btn btn-xs btn-ghost" (click)="editGroup(group)">
                                        <lucide-icon [img]="icons.Edit" class="w-3 h-3"></lucide-icon>
                                    </button>
                                    <button class="btn btn-xs btn-ghost text-error" (click)="deleteGroup(group.id)">
                                        <lucide-icon [img]="icons.Trash2" class="w-3 h-3"></lucide-icon>
                                    </button>
                                </div>
                            </div>
                            <div class="card-actions mt-2">
                                <button class="btn btn-xs btn-outline w-full" (click)="openGroupDetail(group)">
                                    管理商品
                                </button>
                            </div>
                        </div>
                    </div>
                } @empty {
                    <div class="col-span-full text-center py-10 text-gray-500">
                        暂无分组，点击"新建分组"创建
                    </div>
                }
            </div>
        </div>

        <!-- 创建/编辑分组弹窗 -->
        <dialog [class.modal]="showCreateModal || editingGroup()" [open]="showCreateModal || !!editingGroup()">
            <div class="modal-box">
                <h3 class="font-bold text-lg mb-4">{{ editingGroup() ? '编辑分组' : '新建分组' }}</h3>
                <div class="form-control mb-4">
                    <label class="label"><span class="label-text">分组名称 *</span></label>
                    <input type="text" [(ngModel)]="formData.name" class="input input-bordered" placeholder="如：API商品、教程类" />
                </div>
                <div class="form-control mb-4">
                    <label class="label"><span class="label-text">描述</span></label>
                    <textarea [(ngModel)]="formData.description" class="textarea textarea-bordered" placeholder="可选"></textarea>
                </div>
                <div class="modal-action">
                    <button class="btn btn-ghost" (click)="closeModal()">取消</button>
                    <button class="btn btn-primary" (click)="saveGroup()">保存</button>
                </div>
            </div>
        </dialog>

        <!-- 分组详情弹窗 -->
        <dialog [class.modal]="currentGroup()" [open]="!!currentGroup()" class="modal-xl">
            <div class="modal-box max-w-4xl">
                @if (currentGroup()) {
                    <h3 class="font-bold text-lg mb-4">
                        {{ currentGroup()?.name }} - 商品管理
                        <span class="text-sm font-normal text-gray-500">({{ currentGroup()?.items?.length || 0 }} 个商品)</span>
                    </h3>
                    
                    <!-- 添加商品 -->
                    <div class="mb-4">
                        <div class="flex flex-col gap-2 md:flex-row md:items-start">
                            <select class="select select-bordered select-sm md:w-44"
                                [ngModel]="selectedAccountId()"
                                (ngModelChange)="onAccountFilterChange($event || '')">
                                <option value="">全部账号</option>
                                @for (account of availableAccounts(); track account.id) {
                                    <option [value]="account.id">{{ account.name }}</option>
                                }
                            </select>
                            <div class="relative flex-1">
                                @if (selectedAvailableItem(); as selected) {
                                    <div class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-100 p-2 min-h-10">
                                        @if (getItemImage(selected)) {
                                            <img [src]="getItemImage(selected)" class="w-10 h-10 rounded object-cover shrink-0" />
                                        } @else {
                                            <div class="w-10 h-10 rounded bg-base-300 flex items-center justify-center text-base-content/40 text-[10px] shrink-0">无图</div>
                                        }
                                        <div class="min-w-0 flex-1">
                                            <div class="text-sm font-medium truncate">{{ selected.item_title }}</div>
                                            <div class="text-xs text-base-content/50">
                                                {{ selected.account_nickname || selected.account_id }} · {{ selected.order_count || 0 }}单
                                            </div>
                                        </div>
                                        <button type="button" class="btn btn-ghost btn-xs" (click)="clearSelectedItem()">更换</button>
                                    </div>
                                } @else {
                                    <input type="text" class="input input-bordered input-sm w-full"
                                        [ngModel]="itemSearch()"
                                        (ngModelChange)="onItemSearchChange($event)"
                                        (focus)="showItemDropdown.set(true)"
                                        (blur)="hideItemDropdownSoon()"
                                        placeholder="搜索商品名称或ID添加到分组..." />
                                    @if (showItemDropdown()) {
                                        <div class="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-base-300 bg-base-100 shadow-lg">
                                            @for (item of filteredAvailableItems(); track item.item_id + item.account_id) {
                                                <div class="flex cursor-pointer items-center gap-2 p-2 hover:bg-base-200"
                                                    (mousedown)="selectAvailableItem(item)">
                                                    @if (getItemImage(item)) {
                                                        <img [src]="getItemImage(item)" class="w-10 h-10 rounded object-cover shrink-0" />
                                                    } @else {
                                                        <div class="w-10 h-10 rounded bg-base-300 flex items-center justify-center text-base-content/40 text-[10px] shrink-0">无图</div>
                                                    }
                                                    <div class="min-w-0 flex-1">
                                                        <div class="text-sm truncate">{{ item.item_title }}</div>
                                                        <div class="text-xs text-base-content/50">
                                                            {{ item.account_nickname || item.account_id }} · {{ item.order_count || 0 }}单
                                                        </div>
                                                    </div>
                                                </div>
                                            } @empty {
                                                <div class="p-4 text-center text-sm text-base-content/50">未找到匹配商品</div>
                                            }
                                        </div>
                                    }
                                }
                            </div>
                            <button class="btn btn-sm btn-primary" (click)="addItemToGroup()" [disabled]="!selectedItemId">
                                添加
                            </button>
                        </div>
                    </div>

                    <!-- 商品列表 -->
                    <div class="overflow-x-auto">
                        <table class="table table-sm">
                            <thead>
                                <tr>
                                    <th>商品名称</th>
                                    <th>账号</th>
                                    <th>操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                @for (item of currentGroup()?.items; track item.item_id + item.account_id) {
                                    <tr>
                                        <td>{{ item.item_title }}</td>
                                        <td class="text-xs">{{ accountDisplayName(item) }}</td>
                                        <td>
                                            <button class="btn btn-xs btn-ghost text-error" (click)="removeItem(item)">
                                                移除
                                            </button>
                                        </td>
                                    </tr>
                                } @empty {
                                    <tr><td colspan="3" class="text-center text-gray-500">暂无商品</td></tr>
                                }
                            </tbody>
                        </table>
                    </div>

                    <div class="modal-action">
                        <button class="btn" (click)="currentGroup.set(null)">关闭</button>
                    </div>
                }
            </div>
        </dialog>
    `,
    styles: [`:host { display: block; padding: 1rem; }`]
})
export class ItemGroupsComponent implements OnInit {
    private readonly groupService = inject(ItemGroupService);
    private readonly goodsService = inject(GoodsService);
    readonly icons = ICONS;

    groups = signal<any[]>([]);
    availableItems = signal<any[]>([]);
    currentGroup = signal<any>(null);
    editingGroup = signal<any>(null);
    itemSearch = signal('');
    selectedAccountId = signal('');
    showItemDropdown = signal(false);
    showCreateModal = false;

    formData = { name: '', description: '' };
    selectedItemId = '';

    filteredAvailableItems = signal<any[]>([]);

    ngOnInit() {
        this.loadGroups();
        this.loadAvailableItems();
    }

    async loadGroups() {
        try {
            const data = await this.groupService.getGroups();
            this.groups.set(data);
        } catch (e) {
            console.error('loadGroups', e);
        }
    }

    async loadAvailableItems() {
        try {
            const [groupItems, goodsData] = await Promise.all([
                this.groupService.getAvailableItems(),
                this.goodsService.getGoods()
            ]);

            const merged = new Map<string, any>();

            for (const item of groupItems || []) {
                merged.set(`${item.account_id}::${item.item_id}`, item);
            }

            for (const goods of goodsData.items || []) {
                if (!goods.id || !goods.accountId) continue;

                const key = `${goods.accountId}::${goods.id}`;
                if (!merged.has(key)) {
                    merged.set(key, this.goodsToAvailableItem(goods));
                }
            }

            this.setAvailableItems(Array.from(merged.values()).sort((a, b) => {
                const orderCountDiff = Number(b.order_count || 0) - Number(a.order_count || 0);
                if (orderCountDiff !== 0) return orderCountDiff;
                return String(a.item_title || '').localeCompare(String(b.item_title || ''), 'zh-Hans-CN');
            }));
        } catch (e) {
            console.error('loadAvailableItems', e);
        }
    }

    private setAvailableItems(items: any[]) {
        this.availableItems.set(items);
        this.refreshFilteredAvailableItems();
    }

    private refreshFilteredAvailableItems() {
        const search = this.itemSearch().trim().toLowerCase();
        const accountId = this.selectedAccountId();
        let items = this.availableItems();
        if (accountId) {
            items = items.filter(item => item.account_id === accountId);
        }
        if (!search) {
            this.filteredAvailableItems.set(items.slice(0, 80));
            return;
        }

        this.filteredAvailableItems.set(items.filter(item =>
            String(item.item_title || '').toLowerCase().includes(search) ||
            String(item.item_id || '').includes(search) ||
            String(item.account_id || '').includes(search) ||
            String(item.account_nickname || '').toLowerCase().includes(search)
        ).slice(0, 80));
    }

    private goodsToAvailableItem(goods: GoodsItem) {
        return {
            item_id: goods.id,
            item_title: goods.title,
            item_pic_url: goods.picUrl || null,
            account_id: goods.accountId || '',
            order_count: 0,
            account_nickname: goods.accountNickname || null
        };
    }

    availableAccounts() {
        const accounts = new Map<string, string>();
        for (const item of this.availableItems()) {
            const id = String(item.account_id || '').trim();
            if (!id) continue;
            accounts.set(id, item.account_nickname || id);
        }

        return Array.from(accounts.entries())
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }

    editGroup(group: any) {
        this.editingGroup.set(group);
        this.formData = { name: group.name, description: group.description || '' };
    }

    closeModal() {
        this.showCreateModal = false;
        this.editingGroup.set(null);
        this.formData = { name: '', description: '' };
    }

    async saveGroup() {
        if (!this.formData.name.trim()) {
            alert('请输入分组名称');
            return;
        }
        try {
            if (this.editingGroup()) {
                await this.groupService.updateGroup(this.editingGroup().id, this.formData.name, this.formData.description);
            } else {
                await this.groupService.createGroup(this.formData.name, this.formData.description);
            }
            this.closeModal();
            this.loadGroups();
        } catch (e) {
            console.error('saveGroup', e);
            alert('保存失败');
        }
    }

    async deleteGroup(id: number) {
        if (!confirm('确定删除该分组？')) return;
        try {
            await this.groupService.deleteGroup(id);
            this.loadGroups();
        } catch (e) {
            console.error('deleteGroup', e);
        }
    }

    async openGroupDetail(group: any) {
        try {
            const data = await this.groupService.getGroup(group.id);
            this.currentGroup.set(data);
            this.clearSelectedItem();
        } catch (e) {
            console.error('openGroupDetail', e);
        }
    }

    selectedAvailableItem() {
        if (!this.selectedItemId) return null;
        const [itemId, accountId] = this.selectedItemId.split('|');
        return this.availableItems().find(i => i.item_id === itemId && i.account_id === accountId) || null;
    }

    selectAvailableItem(item: any) {
        this.selectedItemId = `${item.item_id}|${item.account_id}`;
        this.itemSearch.set('');
        this.showItemDropdown.set(false);
    }

    onItemSearchChange(value: string) {
        this.itemSearch.set(value);
        this.refreshFilteredAvailableItems();
    }

    onAccountFilterChange(accountId: string) {
        this.selectedAccountId.set(accountId);
        this.clearSelectedItem();
        this.showItemDropdown.set(true);
    }

    clearSelectedItem() {
        this.selectedItemId = '';
        this.itemSearch.set('');
        this.refreshFilteredAvailableItems();
    }

    hideItemDropdownSoon() {
        setTimeout(() => this.showItemDropdown.set(false), 160);
    }

    getItemImage(item: any): string | null {
        return item?.item_pic_url || item?.picUrl || null;
    }

    accountDisplayName(item: any): string {
        return item?.account_nickname || item?.accountNickname || item?.account_id || '-';
    }

    async addItemToGroup() {
        if (!this.selectedItemId) return;
        const [itemId, accountId] = this.selectedItemId.split('|');
        const item = this.availableItems().find(i => i.item_id === itemId && i.account_id === accountId);
        if (!item) return;

        try {
            await this.groupService.addItems(this.currentGroup().id, [{
                itemId: item.item_id,
                itemTitle: item.item_title,
                accountId: item.account_id
            }]);
            const data = await this.groupService.getGroup(this.currentGroup().id);
            this.currentGroup.set(data);
            this.clearSelectedItem();
        } catch (e) {
            console.error('addItemToGroup', e);
        }
    }

    async removeItem(item: any) {
        try {
            await this.groupService.removeItem(this.currentGroup().id, item.item_id, item.account_id);
            const data = await this.groupService.getGroup(this.currentGroup().id);
            this.currentGroup.set(data);
        } catch (e) {
            console.error('removeItem', e);
        }
    }
}
