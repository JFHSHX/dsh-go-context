export const name = 'dsh-go-context'

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = process.env.DSH_CONTEXT_PORT || '3080'
const AUTHORITY = '127.0.0.1:' + PORT
const BASE = 'http://' + AUTHORITY

const BUCKET_ZH = ['系统提示', '技能', '注入内容', '用户消息', '助手输出', '工具']
const BUCKET_EN = ['System', 'Skills', 'Injected', 'User', 'Assistant', 'Tools']
const EVENT_ZH = { inject: '注入', model: '模型', skill: '技能', tool: '工具', message: '消息', compact: '压缩', file: '文件' }
const EVENT_EN = { inject: 'Inject', model: 'Model', skill: 'Skill', tool: 'Tool', message: 'Message', compact: 'Compact', file: 'File' }
const PART_ZH = { system: '系统提示', tools: '工具定义', user: '用户消息', inject: '注入内容', skill: '技能', toolCalls: '工具结果', thinking: '思考', answers: '回答' }
const PART_EN = { system: 'System', tools: 'Tool defs', user: 'User', inject: 'Injected', skill: 'Skills', toolCalls: 'Tool results', thinking: 'Thinking', answers: 'Answers' }

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
        // App 鉴权层偶发拒绝同一有效凭据；换一次签名并稍后重试
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

async function timelineOf(sessionId) {
  const ids = idVariants(sessionId)
  const value = (await post('/api/dsh-context/snapshot', { ids })).value || {}
  const bare = ids[2]
  for (const key of Object.keys(value)) {
    if (key === sessionId || key.replace(/^session-/, '') === bare) return value[key]?.contextTimeline ?? null
  }
  return null
}

async function versionInfo() {
  try {
    const v = (await post('/api/dsh-context/version')).value || {}
    return typeof v.current === 'string' ? v : null
  } catch {
    return null
  }
}

const fmt = (n) => {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/u, '') + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/u, '') + 'k'
  return String(Math.round(n))
}

function toneOf(pct) {
  if (pct >= 92) return 'bad'
  if (pct >= 75) return 'warn'
  return 'good'
}

function costOf(tl) {
  return (tl && (tl.cost || (tl.current && tl.current.cost))) || null
}

function cacheHitOf(tl) {
  const cost = costOf(tl)
  let hit = 0
  let miss = 0
  if (cost) for (const p of Object.values(cost)) for (const m of Object.values(p || {})) {
    const pk = m.peak || {}
    hit += Number(pk.cacheRead) || 0
    miss += Number(pk.uncached) || 0
  }
  if (hit + miss <= 0) return null
  return Math.round((hit / (hit + miss)) * 100)
}

function speedOf(tl) {
  const t = (tl && tl.timing) || {}
  if (Number(t.speedTokens) > 0 && Number(t.speedMs) > 0) return Math.round((t.speedTokens / t.speedMs) * 1000)
  return null
}

