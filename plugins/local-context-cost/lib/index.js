export const name = 'local-context-cost'

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = process.env.DSH_CONTEXT_PORT || '3080'
const AUTHORITY = '127.0.0.1:' + PORT
const BASE = 'http://' + AUTHORITY

const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('_', '/').replace(/=+$/u, '')

let secretCache
function readSecret() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const m = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
    if (!m) return null
    return Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  } catch {
    return null
  }
}

function cookieHeader() {
  if (!secretCache) secretCache = readSecret()
  if (!secretCache) return null
  const now = Date.now()
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 30 * 86400e3 }), 'utf8'))
  const sig = b64url(createHmac('sha256', secretCache).update(body).digest())
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest())
  return { Cookie: name + '=v1.' + body + '.' + sig }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

async function post(path, payload) {
  let lastErr = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const headers = cookieHeader()
      if (!headers) throw new Error('本机凭据读取失败')
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(15000),
      }).catch((err) => { throw new Error('连不上上下文服务：' + (err.cause?.code || err.message)) })
      if (r.status === 401) {
        if (attempt >= 2) secretCache = undefined
        lastErr = new Error('本机凭据校验失败，请稍后重试')
        await sleep(220 * (attempt + 1))
        continue
      }
      if (!r.ok) throw new Error('上下文服务返回 ' + r.status)
      const j = await r.json()
      if (!j || j.ok !== true) throw new Error('上下文服务响应异常')
      return j
    } catch (err) {
      lastErr = err
      if (String(err.message || '').includes('上下文服务返回 4')) throw err
      await sleep(300 * (attempt + 1))
    }
  }
  throw lastErr || new Error('上下文服务暂不可用')
}

function idVariants(id) {
  const bare = String(id).replace(/^session-/, '')
  return [String(id), 'session-' + bare, bare]
}

const fmt = (n) => {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/u, '') + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/u, '') + 'k'
  return String(Math.round(n))
}

const usd = (n) => {
  n = Number(n) || 0
  if (n >= 100) return '$' + n.toFixed(0)
  if (n >= 1) return '$' + n.toFixed(2)
  return '$' + n.toFixed(3)
}

const dayLabel = (key) => String(key || '').slice(5)

async function fetchAll() {
  const [snap, summaryRes, daysRes] = await Promise.all([
    post('/api/dsh-context/snapshot', {}),
    post('/api/dsh-context/overview', { part: 'summary' }),
    post('/api/dsh-context/overview', { part: 'days' }),
  ])
  let days = daysRes.value?.days || []
  if (!Array.isArray(days)) days = Object.entries(days || {}).map(([key, v]) => ({ key, ...(v || {}) }))
  return { sessions: snap.value || {}, summary: summaryRes.value?.summary || {}, days }
}

function sessionCosts(sessions) {
  const rows = []
  for (const [sid, s] of Object.entries(sessions || {})) {
    const tl = s?.contextTimeline
    const usdVal = tl?.costRead && tl.costRead.ready ? Number(tl.costRead.usd) : NaN
    if (Number.isNaN(usdVal)) continue
    const raw = typeof tl?.lastUser === 'string' ? tl.lastUser : ''
    const label = raw ? raw.slice(0, 20) + (raw.length > 20 ? '…' : '') : (sid.replace(/^session-/, '').slice(0, 8))
    rows.push({ sid, label, usd: usdVal, total: Number(tl?.current?.total) || 0 })
  }
  rows.sort((a, b) => b.usd - a.usd)
  return rows
}

function modelTokens(sessions) {
  const agg = {}
  for (const s of Object.values(sessions || {})) {
    const tl = s?.contextTimeline
    const cost = (tl && (tl.cost || (tl.current && tl.current.cost))) || null
    if (!cost) continue
    for (const [provider, models] of Object.entries(cost)) {
      for (const [model, mv] of Object.entries(models || {})) {
        const key = provider + '/' + model
        const pk = mv?.peak || {}
        const cur = agg[key] || { uncached: 0, cacheRead: 0, output: 0 }
        cur.uncached += Number(pk.uncached) || 0
        cur.cacheRead += Number(pk.cacheRead) || 0
        cur.output += Number(pk.output) || 0
        agg[key] = cur
      }
    }
  }
  return Object.entries(agg)
    .map(([key, v]) => ({ key, all: v.uncached + v.cacheRead + v.output, ...v }))
    .sort((a, b) => b.all - a.all)
    .slice(0, 3)
}

