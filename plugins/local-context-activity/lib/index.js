export const name = 'dsh-go-context-activity'

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
    return m ? Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64') : null
  } catch { return null }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function post(path, payload) {
  let lastErr = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const headers = cookieHeader()
      if (!headers) throw new Error('本机凭据读取失败')
      const r = await fetch(BASE + path, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(15000),
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

const zhOf = (locale) => !String(locale || 'zh').startsWith('en')
const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}
const shortId = (id) => String(id || '').replace(/^session-/, '').slice(0, 8)
const timeOf = (value) => {
  const d = new Date(Number(value) || 0)
  return d.getTime() ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ''
}
const durationOf = (ms) => {
  const n = Number(ms) || 0
  if (n >= 60000) return (n / 60000).toFixed(1) + 'm'
  if (n >= 1000) return (n / 1000).toFixed(1) + 's'
  return Math.round(n) + 'ms'
}
const basename = (path) => String(path || '').split('/').filter(Boolean).pop() || String(path || '—')
const dirname = (path) => {
  const parts = String(path || '').split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}

async function detailOf(sessionId) {
  return (await post('/api/dsh-context/detail', { sessionId })).value || {}
}
async function fleetOf(sessionId) {
  return (await post('/api/dsh-context/fleet', { sessionId, summary: true })).value || null
}

function fleetError(message) {
  return { ready:true, note:message, familyText:'—', familyCap:'', messageText:'—', messageCap:'', rootText:'', replyText:'', rowsMembers:[], rowsMessages:[], summary:'' }
}

function buildFleet(value, zh) {
  if (!value) return fleetError(zh ? '没有读取到 Agent 网络信息' : 'No agent fleet data')
  const detail = value.detail || {}
  const members = Array.isArray(value.members) ? value.members : []
  const messages = Array.isArray(detail.messages) ? detail.messages : []
  const counts = value.counts || {}
  const family = Number(value.familySize) || members.length + 1
  const rowsMembers = members.slice(0, 30).map((m) => {
    const c = counts[m.id] || {}
    const name = m.name || m.label || (zh ? '子 Agent ' : 'Agent ') + shortId(m.id)
    const subtitle = [m.label || m.description, m.mode, m.phase].filter(Boolean).join(' · ')
    const trailing = [c.delegationsCount ? (zh ? '委派 ' : 'children ') + c.delegationsCount : '', c.messagesTotal ? (zh ? '消息 ' : 'messages ') + c.messagesTotal : ''].filter(Boolean).join(' · ')
    return { title:clip(name, 30), subtitle:clip(subtitle, 60) || shortId(m.id), trailing:trailing || undefined, icon:'agent', tone:m.phase === 'active' ? 'good' : undefined }
  })
  if (!rowsMembers.length) rowsMembers.push({ title:zh ? '当前没有子 Agent' : 'No child agents', subtitle:zh ? '此会话尚未派发子代理或团队成员' : 'No delegations in this session', icon:'agent' })
  const kindNames = zh ? { relay:'转发', mailbox:'团队消息', settled:'完成' } : { relay:'Relay', mailbox:'Mailbox', settled:'Settled' }
  const rowsMessages = messages.slice(0, 20).map((m) => ({
    title:clip(m.fromName || m.from || kindNames[m.kind] || (zh ? 'Agent 消息' : 'Agent message'), 30),
    subtitle:clip(m.summary || m.text, 70) || undefined,
    trailing:timeOf(m.time) || undefined,
    icon:m.kind === 'settled' ? 'done' : 'chat',
  }))
  if (!rowsMessages.length) rowsMessages.push({ title:zh ? '暂无 Agent 消息' : 'No agent messages', icon:'chat' })
  const descriptor = detail.descriptor || {}
  const mode = [descriptor.agentProvider || descriptor.provider, descriptor.agentModel, descriptor.agentReasoningEffort].filter(Boolean).join(' · ')
  const prompt = clip(detail.initialPrompt, 100)
  const reply = clip(detail.lastReply?.text, 100)
  return {
    ready:true,
    familyText:String(family), familyCap:zh ? '含当前 Agent' : 'including this agent',
    messageText:String(detail.messagesTotal ?? messages.length), messageCap:zh ? 'Agent 消息' : 'agent messages',
    rootText:prompt ? (zh ? '任务：' : 'Task: ') + prompt : (zh ? '当前会话' : 'Current session') + ' · ' + shortId(value.rootId),
    replyText:reply ? (zh ? '最近回复：' : 'Last reply: ') + reply : mode,
    rowsMembers, rowsMessages,
    note:zh ? '每 60 秒刷新 · 成员与消息来自 dsh-context Fleet' : 'Every 60s · from dsh-context Fleet',
    summary:(zh ? 'Agent 网络：' : 'Fleet: ') + family + (zh ? ' 个成员，' : ' members, ') + (detail.messagesTotal ?? messages.length) + (zh ? ' 条消息' : ' messages'),
  }
}

function filesError(message) {
  return { ready:true, note:message, opsText:'—', opsCap:'', errText:'—', errCap:'', fileText:'—', fileCap:'', rows:[], kvKinds:[], summary:'' }
}

function buildFiles(detail, zh) {
  const ops = Array.isArray(detail?.fileOps) ? detail.fileOps : []
  const kinds = {}
  const files = new Set()
  let errors = 0
  for (const op of ops) {
    const kind = String(op.kind || 'other')
    kinds[kind] = (kinds[kind] || 0) + 1
    if (op.path) files.add(op.path)
    if (op.err) errors++
  }
  const kindZh = { read:'读取', write:'写入', edit:'编辑', create:'新建', delete:'删除', move:'移动', other:'其他' }
  const rows = ops.slice(-20).reverse().map((op) => {
    const delta = (Number(op.added) || Number(op.removed)) ? '+' + (Number(op.added) || 0) + '/-' + (Number(op.removed) || 0) : ''
    return {
      title:(op.err ? '失败 · ' : '') + (zh ? (kindZh[op.kind] || op.kind || '操作') : (op.kind || 'operation')) + ' · ' + clip(basename(op.path), 24),
      subtitle:clip(dirname(op.path) + (op.program ? ' · ' + op.program : ''), 70),
      trailing:[delta, timeOf(op.time)].filter(Boolean).join(' · ') || undefined,
      icon:op.err ? 'error' : (op.kind === 'read' ? 'read' : 'edit'), tone:op.err ? 'bad' : undefined,
    }
  })
  if (!rows.length) rows.push({ title:zh ? '暂无文件活动' : 'No file activity', icon:'file' })
  return {
    ready:true, opsText:String(ops.length), opsCap:zh ? '文件操作' : 'file operations',
    errText:String(errors), errCap:zh ? '失败操作' : 'failed', fileText:String(files.size), fileCap:zh ? '涉及文件' : 'files touched',
    rows, kvKinds:Object.entries(kinds).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[zh ? (kindZh[k] || k) : k, String(v)]),
    note:zh ? '每 60 秒刷新 · 仅显示最近 20 条' : 'Every 60s · latest 20',
    summary:(zh ? '文件活动：' : 'Files: ') + ops.length + (zh ? ' 次操作，' : ' operations, ') + files.size + (zh ? ' 个文件，失败 ' : ' files, failed ') + errors,
  }
}

