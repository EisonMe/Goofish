import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ReportService {
    private readonly baseUrl = '/api/reports';

    async getRevenue(period = 'day', days = 30, startDate?: string, endDate?: string, groupId?: number) {
        let url = `${this.baseUrl}/revenue?period=${period}&days=${days}`;
        if (startDate && endDate) {
            url += `&startDate=${startDate}&endDate=${endDate}`;
        }
        if (groupId) {
            url += `&groupId=${groupId}`;
        }
        const res = await fetch(url);
        return res.json();
    }

    async getOverview() {
        const res = await fetch(`${this.baseUrl}/overview`);
        return res.json();
    }

    async getHotItems(limit = 20, groupId?: number) {
        let url = `${this.baseUrl}/hot-items?limit=${limit}`;
        if (groupId) url += `&groupId=${groupId}`;
        const res = await fetch(url);
        return res.json();
    }

    async getRefunds(days = 30, groupId?: number) {
        let url = `${this.baseUrl}/refunds?days=${days}`;
        if (groupId) url += `&groupId=${groupId}`;
        const res = await fetch(url);
        return res.json();
    }

    async getService(days = 7) {
        const res = await fetch(`${this.baseUrl}/service?days=${days}`);
        return res.json();
    }

    async getGroups(days = 30) {
        const res = await fetch(`${this.baseUrl}/groups?days=${days}`);
        return res.json();
    }

    async getAutoSell(days = 7) {
        const res = await fetch(`${this.baseUrl}/autosell?days=${days}`);
        return res.json();
    }

    async getAccounts(days = 30) {
        const res = await fetch(`${this.baseUrl}/accounts?days=${days}`);
        return res.json();
    }

    async getStatus(days = 30) {
        const res = await fetch(`${this.baseUrl}/status?days=${days}`);
        return res.json();
    }

    async getBuyers(days = 90) {
        const res = await fetch(`${this.baseUrl}/buyers?days=${days}`);
        return res.json();
    }
}
