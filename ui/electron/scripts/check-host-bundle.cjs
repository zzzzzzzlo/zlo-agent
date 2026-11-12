const { access, readFile } = require('node:fs/promises')
const { join } = require('node:path')

module.exports = async ({ appOutDir, electronPlatformName }) => {
  if (electronPlatformName !== 'win32') return
  const host = join(appOutDir, 'resources', 'agent-host')
  const { dependencies } = JSON.parse(await readFile(join(host, 'package.json'), 'utf8'))
  await access(join(host, 'src', 'cli.ts'))
  await access(join(appOutDir, 'resources', 'shared', 'contracts', 'desktop.ts'))
  await access(join(appOutDir, 'resources', 'shared', 'diagnostics.ts'))
  await access(join(appOutDir, 'resources', 'shared', 'loopback-http.ts'))
  for (const dependency of Object.keys(dependencies)) {
    await access(join(host, 'node_modules', dependency, 'package.json'))
  }
}