function commandsError(message) {
  return { ready:true, note:message, runText:'—', runCap:'', failText:'—', failCap:'', timeText:'—', timeCap:'', rows:[], kvTools:[], summary:'' }
}

function buildCommands(detail, zh) {
  const commands = Array.isArray(detail?.commands) ? detail.commands : []
  const stats = detail?.commandStats || {}
  const failed = commands.filter((c) => c.err || c.status === 'failed').length || Number(stats.failed) || 0
  const tally = detail?.head?.programTally || {}
  const kvTools = Object.entries(tally).sort((a,b)=>(Number(b[1])||0)-(Number(a[1])||0)).slice(0,8).map(([k,v])=>[k,String(v)])
  const rows = commands.slice(-20).reverse().map((c) => {
    const title = c.description || String(c.cmd || '').split('\n')[0] || c.tool || 'command'
    const status = c.status === 'running' ? (zh ? '运行中' : 'running') : (c.err || c.status === 'failed' ? (zh ? '失败' : 'failed') : (zh ? '完成' : 'done'))
    const ms = Number(c.end) > 0 && Number(c.start) > 0 ? Number(c.end) - Number(c.start) : 0
    return {
      title:clip(title, 34),
      subtitle:[c.tool, c.turn !== undefined ? 'T' + c.turn + (c.step !== undefined ? '·S' + c.step : '') : '', c.outChars !== undefined ? (zh ? '输出 ' : 'out ') + c.outChars : ''].filter(Boolean).join(' · '),
      trailing:[status, ms ? durationOf(ms) : ''].filter(Boolean).join(' · '),
      icon:c.err ? 'error' : (c.status === 'running' ? 'running' : 'terminal'), tone:c.err ? 'bad' : undefined,
    }
  })
  if (!rows.length) rows.push({ title:zh ? '暂无命令执行' : 'No commands', icon:'terminal' })
  const runs = Number(stats.runs) || commands.length
  const ms = Number(stats.ms) || commands.reduce((acc,c)=>acc + Math.max(0,(Number(c.end)||0)-(Number(c.start)||0)),0)
  return {
    ready:true, runText:String(runs), runCap:zh ? '命令执行' : 'command runs',
    failText:String(failed), failCap:zh ? '失败' : 'failed', timeText:durationOf(ms), timeCap:zh ? '累计耗时' : 'total time',
    rows, kvTools,
    note:zh ? '每 60 秒刷新 · 仅显示最近 20 条，不展示完整命令内容' : 'Every 60s · latest 20, command bodies omitted',
    summary:(zh ? '命令执行：' : 'Commands: ') + runs + (zh ? ' 次，失败 ' : ' runs, failed ') + failed + (zh ? '，耗时 ' : ', time ') + durationOf(ms),
  }
}

