import { Component, OnInit, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ICONS } from '../../shared/icons';
import { ReportService } from '../../core/services/report.service';
import { ItemGroupService } from '../../core/services/item-group.service';

@Component({
    selector: 'app-system-reports',
    standalone: true,
    imports: [CommonModule, LucideAngularModule, FormsModule],
    template: `
        <div class="space-y-6 p-1">
            <!-- 标题 -->
            <h2 class="text-xl font-bold flex items-center gap-2">
                <lucide-icon [img]="icons.BarChart3" class="w-5 h-5"></lucide-icon>
                数据报表
            </h2>

            <!-- Tab 切换 -->
            <div class="tabs tabs-boxed bg-base-200 p-1 flex-wrap">
                <a class="tab" [class.tab-active]="activeTab() === 'overview'" (click)="activeTab.set('overview')">
                    <lucide-icon [img]="icons.Activity" class="w-4 h-4 mr-1"></lucide-icon>销售概览
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'revenue'" (click)="activeTab.set('revenue')">
                    <lucide-icon [img]="icons.TrendingUp" class="w-4 h-4 mr-1"></lucide-icon>收入报表
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'status'" (click)="activeTab.set('status')">
                    <lucide-icon [img]="icons.ListChecks" class="w-4 h-4 mr-1"></lucide-icon>订单状态
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'buyers'" (click)="activeTab.set('buyers')">
                    <lucide-icon [img]="icons.UserCheck" class="w-4 h-4 mr-1"></lucide-icon>买家质量
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'hotitems'" (click)="activeTab.set('hotitems')">
                    <lucide-icon [img]="icons.Package" class="w-4 h-4 mr-1"></lucide-icon>热门商品
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'refunds'" (click)="activeTab.set('refunds')">
                    <lucide-icon [img]="icons.RotateCcw" class="w-4 h-4 mr-1"></lucide-icon>退款分析
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'groups'" (click)="activeTab.set('groups')">
                    <lucide-icon [img]="icons.Box" class="w-4 h-4 mr-1"></lucide-icon>分组分析
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'autosell'" (click)="activeTab.set('autosell')">
                    <lucide-icon [img]="icons.Zap" class="w-4 h-4 mr-1"></lucide-icon>自动发货
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'accounts'" (click)="activeTab.set('accounts')">
                    <lucide-icon [img]="icons.Users" class="w-4 h-4 mr-1"></lucide-icon>账号经营
                </a>
                <a class="tab" [class.tab-active]="activeTab() === 'service'" (click)="activeTab.set('service')">
                    <lucide-icon [img]="icons.MessageSquare" class="w-4 h-4 mr-1"></lucide-icon>客服效率
                </a>
            </div>

            <!-- ============ 销售概览 ============ -->
            <div *ngIf="activeTab() === 'overview'">
                <!-- 核心指标 -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">今日订单</div>
                        <div class="stat-value text-2xl">{{ overview()?.today?.orders || 0 }}</div>
                        <div class="stat-desc text-xs" [class.text-success]="overview()?.trends?.ordersChange > 0" [class.text-error]="overview()?.trends?.ordersChange < 0">
                            {{ overview()?.trends?.ordersChange > 0 ? '+' : '' }}{{ overview()?.trends?.ordersChange || 0 }}% vs 昨日
                        </div>
                    </div>
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">今日收入</div>
                        <div class="stat-value text-2xl text-primary">¥{{ overview()?.today?.revenue || 0 }}</div>
                        <div class="stat-desc text-xs" [class.text-success]="overview()?.trends?.revenueChange > 0" [class.text-error]="overview()?.trends?.revenueChange < 0">
                            {{ overview()?.trends?.revenueChange > 0 ? '+' : '' }}{{ overview()?.trends?.revenueChange || 0 }}% vs 昨日
                        </div>
                    </div>
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">本月收入</div>
                        <div class="stat-value text-2xl text-secondary">¥{{ overview()?.thisMonth?.revenue || 0 }}</div>
                        <div class="stat-desc text-xs">{{ overview()?.thisMonth?.orders || 0 }} 笔订单</div>
                    </div>
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">账号状态</div>
                        <div class="stat-value text-2xl text-accent">{{ overview()?.accounts?.connected || 0 }}/{{ overview()?.accounts?.enabled || 0 }}</div>
                        <div class="stat-desc text-xs">在线/启用</div>
                    </div>
                </div>
                <!-- 新增指标：退款、日均、发货效率 -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">今日退款</div>
                        <div class="stat-value text-2xl text-error">{{ overview()?.today?.refunds || 0 }}</div>
                        <div class="stat-desc text-xs">笔</div>
                    </div>
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">7日日均订单</div>
                        <div class="stat-value text-2xl">{{ overview()?.averages?.dailyOrders || 0 }}</div>
                        <div class="stat-desc text-xs">笔/天</div>
                    </div>
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">7日日均收入</div>
                        <div class="stat-value text-2xl text-primary">¥{{ overview()?.averages?.dailyRevenue || 0 }}</div>
                        <div class="stat-desc text-xs">元/天</div>
                    </div>
                    <div class="stat bg-base-100 shadow rounded-box p-4">
                        <div class="stat-title text-xs">自动发货成功率</div>
                        <div class="stat-value text-2xl" [class.text-success]="(overview()?.delivery?.rate || 0) >= 90" [class.text-warning]="(overview()?.delivery?.rate || 0) >= 70 && (overview()?.delivery?.rate || 0) < 90" [class.text-error]="(overview()?.delivery?.rate || 0) < 70">
                            {{ overview()?.delivery?.rate || 0 }}%
                        </div>
                        <div class="stat-desc text-xs">成功 {{ overview()?.delivery?.success || 0 }} / {{ overview()?.delivery?.total || 0 }}</div>
                    </div>
                </div>
                <!-- 本周/昨日对比 -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">本周累计</h3>
                        <div class="flex justify-between text-sm">
                            <span>订单 <strong>{{ overview()?.thisWeek?.orders || 0 }}</strong></span>
                            <span>收入 <strong class="text-primary">¥{{ overview()?.thisWeek?.revenue || 0 }}</strong></span>
                            <span>成交 <strong>{{ overview()?.thisWeek?.success || 0 }}</strong></span>
                            <span class="text-error">退款 <strong>{{ overview()?.thisWeek?.refunds || 0 }}</strong></span>
                        </div>
                    </div>
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">昨日数据</h3>
                        <div class="flex justify-between text-sm">
                            <span>订单 <strong>{{ overview()?.yesterday?.orders || 0 }}</strong></span>
                            <span>收入 <strong class="text-primary">¥{{ overview()?.yesterday?.revenue || 0 }}</strong></span>
                            <span>成交 <strong>{{ overview()?.yesterday?.success || 0 }}</strong></span>
                            <span class="text-error">退款 <strong>{{ overview()?.yesterday?.refunds || 0 }}</strong></span>
                        </div>
                    </div>
                </div>
                <!-- 待发货提醒 -->
                <div class="alert alert-warning" *ngIf="(overview()?.pendingShipments || 0) > 0">
                    <lucide-icon [img]="icons.Truck" class="w-5 h-5"></lucide-icon>
                    <span>待发货订单: <strong>{{ overview()?.pendingShipments || 0 }}</strong> 笔</span>
                </div>
            </div>

            <!-- ============ 收入报表 ============ -->
            <div *ngIf="activeTab() === 'revenue'">
                <div class="flex gap-2 mb-4 items-center flex-wrap">
                    <select [(ngModel)]="selectedGroupId" (ngModelChange)="loadRevenue()" class="select select-bordered select-sm">
                        <option [ngValue]="0">全部分组</option>
                        @for (g of groups(); track g.id) {
                            <option [ngValue]="g.id">{{ g.name }}</option>
                        }
                    </select>
                    <button class="btn btn-sm" [class.btn-primary]="revenueQuickPreset() === 'today'"
                        [class.btn-ghost]="revenueQuickPreset() !== 'today'" (click)="loadRevenuePreset('today')">今天</button>
                    <button class="btn btn-sm" [class.btn-primary]="revenueQuickPreset() === 'yesterday'"
                        [class.btn-ghost]="revenueQuickPreset() !== 'yesterday'" (click)="loadRevenuePreset('yesterday')">昨天</button>
                    <select [(ngModel)]="revenueDays" (ngModelChange)="loadRevenue()" class="select select-bordered select-sm">
                        <option [ngValue]="7">近7天</option>
                        <option [ngValue]="14">近14天</option>
                        <option [ngValue]="30">近30天</option>
                        <option [ngValue]="90">近90天</option>
                    </select>
                    <span class="text-sm mx-2">或选择日期范围:</span>
                    <input type="date" [(ngModel)]="revenueStartDate" class="input input-bordered input-sm w-36" />
                    <span class="text-sm">至</span>
                    <input type="date" [(ngModel)]="revenueEndDate" class="input input-bordered input-sm w-36" />
                    <button class="btn btn-sm btn-primary" (click)="loadRevenueByDate()">查询</button>
                    <button class="btn btn-sm btn-ghost" (click)="clearDateFilter()">清除</button>
                </div>
                <!-- 摘要 -->
                <div class="stats shadow mb-4 w-full overflow-x-auto flex-wrap">
                    <div class="stat">
                        <div class="stat-title">总销售额</div>
                        <div class="stat-value text-primary">¥{{ revenue()?.summary?.totalRevenue || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款金额</div>
                        <div class="stat-value text-error">¥{{ revenue()?.summary?.totalRefundAmount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">实际收款</div>
                        <div class="stat-value text-success">¥{{ revenue()?.summary?.actualRevenue || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title flex items-center gap-1">
                            实际到账
                            <span class="badge badge-sm badge-info font-normal">新</span>
                        </div>
                        <div class="stat-value text-info">¥{{ revenue()?.summary?.netIncome || 0 }}</div>
                        <div class="stat-desc text-[10px] text-gray-400">交易成功 - 退款，未扣除闲鱼服务费</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">待确认收货金额</div>
                        <div class="stat-value text-warning">¥{{ revenue()?.summary?.pendingConfirmAmount || 0 }}</div>
                        <div class="stat-desc text-[10px] text-gray-400">实际收款 - 实际到账</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">总订单</div>
                        <div class="stat-value">{{ revenue()?.summary?.totalOrders || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款订单</div>
                        <div class="stat-value text-warning">{{ revenue()?.summary?.refundOrders || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款率</div>
                        <div class="stat-value" [class.text-error]="(revenue()?.summary?.refundRate || 0) > 10">{{ revenue()?.summary?.refundRate || 0 }}%</div>
                    </div>
                </div>
                <!-- 发货效率 -->
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4" *ngIf="revenue()?.efficiency">
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-2 text-sm">平均发货时间</h3>
                        <div class="text-2xl font-bold text-primary">{{ revenue()?.efficiency?.avgShipText || '-' }}</div>
                        <div class="text-xs text-gray-500">付款到发货</div>
                    </div>
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-2 text-sm">中位发货时间</h3>
                        <div class="text-2xl font-bold text-secondary">{{ revenue()?.efficiency?.medianShipText || '-' }}</div>
                        <div class="text-xs text-gray-500">付款到发货</div>
                    </div>
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-2 text-sm">平均确认时间</h3>
                        <div class="text-2xl font-bold">{{ revenue()?.efficiency?.avgConfirmText || '-' }}</div>
                        <div class="text-xs text-gray-500">发货到成交</div>
                    </div>
                </div>
                <!-- 每日趋势 -->
                <div class="card bg-base-100 shadow p-4 mb-4">
                    <h3 class="font-medium mb-3">每日收入趋势</h3>
                    <div class="flex items-end gap-1 h-40 overflow-x-auto">
                        <div *ngFor="let d of revenue()?.daily || []" class="flex-1 min-w-[20px] flex flex-col items-center justify-end h-full" [title]="d.date + ' | 到账 ¥' + d.netIncome + ' | 订单 ' + d.orders">
                            <span class="text-[10px] mb-0.5">¥{{ d.netIncome || 0 }}</span>
                            <div class="w-full rounded-t bg-info opacity-80 transition-all"
                                [style.height.%]="maxRevenue() > 0 ? (d.netIncome / maxRevenue()) * 100 : 0"
                                [style.min-height.px]="d.netIncome > 0 ? 2 : 0"></div>
                            <span class="text-[9px] mt-0.5 -rotate-45 origin-top-left whitespace-nowrap">{{ d.date.slice(5) }}</span>
                        </div>
                    </div>
                    <div class="flex gap-4 mt-2 text-xs justify-center flex-wrap">
                        <span *ngFor="let d of revenue()?.daily?.slice(-5) || []" class="flex items-center gap-1">
                            {{ d.date.slice(5) }}: 到账¥{{ d.netIncome || 0 }} ({{ d.orders }}单)
                        </span>
                    </div>
                </div>
                <!-- 24小时订单分布 -->
                <div class="card bg-base-100 shadow p-4 mb-4" *ngIf="revenue()?.hourly?.length">
                    <h3 class="font-medium mb-3">24小时订单分布</h3>
                    <div class="flex items-end gap-0.5 h-32">
                        <div *ngFor="let h of revenue()?.hourly || []" class="flex-1 flex flex-col items-center justify-end h-full" [title]="h.hour + '点: ' + h.orders + '单'">
                            <div class="w-full rounded-t bg-secondary opacity-70"
                                [style.height.%]="maxHourlyOrders() > 0 ? (h.orders / maxHourlyOrders()) * 100 : 0"
                                [style.min-height.px]="h.orders > 0 ? 2 : 0"></div>
                        </div>
                    </div>
                    <div class="flex justify-between text-[8px] mt-1 text-gray-500">
                        <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
                    </div>
                </div>
                <!-- 商品排行 -->
                <div class="card bg-base-100 shadow p-4 mb-4" *ngIf="revenue()?.itemRanking?.length">
                    <h3 class="font-medium mb-3">商品收入排行 TOP 10</h3>
                    <div class="overflow-x-auto">
                        <table class="table table-sm">
                            <thead><tr><th>商品</th><th>订单</th><th>收入</th><th>实际到账</th><th>退款</th><th>退款率</th></tr></thead>
                            <tbody>
                                <tr *ngFor="let item of revenue()?.itemRanking?.slice(0, 10)">
                                    <td class="max-w-[200px] truncate" [title]="item.title">{{ item.title || '未知商品' }}</td>
                                    <td>{{ item.count }}</td>
                                    <td class="text-primary font-medium">¥{{ item.revenue }}</td>
                                    <td class="text-info font-medium">¥{{ item.netIncome || 0 }}</td>
                                    <td class="text-error">{{ item.refunds || 0 }}</td>
                                    <td><span class="badge badge-sm" [class.badge-error]="item.refundRate > 20" [class.badge-warning]="item.refundRate > 10 && item.refundRate <= 20">{{ item.refundRate || 0 }}%</span></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <!-- 账号排行 -->
                <div class="card bg-base-100 shadow p-4" *ngIf="revenue()?.accountRanking?.length">
                    <h3 class="font-medium mb-3">账号收入排行 TOP 10</h3>
                    <div class="overflow-x-auto">
                        <table class="table table-sm">
                            <thead><tr><th>账号</th><th>订单</th><th>收入</th><th>实际到账</th><th>退款</th><th>退款率</th></tr></thead>
                            <tbody>
                                <tr *ngFor="let a of revenue()?.accountRanking?.slice(0, 10)">
                                    <td>
                                        <div class="font-medium">{{ a.accountNickname || a.accountId }}</div>
                                        <div class="text-[10px] text-base-content/40">{{ a.accountId }}</div>
                                    </td>
                                    <td>{{ a.count }}</td>
                                    <td class="text-primary font-medium">¥{{ a.revenue }}</td>
                                    <td class="text-info font-medium">¥{{ a.netIncome || 0 }}</td>
                                    <td class="text-error">{{ a.refunds || 0 }}</td>
                                    <td><span class="badge badge-sm" [class.badge-error]="a.refundRate > 20" [class.badge-warning]="a.refundRate > 10 && a.refundRate <= 20">{{ a.refundRate || 0 }}%</span></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- ============ 订单状态 ============ -->
            <div *ngIf="activeTab() === 'status'">
                <div class="flex gap-2 mb-4">
                    <select [(ngModel)]="statusDays" (ngModelChange)="loadOrderStatus()" class="select select-bordered select-sm">
                        <option [ngValue]="7">近7天</option>
                        <option [ngValue]="14">近14天</option>
                        <option [ngValue]="30">近30天</option>
                        <option [ngValue]="90">近90天</option>
                    </select>
                </div>
                <div class="stats shadow mb-4 w-full overflow-x-auto flex-wrap">
                    <div class="stat">
                        <div class="stat-title">总订单</div>
                        <div class="stat-value">{{ orderStatus()?.summary?.totalOrders || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">待发货</div>
                        <div class="stat-value text-warning">{{ orderStatus()?.summary?.pendingShipments || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">待确认</div>
                        <div class="stat-value text-secondary">{{ orderStatus()?.summary?.pendingConfirmOrders || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">交易成功</div>
                        <div class="stat-value text-success">{{ orderStatus()?.summary?.successOrders || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款订单</div>
                        <div class="stat-value text-error">{{ orderStatus()?.summary?.refundOrders || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">实际到账</div>
                        <div class="stat-value text-info">¥{{ orderStatus()?.summary?.netIncome || 0 }}</div>
                    </div>
                </div>
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">订单状态分布</h3>
                        <div class="space-y-2">
                            <div *ngFor="let s of orderStatus()?.groups || []" class="flex items-center gap-2">
                                <span class="text-sm w-36 truncate" [title]="s.label">{{ s.label }}</span>
                                <div class="flex-1 bg-base-200 rounded h-4 overflow-hidden">
                                    <div class="bg-primary h-full rounded" [style.width.%]="maxStatusOrders() > 0 ? (s.orderCount / maxStatusOrders()) * 100 : 0"></div>
                                </div>
                                <span class="text-sm font-medium w-12 text-right">{{ s.orderCount }}</span>
                            </div>
                        </div>
                    </div>
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">状态明细</h3>
                        <div class="overflow-x-auto">
                            <table class="table table-sm">
                                <thead><tr><th>状态</th><th>订单</th><th>收入</th><th>实际到账</th><th>退款</th><th>账号</th><th>商品</th></tr></thead>
                                <tbody>
                                    <tr *ngFor="let s of orderStatus()?.groups || []">
                                        <td>{{ s.label }}</td>
                                        <td>{{ s.orderCount }}</td>
                                        <td class="text-primary">¥{{ s.revenue }}</td>
                                        <td class="text-info">¥{{ s.netIncome }}</td>
                                        <td class="text-error">¥{{ s.refundAmount }}</td>
                                        <td>{{ s.accountCount }}</td>
                                        <td>{{ s.itemCount }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ============ 买家质量 ============ -->
            <div *ngIf="activeTab() === 'buyers'">
                <div class="flex gap-2 mb-4">
                    <select [(ngModel)]="buyerDays" (ngModelChange)="loadBuyerQuality()" class="select select-bordered select-sm">
                        <option [ngValue]="30">近30天</option>
                        <option [ngValue]="60">近60天</option>
                        <option [ngValue]="90">近90天</option>
                        <option [ngValue]="180">近180天</option>
                    </select>
                </div>
                <div class="stats shadow mb-4 w-full overflow-x-auto flex-wrap">
                    <div class="stat">
                        <div class="stat-title">买家数</div>
                        <div class="stat-value">{{ buyerQuality()?.summary?.buyerCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">复购买家</div>
                        <div class="stat-value text-success">{{ buyerQuality()?.summary?.repeatBuyerCount || 0 }}</div>
                        <div class="stat-desc">复购率 {{ buyerQuality()?.summary?.repeatRate || 0 }}%</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">高退款买家</div>
                        <div class="stat-value" [class.text-error]="(buyerQuality()?.summary?.highRiskBuyerCount || 0) > 0">
                            {{ buyerQuality()?.summary?.highRiskBuyerCount || 0 }}
                        </div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">人均订单</div>
                        <div class="stat-value">{{ buyerQuality()?.summary?.avgOrdersPerBuyer || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">实际到账</div>
                        <div class="stat-value text-info">¥{{ buyerQuality()?.summary?.netIncome || 0 }}</div>
                    </div>
                </div>
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">买家复购排行</h3>
                        <div class="overflow-x-auto">
                            <table class="table table-sm">
                                <thead><tr><th>买家</th><th>订单</th><th>商品</th><th>收入</th><th>实际到账</th><th>退款率</th><th>最近购买</th></tr></thead>
                                <tbody>
                                    <tr *ngFor="let b of buyerQuality()?.topBuyers?.slice(0, 20) || []" [ngClass]="{ 'bg-error/10': b.highRisk }">
                                        <td>
                                            <div class="font-medium" [class.text-error]="b.highRisk">{{ b.buyerNickname || b.buyerKey }}</div>
                                            <div class="text-[10px] text-base-content/40 max-w-[160px] truncate">{{ b.buyerKey }}</div>
                                        </td>
                                        <td>{{ b.orderCount }}</td>
                                        <td>{{ b.itemCount }}</td>
                                        <td class="text-primary">¥{{ b.revenue }}</td>
                                        <td class="text-info">¥{{ b.netIncome }}</td>
                                        <td><span class="badge badge-sm" [class.badge-error]="b.refundRate >= 50" [class.badge-warning]="b.refundRate >= 20 && b.refundRate < 50">{{ b.refundRate }}%</span></td>
                                        <td class="text-xs">{{ b.lastOrderTime?.slice(0, 10) || '-' }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">高退款买家</h3>
                        <div class="space-y-2" *ngIf="buyerQuality()?.highRiskBuyers?.length; else noRiskBuyers">
                            <div *ngFor="let b of buyerQuality()?.highRiskBuyers?.slice(0, 12)" class="flex items-center gap-2">
                                <span class="text-sm w-40 truncate text-error" [title]="b.buyerNickname || b.buyerKey">{{ b.buyerNickname || b.buyerKey }}</span>
                                <div class="flex-1 bg-base-200 rounded h-4 overflow-hidden">
                                    <div class="bg-error h-full rounded" [style.width.%]="maxBuyerOrders() > 0 ? (b.orderCount / maxBuyerOrders()) * 100 : 0"></div>
                                </div>
                                <span class="text-sm font-medium w-24 text-right">{{ b.refundOrders }}/{{ b.orderCount }} 单</span>
                            </div>
                        </div>
                        <ng-template #noRiskBuyers>
                            <div class="text-sm text-base-content/50 py-6 text-center">暂无高退款复购买家</div>
                        </ng-template>
                    </div>
                </div>
            </div>

            <!-- ============ 热门商品 ============ -->
            <div *ngIf="activeTab() === 'hotitems'">
                <div class="flex gap-2 mb-4 items-center flex-wrap">
                    <select [(ngModel)]="selectedHotGroupId" (ngModelChange)="loadHotItems()" class="select select-bordered select-sm">
                        <option [ngValue]="0">全部分组</option>
                        @for (g of groups(); track g.id) {
                            <option [ngValue]="g.id">{{ g.name }}</option>
                        }
                    </select>
                </div>
                <div class="overflow-x-auto">
                    <table class="table table-sm table-zebra">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>商品名称</th>
                                <th>账号</th>
                                <th>订单数</th>
                                <th>成功数</th>
                                <th>退款数</th>
                                <th>成功率</th>
                                <th>退款率</th>
                                <th>总收入</th>
                                <th>客单价</th>
                                <th>最近订单</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let item of hotItems(); let i = index">
                                <td class="font-bold">{{ i + 1 }}</td>
                                <td class="max-w-[200px] truncate" [title]="item.title">{{ item.title }}</td>
                                <td class="text-xs">{{ item.accountId }}</td>
                                <td><span class="badge badge-sm">{{ item.orderCount }}</span></td>
                                <td class="text-success">{{ item.successCount || 0 }}</td>
                                <td class="text-error">{{ item.refundCount || 0 }}</td>
                                <td>
                                    <span class="badge badge-sm" [class.badge-success]="item.successRate >= 80" [class.badge-warning]="item.successRate >= 50 && item.successRate < 80" [class.badge-error]="item.successRate < 50">
                                        {{ item.successRate }}%
                                    </span>
                                </td>
                                <td>
                                    <span class="badge badge-sm" [class.badge-error]="(item.refundRate || 0) > 20" [class.badge-warning]="(item.refundRate || 0) > 10 && (item.refundRate || 0) <= 20" [class.badge-success]="(item.refundRate || 0) <= 5">
                                        {{ item.refundRate || 0 }}%
                                    </span>
                                </td>
                                <td class="text-primary font-medium">¥{{ item.totalRevenue }}</td>
                                <td>¥{{ item.avgPrice }}</td>
                                <td class="text-xs">{{ item.lastOrder?.slice(0, 10) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- ============ 退款分析 ============ -->
            <div *ngIf="activeTab() === 'refunds'">
                <div class="flex gap-2 mb-4 items-center flex-wrap">
                    <select [(ngModel)]="selectedRefundGroupId" (ngModelChange)="loadRefunds()" class="select select-bordered select-sm">
                        <option [ngValue]="0">全部分组</option>
                        @for (g of groups(); track g.id) {
                            <option [ngValue]="g.id">{{ g.name }}</option>
                        }
                    </select>
                </div>
                <div class="flex gap-2 mb-4">
                    <select [(ngModel)]="refundDays" (ngModelChange)="loadRefunds()" class="select select-bordered select-sm">
                        <option [ngValue]="7">近7天</option>
                        <option [ngValue]="14">近14天</option>
                        <option [ngValue]="30">近30天</option>
                        <option [ngValue]="90">近90天</option>
                    </select>
                </div>
                <!-- 摘要 -->
                <div class="stats shadow mb-4 w-full overflow-x-auto">
                    <div class="stat">
                        <div class="stat-title">总订单</div>
                        <div class="stat-value">{{ refunds()?.summary?.totalOrders || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款订单</div>
                        <div class="stat-value text-error">{{ refunds()?.summary?.refundCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款率</div>
                        <div class="stat-value" [class.text-error]="(refunds()?.summary?.refundRate || 0) > 10">{{ refunds()?.summary?.refundRate || 0 }}%</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款总额</div>
                        <div class="stat-value text-warning">¥{{ refunds()?.summary?.totalRefundAmount || 0 }}</div>
                    </div>
                </div>
                <!-- 退款趋势 -->
                <div class="card bg-base-100 shadow p-4 mb-4">
                    <h3 class="font-medium mb-3">每日退款趋势</h3>
                    <div class="flex items-end gap-1 h-40 overflow-x-auto">
                        <div *ngFor="let d of refunds()?.daily || []" class="flex-1 min-w-[20px] flex flex-col items-center justify-end h-full" [title]="d.date + ': ' + d.refunds + '笔 退款率' + d.refundRate + '%'">
                            <span class="text-[10px] mb-0.5">{{ d.refunds }}</span>
                            <div class="w-full rounded-t bg-error opacity-70 transition-all"
                                [style.height.%]="maxRefunds() > 0 ? (d.refunds / maxRefunds()) * 100 : 0"
                                [style.min-height.px]="d.refunds > 0 ? 2 : 0"></div>
                            <span class="text-[9px] mt-0.5 -rotate-45 origin-top-left whitespace-nowrap">{{ d.date.slice(5) }}</span>
                        </div>
                    </div>
                </div>
                <!-- 按商品退款 -->
                <div class="card bg-base-100 shadow p-4 mb-4" *ngIf="refunds()?.byItem?.length">
                    <h3 class="font-medium mb-3">商品退款排行</h3>
                    <div class="overflow-x-auto">
                        <table class="table table-sm">
                            <thead><tr><th>商品</th><th>退款数</th><th>退款金额</th></tr></thead>
                            <tbody>
                                <tr *ngFor="let item of refunds()?.byItem?.slice(0, 10)">
                                    <td class="max-w-[250px] truncate" [title]="item.title">{{ item.title }}</td>
                                    <td class="text-error">{{ item.refunds }}</td>
                                    <td class="text-warning">¥{{ item.amount }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <!-- 退款原因 -->
                <div class="card bg-base-100 shadow p-4" *ngIf="refunds()?.byReason?.length">
                    <h3 class="font-medium mb-3">退款状态分布</h3>
                    <div class="space-y-2">
                        <div *ngFor="let r of refunds()?.byReason" class="flex items-center gap-2">
                            <span class="text-sm w-40 truncate" [title]="r.reason">{{ r.reason }}</span>
                            <div class="flex-1 bg-base-200 rounded h-4 overflow-hidden">
                                <div class="bg-warning h-full rounded" [style.width.%]="maxRefundReason() > 0 ? (r.count / maxRefundReason()) * 100 : 0"></div>
                            </div>
                            <span class="text-sm font-medium w-8 text-right">{{ r.count }}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ============ 分组分析 ============ -->
            <div *ngIf="activeTab() === 'groups'">
                <div class="flex gap-2 mb-4">
                    <select [(ngModel)]="groupDays" (ngModelChange)="loadGroupPerformance()" class="select select-bordered select-sm">
                        <option [ngValue]="7">近7天</option>
                        <option [ngValue]="14">近14天</option>
                        <option [ngValue]="30">近30天</option>
                        <option [ngValue]="90">近90天</option>
                    </select>
                </div>
                <div class="stats shadow mb-4 w-full overflow-x-auto flex-wrap">
                    <div class="stat">
                        <div class="stat-title">分组数</div>
                        <div class="stat-value">{{ groupPerformance()?.summary?.groupCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">分组商品</div>
                        <div class="stat-value">{{ groupPerformance()?.summary?.itemCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">分组订单</div>
                        <div class="stat-value">{{ groupPerformance()?.summary?.orderCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">实际到账</div>
                        <div class="stat-value text-info">¥{{ groupPerformance()?.summary?.netIncome || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">退款率</div>
                        <div class="stat-value" [class.text-error]="(groupPerformance()?.summary?.refundRate || 0) > 10">
                            {{ groupPerformance()?.summary?.refundRate || 0 }}%
                        </div>
                    </div>
                </div>
                <div class="card bg-base-100 shadow p-4">
                    <h3 class="font-medium mb-3">商品分组经营排行</h3>
                    <div class="overflow-x-auto">
                        <table class="table table-sm">
                            <thead><tr><th>分组</th><th>商品</th><th>订单</th><th>实付</th><th>实际到账</th><th>退款</th><th>退款率</th><th>客单价</th><th>最近订单</th></tr></thead>
                            <tbody>
                                <tr *ngFor="let g of groupPerformance()?.groups || []">
                                    <td class="font-medium">{{ g.groupName }}</td>
                                    <td>{{ g.itemCount }}</td>
                                    <td>{{ g.orderCount }}</td>
                                    <td class="text-primary">¥{{ g.revenue }}</td>
                                    <td class="text-info font-medium">¥{{ g.netIncome }}</td>
                                    <td class="text-error">¥{{ g.refundAmount }}</td>
                                    <td><span class="badge badge-sm" [class.badge-error]="g.refundRate > 20" [class.badge-warning]="g.refundRate > 10 && g.refundRate <= 20">{{ g.refundRate }}%</span></td>
                                    <td>¥{{ g.avgOrderValue }}</td>
                                    <td class="text-xs">{{ g.lastOrderTime?.slice(0, 10) || '-' }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- ============ 自动发货 ============ -->
            <div *ngIf="activeTab() === 'autosell'">
                <div class="flex gap-2 mb-4">
                    <select [(ngModel)]="autoSellDays" (ngModelChange)="loadAutoSell()" class="select select-bordered select-sm">
                        <option [ngValue]="3">近3天</option>
                        <option [ngValue]="7">近7天</option>
                        <option [ngValue]="14">近14天</option>
                        <option [ngValue]="30">近30天</option>
                    </select>
                </div>
                <div class="stats shadow mb-4 w-full overflow-x-auto flex-wrap">
                    <div class="stat">
                        <div class="stat-title">触发次数</div>
                        <div class="stat-value">{{ autoSell()?.summary?.total || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">成功</div>
                        <div class="stat-value text-success">{{ autoSell()?.summary?.success || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">失败</div>
                        <div class="stat-value text-error">{{ autoSell()?.summary?.failed || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">成功率</div>
                        <div class="stat-value" [class.text-success]="(autoSell()?.summary?.successRate || 0) >= 95" [class.text-error]="(autoSell()?.summary?.successRate || 0) < 90">
                            {{ autoSell()?.summary?.successRate || 0 }}%
                        </div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">发货数量</div>
                        <div class="stat-value">{{ autoSell()?.summary?.deliveredQuantity || 0 }}</div>
                    </div>
                </div>
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">规则健康度</h3>
                        <div class="overflow-x-auto">
                            <table class="table table-sm">
                                <thead><tr><th>规则</th><th>触发</th><th>成功</th><th>失败</th><th>成功率</th><th>数量</th></tr></thead>
                                <tbody>
                                    <tr *ngFor="let r of autoSell()?.byRule?.slice(0, 12) || []">
                                        <td class="max-w-[180px] truncate" [title]="r.ruleName">{{ r.ruleName }}</td>
                                        <td>{{ r.total }}</td>
                                        <td class="text-success">{{ r.success }}</td>
                                        <td class="text-error">{{ r.failed }}</td>
                                        <td><span class="badge badge-sm" [class.badge-success]="r.successRate >= 95" [class.badge-error]="r.successRate < 90">{{ r.successRate }}%</span></td>
                                        <td>{{ r.quantity }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div class="card bg-base-100 shadow p-4">
                        <h3 class="font-medium mb-3">失败原因</h3>
                        <div class="space-y-2" *ngIf="autoSell()?.byError?.length; else noAutoSellErrors">
                            <div *ngFor="let e of autoSell()?.byError?.slice(0, 10)" class="flex items-center gap-2">
                                <span class="text-sm w-48 truncate" [title]="e.reason">{{ e.reason }}</span>
                                <div class="flex-1 bg-base-200 rounded h-4 overflow-hidden">
                                    <div class="bg-error h-full rounded" [style.width.%]="maxAutoSellError() > 0 ? (e.count / maxAutoSellError()) * 100 : 0"></div>
                                </div>
                                <span class="text-sm font-medium w-8 text-right">{{ e.count }}</span>
                            </div>
                        </div>
                        <ng-template #noAutoSellErrors>
                            <div class="text-sm text-base-content/50 py-6 text-center">暂无失败记录</div>
                        </ng-template>
                    </div>
                </div>
                <div class="card bg-base-100 shadow p-4">
                    <h3 class="font-medium mb-3">库存池概览</h3>
                    <div class="overflow-x-auto">
                        <table class="table table-sm">
                            <thead><tr><th>库存来源规则</th><th>可用</th><th>总量</th><th>已用</th><th>关联规则</th><th>关联商品</th><th>预计可用天数</th></tr></thead>
                            <tbody>
                                <tr *ngFor="let p of autoSell()?.stockPools || []">
                                    <td class="max-w-[220px] truncate" [title]="p.ruleName">{{ p.ruleName }}</td>
                                    <td class="font-mono" [class.text-error]="p.available <= 5" [class.text-warning]="p.available > 5 && p.available <= 20">{{ p.available }}</td>
                                    <td class="font-mono">{{ p.total }}</td>
                                    <td class="font-mono">{{ p.used }}</td>
                                    <td>{{ p.relatedRuleCount }}</td>
                                    <td>{{ p.relatedItemCount }}</td>
                                    <td>{{ p.estimatedDays ?? '-' }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- ============ 账号经营 ============ -->
            <div *ngIf="activeTab() === 'accounts'">
                <div class="flex gap-2 mb-4">
                    <select [(ngModel)]="accountDays" (ngModelChange)="loadAccountPerformance()" class="select select-bordered select-sm">
                        <option [ngValue]="7">近7天</option>
                        <option [ngValue]="14">近14天</option>
                        <option [ngValue]="30">近30天</option>
                        <option [ngValue]="90">近90天</option>
                    </select>
                </div>
                <div class="stats shadow mb-4 w-full overflow-x-auto flex-wrap">
                    <div class="stat">
                        <div class="stat-title">账号数</div>
                        <div class="stat-value">{{ accountPerformance()?.summary?.accountCount || 0 }}</div>
                        <div class="stat-desc">启用 {{ accountPerformance()?.summary?.enabledCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">在线账号</div>
                        <div class="stat-value text-success">{{ accountPerformance()?.summary?.connectedCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">异常账号</div>
                        <div class="stat-value" [class.text-error]="(accountPerformance()?.summary?.offlineCount || 0) > 0">
                            {{ accountPerformance()?.summary?.offlineCount || 0 }}
                        </div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">订单</div>
                        <div class="stat-value">{{ accountPerformance()?.summary?.orderCount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">实际到账</div>
                        <div class="stat-value text-info">¥{{ accountPerformance()?.summary?.netIncome || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">待到账金额</div>
                        <div class="stat-value text-warning">¥{{ accountPerformance()?.summary?.pendingConfirmAmount || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">自动发货成功率</div>
                        <div class="stat-value" [class.text-success]="(accountPerformance()?.summary?.autoSellSuccessRate || 0) >= 95" [class.text-error]="(accountPerformance()?.summary?.autoSellSuccessRate || 0) < 90">
                            {{ accountPerformance()?.summary?.autoSellSuccessRate || 0 }}%
                        </div>
                    </div>
                </div>
                <div class="card bg-base-100 shadow p-4">
                    <h3 class="font-medium mb-3">账号经营排行</h3>
                    <div class="overflow-x-auto">
                        <table class="table table-sm">
                            <thead>
                                <tr>
                                    <th>账号</th><th>状态</th><th>订单</th><th>活跃商品</th><th>收入</th><th>实际到账</th><th>待到账</th><th>退款率</th><th>自动发货</th><th>最近订单</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let a of accountPerformance()?.accounts || []" [ngClass]="{ 'bg-error/10': a.offline }">
                                    <td>
                                        <div class="font-medium" [class.text-error]="a.offline">{{ a.accountNickname || a.accountId }}</div>
                                        <div class="text-[10px] text-base-content/40">{{ a.accountId }}</div>
                                    </td>
                                    <td>
                                        <span class="badge badge-sm" [class.badge-success]="a.connected && !a.errorMessage" [class.badge-error]="a.offline" [class.badge-ghost]="!a.enabled">
                                            {{ !a.enabled ? '停用' : (a.offline ? '异常' : '在线') }}
                                        </span>
                                        <div class="text-[10px] text-error max-w-[160px] truncate" *ngIf="a.errorMessage" [title]="a.errorMessage">{{ a.errorMessage }}</div>
                                    </td>
                                    <td>{{ a.orderCount }}</td>
                                    <td>{{ a.activeItems }}</td>
                                    <td class="text-primary">¥{{ a.revenue }}</td>
                                    <td class="text-info font-medium">¥{{ a.netIncome }}</td>
                                    <td class="text-warning">¥{{ a.pendingConfirmAmount || 0 }}</td>
                                    <td><span class="badge badge-sm" [class.badge-error]="a.refundRate > 20" [class.badge-warning]="a.refundRate > 10 && a.refundRate <= 20">{{ a.refundRate }}%</span></td>
                                    <td>
                                        <span class="badge badge-sm" [class.badge-success]="a.autoSell?.successRate >= 95" [class.badge-error]="a.autoSell?.successRate < 90 && a.autoSell?.total > 0">
                                            {{ a.autoSell?.successRate || 0 }}%
                                        </span>
                                        <div class="text-[10px] text-base-content/50">成功 {{ a.autoSell?.success || 0 }} / {{ a.autoSell?.total || 0 }}</div>
                                    </td>
                                    <td class="text-xs">{{ a.lastOrderTime?.slice(0, 10) || '-' }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- ============ 客服效率 ============ -->
            <div *ngIf="activeTab() === 'service'">
                <div class="flex gap-2 mb-4">
                    <select [(ngModel)]="serviceDays" (ngModelChange)="loadService()" class="select select-bordered select-sm">
                        <option [ngValue]="3">近3天</option>
                        <option [ngValue]="7">近7天</option>
                        <option [ngValue]="14">近14天</option>
                        <option [ngValue]="30">近30天</option>
                    </select>
                </div>
                <!-- 摘要 -->
                <div class="stats shadow mb-4 w-full overflow-x-auto flex-wrap">
                    <div class="stat">
                        <div class="stat-title">工作流执行</div>
                        <div class="stat-value">{{ service()?.summary?.workflowTotal || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">完成率</div>
                        <div class="stat-value text-success">{{ service()?.summary?.completionRate || 0 }}%</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">失败率</div>
                        <div class="stat-value" [class.text-error]="(service()?.summary?.failureRate || 0) > 10">{{ service()?.summary?.failureRate || 0 }}%</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">总消息</div>
                        <div class="stat-value">{{ service()?.summary?.totalMessages || 0 }}</div>
                    </div>
                    <div class="stat">
                        <div class="stat-title">收/发</div>
                        <div class="stat-value text-sm">{{ service()?.summary?.inboundMessages || 0 }}/{{ service()?.summary?.outboundMessages || 0 }}</div>
                    </div>
                </div>
                <!-- 库存使用 -->
                <div class="card bg-base-100 shadow p-4 mb-4" *ngIf="service()?.stock">
                    <h3 class="font-medium mb-3">库存使用情况</h3>
                    <div class="grid grid-cols-4 gap-4 text-center">
                        <div>
                            <div class="text-2xl font-bold">{{ service()?.stock?.total || 0 }}</div>
                            <div class="text-xs text-gray-500">总库存</div>
                        </div>
                        <div>
                            <div class="text-2xl font-bold text-warning">{{ service()?.stock?.used || 0 }}</div>
                            <div class="text-xs text-gray-500">已使用</div>
                        </div>
                        <div>
                            <div class="text-2xl font-bold text-success">{{ service()?.stock?.available || 0 }}</div>
                            <div class="text-xs text-gray-500">可用</div>
                        </div>
                        <div>
                            <div class="text-2xl font-bold" [class.text-error]="(service()?.stock?.usageRate || 0) > 80">{{ service()?.stock?.usageRate || 0 }}%</div>
                            <div class="text-xs text-gray-500">使用率</div>
                        </div>
                    </div>
                </div>
                <!-- 工作流执行状态 -->
                <div class="card bg-base-100 shadow p-4 mb-4" *ngIf="service()?.workflowExecution?.length">
                    <h3 class="font-medium mb-3">工作流执行状态</h3>
                    <div class="space-y-2">
                        <div *ngFor="let w of service()?.workflowExecution" class="flex items-center gap-2">
                            <span class="badge badge-sm" [class.badge-success]="w.status === 'completed'" [class.badge-error]="w.status === 'failed'" [class.badge-warning]="w.status === 'waiting'" [class.badge-info]="w.status !== 'completed' && w.status !== 'failed' && w.status !== 'waiting'">
                                {{ w.status }}
                            </span>
                            <div class="flex-1 bg-base-200 rounded h-4 overflow-hidden">
                                <div class="h-full rounded"
                                    [class.bg-success]="w.status === 'completed'"
                                    [class.bg-error]="w.status === 'failed'"
                                    [class.bg-warning]="w.status === 'waiting'"
                                    [class.bg-info]="w.status !== 'completed' && w.status !== 'failed' && w.status !== 'waiting'"
                                    [style.width.%]="maxWfCount() > 0 ? (w.count / maxWfCount()) * 100 : 0"></div>
                            </div>
                            <span class="text-sm font-medium w-12 text-right">{{ w.count }}</span>
                        </div>
                    </div>
                </div>
                <!-- 每日消息量 -->
                <div class="card bg-base-100 shadow p-4 mb-4">
                    <h3 class="font-medium mb-3">每日消息量</h3>
                    <div class="flex items-end gap-1 h-40 overflow-x-auto">
                        <div *ngFor="let d of service()?.daily || []" class="flex-1 min-w-[20px] flex flex-col items-center justify-end h-full" [title]="d.date + ': 收' + d.inbound + ' 发' + d.outbound">
                            <div class="w-full flex flex-col items-center justify-end" style="height:100%">
                                <div class="w-full rounded-t bg-secondary opacity-70 mb-0.5"
                                    [style.height.%]="maxMsgs() > 0 ? (d.outbound / maxMsgs()) * 80 : 0"
                                    [style.min-height.px]="d.outbound > 0 ? 2 : 0"></div>
                                <div class="w-full rounded-t bg-info opacity-70"
                                    [style.height.%]="maxMsgs() > 0 ? (d.inbound / maxMsgs()) * 80 : 0"
                                    [style.min-height.px]="d.inbound > 0 ? 2 : 0"></div>
                            </div>
                            <span class="text-[9px] mt-0.5 -rotate-45 origin-top-left whitespace-nowrap">{{ d.date.slice(5) }}</span>
                        </div>
                    </div>
                    <div class="flex gap-4 mt-2 text-xs justify-center">
                        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-info inline-block"></span>收到</span>
                        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-secondary inline-block"></span>发送</span>
                    </div>
                </div>
                <!-- 24小时消息分布 -->
                <div class="card bg-base-100 shadow p-4" *ngIf="service()?.hourly?.length">
                    <h3 class="font-medium mb-3">24小时消息分布</h3>
                    <div class="flex items-end gap-0.5 h-32">
                        <div *ngFor="let h of service()?.hourly || []" class="flex-1 flex flex-col items-center justify-end h-full" [title]="h.hour + '点: 收' + h.inbound + ' 发' + h.outbound">
                            <div class="w-full rounded-t bg-secondary opacity-50"
                                [style.height.%]="maxHourlyMsgs() > 0 ? (h.outbound / maxHourlyMsgs()) * 50 : 0"
                                [style.min-height.px]="h.outbound > 0 ? 1 : 0"></div>
                            <div class="w-full rounded-t bg-info opacity-50"
                                [style.height.%]="maxHourlyMsgs() > 0 ? (h.inbound / maxHourlyMsgs()) * 50 : 0"
                                [style.min-height.px]="h.inbound > 0 ? 1 : 0"></div>
                        </div>
                    </div>
                    <div class="flex justify-between text-[8px] mt-1 text-gray-500">
                        <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
                    </div>
                </div>
            </div>
        </div>
    `,
    styles: [`:host { display: block; padding: 1rem; }`]
})
export class SystemReportsComponent implements OnInit {
    private readonly reportService = inject(ReportService);
    private readonly groupService = inject(ItemGroupService);
    readonly icons = ICONS;