function pickJsonTime(t) {
  const d = new Date(Number(t) || 0)
  if (!d.getTime()) return ''
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function errorData(message, zh) {
  const d = { ready: true, note: message, kv: [], pct: 0, tone: 'info', usedText: '—', pctText: '', windowText: '', bmax: 1, summary: '' }
  const names = zh ? BUCKET_ZH : BUCKET_EN
  for (let i = 0; i < 6; i++) { d['b' + i] = 0; d['n' + i] = names[i]; d['c' + i] = '—' }
  return d
}

function buildData(tl, zh) {
  if (!tl || tl.ok !== true || !tl.current) return errorData(zh ? '这个会话还没有可统计的上下文' : 'No context stats for this session yet', zh)
  const c = tl.current
  const win = Number(tl.contextWindow) || 0
  const used = Number(c.total) || 0
  const pct = win > 0 ? Math.min(100, Math.round((used / win) * 1000) / 10) : 0
  const raw = [c.system, c.skill, c.inject, c.user, c.assistant, (Number(c.tools) || 0) + (Number(c.tool) || 0)].map((n) => Math.max(0, Number(n) || 0))
  const kOf = (n) => Math.round(n / 100) / 10
  const share = (n) => Math.round((n / (used > 0 ? used : 1)) * 100)
  const names = zh ? BUCKET_ZH : BUCKET_EN
  const b = raw.map(kOf)

  const counts = tl.counts || {}
  const timing = tl.timing || {}
  const usd = tl.costRead && tl.costRead.ready ? Number(tl.costRead.usd) : NaN
  const last = typeof tl.lastUser === 'string' ? tl.lastUser : ''
  const kv = []
  if (win > 0) kv.push([zh ? '上下文窗口' : 'Context window', fmt(win) + ' tokens'])
  if (counts.turns !== undefined) kv.push([zh ? '回合 / 步骤' : 'Turns / steps', (counts.turns ?? '—') + ' / ' + (counts.steps ?? '—')])
  if (timing.toolCalls !== undefined) kv.push([zh ? '工具调用' : 'Tool calls', String(timing.toolCalls)])
  const hit = cacheHitOf(tl)
  if (hit !== null) kv.push([zh ? '缓存命中' : 'Cache hit', hit + '%'])
  const sp = speedOf(tl)
  if (sp !== null) kv.push([zh ? '输出速度' : 'Speed', sp + ' tok/s'])
  if (tl.generatedAnswerTokens !== undefined) kv.push([zh ? '本轮生成' : 'Generated', fmt((Number(tl.generatedAnswerTokens) || 0) + (Number(tl.generatedReasoning) || 0)) + ' tokens'])
  if (!Number.isNaN(usd)) kv.push([zh ? '累计成本' : 'Cost', '$' + usd.toFixed(usd < 10 ? 3 : 2)])
  if (last) kv.push([zh ? '最近消息' : 'Last message', last.slice(0, 20) + (last.length > 20 ? '…' : '')])

  const data = {
    ready: true,
    usedText: fmt(used) + ' tokens',
    pctText: (win > 0 ? pct + '% · ' : '') + (zh ? '窗口 ' : 'window ') + (win > 0 ? fmt(win) : (zh ? '未知' : 'unknown')),
    windowText: win > 0 ? fmt(win) + ' tokens' : (zh ? '窗口未知' : 'window unknown'),
    pct,
    tone: toneOf(pct),
    bmax: Math.max(1, ...b),
    kv,
    summary: buildSummary(tl, zh),
    note: zh ? '数据来自 dsh-context · 每 30 秒自动刷新' : 'From dsh-context · refreshes every 30s',
  }
  for (let i = 0; i < 6; i++) {
    data['b' + i] = b[i]
    data['n' + i] = names[i]
    data['c' + i] = b[i] + 'k tokens · ' + share(raw[i]) + '%'
  }
  return data
}

function buildSummary(tl, zh) {
  if (!tl || tl.ok !== true || !tl.current) return zh ? '（暂无上下文统计）' : '(no context stats)'
  const c = tl.current
  const win = Number(tl.contextWindow) || 0
  const used = Number(c.total) || 0
  const pct = win > 0 ? Math.round((used / win) * 100) : 0
  const toolAll = (Number(c.tools) || 0) + (Number(c.tool) || 0)
  const rows = [
    (zh ? '已用 ' : 'Used ') + fmt(used) + (win > 0 ? ' / ' + fmt(win) + ' tokens（' + pct + '%）' : ' tokens'),
    (zh ? '构成 ' : 'Buckets ') + ['system', 'skill', 'inject', 'user', 'assistant'].map((k) => k + ' ' + fmt(c[k])).join(' · ') + ' · tools ' + fmt(toolAll),
  ]
  const counts = tl.counts || {}
  if (counts.turns !== undefined) rows.push((zh ? '回合 ' : 'Turns ') + counts.turns + ' · ' + (zh ? '步骤 ' : 'steps ') + (counts.steps ?? '—'))
  const hit = cacheHitOf(tl)
  if (hit !== null) rows.push((zh ? '缓存命中 ' : 'Cache hit ') + hit + '%')
  const usd = tl.costRead && tl.costRead.ready ? Number(tl.costRead.usd) : NaN
  if (!Number.isNaN(usd)) rows.push((zh ? '成本 $' : 'Cost $') + usd.toFixed(4))
  return rows.join('\n')
}

function eventRows(events, zh) {
  const names = zh ? EVENT_ZH : EVENT_EN
  const rows = []
  for (const ev of (events || []).slice(-20).reverse()) {
    const kind = names[ev.kind] || String(ev.kind || '·')
    let title = kind
    let subtitle = ''
    if (ev.kind === 'model') { title = zh ? '模型切换' : 'Model switch'; subtitle = String(ev.from || '') + ' → ' + String(ev.to || '') }
    else if (ev.name) { title = (kind + ' · ' + String(ev.name)).slice(0, 30); if (ev.detail) subtitle = String(ev.detail).slice(0, 60) }
    else if (ev.from) subtitle = String(ev.from).slice(0, 60)
    const where = ev.turn !== undefined ? 'T' + ev.turn + (ev.step !== undefined ? '·S' + ev.step : '') : ''
    const tok = Number(ev.tokens) > 0 ? '+' + fmt(ev.tokens) : ''
    const trailing = [tok, where].filter(Boolean).join(' · ')
    rows.push({ title, subtitle: subtitle || undefined, trailing: trailing || undefined })
  }
  return rows
}

function requestRows(requests, zh) {
  const list = (requests || []).slice(-12).reverse()
  const rows = []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const prev = list[i + 1]
    const delta = prev ? (Number(r.total) || 0) - (Number(prev.total) || 0) : 0
    const where = r.turn !== undefined ? 'T' + r.turn + (r.step !== undefined ? '·S' + r.step : '') : ''
    const prompt = Number(r.prompt) || 0
    const cacheRead = prompt > 0 ? Math.round(((Number(r.cacheRead) || 0) / prompt) * 100) + '%' : ''
    rows.push({
      title: fmt(r.total) + ' tokens',
      subtitle: where + (prev ? ' · ' + (zh ? '较上次 ' : 'delta ') + (delta >= 0 ? '+' : '') + fmt(delta) : ' · ' + (zh ? '会话起点' : 'start')) + (cacheRead ? ' · ' + (zh ? '缓存 ' : 'cache ') + cacheRead : ''),
      trailing: pickJsonTime(r.time) || undefined,
    })
  }
  return rows
}

