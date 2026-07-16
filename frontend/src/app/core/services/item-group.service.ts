import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ItemGroupService {
    private readonly baseUrl = '/api/item-groups';

    async getGroups() {
        const res = await fetch(this.baseUrl);
        return res.json();
    }

    async getGroup(id: number) {
        const res = await fetch(`${this.baseUrl}/${id}`);
        return res.json();
    }

    async getAvailableItems() {
        const res = await fetch(`${this.baseUrl}/available-items`);
        return res.json();
    }

    async createGroup(name: string, description?: string) {
        const res = await fetch(this.baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
        });
        return res.json();
    }

    async updateGroup(id: number, name: string, description?: string) {
        const res = await fetch(`${this.baseUrl}/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
        });
        return res.json();
    }

    async deleteGroup(id: number) {
        const res = await fetch(`${this.baseUrl}/${id}`, { method: 'DELETE' });
        return res.json();
    }

    async addItems(groupId: number, items: { itemId: string; itemTitle: string; accountId: string }[]) {
        const res = await fetch(`${this.baseUrl}/${groupId}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        return res.json();
    }

    async removeItem(groupId: number, itemId: string, accountId: string) {
        const res = await fetch(`${this.baseUrl}/${groupId}/items/${itemId}?accountId=${accountId}`, {
            method: 'DELETE'
        });
        return res.json();
    }
}