    activeTab = signal<string>('overview');
    loading = signal<boolean>(false);

    overview = signal<any>(null);
    revenue = signal<any>(null);
    hotItems = signal<any[]>([]);
    refunds = signal<any>(null);
    service = signal<any>(null);
    groupPerformance = signal<any>(null);
    autoSell = signal<any>(null);
    accountPerformance = signal<any>(null);
    orderStatus = signal<any>(null);
    buyerQuality = signal<any>(null);

    revenueDays = 30;
    refundDays = 30;
    serviceDays = 7;
    groupDays = 30;
    autoSellDays = 7;
    accountDays = 30;
    statusDays = 30;
    buyerDays = 90;
    revenueStartDate = '';
    revenueEndDate = '';
    selectedGroupId = 0;
    selectedHotGroupId = 0;
    selectedRefundGroupId = 0;
    groups = signal<any[]>([]);
    revenueQuickPreset = signal<'today' | 'yesterday' | 'days'>('days');

    maxRevenue = signal<number>(0);
    maxHourlyOrders = signal<number>(0);
    maxRefunds = signal<number>(0);
    maxRefundReason = signal<number>(0);
    maxWfCount = signal<number>(0);
    maxMsgs = signal<number>(0);
    maxHourlyMsgs = signal<number>(0);
    maxAutoSellError = signal<number>(0);
    maxStatusOrders = signal<number>(0);
    maxBuyerOrders = signal<number>(0);

