// dsh-wechat-channel —— 给 DSH 接一条微信通道。
//
// 微信只当通道：消息进来注入会话，回复显式发出去。
// 记忆、人设、上下文都留在 DSH 这一份，微信那边不存东西。
//
// 后端职责：
//   1. 扫码登录（拿 bot_token / account_id）
//   2. 存机器人（token 只落本地盘，不进源码目录）
//   3. 绑会话（每个机器人绑一个 DSH 会话）
//
// 运行时数据放 <DSH_HOME>/wechat-channel/，源码目录只放代码。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import qrcode from 'qrcode-generator'
import { createRelay } from './relay.js'
import { createSelfBeat } from './selfbeat.js'

export const name = 'dsh-wechat-channel'
// sessionController 用来把消息注入会话；没有它也能扫码，只是收消息会失败
export const inject = ['sessionController']

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const HEADERS = { 'iLink-App-ClientVersion': '1' }

/** 数据目录：DSH_HOME 优先，兜底 ~/.dsh */
const DATA_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'wechat-channel')
const BOTS_FILE = path.join(DATA_DIR, 'bots.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

/** 正在等着的扫码会话（内存里，重启即失效） */
const pending = new Map()
/** 已经建好的扫码会话：同一个 id 再来问，直接认出是同一次，别再建一条 */
const finished = new Map()
let seq = 0

// ─────────────────────────── 存取 ───────────────────────────

/** @returns {{ bots: any[], lastBotId: string }} */
function readState() {
  try {
    const raw = fs.readFileSync(BOTS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      bots: Array.isArray(parsed?.bots) ? parsed.bots : [],
      lastBotId: typeof parsed?.lastBotId === 'string' ? parsed.lastBotId : '',
    }
  } catch {
    return { bots: [], lastBotId: '' }
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = BOTS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, BOTS_FILE)
}

/** 把某个机器人的一小块状态写回 bots.json——重启后还知道该回谁 */
function patchBot(id, patch) {
  try {
    const state = readState()
    const i = state.bots.findIndex((b) => b && b.id === id)
    if (i < 0) return
    state.bots[i] = { ...state.bots[i], ...patch }
    writeState(state)
  } catch {
    /* 存不下就算了，别把收发搅停 */
  }
}

/** 记住「最后是哪个机器人收到的消息」——重启之后主动找人也有个默认目标 */
function rememberLastBot(botId) {
  try {
    const state = readState()
    if (state.lastBotId === botId) return
    state.lastBotId = botId
    writeState(state)
  } catch {
    /* 同上 */
  }
}

// ─────────────────────── 主动找人：按时段选号 ───────────────────────

/** 主动找人的默认号：上班时段找小号，下班找大号（可在 settings.json 里改） */
const DEFAULT_SETTINGS = {
  workDays: [1, 2, 3, 4, 5], // 上班的日子：1=周一 … 6=周六、0=周日（周末不算上班）
  workStart: '08:30', // 上班时间
  workEnd: '18:00', // 下班时间
  workBotId: '', // 上班时段用哪条机器人（空＝按名字猜「小号」）
  offBotId: '', // 下班时段用哪条机器人（空＝按名字猜「大号」）
  replyWindowMinutes: 20, // 这段时间内有人说过话，就回那条，不按时段挑
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 'HH:MM' → 当天第几分钟；格式不对返回 null */
function minutesOfClock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 本地节假日表：date(YYYY-MM-DD) → true=放假 / false=调休补班。按文件 mtime 缓存，改了就重读 */
let holidayCache = { key: '', map: new Map() }

function holidayMap() {
  try {
    const dir = DATA_DIR
    const files = fs.readdirSync(dir).filter((f) => /^holiday-\d{4}\.json$/.test(f)).sort()
    const key = files.map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|')
    if (key === holidayCache.key) return holidayCache.map
    const map = new Map()
    for (const f of files) {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      for (const d of Array.isArray(parsed?.days) ? parsed.days : []) {
        if (d && d.date) map.set(String(d.date), Boolean(d.isOffDay))
      }
    }
    holidayCache = { key, map }
    return map
  } catch {
    return holidayCache.map || new Map()
  }
}

/** 本地日期 → 'YYYY-MM-DD'（按本机时区，别用 toISOString，那是 UTC） */
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 现在是不是上班时段（节假日表优先，其次周末，再按时段；支持跨夜）；配置不合格返回 null */
function inWorkShift(settings, now = new Date()) {
  const a = minutesOfClock(settings.workStart)
  const b = minutesOfClock(settings.workEnd)
  if (a == null || b == null || a === b) return null

  // ① 节假日表说了算：法定假日 → 当天全算下班；调休补班 → 当天算上班
  const off = holidayMap().get(dateKey(now))
  let workday
  if (off === true) workday = false
  else if (off === false) workday = true
  else {
    // ② 表里没有（比如明年还没发布）→ 退回周末规则
    const days = Array.isArray(settings.workDays) ? settings.workDays.map(Number) : DEFAULT_SETTINGS.workDays
    workday = days.includes(now.getDay())
  }
  if (!workday) return false

  const cur = now.getHours() * 60 + now.getMinutes()
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

/** 按名字猜号：「小号」是上班用的，「大号」是下班用的 */
function pickShiftBot(bots, work) {
  return (
    bots.find((b) => {
      if (!b || !b.id) return false
      const n = String(b.name || '')
      const small = /小/.test(n)
      const big = /大/.test(n)
      return work ? small && !big : big && !small
    }) || null
  )
}

function nextBotId(bots) {  let n = bots.length + 1
  const used = new Set(bots.map((b) => b.id))
  while (used.has(`bot-${n}`)) n += 1
  return `bot-${n}`
}

/** 对外的机器人视图：抹掉 token 全文，只留尾巴 */
function publicBot(bot) {
  const t = String(bot.token || '')
  return {
    id: bot.id,
    name: bot.name,
    accountId: bot.accountId,
    sessionId: bot.sessionId || null,
    createdAt: bot.createdAt,
    tokenTail: t ? `…${t.slice(-6)}` : '',
    baseUrl: bot.baseUrl || ILINK_BASE,
  }
}

// ─────────────────────────── 接口 ───────────────────────────

/** 会话标题存在 projcache 里（比如「我的房间」）；读不到就返回空 */
function readTitle(sessionId) {
  try {
    const f = path.join(
      path.dirname(DATA_DIR),
      'storages',
      'session_projcache',
      'sessions',
      sessionId + '.json',
    )
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const t = j?.record?.rows?.title?.val
    return typeof t === 'string' ? t.trim() : ''
  } catch {
    return ''
  }
}

/** 扫描 DSH 的会话目录，列出可绑定的会话（最近更新的排前面） */
function listSessions() {
  const out = []
  const root = path.join(path.dirname(DATA_DIR), 'sessions')
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const proj of projects) {
    const projDir = path.join(root, proj.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(projDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const s of sessions) {
      const file = path.join(projDir, s.name, 'session.v4.jsonl.zstd')
      let st
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      out.push({
        id: s.name,
        title: readTitle(s.name),
        // 目录名是编码过的路径：--<编码后的工程目录>--
        workspace: proj.name.replace(/^-+|-+$/g, '').replace(/-/g, '\\'),
        updatedAt: st.mtimeMs,
      })
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

/** 微信给的是一个链接，这里画成二维码 SVG */
function toSvg(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true })
}

/** 拉一张新的登录二维码 */
async function requestQr(name) {
  const data = await getJson(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`)
  if (!data.qrcode || !data.qrcode_img_content) {
    throw new Error('接口没给二维码')
  }
  const id = `qr-${++seq}`
  pending.set(id, { qrcode: data.qrcode, name: String(name || '').trim(), at: Date.now() })
  return { id, content: data.qrcode_img_content, svg: toSvg(data.qrcode_img_content) }
}

/** 记住「这次扫码已经建好了」——前端轮询会并发打进来，同一个码只许建一次 */
function rememberFinished(id, bot) {
  finished.set(id, bot)
  if (finished.size > 20) {
    const oldest = finished.keys().next().value
    finished.delete(oldest)
  }
}

/** 问扫码结果；确认后直接落盘 */
async function checkQr(id) {
  const seen = finished.get(id)
  if (seen) return { code: 200, body: { status: 'created', bot: publicBot(seen), reused: true } }

  const item = pending.get(id)
  if (!item) {
    return { code: 404, body: { error: '没有这个扫码会话，可能已经过期或者重开过' } }
  }
  const data = await getJson(
    `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(item.qrcode)}`,
    40000,
  )
  const st = String(data.status || 'wait')

  if (st === 'confirmed') {
    if (!data.bot_token) {
      return { code: 200, body: { status: 'error', message: '登录成功，但接口没给 token' } }
    }
    pending.delete(id)

    const state = readState()
    const accountId = data.ilink_bot_id || ''
    // 同一个微信号扫了两次就按账号合并，别再冒出一条（上一版就是这么出两个的）
    const existed = accountId ? state.bots.find((b) => b && b.accountId === accountId) : null
    if (existed) {
      existed.token = data.bot_token
      if (item.name) existed.name = item.name
      if (data.ilink_user_id) existed.userId = data.ilink_user_id
      existed.baseUrl = data.base_url || data.baseurl || existed.baseUrl
      writeState(state)
      rememberFinished(id, existed)
      return { code: 200, body: { status: 'created', bot: publicBot(existed), reused: true } }
    }

    const bot = {
      id: nextBotId(state.bots),
      name: item.name || `微信-${state.bots.length + 1}`,
      token: data.bot_token,
      accountId,
      userId: data.ilink_user_id || '',
      baseUrl: data.base_url || data.baseurl || ILINK_BASE,
      sessionId: null,
      createdAt: Date.now(),
    }
    state.bots.push(bot)
    writeState(state)
    rememberFinished(id, bot)
    return { code: 200, body: { status: 'created', bot: publicBot(bot) } }
  }

  if (st === 'expired') return { code: 200, body: { status: 'expired' } }
  if (st === 'cancel' || st === 'canceled' || st === 'denied') {
    return { code: 200, body: { status: 'denied' } }
  }
  return { code: 200, body: { status: 'pending' } }
}

// ─────────────────────────── 界面 ───────────────────────────

const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信通道</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         max-width: 680px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .hint { color: #888; margin: 0 0 24px; font-size: 13px; }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; padding: 1px 8px; border-radius: 99px; background: #8882; }
  .ok { background: #25a55f33; color: #25a55f; }
  .no { background: #8882; color: #888; }
  input { font: inherit; padding: 5px 8px; border: 1px solid #8886; border-radius: 6px; background: transparent; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #8886;
           background: #8881; cursor: pointer; }
  button:hover { background: #8883; }
  button.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  #qrbox { text-align: center; margin: 20px 0; padding: 20px; border: 1px dashed #8886; border-radius: 12px; }
  #qrbox svg { width: 240px; height: 240px; background: #fff; border-radius: 8px; padding: 8px; }
  #qrtip { margin-top: 10px; color: #888; font-size: 13px; }
  .muted { color: #888; font-size: 13px; }
</style>
</head>
<body>
<h1>微信通道</h1>
<p class="hint">微信只当通道：消息进你绑定的会话，回的话发回微信。记忆不存微信那边。</p>

<div id="qrbox" hidden>
  <div id="qrimg"></div>
  <div id="qrtip">用手机微信扫码，确认登录</div>
</div>

<div id="list"></div>
<p><input id="newname" placeholder="起个名字（不填就叫「小号」）" style="padding:6px 10px;border-radius:6px;border:1px solid #8886;background:transparent;font:inherit;margin-right:8px;min-width:200px" /><button class="primary" id="new">+ 新建机器人</button></p>

<script>
const API = '/dsh-wechat';
const $ = (id) => document.getElementById(id);
let polling = null;
let SESSIONS = [];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function shortTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function shortName(s) {
  const w = String(s.workspace || '').split('\\\\').pop() || '?'
  // 有标题就先用标题（人认得出来），没有才退回工作目录名
  const name = String(s.title || '').trim() || w
  return name + ' · ' + shortTime(s.updatedAt)
}

async function load() {
  const [b, s] = await Promise.all([
    fetch(API + '/bots').then((r) => r.json()),
    fetch(API + '/sessions').then((r) => r.json()).catch(() => ({ sessions: [] })),
  ]);
  SESSIONS = s.sessions || [];
  const list = $('list');
  list.innerHTML = '';
  if (!b.bots || !b.bots.length) {
    list.appendChild(el('p', 'muted', '还没有机器人。点下面的按钮新建一个。'));
    return;
  }
  for (const bot of b.bots) list.appendChild(card(bot));
}

function card(bot) {
  const box = el('div', 'card');
  const row = el('div', 'row');
  row.appendChild(el('span', 'name', bot.name));
  // 直接把绑的是哪个会话写出来，不用展开下拉也知道
  const bound = bot.sessionId ? SESSIONS.find((s) => s.id === bot.sessionId) : null;
  const boundLabel = bot.sessionId
    ? '已绑 · ' + (bound ? (bound.title || shortName(bound)) : '（列表里没找到）')
    : '未绑会话';
  row.appendChild(el('span', 'tag ' + (bot.sessionId ? 'ok' : 'no'), boundLabel));
  row.appendChild(el('span', 'muted', '账号 ' + (bot.accountId || '?')));
  row.appendChild(el('span', 'muted', 'token ' + (bot.tokenTail || '?')));
  box.appendChild(row);

  const bind = el('div', 'row');
  bind.style.marginTop = '10px';

  const sel = document.createElement('select');
  sel.style.flex = '1';
  sel.style.minWidth = '260px';
  sel.style.padding = '5px 8px';
  sel.style.borderRadius = '6px';
  sel.style.border = '1px solid #8886';
  sel.style.background = 'transparent';
  sel.style.font = 'inherit';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— 选一个会话 —';
  sel.appendChild(none);

  let matched = false;
  for (const s2 of SESSIONS) {
    const o = document.createElement('option');
    o.value = s2.id;
    o.textContent = shortName(s2);
    if (s2.id === bot.sessionId) { o.selected = true; matched = true; }
    sel.appendChild(o);
  }
  if (bot.sessionId && !matched) {
    const o = document.createElement('option');
    o.value = bot.sessionId;
    o.textContent = bot.sessionId + '（已绑，但列表里没找到）';
    o.selected = true;
    sel.appendChild(o);
  }

  const save = el('button', null, '保存');
  save.onclick = async () => {
    await fetch(API + '/bots/' + encodeURIComponent(bot.id) + '/bind?sessionId='
      + encodeURIComponent(sel.value), { method: 'POST' });
    load();
  };
  const rename = el('button', null, '改名');
  // 改名走内联输入行：面板常驻在设置页的 iframe 里，Electron 会把 prompt() 拦掉，
  // 表现就是「点了没反应」——所以这里一个弹窗都不用。
  const renameRow = el('div', 'row');
  renameRow.style.display = 'none';
  renameRow.style.marginTop = '8px';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = bot.name;
  nameInput.style.flex = '1';
  nameInput.style.minWidth = '200px';
  nameInput.style.padding = '5px 8px';
  nameInput.style.borderRadius = '6px';
  nameInput.style.border = '1px solid #8886';
  nameInput.style.background = 'transparent';
  nameInput.style.font = 'inherit';
  const renameOk = el('button', null, '确定');
  const renameNo = el('button', null, '取消');
  renameRow.appendChild(nameInput);
  renameRow.appendChild(renameOk);
  renameRow.appendChild(renameNo);
  box.appendChild(renameRow);

  rename.onclick = () => {
    renameRow.style.display = 'flex';
    nameInput.value = bot.name;
    nameInput.focus();
    nameInput.select();
  };
  renameOk.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name || name === bot.name) {
      renameRow.style.display = 'none';
      return;
    }
    await fetch(API + '/bots/' + encodeURIComponent(bot.id) + '/rename?name='
      + encodeURIComponent(name), { method: 'POST' });
    load();
  };
  renameNo.onclick = () => { renameRow.style.display = 'none' };

  // 删除也不用 confirm()，同一个原因
  const del = el('button', null, '删除');
  const delRow = el('div', 'row');
  delRow.style.display = 'none';
  delRow.style.marginTop = '8px';
  delRow.appendChild(el('span', 'muted', '删掉「' + bot.name + '」？删了得重新扫码。'));
  const delOk = el('button', null, '确定删');
  const delNo = el('button', null, '算了');
  delRow.appendChild(delOk);
  delRow.appendChild(delNo);
  box.appendChild(delRow);

  del.onclick = () => { delRow.style.display = 'flex' };
  delOk.onclick = async () => {
    await fetch(API + '/bots/' + encodeURIComponent(bot.id), { method: 'DELETE' });
    load();
  };
  delNo.onclick = () => { delRow.style.display = 'none' };

  bind.appendChild(sel);
  bind.appendChild(save);
  bind.appendChild(rename);
  bind.appendChild(del);
  box.appendChild(bind);
  return box;
}

async function newBot() {
  // 不要用 prompt：嵌在设置页的 iframe 里，Electron 会把它当弹窗拦掉，点了像死了一样
  const typed = ($('newname').value || '').trim();
  const name = typed || '小号';
  $('newname').value = '';
  $('qrbox').hidden = false;
  $('qrimg').innerHTML = '<span class="muted">正在拿二维码…</span>';
  $('qrtip').textContent = '用手机微信扫码，确认登录';

  const r = await fetch(API + '/qr?name=' + encodeURIComponent(name));
  const data = await r.json();
  if (!data.svg) {
    $('qrimg').innerHTML = '<span class="muted">拿不到二维码：' + (data.error || '未知错误') + '</span>';
    return;
  }
  $('qrimg').innerHTML = data.svg;

  clearInterval(polling);
  polling = setInterval(async () => {
    const s = await fetch(API + '/qr/status?id=' + encodeURIComponent(data.id)).then(x => x.json());
    if (s.status === 'created') {
      clearInterval(polling);
      $('qrtip').textContent = '扫码成功：' + s.bot.name + ' 已保存';
      setTimeout(() => { $('qrbox').hidden = true; }, 1200);
      load();
    } else if (s.status === 'expired') {
      clearInterval(polling);
      $('qrtip').textContent = '二维码过期了，重新点一次「新建机器人」';
    } else if (s.status === 'denied') {
      clearInterval(polling);
      $('qrtip').textContent = '取消了登录';
    }
  }, 1500);
}

$('new').onclick = newBot;
load();
</script>
</body>
</html>`

// ─────────────────────────── 插件 ───────────────────────────

export function apply(ctx, config = {}) {
  console.log('[dsh-wechat] 插件加载，开始挂服务')
  /** 中继（收发都在它那儿）；sessionController 到位后才建得起来 */
  let relay = null
  /** 自主出门：到点叫醒她一声，说不说、说什么由她定 */
  let selfBeat = null

  ctx.inject(['sessionController'], (scoped) => {
    if (relay) return
    try {
      relay = createRelay({
        readBots: () => readState().bots,
        patchBot,
        rememberLastBot,
        sessionController: scoped.sessionController,
        mediaDir: path.join(DATA_DIR, 'media'),
        log: (m) => console.log('[dsh-wechat]', m),
      })
      const bots = readState().bots
      console.log('[dsh-wechat] sessionController 就绪，机器人', bots.length, '个')
      // 已经绑好会话的机器人，直接开始听
      for (const bot of bots) {
        if (bot.sessionId) {
          console.log('[dsh-wechat] 开始轮询', bot.name, '→', bot.sessionId)
          relay.start(bot.id)
        }
      }
      // 自主出门：心跳插件停用之后，这条通道自己留一扇窗
      selfBeat = createSelfBeat({
        relay,
        readBots: () => readState().bots,
        dataDir: DATA_DIR,
        readConfig: readSettings,
        log: (m) => console.log('[dsh-wechat]', m),
      })
      selfBeat.start()
    } catch (err) {
      console.log('[dsh-wechat] 中继起不来：', err instanceof Error ? err.message : String(err))
    }
  })

  // 给 agent 一个「发到微信」的工具
  ctx.inject(['tools'], (scoped) => {
    try {
      scoped.tools.register({
        name: 'wechat_send',
        description:
          '往微信发一条消息。只有绑定在本会话上的机器人能发——别的会话的号会直接被拒绝。微信屏幕小，只发结论、一两句；细节留在 DSH 这边。不指定 to 时：刚有人说过话就回那个号；没人说话就按时段挑——上班（8:30–18:00）发小号，其余时间发大号。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要发送的文字，尽量 120 字以内' },
            to: { type: 'string', description: '可选：指定哪个机器人（填名字或 id，必须是绑在本会话上的号）' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
            required: ['ok', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        timeoutMs: 20000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const text = String(args?.text ?? '').trim()
          if (!text) return { ok: false, message: 'text 不能为空' }
          if (!relay) return { ok: false, message: '微信中继还没起来（sessionController 未就绪）' }

          // 只认绑定：这个会话绑了哪些机器人，就只能从这些里挑——回执不会串到别人家的号上。
          // 宿主把调用方会话放在 exec.agent.session.id 里；拿不到就宁可不发。
          const callerSession = exec?.agent?.session?.id || ''
          if (!callerSession) return { ok: false, message: '拿不到当前会话，为防串号这次不发' }

          const state = readState()
          let bots = (state.bots || []).filter((b) => b && b.id && b.sessionId === callerSession)
          if (!bots.length) {
            return { ok: false, message: '这个会话没绑微信机器人，发不出去（设置 → 微信通道里绑一个）' }
          }

          // 明确点了号：那号也必须绑在这个会话上
          if (args?.to) {
            const want = bots.find(
              (b) => b.id === args.to || b.name === args.to || b.accountId === args.to,
            )
            if (!want) {
              return { ok: false, message: `「${args.to}」不是绑在这个会话上的机器人，不能发` }
            }
            bots = [want]
          }

          // 挑号的三层规矩（只在「绑在本会话的号」里面挑）：
          //   ① 刚有人说过话（默认 20 分钟内）→ 回那条，别让那头等着
          //   ② 没人说话 → 按时段：上班找小号，其余找大号
          //   ③ 上面都不成 → 退回「上次记下的那个号」
          const settings = readSettings()
          const picked = typeof relay.lastIncoming === 'function' ? relay.lastIncoming() : null
          const fresh =
            picked &&
            Date.now() - Number(picked.at || 0) < Number(settings.replyWindowMinutes || 20) * 60 * 1000
          const work = inWorkShift(settings)
          const byId = (id) => (id ? bots.find((b) => b && b.id === id) || null : null)
          const ordered = [
            fresh ? byId(picked.botId) : null,
            work === null ? null : byId(work ? settings.workBotId : settings.offBotId),
            work === null ? null : pickShiftBot(bots, work),
            byId(state.lastBotId),
            bots.find((b) => b && b.lastUserId) || null,
            bots[0] || null,
          ].filter(Boolean)
          const why = fresh ? '回刚说话的那个' : work === null ? '默认号' : work ? '上班时段' : '下班时段'

          let lastErr = null
          const tried = new Set()
          for (const bot of ordered) {
            if (tried.has(bot.id)) continue
            tried.add(bot.id)
            // 回复对象：刚说话的那个人；否则用这号上次记下的用户
            const to = fresh && picked && bot.id === picked.botId ? picked.userId : bot.lastUserId || undefined
            try {
              await relay.sendText(bot, text, to)
              return { ok: true, message: `已发给「${bot.name}」（${why}）` }
            } catch (err) {
              // 这条发不出去（比如从没收到过它的消息），换下一条试
              lastErr = err
            }
          }
          return { ok: false, message: lastErr ? String(lastErr.message || lastErr) : '没有可用的机器人' }
        },
      })
    } catch (err) {
      console.log('[dsh-wechat] 工具注册失败：', err instanceof Error ? err.message : String(err))
    }
  })

  ctx.inject(['webServer'], (scope) => {
    scope.webServer.register({
      kind: 'prefix',
      path: '/dsh-wechat',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://local')
        const route = url.pathname.replace(/^\/dsh-wechat/, '') || '/'
        const method = (req.method || 'GET').toUpperCase()

        const reply = (code, obj) => {
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(obj))
        }

        try {
          // 小面板（独立页面，先不挤进 DSH 设置）
          if (route === '/ui' && method === 'GET') {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(UI_HTML)
            return
          }

          // 可绑定的会话列表
          if (route === '/sessions' && method === 'GET') {
            return reply(200, { sessions: listSessions() })
          }

          // 机器人列表
          if (route === '/bots' && method === 'GET') {
            return reply(200, { bots: readState().bots.map(publicBot) })
          }

          // 拉二维码：?name=小号
          if (route === '/qr' && method === 'GET') {
            const name = url.searchParams.get('name') || ''
            return reply(200, await requestQr(name))
          }

          // 问扫码结果：?id=qr-1
          if (route === '/qr/status' && method === 'GET') {
            const id = url.searchParams.get('id') || ''
            const out = await checkQr(id)
            return reply(out.code, out.body)
          }

          // 删掉一个机器人
          const delMatch = route.match(/^\/bots\/([^/]+)$/)
          if (delMatch && method === 'DELETE') {
            const id = decodeURIComponent(delMatch[1])
            const state = readState()
            const idx = state.bots.findIndex((b) => b.id === id)
            if (idx < 0) return reply(404, { error: '没有这个机器人' })
            state.bots.splice(idx, 1)
            writeState(state)
            return reply(200, { ok: true })
          }

          // 绑会话
          const bindMatch = route.match(/^\/bots\/([^/]+)\/bind$/)
          if (bindMatch && method === 'POST') {
            const id = decodeURIComponent(bindMatch[1])
            const sessionId = url.searchParams.get('sessionId') || ''
            const state = readState()
            const bot = state.bots.find((b) => b.id === id)
            if (!bot) return reply(404, { error: '没有这个机器人' })
            bot.sessionId = sessionId || null
            writeState(state)
            if (bot.sessionId) relay?.start(bot.id)
            else relay?.stop(bot.id)
            return reply(200, { ok: true, bot: publicBot(bot) })
          }

          // 改名：扫完码之后自己起的名不一定准（比如把大号叫成了小号）
          const renameMatch = route.match(/^\/bots\/([^/]+)\/rename$/)
          if (renameMatch && method === 'POST') {
            const id = decodeURIComponent(renameMatch[1])
            const name = (url.searchParams.get('name') || '').trim()
            if (!name) return reply(400, { error: '名字不能为空' })
            const state = readState()
            const bot = state.bots.find((b) => b.id === id)
            if (!bot) return reply(404, { error: '没有这个机器人' })
            bot.name = name
            writeState(state)
            return reply(200, { ok: true, bot: publicBot(bot) })
          }

          return reply(404, { error: `没有这条路：${method} ${route}` })
        } catch (err) {
          return reply(500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    })
  })

  // 插件被卸载或重载时把定时器收干净，别在后台留一个没人管的孤儿
  try {
    ctx.on?.('dispose', () => {
      try {
        selfBeat?.stop()
      } catch {
        /* 停不下也别拦着卸载 */
      }
    })
  } catch {
    /* 这个宿主没给 ctx.on，跳过 */
  }
}
