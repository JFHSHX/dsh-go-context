import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCost } from '../plugins/local-context-cost/lib/index.js'

test('cost panel aggregates today, week, session and models', () => {
  const today = new Date().toLocaleDateString('sv')
  const sessions = {
    'session-a': { contextTimeline: { current: { total: 2000 }, costRead: { ready: true, usd: 0.5 }, cost: { p: { m: { peak: { uncached: 100, cacheRead: 200, output: 50 } } } }, lastUser: '甲会话' } },
    'session-b': { contextTimeline: { current: { total: 3000 }, costRead: { ready: true, usd: 1 }, lastUser: '乙会话' } },
  }
  const data = buildCost(sessions, { costUsd: 12.3456, costSessions: 2 }, [{ key: today, costUsd: 0.5, tokens: 5000, sessions: 1 }, { key: '2026-01-01', costUsd: 1, tokens: 10000, sessions: 2 }], 'session-a', true)
  assert.equal(data.todayText, '$0.500')
  assert.equal(data.weekText, '$1.50')
  assert.equal(data.totalText, '$12.35')
  assert.equal(data.selfText, '$0.500')
  assert.equal(data.kvTop[0][0], '乙会话')
  assert.equal(data.kvModel[0][0], 'p/m')
  assert.ok(data.summaryRows.join('\n').includes('本会话'))
})