function buildCost(sessions, summary, days, sid, zh) {
  const localToday = new Date().toLocaleDateString('sv')
  const last7 = (Array.isArray(days) ? days.slice(-7) : [])
  const todayRow = last7.find((d) => d.key === localToday)
  const weekUsd = last7.reduce((acc, d) => acc + (Number(d.costUsd) || 0), 0)
  const totalUsd = Number(summary.costUsd) || 0
  const sc = sessionCosts(sessions)
  const self = sid ? sc.find((r) => idVariants(sid).some((v) => v === r.sid || r.sid.replace(/^session-/, '') === v.replace(/^session-/, ''))) : null

  const data = {
    ready: true,
    todayText: usd(todayRow ? todayRow.costUsd : 0),
    todayCap: zh ? '今日 · ' + (todayRow ? fmt(todayRow.tokens) + ' tokens' : '暂无用量') : 'today',
    weekText: usd(weekUsd),
    weekCap: zh ? '近 7 天' : 'last 7 days',
    totalText: usd(totalUsd),
    totalCap: zh ? '累计 · ' + (summary.costSessions ?? '—') + ' 个会话计费' : 'all time',
    selfText: self ? usd(self.usd) : '—',
    selfCap: self ? fmt(self.total) + ' tokens' : (zh ? '在对话里打开可看本会话' : 'open in a conversation'),
    kvTop: sc.slice(0, 5).map((r) => [r.label, usd(r.usd) + ' · ' + fmt(r.total) + ' tokens']),
    kvModel: modelTokens(sessions).map((m) => [m.key, (zh ? '输入 ' : 'in ') + fmt(m.uncached + m.cacheRead) + ' · ' + (zh ? '输出 ' : 'out ') + fmt(m.output) + ' tokens']),
    summaryRows: [],
    note: zh ? '数据来自 dsh-context（按模型计价折算美元）· 每 60 秒刷新' : 'From dsh-context · refreshes every 60s',
  }
  const cents = last7.map((d) => Math.round((Number(d.costUsd) || 0) * 100))
  data.bmax = Math.max(1, ...cents)
  for (let i = 0; i < 7; i++) {
    const d = last7[i]
    if (!d) { data['b' + i] = 0; data['n' + i] = '—'; data['c' + i] = '—'; continue }
    data['b' + i] = Math.round((Number(d.costUsd) || 0) * 100)
    data['n' + i] = dayLabel(d.key)
    data['c' + i] = usd(d.costUsd) + ' · ' + (Number(d.sessions) || 0) + (zh ? ' 会话 · ' : ' ses · ') + fmt(d.tokens) + ' tokens'
  }
  data.summaryRows = [
    (zh ? '今日 ' : 'Today ') + usd(todayRow ? todayRow.costUsd : 0) + ' · ' + (zh ? '近 7 天 ' : 'week ') + usd(weekUsd) + ' · ' + (zh ? '累计 ' : 'total ') + usd(totalUsd),
    (zh ? '花费 Top ' : 'Top ') + sc.slice(0, 3).map((r) => r.label + ' ' + usd(r.usd)).join(' | '),
  ]
  if (self) data.summaryRows.push((zh ? '本会话 ' : 'This session ') + usd(self.usd) + ' · ' + fmt(self.total) + ' tokens')
  return data
}

function costError(message, zh) {
  const d = { ready: true, note: message, todayText: '—', todayCap: '', weekText: '—', weekCap: '', totalText: '—', totalCap: '', selfText: '—', selfCap: '', kvTop: [], kvModel: [], bmax: 1, summaryRows: [] }
  for (let i = 0; i < 7; i++) { d['b' + i] = 0; d['n' + i] = '—'; d['c' + i] = '—' }
  return d
}

