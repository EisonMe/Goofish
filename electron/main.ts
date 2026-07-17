import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
    app,
    BrowserWindow,
    dialog,
    Menu,
    nativeImage,
    shell,
    Tray,
    type MenuItemConstructorOptions
} from 'electron'

interface BackendModule {
    main: () => Promise<void>
    shutdown: () => Promise<void>
}

const APP_ID = 'com.lrzy8.goofish'
const APP_NAME = 'Goofish'

let backend: BackendModule | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let localUrl = ''
let runtimeDir = ''
let quitting = false
let shutdownComplete = false
let quitPromise: Promise<void> | null = null

function getAssetPath(...segments: string[]) {
    const baseDir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build')
    return path.join(baseDir, ...segments)
}

function findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.unref()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('无法分配本地服务端口'))
                return
            }

            const { port } = address
            server.close((error) => {
                if (error) reject(error)
                else resolve(port)
            })
        })
    })
}

function prepareRuntime(resourcePath: string) {
    runtimeDir = path.join(app.getPath('userData'), 'runtime')
    const sourcePublicDir = path.join(resourcePath, 'public')

    if (!existsSync(sourcePublicDir)) {
        throw new Error(`找不到前端资源目录: ${sourcePublicDir}`)
    }

    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(path.join(runtimeDir, 'data'), { recursive: true })
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true })

    return sourcePublicDir
}

function isStartHidden() {
    if (process.argv.includes('--hidden')) return true
    return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden
}

function showWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
}

function hideWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.hide()
}

function toggleWindow() {
    if (mainWindow?.isVisible()) hideWindow()
    else showWindow()
}

function isLocalAppUrl(url: string) {
    try {
        return new URL(url).origin === localUrl
    } catch {
        return false
    }
}

function openExternalUrl(url: string) {
    try {
        const protocol = new URL(url).protocol
        if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
    } catch {
        // Ignore malformed URLs emitted by the renderer.
    }
}

function rebuildTrayMenu() {
    if (!tray || tray.isDestroyed()) return

    const template: MenuItemConstructorOptions[] = [
        {
            label: mainWindow?.isVisible() ? '隐藏窗口' : '显示窗口',
            click: toggleWindow
        },
        {
            label: '在浏览器中打开',
            click: () => {
                if (localUrl) void shell.openExternal(localUrl)
            }
        },
        {
            label: '打开数据目录',
            click: () => {
                if (!runtimeDir) return
                void shell.openPath(path.join(runtimeDir, 'data')).then((error) => {
                    if (error) console.error(`打开数据目录失败: ${error}`)
                })
            }
        },
        { type: 'separator' }
    ]

    if (process.platform === 'win32' || process.platform === 'darwin') {
        template.push({
            label: '开机自动启动',
            type: 'checkbox',
            enabled: app.isPackaged,
            checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
            click: (menuItem) => {
                app.setLoginItemSettings({
                    openAtLogin: menuItem.checked,
                    ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}),
                    ...(process.platform === 'darwin' ? { openAsHidden: true } : {})
                })
                rebuildTrayMenu()
            }
        })
        template.push({ type: 'separator' })
    }

    template.push({
        label: '退出',
        click: () => void requestQuit()
    })

    tray.setContextMenu(Menu.buildFromTemplate(template))
}

function createTray() {
    const trayFile = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
    const trayImage = nativeImage.createFromPath(getAssetPath('tray', trayFile))
    if (trayImage.isEmpty()) {
        throw new Error(`无法加载托盘图标: ${trayFile}`)
    }
    if (process.platform === 'darwin') trayImage.setTemplateImage(true)

    tray = new Tray(trayImage)
    tray.setToolTip(`${APP_NAME} 闲鱼助手`)
    tray.on('click', toggleWindow)
    tray.on('double-click', showWindow)
    rebuildTrayMenu()
}

async function createMainWindow(startHidden: boolean) {
    const window = new BrowserWindow({
        title: APP_NAME,
        width: 1320,
        height: 860,
        minWidth: 980,
        minHeight: 680,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#f5f6f8',
        icon: getAssetPath('icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
        }
    })

    window.on('close', (event) => {
        if (!quitting) {
            event.preventDefault()
            window.hide()
        }
    })
    window.on('closed', () => {
        mainWindow = null
    })
    window.on('show', rebuildTrayMenu)
    window.on('hide', rebuildTrayMenu)
    window.once('ready-to-show', () => {
        if (!startHidden) window.show()
    })

    window.webContents.setWindowOpenHandler(({ url }) => {
        if (!isLocalAppUrl(url)) openExternalUrl(url)
        return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
        if (isLocalAppUrl(url)) return
        event.preventDefault()
        openExternalUrl(url)
    })

    await window.loadURL(localUrl)
    return window
}

function configureApplicationMenu() {
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null)
        return
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: APP_NAME,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        { role: 'editMenu' },
        { role: 'windowMenu' }
    ]))
}

async function initialize() {
    app.setAppUserModelId(APP_ID)
    app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: app.getVersion(),
        copyright: 'Goofish contributors'
    })

    const appPath = app.getAppPath()
    const resourcePath = app.isPackaged ? process.resourcesPath : appPath
    const staticDir = prepareRuntime(resourcePath)

    const port = await findAvailablePort()
    process.env.HOST = '127.0.0.1'
    process.env.PORT = String(port)
    process.env.NODE_ENV = 'production'
    process.env.GOOFISH_DESKTOP = '1'
    process.env.GOOFISH_STATIC_DIR = staticDir
    process.chdir(runtimeDir)

    const backendEntry = path.join(appPath, 'dist', 'index.js')
    const loadedBackend = await import(pathToFileURL(backendEntry).href) as Partial<BackendModule>
    if (typeof loadedBackend.main !== 'function' || typeof loadedBackend.shutdown !== 'function') {
        throw new Error('后端入口未导出 main() 和 shutdown()')
    }
    backend = loadedBackend as BackendModule
    await backend.main()

    localUrl = `http://127.0.0.1:${port}`
    configureApplicationMenu()
    mainWindow = await createMainWindow(isStartHidden())
    createTray()
}

function requestQuit() {
    if (quitPromise) return quitPromise

    quitting = true
    quitPromise = (async () => {
        try {
            await backend?.shutdown()
        } catch (error) {
            console.error('关闭后端服务失败:', error)
        } finally {
            backend = null
            shutdownComplete = true
            tray?.destroy()
            tray = null
            app.quit()
        }
    })()
    return quitPromise
}

app.setName(APP_NAME)

if (!app.requestSingleInstanceLock()) {
    app.quit()
} else {
    app.on('second-instance', showWindow)
    app.on('activate', showWindow)
    app.on('before-quit', (event) => {
        if (shutdownComplete) return
        event.preventDefault()
        void requestQuit()
    })

    app.whenReady()
        .then(initialize)
        .catch((error) => {
            console.error('桌面应用启动失败:', error)
            dialog.showErrorBox('Goofish 启动失败', error instanceof Error ? error.message : String(error))
            void requestQuit()
        })
}