    ngOnInit() {
        this.loadGroups();
        this.loadOverview();
        this.loadRevenue();
        this.loadHotItems();
        this.loadRefunds();
        this.loadService();
        this.loadGroupPerformance();
        this.loadAutoSell();
        this.loadAccountPerformance();
        this.loadOrderStatus();
        this.loadBuyerQuality();
    }

    async loadOverview() {
        try { this.overview.set(await this.reportService.getOverview()); } catch (e) { console.error('loadOverview', e); }
    }

    async loadGroups() {
        try {
            const data = await this.groupService.getGroups();
            this.groups.set(data);
        } catch (e) { console.error('loadGroups', e); }
    }

    async loadRevenue() {
        try {
            this.revenueQuickPreset.set('days');
            const groupId = this.selectedGroupId > 0 ? this.selectedGroupId : undefined;
            const data = await this.reportService.getRevenue('day', this.revenueDays, undefined, undefined, groupId);
            this.revenue.set(data);
            const daily = data?.daily || [];
            this.maxRevenue.set(daily.reduce((m: number, d: any) => Math.max(m, d.netIncome || d.actualRevenue || d.revenue), 0));
            const hourly = data?.hourly || [];
            this.maxHourlyOrders.set(hourly.reduce((m: number, h: any) => Math.max(m, h.orders), 0));
        } catch (e) { console.error('loadRevenue', e); }
    }

