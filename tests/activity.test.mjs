import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFleet, buildFiles, buildCommands, activityMarkdown } from '../plugins/local-context-activity/lib/index.js'

test('fleet renders members and messages', () => {
  const data = buildFleet({ rootId: 'root', familySize: 2, members: [{ id: 'child', name: 'worker', phase: 'active', mode: 'continuable' }], counts: { child: { messagesTotal: 1 } }, detail: { initialPrompt: '任务', messages: [{ kind: 'settled', fromName: 'worker', text: '完成', time: 1000 }] } }, true)
  assert.equal(data.familyText, '2')
  assert.equal(data.rowsMembers[0].title, 'worker')
  assert.equal(data.rowsMembers[0].tone, 'good')
  assert.equal(data.rowsMessages[0].title, 'worker')
})

test('file and command views handle failures and running commands', () => {
  const detail = {
    fileOps: [{ kind: 'read', path: '/tmp/a.js', time: 1000 }, { kind: 'edit', path: '/tmp/b.js', added: 2, removed: 1, err: true, time: 2000 }],
    commands: [{ tool: 'bash', description: '失败任务', status: 'failed', err: true, start: 1000, end: 2500 }, { tool: 'bash', description: '运行任务', status: 'running', start: 3000 }],
    commandStats: { runs: 2, failed: 1, ms: 1500 },
    head: { programTally: { bash: 2 } },
  }
  const files = buildFiles(detail, true)
  const commands = buildCommands(detail, true)
  assert.equal(files.fileText, '2')
  assert.equal(files.errText, '1')
  assert.match(files.rows[0].title, /失败/)
  assert.equal(commands.failText, '1')
  assert.match(commands.rows[0].trailing, /运行中/)
  assert.match(commands.rows[1].trailing, /1.5s/)
  const report = activityMarkdown(detail, null, true)
  assert.match(report, /# 活动报告/)
  assert.ok(report.length <= 7800)
})
