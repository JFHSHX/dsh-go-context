import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
const checker = process.env.DSH_GO_PLUGIN_CHECKER || join(home, 'skills/dsh-go-plugin/kit/bin/check.mjs')
if (!existsSync(checker)) {
  console.error('找不到 dsh-go-plugin 检查器；请在本机 dsh-go 环境运行，或设置 DSH_GO_PLUGIN_CHECKER。')
  process.exit(2)
}
const root = new URL('..', import.meta.url).pathname
for (const name of readdirSync(join(root, 'plugins')).sort()) {
  const plugin = join(root, 'plugins', name)
  const result = spawnSync(process.execPath, [checker, plugin, '--load', '--budget', 'panel', '--budget', 'strip', '--lang', 'zh'], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
