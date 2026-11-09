import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ui = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
const out = join(ui, 'out')
const destination = join(out, 'agent-host')
const host = join(dirname(ui), 'host')

await mkdir(out, { recursive: true })
if (!(await lstat(out)).isDirectory() || await realpath(out) !== out) {
  throw new Error('Refusing to stage Host through a redirected build directory')
}

const existing = await lstat(destination).catch((error) => {
  if (error.code !== 'ENOENT') throw error
})
if (existing) {
  if (!existing.isDirectory() || await realpath(destination) !== destination) {
    throw new Error('Refusing to replace a redirected Host staging directory')
  }
  await rm(destination, { recursive: true, force: true })
}

await mkdir(destination)
for (const file of ['package.json', 'package-lock.json', 'src']) {
  await cp(join(host, file), join(destination, file), { recursive: true })
}

const npm = process.env.npm_execpath
if (!npm) throw new Error('Run Host staging through npm')
const result = spawnSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: destination, stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
if (result.status !== 0) process.exitCode = result.status ?? 1
