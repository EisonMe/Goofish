import { Injectable, inject } from '@angular/core';

import { HttpService } from '../utils';
import { API_BASE } from '../constants/api.constants';
import type { Order, OrderListResponse, OrderAutoSellDebug, AutoSellAnomalyItem } from '../types';

export interface OrderQueryOptions {
    accountId?: string;
    groupId?: number;
    status?: number;
    keyword?: string;
    hasRefund?: boolean;
    pendingRedelivery?: boolean;
    orderTimeStart?: string;
    limit?: number;
    offset?: number;
}

@Injectable({ providedIn: 'root' })
export class OrderService {
    private http = inject(HttpService);

    getOrders(options: OrderQueryOptions = {}) {
        const { limit = 50, offset = 0, ...rest } = options;
        return this.http.get<OrderListResponse>('/api/orders', { ...rest, limit, offset });
    }

    getOrder(orderId: string) {
        return this.http.get<{ order: Order }>(`/api/orders/${orderId}`);
    }

    getAutoSellDebug(orderId: string) {
        return this.http.get<OrderAutoSellDebug>(`/api/orders/${orderId}/autosell-debug`);
    }

    getAutoSellAnomalies(limit = 20) {
        return this.http.get<{ anomalies: AutoSellAnomalyItem[]; total: number }>(
            '/api/orders/autosell/anomalies',
            { limit }
        );
    }

    async exportAutoSellSupplementSheet(limit = 1000) {
        const url = `${API_BASE}/api/orders/autosell/anomalies/export?limit=${limit}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`导出失败: ${response.status}`);
        }

        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/i);
        const fileName = match?.[1] || 'autosell-supplement-sheet.csv';

        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);

        return fileName;
    }

    refreshOrder(orderId: string) {
        return this.http.post<{ success: boolean; order?: Order; error?: string }>(
            `/api/orders/${orderId}/refresh`
        );
    }

    refreshAllOrders() {
        return this.http.post<{
            success: boolean;
            summary?: { total: number; refreshed: number; failed: number; skipped: number; errors: string[] };
            error?: string;
        }>('/api/orders/refresh-all');
    }

    refreshRecentOrders(days: number) {
        return this.http.post<{
            success: boolean;
            summary?: { total: number; refreshed: number; failed: number; skipped: number; errors: string[] };
            error?: string;
        }>('/api/orders/refresh-recent', { days });
    }

    redeliverMissing(orderId: string) {
        return this.http.post<{
            success: boolean;
            order?: Order;
            deliveredQuantity?: number;
            remainingQuantity?: number;
            content?: string;
            error?: string;
        }>(`/api/orders/${orderId}/redeliver-missing`);
    }

    fetchOrder(accountId: string, orderId: string) {
        return this.http.post<{ success: boolean; order?: Order; error?: string }>(
            '/api/orders/fetch', { accountId, orderId }
        );
    }

    shipOrder(orderId: string) {
        return this.http.post<{ success: boolean; order?: Order; error?: string }>(
            `/api/orders/${orderId}/ship`
        );
    }

    freeShipOrder(orderId: string) {
        return this.http.post<{ success: boolean; order?: Order; error?: string }>(
            `/api/orders/${orderId}/freeship`
        );
    }

    deleteOrder(orderId: string) {
        return this.http.delete<{ success: boolean; message?: string; error?: string }>(
            `/api/orders/${orderId}`
        );
    }
}