async function overviewInsights() {
  const summary = (await post('/api/dsh-context/overview', { part: 'summary' })).value?.summary || {}
  let days = (await post('/api/dsh-context/overview', { part: 'days' })).value?.days || []
  if (!Array.isArray(days)) days = Object.entries(days || {}).map(([key, v]) => ({ key, ...(v || {}) }))
  return { summary, days }
}

function insightsError(message, zh) {
  const d = { ready: true, note: message, tokenText: '—', costText: '—', cacheText: '—', tokenCap: '', costCap: '', cacheCap: '', bmax: 1, kvWeek: [], kvMisc: [], summaryRows: [] }
  for (let i = 0; i < 8; i++) { d['b' + i] = 0; d['n' + i] = '—'; d['c' + i] = '—' }
  return d
}

function buildInsights(summary, days, ver, zh) {
  const tokens = Number(summary.tokens) || 0
  const parts = Array.isArray(summary.tokenParts) ? summary.tokenParts : []
  const partSum = parts.reduce((acc, p) => acc + (Number(p.value) || 0), 0) || 1
  const names = zh ? PART_ZH : PART_EN
  const data = {
    ready: true,
    tokenText: fmt(tokens),
    costText: summary.costUsd !== undefined ? '$' + Number(summary.costUsd).toFixed(2) : '—',
    cacheText: summary.cacheHit !== undefined ? Number(summary.cacheHit) + '%' : '—',
    tokenCap: zh ? 'tokens · ' + (summary.sessions ?? '—') + ' 个会话' : 'tokens · ' + (summary.sessions ?? '—') + ' sessions',
    costCap: zh ? '累计成本' : 'total cost',
    cacheCap: zh ? '缓存命中率' : 'cache hit rate',
    bmax: 1,
    kvWeek: (Array.isArray(days) ? days.slice(-7) : []).map((d) => [String(d.key || ''), fmt(d.tokens) + ' tokens · $' + (Number(d.costUsd) || 0).toFixed(2) + ' · ' + (Number(d.sessions) || 0) + (zh ? ' 会话' : ' ses')]),
    kvMisc: [],
    summaryRows: [],
    note: (zh ? '来自 dsh-context · 每 60 秒刷新' : 'From dsh-context · every 60s') + (ver ? ' · ' + (ver.updateAvailable ? 'dsh-context ' + ver.current + ' → ' + ver.latest + ' 可更新' : 'dsh-context ' + ver.current) : ''),
  }
  parts.forEach((p, i) => {
    const k = Math.round((Number(p.value) || 0) / 1000)
    data['b' + i] = k
    data['n' + i] = names[p.key] || p.key
    data['c' + i] = k + 'k tokens · ' + Math.round(((Number(p.value) || 0) / partSum) * 100) + '%'
  })
  for (let i = parts.length; i < 8; i++) { data['b' + i] = 0; data['n' + i] = '—'; data['c' + i] = '—' }
  data.bmax = Math.max(1, ...parts.map((p) => Math.round((Number(p.value) || 0) / 1000)))
  const misc = data.kvMisc
  misc.push([zh ? '会话' : 'Sessions', String(summary.sessions ?? '—') + (summary.sessionsArchived ? ' (' + (zh ? '归档 ' : 'arch. ') + summary.sessionsArchived + ')' : '')])
  if (summary.turns !== undefined) misc.push([zh ? '回合' : 'Turns', String(summary.turns)])
  const timing = summary.timing || {}
  if (timing.toolCalls !== undefined) misc.push([zh ? '工具调用' : 'Tool calls', String(timing.toolCalls)])
  if (timing.calls !== undefined) misc.push([zh ? '模型请求' : 'Requests', String(timing.calls)])
  if (Number(timing.wallMs) > 0) misc.push([zh ? '活跃时长' : 'Active time', fmt(timing.wallMs / 1000) + 's'])
  const tools = timing.tools || {}
  const top = Object.entries(tools).sort((a, b) => (Number(b[1]?.calls) || 0) - (Number(a[1]?.calls) || 0)).slice(0, 8)
  for (const [name, t] of top) misc.push([String(name), (Number(t?.calls) || 0) + (zh ? ' 次 · ' : ' calls · ') + ((Number(t?.ms) || 0) / 1000).toFixed(1) + 's'])
  data.summaryRows = [
    (zh ? '累计 ' : 'Total ') + fmt(tokens) + ' tokens · $' + (Number(summary.costUsd) || 0).toFixed(2) + ' · ' + (zh ? '缓存命中 ' : 'cache ') + (summary.cacheHit ?? '—') + '%',
    (zh ? '构成 ' : 'Parts ') + parts.map((p) => (names[p.key] || p.key) + ' ' + fmt(p.value)).join(' · '),
  ]
  return data
}