function activityMarkdown(detail, fleet, zh) {
  const f = buildFiles(detail, zh)
  const c = buildCommands(detail, zh)
  const a = buildFleet(fleet, zh)
  const lines = [zh ? '# 活动报告' : '# Activity report', '', '## ' + (zh ? 'Agent 网络' : 'Agent fleet'), a.summary]
  for (const m of (a.rowsMembers || []).slice(0,10)) lines.push('- ' + m.title + (m.subtitle ? ' · ' + m.subtitle : ''))
  lines.push('', '## ' + (zh ? '文件活动' : 'File activity'), f.summary)
  for (const op of (f.rows || []).slice(0,10)) lines.push('- ' + op.title + (op.trailing ? ' · ' + op.trailing : ''))
  lines.push('', '## ' + (zh ? '命令执行' : 'Commands'), c.summary)
  for (const cmd of (c.rows || []).slice(0,10)) lines.push('- ' + cmd.title + (cmd.trailing ? ' · ' + cmd.trailing : ''))
  return lines.join('\n').slice(0,7800)
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('ctxa-report', (scope, event) => {
      const zh = zhOf(event?.locale)
      const sid = scope?.sessionId
      if (!sid) return { toast:zh ? '没有当前会话' : 'No session' }
      return {
        pending:{ label:zh ? '正在生成报告' : 'Preparing report', timeoutMs:30000 },
        result:async () => {
          const [detail, fleet] = await Promise.all([detailOf(sid), fleetOf(sid)])
          return { copy:activityMarkdown(detail, fleet, zh), toast:zh ? '已复制活动报告' : 'Activity copied' }
        },
      }
    })

    ctx.dshGo.panel('ctxa-fleet', {
      view:(scope, caps) => {
        const zh = zhOf(caps?.locale)
        return { type:'stack', title:zh ? 'Agent 网络' : 'Agent fleet', children:[
          { type:'row', children:[
            { type:'metric', label:zh ? '成员' : 'Members', value:{ $:'data.familyText' }, tone:'info', caption:{ $:'data.familyCap' } },
            { type:'metric', label:zh ? '消息' : 'Messages', value:{ $:'data.messageText' }, caption:{ $:'data.messageCap' } },
          ] },
          { type:'text', text:{ $:'data.rootText' } },
          { type:'text', text:{ $:'data.replyText' }, tone:'muted' },
          { type:'list', items:{ $:'data.rowsMembers' } },
          { type:'text', text:zh ? '最近 Agent 消息' : 'Recent agent messages', tone:'muted' },
          { type:'list', items:{ $:'data.rowsMessages' } },
          { type:'callout', text:{ $:'data.note' }, tone:'info' },
          { type:'actions', items:[
            { label:zh ? '刷新' : 'Refresh', action:'refresh' },
            { label:zh ? '复制摘要' : 'Copy summary', action:'copySummary', style:'plain' },
          ] },
        ] }
      },
      data:(scope, emit, caps) => {
        const zh = zhOf(caps?.locale)
        let stopped = false
        const tick = async () => {
          if (stopped) return
          const sid = scope?.sessionId
          if (!sid) { emit(fleetError(zh ? '在对话里打开可看当前 Agent 网络。' : 'Open inside a conversation.')); return }
          try { const value = await fleetOf(sid); if (!stopped) emit(buildFleet(value, zh)) }
          catch (err) { if (!stopped) emit(fleetError(String(err.message || err))) }
        }
        void tick()
        const timer = setInterval(tick, 60000)
        return () => { stopped = true; clearInterval(timer) }
      },
      actions:{
        refresh:(scope, event) => {
          const zh = zhOf(event?.locale), sid = scope?.sessionId
          if (!sid) return { toast:zh ? '没有当前会话' : 'No session' }
          return { pending:{ label:zh ? '正在刷新' : 'Refreshing', timeoutMs:30000 }, result:async () => ({ patch:buildFleet(await fleetOf(sid), zh), toast:zh ? '已刷新' : 'Refreshed' }) }
        },
        copySummary:(scope, event) => {
          const zh = zhOf(event?.locale), sid = scope?.sessionId
          if (!sid) return { toast:zh ? '没有当前会话' : 'No session' }
          return { pending:{ label:zh ? '正在生成摘要' : 'Preparing', timeoutMs:30000 }, result:async () => {
            const data = buildFleet(await fleetOf(sid), zh)
            const lines = [zh ? 'Agent 网络' : 'Agent fleet', data.summary, ...data.rowsMembers.map((m)=>'- '+m.title+(m.subtitle?' · '+m.subtitle:''))]
            return { copy:lines.join('\n').slice(0,7800), toast:zh ? '已复制摘要' : 'Copied' }
          } }
        },
      },
    })

    ctx.dshGo.panel('ctxa-files', {
      view:(scope, caps) => {
        const zh = zhOf(caps?.locale)
        return { type:'stack', title:zh ? '文件活动' : 'File activity', children:[
          { type:'row', children:[
            { type:'metric', label:zh ? '操作' : 'Operations', value:{ $:'data.opsText' }, tone:'info', caption:{ $:'data.opsCap' } },
            { type:'metric', label:zh ? '失败' : 'Failed', value:{ $:'data.errText' }, tone:'warn', caption:{ $:'data.errCap' } },
            { type:'metric', label:zh ? '文件' : 'Files', value:{ $:'data.fileText' }, caption:{ $:'data.fileCap' } },
          ] },
          { type:'keyValue', items:{ $:'data.kvKinds' } },
          { type:'list', items:{ $:'data.rows' } },
          { type:'callout', text:{ $:'data.note' }, tone:'info' },
          { type:'actions', items:[
            { label:zh ? '刷新' : 'Refresh', action:'refresh' },
            { label:zh ? '命令执行' : 'Commands', action:'openCommands', style:'plain' },
            { label:zh ? '复制摘要' : 'Copy summary', action:'copySummary', style:'plain' },
          ] },
        ] }
      },
      data:(scope, emit, caps) => {
        const zh = zhOf(caps?.locale)
        let stopped = false
        const tick = async () => {
          if (stopped) return
          const sid = scope?.sessionId
          if (!sid) { emit(filesError(zh ? '在对话里打开可看当前会话的文件活动。' : 'Open inside a conversation.')); return }
          try { emit(buildFiles(await detailOf(sid), zh)) }
          catch (err) { if (!stopped) emit(filesError(String(err.message || err))) }
        }
        void tick()
        const timer = setInterval(tick, 60000)
        return () => { stopped = true; clearInterval(timer) }
      },
      actions:{
        openCommands:() => ({ open:'panel:ctxa-commands' }),
        refresh:(scope, event) => {
          const zh = zhOf(event?.locale), sid = scope?.sessionId
          if (!sid) return { toast:zh ? '没有当前会话' : 'No session' }
          return { pending:{ label:zh ? '正在刷新' : 'Refreshing', timeoutMs:30000 }, result:async () => ({ patch:buildFiles(await detailOf(sid), zh), toast:zh ? '已刷新' : 'Refreshed' }) }
        },
        copySummary:(scope, event) => {
          const zh = zhOf(event?.locale), sid = scope?.sessionId
          if (!sid) return { toast:zh ? '没有当前会话' : 'No session' }
          return { pending:{ label:zh ? '正在生成摘要' : 'Preparing', timeoutMs:30000 }, result:async () => {
            const data = buildFiles(await detailOf(sid), zh)
            return { copy:[zh ? '文件活动' : 'File activity', data.summary, ...data.rows.map((r)=>'- '+r.title+(r.trailing?' · '+r.trailing:''))].join('\n').slice(0,7800), toast:zh ? '已复制摘要' : 'Copied' }
          } }
        },
      },
    })

    ctx.dshGo.panel('ctxa-commands', {
      view:(scope, caps) => {
        const zh = zhOf(caps?.locale)
        return { type:'stack', title:zh ? '命令执行' : 'Commands', children:[
          { type:'row', children:[
            { type:'metric', label:zh ? '执行' : 'Runs', value:{ $:'data.runText' }, tone:'info', caption:{ $:'data.runCap' } },
            { type:'metric', label:zh ? '失败' : 'Failed', value:{ $:'data.failText' }, tone:'warn', caption:{ $:'data.failCap' } },
            { type:'metric', label:zh ? '耗时' : 'Time', value:{ $:'data.timeText' }, caption:{ $:'data.timeCap' } },
          ] },
          { type:'keyValue', items:{ $:'data.kvTools' } },
          { type:'list', items:{ $:'data.rows' } },
          { type:'callout', text:{ $:'data.note' }, tone:'info' },
          { type:'actions', items:[
            { label:zh ? '刷新' : 'Refresh', action:'refresh' },
            { label:zh ? '文件活动' : 'File activity', action:'openFiles', style:'plain' },
            { label:zh ? '复制摘要' : 'Copy summary', action:'copySummary', style:'plain' },
          ] },
        ] }
      },
      data:(scope, emit, caps) => {
        const zh = zhOf(caps?.locale)
        let stopped = false
        const tick = async () => {
          if (stopped) return
          const sid = scope?.sessionId
          if (!sid) { emit(commandsError(zh ? '在对话里打开可看当前会话的命令执行。' : 'Open inside a conversation.')); return }
          try { emit(buildCommands(await detailOf(sid), zh)) }
          catch (err) { if (!stopped) emit(commandsError(String(err.message || err))) }
        }
        void tick()
        const timer = setInterval(tick, 60000)
        return () => { stopped = true; clearInterval(timer) }
      },
      actions:{
        openFiles:() => ({ open:'panel:ctxa-files' }),
        refresh:(scope, event) => {
          const zh = zhOf(event?.locale), sid = scope?.sessionId
          if (!sid) return { toast:zh ? '没有当前会话' : 'No session' }
          return { pending:{ label:zh ? '正在刷新' : 'Refreshing', timeoutMs:30000 }, result:async () => ({ patch:buildCommands(await detailOf(sid), zh), toast:zh ? '已刷新' : 'Refreshed' }) }
        },
        copySummary:(scope, event) => {
          const zh = zhOf(event?.locale), sid = scope?.sessionId
          if (!sid) return { toast:zh ? '没有当前会话' : 'No session' }
          return { pending:{ label:zh ? '正在生成摘要' : 'Preparing', timeoutMs:30000 }, result:async () => {
            const data = buildCommands(await detailOf(sid), zh)
            return { copy:[zh ? '命令执行' : 'Commands', data.summary, ...data.rows.map((r)=>'- '+r.title+(r.trailing?' · '+r.trailing:''))].join('\n').slice(0,7800), toast:zh ? '已复制摘要' : 'Copied' }
          } }
        },
      },
    })
  })
}

export { buildFleet, buildFiles, buildCommands, activityMarkdown }
