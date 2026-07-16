import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Resvg } from '@resvg/resvg-js'

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const buildDir = path.join(rootDir, 'build')
const trayDir = path.join(buildDir, 'tray')

async function renderSvg(sourceFile, targetFile, width) {
    const source = await readFile(sourceFile, 'utf8')
    const renderer = new Resvg(source, {
        background: 'rgba(0, 0, 0, 0)',
        fitTo: { mode: 'width', value: width }
    })
    await writeFile(targetFile, renderer.render().asPng())
}

await mkdir(trayDir, { recursive: true })

const iconSource = path.join(buildDir, 'icon.svg')
const traySource = path.join(buildDir, 'tray.svg')

await Promise.all([
    renderSvg(iconSource, path.join(buildDir, 'icon.png'), 1024),
    renderSvg(iconSource, path.join(trayDir, 'tray.png'), 32),
    renderSvg(iconSource, path.join(trayDir, 'tray@2x.png'), 64),
    renderSvg(traySource, path.join(trayDir, 'trayTemplate.png'), 18),
    renderSvg(traySource, path.join(trayDir, 'trayTemplate@2x.png'), 36)
])

console.log('Generated desktop and tray icons')