function trendError(message, zh) {
  return { ready: true, note: message, rowsReq: [], rowsEv: [], nowText: '—', growText: '—', cacheText: '—', modelText: '', summary: '' }
}

function buildTrend(detail, zh) {
  const head = detail?.head || {}
  const requests = Array.isArray(detail?.requests) ? detail.requests : []
  const events = Array.isArray(detail?.events) ? detail.events : []
  const lastReq = requests[requests.length - 1] || {}
  const firstReq = requests[0] || {}
  const total = Number(lastReq.total) || 0
  const start = Number(firstReq.total) || 0
  const win = Number(head.contextWindow) || 0
  const grow = start > 0 ? Math.round(((total - start) / start) * 100) : 0
  const prompt = Number(lastReq.prompt) || 0
  const cacheRead = Number(lastReq.cacheRead) || 0
  return {
    ready: true,
    nowText: fmt(total) + (win > 0 ? ' / ' + fmt(win) : ''),
    nowCap: zh ? '最近请求 tokens' : 'latest request tokens',
    growText: (grow >= 0 ? '+' : '') + grow + '%',
    growCap: zh ? '较首个请求' : 'since first',
    cacheText: prompt > 0 ? Math.round((cacheRead / prompt) * 100) + '%' : '—',
    cacheCap: zh ? '上次请求缓存命中' : 'last cache hit',
    modelText: [head.provider, head.model].filter(Boolean).join(' · ') || (zh ? '未知模型' : 'unknown model'),
    rowsReq: requestRows(requests, zh),
    rowsEv: eventRows(events, zh),
    summary: [
      (zh ? '当前 ' : 'Now ') + fmt(total) + (win > 0 ? ' / ' + fmt(win) + ' tokens' : ' tokens'),
      (zh ? '请求 ' : 'Requests ') + requests.length + (zh ? ' 次 · 最近 T' : ' · last T') + (lastReq.turn ?? '—') + '·S' + (lastReq.step ?? '—'),
      (zh ? '事件 ' : 'Events ') + events.length + (zh ? ' 条' : ''),
    ].join('\n'),
    note: zh ? '每 60 秒自动刷新 · 数据来自 dsh-context detail' : 'Refreshes every 60s · from dsh-context detail',
  }
}

function overviewBuildError(message, zh) {
  return { ready: true, note: message, todayText: '—', todayCap: '', activeText: '—', activeCap: '', sumText: '—', sumCap: '', kvWeek: [], kvTop: [], summary: '' }
}

