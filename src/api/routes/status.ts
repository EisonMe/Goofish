import { Hono } from 'hono'
import { messageStore } from '../message.store.js'
import type { ClientManager } from '../../websocket/client.manager.js'
import { getSetting, setSetting } from '../../db/settings.repository.js'

export function createStatusRoutes(getClientManager: () => ClientManager | null) {
    const router = new Hono()

    // 健康检查
    router.get('/health', (c) => {
        return c.json({ status: 'ok', timestamp: Date.now() })
    })

    // 获取整体状态
    router.get('/status', (c) => {
        const clientManager = getClientManager()
        if (!clientManager) {
            return c.json({ error: 'ClientManager not initialized' }, 500)
        }
        return c.json({
            clients: clientManager.getStatus(),
            activeCount: clientManager.getActiveCount(),
            messageCount: messageStore.count()
        })
    })
    
    // 获取系统时间信息
    router.get('/time', (c) => {
        const now = new Date()
        const timezoneSetting = getSetting('system_timezone') || 'Asia/Shanghai'

        return c.json({
            utc_time: now.toISOString(),
            local_time: now.toLocaleString('zh-CN', { timeZone: timezoneSetting }),
            local_formatted: now.toLocaleString('zh-CN', { timeZone: timezoneSetting, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
            timezone: timezoneSetting,
            timezone_offset: '+8:00',
            timestamp: now.getTime()
        })
    })
    
    // 获取时区设置
    router.get('/timezone', (c) => {
        const timezoneSetting = getSetting('system_timezone') || 'Asia/Shanghai'
        return c.json({ timezone: timezoneSetting })
    })
    
    // 设置时区
    router.put('/timezone', async (c) => {
        const body = await c.req.json()
        const { timezone } = body
        
        if (!timezone) {
            return c.json({ error: '时区参数不能为空' }, 400)
        }
        
        setSetting('system_timezone', timezone)
        return c.json({ success: true, timezone })
    })

    return router
}
