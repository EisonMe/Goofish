import { Hono } from 'hono'
import {
    getGroups,
    getGroupById,
    createGroup,
    updateGroup,
    deleteGroup,
    addItemsToGroup,
    removeItemFromGroup,
    getAvailableItems
} from '../../services/item-group.service.js'

export function createItemGroupRoutes() {
    const router = new Hono()

    // 获取所有分组
    router.get('/', (c) => {
        return c.json(getGroups())
    })

    // 获取可用商品列表
    router.get('/available-items', async (c) => {
        return c.json(await getAvailableItems())
    })

    // 获取分组详情
    router.get('/:id', (c) => {
        const id = parseInt(c.req.param('id'))
        const group = getGroupById(id)
        if (!group) return c.json({ error: '分组不存在' }, 404)
        return c.json(group)
    })

    // 创建分组
    router.post('/', async (c) => {
        const body = await c.req.json()
        if (!body.name) return c.json({ error: '分组名称不能为空' }, 400)
        const group = createGroup(body.name, body.description)
        return c.json(group, 201)
    })

    // 更新分组
    router.put('/:id', async (c) => {
        const id = parseInt(c.req.param('id'))
        const body = await c.req.json()
        if (!body.name) return c.json({ error: '分组名称不能为空' }, 400)
        try {
            const group = updateGroup(id, body.name, body.description)
            return c.json(group)
        } catch (e: any) {
            return c.json({ error: e.message }, 404)
        }
    })

    // 删除分组
    router.delete('/:id', (c) => {
        const id = parseInt(c.req.param('id'))
        deleteGroup(id)
        return c.json({ success: true })
    })

    // 添加商品到分组
    router.post('/:id/items', async (c) => {
        const id = parseInt(c.req.param('id'))
        const body = await c.req.json()
        if (!body.items || !Array.isArray(body.items)) {
            return c.json({ error: 'items 参数必须是数组' }, 400)
        }
        try {
            const result = addItemsToGroup(id, body.items)
            return c.json(result)
        } catch (e: any) {
            return c.json({ error: e.message }, 404)
        }
    })

    // 从分组移除商品
    router.delete('/:id/items/:itemId', (c) => {
        const id = parseInt(c.req.param('id'))
        const itemId = c.req.param('itemId')
        const accountId = c.req.query('accountId') || ''
        removeItemFromGroup(id, itemId, accountId)
        return c.json({ success: true })
    })

    return router
}