function buildOverview(value, ver, zh) {
  const localToday = new Date().toLocaleDateString('sv')
  const dayMap = {}
  const tops = []
  let todayTok = 0
  let sessionsToday = 0
  let sumTotal = 0
  let hit = 0
  let miss = 0
  for (const [sid, s] of Object.entries(value || {})) {
    const tl = s?.contextTimeline
    const total = Number(tl?.current?.total) || 0
    sumTotal += total
    const cost = costOf(tl)
    if (cost) for (const p of Object.values(cost)) for (const m of Object.values(p || {})) {
      const pk = m.peak || {}
      hit += Number(pk.cacheRead) || 0
      miss += Number(pk.uncached) || 0
    }
    const days = (s?.contextActivity && s.contextActivity.days) || {}
    let tToday = 0
    for (const [d, v] of Object.entries(days)) {
      dayMap[d] = (dayMap[d] || 0) + (Number(v.tokens) || 0)
      if (d === localToday) tToday += Number(v.tokens) || 0
    }
    if (tToday > 0) sessionsToday++
    const win = Number(tl?.contextWindow) || 0
    const raw = typeof tl?.lastUser === 'string' ? tl.lastUser : ''
    const label = raw ? raw.slice(0, 20) + (raw.length > 20 ? '…' : '') : (zh ? '会话 ' : 'Session ') + sid.replace(/^session-/, '').slice(0, 8)
    tops.push({ label, total, pct: win > 0 ? Math.round((total / win) * 100) : 0 })
  }
  tops.sort((a, b) => b.total - a.total)
  const days = Object.keys(dayMap).sort().slice(-7)
  const kvWeek = days.map((d) => [d, fmt(dayMap[d]) + ' tokens'])
  const kvTop = tops.slice(0, 5).map((t) => [t.label, fmt(t.total) + (t.pct !== 0 ? ' · ' + t.pct + '%' : '')])
  const hitPct = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) + '%' : null
  const verText = ver ? (ver.updateAvailable ? 'dsh-context ' + ver.current + ' → ' + ver.latest + ' 可更新' : 'dsh-context ' + ver.current) : null
  const rows = [
    (zh ? '今日 ' : 'Today ') + fmt(dayMap[localToday] || 0) + ' tokens · ' + (zh ? '活跃会话 ' : 'active sessions ') + sessionsToday,
    (zh ? '近 7 天 ' : 'Last 7 days ') + days.map((d) => d.slice(5) + ' ' + fmt(dayMap[d])).join(', '),
    (zh ? '最近会话 ' : 'Top sessions ') + tops.slice(0, 3).map((t) => t.label + ' ' + fmt(t.total)).join(' | '),
  ]
  if (hitPct) rows.push((zh ? '缓存命中 ' : 'Cache hit ') + hitPct)
  return {
    ready: true,
    todayText: fmt(dayMap[localToday] || 0),
    todayCap: zh ? 'tokens · ' + sessionsToday + ' 个会话活跃' : 'tokens · ' + sessionsToday + ' active',
    activeText: String(Object.keys(value || {}).length),
    activeCap: zh ? '个会话有统计' : 'sessions tracked',
    sumText: fmt(sumTotal),
    sumCap: zh ? 'tokens · 最近会话合计' : 'tokens · tracked total',
    kvWeek,
    kvTop,
    note: (zh ? '来自 dsh-context · 每 60 秒刷新' : 'From dsh-context · every 60s') + (verText ? ' · ' + verText : ''),
    summary: rows.join('\n'),
  }
}

const zhOf = (locale) => !String(locale || 'zh').startsWith('en')