    async loadRevenueByDate() {
        if (!this.revenueStartDate || !this.revenueEndDate) {
            alert('请选择开始和结束日期');
            return;
        }
        try {
            this.revenueQuickPreset.set('days');
            const groupId = this.selectedGroupId > 0 ? this.selectedGroupId : undefined;
            const data = await this.reportService.getRevenue('day', 365, this.revenueStartDate, this.revenueEndDate, groupId);
            this.revenue.set(data);
            const daily = data?.daily || [];
            this.maxRevenue.set(daily.reduce((m: number, d: any) => Math.max(m, d.netIncome || d.actualRevenue || d.revenue), 0));
            const hourly = data?.hourly || [];
            this.maxHourlyOrders.set(hourly.reduce((m: number, h: any) => Math.max(m, h.orders), 0));
        } catch (e) { console.error('loadRevenueByDate', e); }
    }

    clearDateFilter() {
        this.revenueStartDate = '';
        this.revenueEndDate = '';
        this.revenueQuickPreset.set('days');
        this.loadRevenue();
    }

    async loadRevenuePreset(preset: 'today' | 'yesterday') {
        const now = new Date();
        const target = new Date(now);
        if (preset === 'yesterday') {
            target.setDate(target.getDate() - 1);
        }
        const date = this.toDateInputValue(target);
        this.revenueStartDate = date;
        this.revenueEndDate = date;
        this.revenueQuickPreset.set(preset);
        await this.loadRevenueByDate();
    }