const zhOf = (locale) => !String(locale || 'zh').startsWith('en')

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('ctxc-cost', {
      view: (scope, caps) => {
        const zh = zhOf(caps?.locale)
        return {
          type: 'stack',
          title: zh ? '花费统计' : 'Cost',
          children: [
            { type: 'row', children: [
              { type: 'metric', label: zh ? '今日' : 'Today', value: { $: 'data.todayText' }, tone: 'info', caption: { $: 'data.todayCap' } },
              { type: 'metric', label: zh ? '近 7 天' : '7 days', value: { $: 'data.weekText' }, tone: 'info', caption: { $: 'data.weekCap' } },
              { type: 'metric', label: zh ? '累计' : 'Total', value: { $: 'data.totalText' }, caption: { $: 'data.totalCap' } },
            ] },
            { type: 'metric', label: zh ? '本会话' : 'This session', value: { $: 'data.selfText' }, tone: 'good', caption: { $: 'data.selfCap' } },
            { type: 'text', text: zh ? '近 7 天每日花费' : 'Daily spend', tone: 'muted' },
            { type: 'progress', value: { $: 'data.b0' }, max: { $: 'data.bmax' }, label: { $: 'data.n0' }, caption: { $: 'data.c0' } },
            { type: 'progress', value: { $: 'data.b1' }, max: { $: 'data.bmax' }, label: { $: 'data.n1' }, caption: { $: 'data.c1' } },
            { type: 'progress', value: { $: 'data.b2' }, max: { $: 'data.bmax' }, label: { $: 'data.n2' }, caption: { $: 'data.c2' } },
            { type: 'progress', value: { $: 'data.b3' }, max: { $: 'data.bmax' }, label: { $: 'data.n3' }, caption: { $: 'data.c3' } },
            { type: 'progress', value: { $: 'data.b4' }, max: { $: 'data.bmax' }, label: { $: 'data.n4' }, caption: { $: 'data.c4' } },
            { type: 'progress', value: { $: 'data.b5' }, max: { $: 'data.bmax' }, label: { $: 'data.n5' }, caption: { $: 'data.c5' } },
            { type: 'progress', value: { $: 'data.b6' }, max: { $: 'data.bmax' }, label: { $: 'data.n6' }, caption: { $: 'data.c6' } },
            { type: 'text', text: zh ? '会话花费 Top5' : 'Top sessions', tone: 'muted' },
            { type: 'keyValue', items: { $: 'data.kvTop' } },
            { type: 'text', text: zh ? '按模型（计费 tokens）' : 'By model', tone: 'muted' },
            { type: 'keyValue', items: { $: 'data.kvModel' } },
            { type: 'callout', text: { $: 'data.note' }, tone: 'info' },
            { type: 'actions', items: [
              { label: zh ? '刷新' : 'Refresh', action: 'refresh' },
              { label: zh ? '复制摘要' : 'Copy summary', action: 'copySummary', style: 'plain' },
            ] },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const zh = zhOf(caps?.locale)
        let stopped = false
        let timer = null
        const tick = async () => {
          if (stopped) return
          try {
            const { sessions, summary, days } = await fetchAll()
            if (!stopped) emit(buildCost(sessions, summary, days, scope?.sessionId, zh))
          } catch (err) {
            if (!stopped) emit(costError(String(err.message || err), zh))
          }
        }
        void tick()
        timer = setInterval(tick, 60_000)
        return () => { stopped = true; if (timer) clearInterval(timer) }
      },
      actions: {
        refresh: (scope, event) => {
          const zh = zhOf(event?.locale)
          return {
            pending: { label: zh ? '正在刷新' : 'Refreshing', timeoutMs: 30000 },
            result: async () => {
              const { sessions, summary, days } = await fetchAll()
              return { patch: buildCost(sessions, summary, days, scope?.sessionId, zh), toast: zh ? '已刷新' : 'Refreshed' }
            },
          }
        },
        copySummary: (scope, event) => {
          const zh = zhOf(event?.locale)
          return {
            pending: { label: zh ? '正在生成摘要' : 'Preparing', timeoutMs: 30000 },
            result: async () => {
              const { sessions, summary, days } = await fetchAll()
              const data = buildCost(sessions, summary, days, scope?.sessionId, zh)
              return { copy: (zh ? '花费统计' : 'Cost') + '\n' + (data.summaryRows || []).join('\n'), toast: zh ? '已复制摘要' : 'Copied' }
            },
          }
        },
      },
    })
  })
}