function contextMarkdown(tl, detail, all, ver, zh) {
  const current = buildData(tl, zh)
  const trend = buildTrend(detail, zh)
  const overview = buildOverview(all, ver, zh)
  const lines = [zh ? '# 上下文报告' : '# Context report', '', '## ' + (zh ? '当前上下文' : 'Current context'), current.summary || current.note]
  for (const row of current.kv || []) lines.push('- ' + row[0] + '：' + row[1])
  lines.push('', '### ' + (zh ? '构成' : 'Composition'))
  for (let i = 0; i < 6; i++) lines.push('- ' + current['n' + i] + '：' + current['c' + i])
  lines.push('', '## ' + (zh ? '上下文演变' : 'Evolution'), trend.summary || trend.note)
  for (const row of (trend.rowsReq || []).slice(0, 8)) lines.push('- ' + row.title + ' · ' + (row.subtitle || '') + (row.trailing ? ' · ' + row.trailing : ''))
  lines.push('', '### ' + (zh ? '最近事件' : 'Recent events'))
  for (const row of (trend.rowsEv || []).slice(0, 8)) lines.push('- ' + row.title + (row.subtitle ? ' · ' + row.subtitle : '') + (row.trailing ? ' · ' + row.trailing : ''))
  lines.push('', '## ' + (zh ? '用量总览' : 'Usage overview'), overview.summary || overview.note)
  return lines.join('\n').slice(0, 7800)
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('ctx-report', (scope, event) => {
      const zh = zhOf(event?.locale)
      const sid = scope?.sessionId
      if (!sid) return { toast: zh ? '没有当前会话' : 'No session' }
      return {
        pending: { label: zh ? '正在生成报告' : 'Preparing report', timeoutMs: 30000 },
        result: async () => {
          const [tl, detail, snapshot] = await Promise.all([
            timelineOf(sid),
            post('/api/dsh-context/detail', { sessionId: sid }),
            post('/api/dsh-context/snapshot', {}),
          ])
          return { copy: contextMarkdown(tl, detail.value || {}, snapshot.value || {}, null, zh), toast: zh ? '已复制上下文报告' : 'Report copied' }
        },
      }
    })

    ctx.dshGo.strip('ctx-strip', (scope, emit, caps) => {
      const zh = zhOf(caps?.locale)
      let stopped = false
      let timer = null
      const tick = async () => {
        if (stopped) return
        const sid = scope?.sessionId
        if (!sid) { emit({ text: zh ? '上下文 —' : 'Context —' }); return }
        try {
          const data = buildData(await timelineOf(sid), zh)
          if (stopped) return
          if (data.usedText === '—') { emit({ text: zh ? '上下文 —' : 'Context —' }); return }
          const used = data.usedText.replace(' tokens', '')
          const win = data.windowText.replace(' tokens', '')
          const unknown = data.windowText.includes('未知') || data.windowText.includes('unknown')
          const text = (zh ? '上下文 ' : 'Context ') + used + (unknown ? '' : '/' + win) + ' · ' + Math.round(data.pct) + '%'
          emit({ text: text.slice(0, 24), tone: data.tone === 'good' ? undefined : data.tone })
        } catch {
          if (!stopped) emit({ text: zh ? '上下文 不可用' : 'Context n/a', tone: 'warn' })
        }
      }
      void tick()
      timer = setInterval(tick, 30_000)
      return () => { stopped = true; if (timer) clearInterval(timer) }
    })

    ctx.dshGo.panel('ctx-panel', {
      view: (scope, caps) => {
        const zh = zhOf(caps?.locale)
        const children = [
          { type: 'metric', label: zh ? '已用上下文' : 'Used context', value: { $: 'data.usedText' }, tone: { $: 'data.tone' }, caption: { $: 'data.pctText' } },
          { type: 'progress', value: { $: 'data.pct' }, max: 100, label: zh ? '窗口占用' : 'Window usage', caption: { $: 'data.windowText' } },
        ]
        for (let i = 0; i < 6; i++) {
          children.push({ type: 'progress', value: { $: 'data.b' + i }, max: { $: 'data.bmax' }, label: { $: 'data.n' + i }, caption: { $: 'data.c' + i } })
        }
        children.push(
          { type: 'keyValue', items: { $: 'data.kv' } },
          { type: 'callout', text: { $: 'data.note' }, tone: 'info' },
          { type: 'actions', items: [
            { label: zh ? '刷新' : 'Refresh', action: 'refresh' },
            { label: zh ? '复制摘要' : 'Copy summary', action: 'copySummary', style: 'plain' },
          ] },
        )
        return { type: 'stack', title: zh ? '上下文洞察' : 'Context', children }
      },
      data: (scope, emit, caps) => {
        const zh = zhOf(caps?.locale)
        let stopped = false
        let timer = null
        const tick = async () => {
          if (stopped) return
          const sid = scope?.sessionId
          if (!sid) { emit(errorData(zh ? '从「全部功能」打开时没有当前会话；在对话里打开可看当前会话的上下文。' : 'Opened without a session; open it inside a conversation.', zh)); return }
          try {
            const data = buildData(await timelineOf(sid), zh)
            if (!stopped) emit(data)
          } catch (err) {
            if (!stopped) emit(errorData(String(err.message || err), zh))
          }
        }
        void tick()
        timer = setInterval(tick, 30_000)
        return () => { stopped = true; if (timer) clearInterval(timer) }
      },
      actions: {
        refresh: (scope, event) => {
          const zh = zhOf(event?.locale)
          const sid = scope?.sessionId
          if (!sid) return { toast: zh ? '没有当前会话' : 'No session' }
          return {
            pending: { label: zh ? '正在刷新' : 'Refreshing', timeoutMs: 20000 },
            result: async () => {
              const data = buildData(await timelineOf(sid), zh)
              return { patch: data, toast: zh ? '已刷新' : 'Refreshed' }
            },
          }
        },
        copySummary: (scope, event) => {
          const zh = zhOf(event?.locale)
          const sid = scope?.sessionId
          if (!sid) return { toast: zh ? '没有当前会话' : 'No session' }
          return {
            pending: { label: zh ? '正在生成摘要' : 'Preparing', timeoutMs: 20000 },
            result: async () => {
              const data = buildData(await timelineOf(sid), zh)
              return { copy: (zh ? '上下文摘要' : 'Context summary') + '\n' + (data.summary || ''), toast: zh ? '已复制摘要' : 'Copied' }
            },
          }
        },
      },
    })

    ctx.dshGo.panel('ctx-overview', {
      view: (scope, caps) => {
        const zh = zhOf(caps?.locale)
        return {
          type: 'stack',
          title: zh ? '用量总览' : 'Usage',
          children: [
            { type: 'row', children: [
              { type: 'metric', label: zh ? '今日' : 'Today', value: { $: 'data.todayText' }, tone: 'info', caption: { $: 'data.todayCap' } },
              { type: 'metric', label: zh ? '会话' : 'Sessions', value: { $: 'data.activeText' }, caption: { $: 'data.activeCap' } },
              { type: 'metric', label: zh ? '合计' : 'Total', value: { $: 'data.sumText' }, tone: 'info', caption: { $: 'data.sumCap' } },
            ] },
            { type: 'keyValue', items: { $: 'data.kvWeek' } },
            { type: 'keyValue', items: { $: 'data.kvTop' } },
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
            const value = (await post('/api/dsh-context/snapshot', {})).value || {}
            const ver = await versionInfo()
            if (!stopped) emit(buildOverview(value, ver, zh))
          } catch (err) {
            if (!stopped) emit(overviewBuildError(String(err.message || err), zh))
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
              const value = (await post('/api/dsh-context/snapshot', {})).value || {}
              const ver = await versionInfo()
              return { patch: buildOverview(value, ver, zh), toast: zh ? '已刷新' : 'Refreshed' }
            },
          }
        },
        copySummary: (scope, event) => {
          const zh = zhOf(event?.locale)
          return {
            pending: { label: zh ? '正在生成摘要' : 'Preparing', timeoutMs: 30000 },
            result: async () => {
              const value = (await post('/api/dsh-context/snapshot', {})).value || {}
              const ver = await versionInfo()
              return { copy: (zh ? '用量总览' : 'Usage overview') + '\n' + (buildOverview(value, ver, zh).summary || ''), toast: zh ? '已复制摘要' : 'Copied' }
            },
          }
        },
      },
    })

    ctx.dshGo.panel('ctx-trend', {
      view: (scope, caps) => {
        const zh = zhOf(caps?.locale)
        return {
          type: 'stack',
          title: zh ? '上下文演变' : 'Evolution',
          children: [
            { type: 'row', children: [
              { type: 'metric', label: zh ? '当前' : 'Now', value: { $: 'data.nowText' }, tone: 'info', caption: { $: 'data.nowCap' } },
              { type: 'metric', label: zh ? '增长' : 'Growth', value: { $: 'data.growText' }, caption: { $: 'data.growCap' } },
              { type: 'metric', label: zh ? '缓存' : 'Cache', value: { $: 'data.cacheText' }, caption: { $: 'data.cacheCap' } },
            ] },
            { type: 'text', text: { $: 'data.modelText' }, tone: 'muted' },
            { type: 'list', items: { $: 'data.rowsReq' } },
            { type: 'text', text: zh ? '最近上下文事件' : 'Recent context events', tone: 'muted' },
            { type: 'list', items: { $: 'data.rowsEv' } },
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
          const sid = scope?.sessionId
          if (!sid) { emit(trendError(zh ? '在对话里打开可看当前会话的演变。' : 'Open inside a conversation.', zh)); return }
          try {
            const j = await post('/api/dsh-context/detail', { sessionId: sid })
            if (!stopped) emit(buildTrend(j.value, zh))
          } catch (err) {
            if (!stopped) emit(trendError(String(err.message || err), zh))
          }
        }
        void tick()
        timer = setInterval(tick, 60_000)
        return () => { stopped = true; if (timer) clearInterval(timer) }
      },
      actions: {
        refresh: (scope, event) => {
          const zh = zhOf(event?.locale)
          const sid = scope?.sessionId
          if (!sid) return { toast: zh ? '没有当前会话' : 'No session' }
          return {
            pending: { label: zh ? '正在刷新' : 'Refreshing', timeoutMs: 30000 },
            result: async () => {
              const j = await post('/api/dsh-context/detail', { sessionId: sid })
              return { patch: buildTrend(j.value, zh), toast: zh ? '已刷新' : 'Refreshed' }
            },
          }
        },
        copySummary: (scope, event) => {
          const zh = zhOf(event?.locale)
          const sid = scope?.sessionId
          if (!sid) return { toast: zh ? '没有当前会话' : 'No session' }
          return {
            pending: { label: zh ? '正在生成摘要' : 'Preparing', timeoutMs: 30000 },
            result: async () => {
              const j = await post('/api/dsh-context/detail', { sessionId: sid })
              return { copy: (zh ? '上下文演变' : 'Evolution') + '\n' + (buildTrend(j.value, zh).summary || ''), toast: zh ? '已复制摘要' : 'Copied' }
            },
          }
        },
      },
    })

    ctx.dshGo.panel('ctx-insights', {
      view: (scope, caps) => {
        const zh = zhOf(caps?.locale)
        const children = [
          { type: 'row', children: [
            { type: 'metric', label: zh ? '累计 tokens' : 'Total tokens', value: { $: 'data.tokenText' }, tone: 'info', caption: { $: 'data.tokenCap' } },
            { type: 'metric', label: zh ? '成本' : 'Cost', value: { $: 'data.costText' }, caption: { $: 'data.costCap' } },
            { type: 'metric', label: zh ? '缓存' : 'Cache', value: { $: 'data.cacheText' }, caption: { $: 'data.cacheCap' } },
          ] },
        ]
        for (let i = 0; i < 8; i++) {
          children.push({ type: 'progress', value: { $: 'data.b' + i }, max: { $: 'data.bmax' }, label: { $: 'data.n' + i }, caption: { $: 'data.c' + i } })
        }
        children.push(
          { type: 'keyValue', items: { $: 'data.kvMisc' } },
          { type: 'text', text: zh ? '近 7 天' : 'Last 7 days', tone: 'muted' },
          { type: 'keyValue', items: { $: 'data.kvWeek' } },
          { type: 'callout', text: { $: 'data.note' }, tone: 'info' },
          { type: 'actions', items: [
            { label: zh ? '刷新' : 'Refresh', action: 'refresh' },
            { label: zh ? '复制摘要' : 'Copy summary', action: 'copySummary', style: 'plain' },
          ] },
        )
        return { type: 'stack', title: zh ? '全部洞察' : 'Insights', children }
      },
      data: (scope, emit, caps) => {
        const zh = zhOf(caps?.locale)
        let stopped = false
        let timer = null
        const tick = async () => {
          if (stopped) return
          try {
            const { summary, days } = await overviewInsights()
            const ver = await versionInfo()
            if (!stopped) emit(buildInsights(summary, days, ver, zh))
          } catch (err) {
            if (!stopped) emit(insightsError(String(err.message || err), zh))
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
              const { summary, days } = await overviewInsights()
              const ver = await versionInfo()
              return { patch: buildInsights(summary, days, ver, zh), toast: zh ? '已刷新' : 'Refreshed' }
            },
          }
        },
        copySummary: (scope, event) => {
          const zh = zhOf(event?.locale)
          return {
            pending: { label: zh ? '正在生成摘要' : 'Preparing', timeoutMs: 30000 },
            result: async () => {
              const { summary, days } = await overviewInsights()
              const ver = await versionInfo()
              const data = buildInsights(summary, days, ver, zh)
              return { copy: (zh ? '全部洞察' : 'Insights') + '\n' + (data.summaryRows || []).join('\n'), toast: zh ? '已复制摘要' : 'Copied' }
            },
          }
        },
      },
    })
  })
}

export { buildData, buildOverview, buildTrend, buildInsights, contextMarkdown }