    private toDateInputValue(date: Date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    async loadHotItems() {
        try {
            const groupId = this.selectedHotGroupId > 0 ? this.selectedHotGroupId : undefined;
            this.hotItems.set(await this.reportService.getHotItems(50, groupId));
        } catch (e) { console.error('loadHotItems', e); }
    }

    async loadRefunds() {
        try {
            const groupId = this.selectedRefundGroupId > 0 ? this.selectedRefundGroupId : undefined;
            const data = await this.reportService.getRefunds(this.refundDays, groupId);
            this.refunds.set(data);
            const daily = data?.daily || [];
            this.maxRefunds.set(daily.reduce((m: number, d: any) => Math.max(m, d.refunds), 0));
            const reasons = data?.byReason || [];
            this.maxRefundReason.set(reasons.reduce((m: number, r: any) => Math.max(m, r.count), 0));
        } catch (e) { console.error('loadRefunds', e); }
    }

    async loadService() {
        try {
            const data = await this.reportService.getService(this.serviceDays);
            this.service.set(data);
            const wf = data?.workflowExecution || [];
            this.maxWfCount.set(wf.reduce((m: number, w: any) => Math.max(m, w.count), 0));
            const daily = data?.daily || [];
            this.maxMsgs.set(daily.reduce((m: number, d: any) => Math.max(m, d.total), 0));
            const hourly = data?.hourly || [];
            this.maxHourlyMsgs.set(hourly.reduce((m: number, h: any) => Math.max(m, h.total), 0));
        } catch (e) { console.error('loadService', e); }
    }

    async loadGroupPerformance() {
        try {
            this.groupPerformance.set(await this.reportService.getGroups(this.groupDays));
        } catch (e) { console.error('loadGroupPerformance', e); }
    }

    async loadAutoSell() {
        try {
            const data = await this.reportService.getAutoSell(this.autoSellDays);
            this.autoSell.set(data);
            const errors = data?.byError || [];
            this.maxAutoSellError.set(errors.reduce((m: number, e: any) => Math.max(m, e.count), 0));
        } catch (e) { console.error('loadAutoSell', e); }
    }

    async loadAccountPerformance() {
        try {
            this.accountPerformance.set(await this.reportService.getAccounts(this.accountDays));
        } catch (e) { console.error('loadAccountPerformance', e); }
    }

    async loadOrderStatus() {
        try {
            const data = await this.reportService.getStatus(this.statusDays);
            this.orderStatus.set(data);
            const groups = data?.groups || [];
            this.maxStatusOrders.set(groups.reduce((m: number, s: any) => Math.max(m, s.orderCount), 0));
        } catch (e) { console.error('loadOrderStatus', e); }
    }

    async loadBuyerQuality() {
        try {
            const data = await this.reportService.getBuyers(this.buyerDays);
            this.buyerQuality.set(data);
            const buyers = data?.topBuyers || [];
            this.maxBuyerOrders.set(buyers.reduce((m: number, b: any) => Math.max(m, b.orderCount), 0));
        } catch (e) { console.error('loadBuyerQuality', e); }
    }
}
