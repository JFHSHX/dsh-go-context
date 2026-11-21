import test from 'node:test'
import assert from 'node:assert/strict'
import { buildData, buildOverview, buildTrend, buildInsights, contextMarkdown } from '../plugins/local-context/lib/index.js'

const timeline = {
  ok: true,
  current: { system: 1000, tools: 200, user: 100, inject: 300, skill: 400, assistant: 2000, tool: 500, total: 4500 },
  contextWindow: 10000,
  counts: { turns: 2, steps: 8 },
  timing: { toolCalls: 3, speedTokens: 1000, speedMs: 2000 },
  costRead: { ready: true, usd: 0.125 },
  cost: { p: { m: { peak: { uncached: 100, cacheRead: 900, output: 50 } } } },
  lastUser: '测试会话',
}

test('buildData computes usage, cache and speed', () => {
  const data = buildData(timeline, true)
  assert.equal(data.usedText, '4.5k tokens')
  assert.equal(data.pct, 45)
  assert.equal(data.tone, 'good')
  assert.ok(data.kv.some(([k, v]) => k === '缓存命中' && v === '90%'))
  assert.ok(data.kv.some(([k, v]) => k === '输出速度' && v === '500 tok/s'))
  assert.equal(data.b0, 1)
})

test('trend and insights preserve detail rows', () => {
  const detail = {
    head: { contextWindow: 10000, provider: 'p', model: 'm' },
    requests: [
      { time: 1000, total: 1000, turn: 1, step: 1, prompt: 900, cacheRead: 450 },
      { time: 2000, total: 1500, turn: 1, step: 2, prompt: 1200, cacheRead: 900 },
    ],
    events: [{ time: 2000, kind: 'inject', name: 'time-context', tokens: 10, turn: 1, step: 2 }],
  }
  const trend = buildTrend(detail, true)
  assert.equal(trend.growText, '+50%')
  assert.ok(trend.rowsReq[0].trailing)
  assert.match(trend.rowsReq[0].subtitle, /\+500/)
  const insights = buildInsights({ tokens: 10000, costUsd: 1.2, cacheHit: '88.5', sessions: 2, tokenParts: [{ key: 'system', value: 6000 }, { key: 'answers', value: 4000 }] }, [], null, true)
  assert.equal(insights.tokenText, '10k')
  assert.equal(insights.costText, '$1.20')
  assert.equal(insights.n0, '系统提示')
})

test('overview and Markdown report stay bounded', () => {
  const sessions = { 'session-a': { contextTimeline: timeline, contextActivity: { days: { '2026-01-01': { tokens: 4500 } } } } }
  const overview = buildOverview(sessions, null, true)
  assert.equal(overview.activeText, '1')
  const report = contextMarkdown(timeline, { requests: [], events: [] }, sessions, null, true)
  assert.match(report, /# 上下文报告/)
  assert.ok(report.length <= 7800)
})
