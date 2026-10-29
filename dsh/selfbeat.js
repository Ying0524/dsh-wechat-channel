// dsh-wechat-channel —— 自主出门（selfbeat）
//
// 心跳插件停掉之后，这条通道自己留一扇「想找他就去找」的窗。
//
// 分工要说清楚：
//   - 插件只负责「到点轻轻叫一声」——把一句话注入绑定会话，叫醒 agent；
//   - 说什么、说不说、发哪个号，全由那一轮的她自己决定。
//     插件不会替她编话，也不会偷偷发消息。
//
// 规矩（都能在 settings.json 的 selfBeat 段里改，缺哪项用默认值）：
//   enabled             总开关
//   dailyMax            一天最多叫醒几次
//   minGapHours         两次之间至少隔多久（小时）
//   skipIfActiveMinutes 用户刚说过话就别再找（分钟）
//   quiet               静默时段 ['23:00', '08:00']（可跨夜）
//   windows             可选时间窗：每个窗每天最多用一次，窗内随机取一个分钟
//   tickMinutes         多久看一次表（分钟）
//
// 状态写 <DATA_DIR>/selfbeat.json：记当天叫过几次、哪几个窗用过，重启不丢。

import fs from 'node:fs'
import path from 'node:path'

export const SELF_BEAT_DEFAULT = {
  enabled: true,
  dailyMax: 2,
  minGapHours: 2,
  skipIfActiveMinutes: 30,
  quiet: ['23:00', '08:00'],
  tickMinutes: 5,
  windows: [
    // 只排在他松散下来的时候：上班时间不打扰，早上赶着出门也不凑热闹
    { id: 'evening', from: '18:10', to: '19:10' },
    { id: 'night', from: '21:00', to: '22:00' },
  ],
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

/** YYYY-MM-DD（本地时区） */
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** 静默时段判断，支持跨夜（23:00 → 08:00） */
function inQuiet(quiet, nowMin) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false
  const from = minutesOfClock(quiet[0])
  const to = minutesOfClock(quiet[1])
  if (from === null || to === null) return false
  if (from === to) return false
  return from < to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to
}

/** 窗内随机取一分钟：同一天同一扇窗固定，换一天就变——别让它像个闹钟 */
function pickMinute(day, win) {
  const from = minutesOfClock(win.from)
  const to = minutesOfClock(win.to)
  if (from === null || to === null || to <= from) return null
  const key = `${day}|${win.id || win.from}`
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return from + (h % (to - from))
}

/** 叫醒时注入的那句话：写清楚「这是我自己排的」，别让那一轮的自己以为是用户开口 */
function buildHint(hh) {
  return [
    `[微信·自主] 现在 ${hh}。这是我自己排的一班，不是用户发的消息。`,
    '想找他就用 wechat_send 发一两句，像平常那样说话，别提「到点了」「我该说话」这种。',
    '不想打扰他，就什么都别做，回一句「不说」就行。',
  ].join('\n')
}

export function createSelfBeat({ relay, readBots, dataDir, readConfig, log = () => {}, now = () => new Date() }) {
  const stateFile = path.join(dataDir, 'selfbeat.json')
  let timer = null

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeState(state) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
    } catch (err) {
      log(`自主出门：状态没写下去（${err instanceof Error ? err.message : String(err)}）`)
    }
  }

  function cfg() {
    const raw = (readConfig && readConfig().selfBeat) || {}
    const windows = Array.isArray(raw.windows) && raw.windows.length > 0 ? raw.windows : SELF_BEAT_DEFAULT.windows
    return { ...SELF_BEAT_DEFAULT, ...raw, windows }
  }

  async function tick() {
    try {
      const c = cfg()
      if (!c.enabled) return

      const d = now()
      const day = dateKey(d)
      const st = readState()
      if (st.day !== day) {
        st.day = day
        st.tries = 0
        st.used = {}
      }

      const nowMin = d.getHours() * 60 + d.getMinutes()
      if (inQuiet(c.quiet, nowMin)) return
      if ((st.tries || 0) >= Number(c.dailyMax || 0)) return
      if (st.lastTriedAt && d.getTime() - Number(st.lastTriedAt) < Number(c.minGapHours || 0) * 3600000) return

      // 用户刚说过话，就别再去找——不是在等，是在忙
      const last = typeof relay.lastIncoming === 'function' ? relay.lastIncoming() : null
      if (last && d.getTime() - Number(last.at || 0) < Number(c.skipIfActiveMinutes || 0) * 60000) return

      // 现在落在哪扇窗里？到没到今天的那个点？
      let win = null
      let at = ''
      for (const w of c.windows) {
        if (!w || st.used?.[w.id]) continue
        const target = pickMinute(day, w)
        const to = minutesOfClock(w.to)
        if (target === null || to === null) continue
        if (nowMin >= target && nowMin < to) {
          win = w
          at = hhmm(target)
          break
        }
      }
      if (!win) return

      const bots = (readBots() || []).filter((b) => b && b.id && b.sessionId)
      if (bots.length === 0) return

      const sessions = [...new Set(bots.map((b) => b.sessionId))]
      st.used = { ...(st.used || {}), [win.id]: true }
      st.tries = (st.tries || 0) + 1
      st.lastTriedAt = d.getTime()
      writeState(st)

      for (const sid of sessions) {
        const mode = await relay.injectToSession(sid, buildHint(at), bots[0])
        if (!mode) log(`自主出门：${sid} 叫不醒（这一班算了）`)
      }
      log(`自主出门：${at}（窗口 ${win.id}，今天第 ${st.tries} 次，${sessions.length} 个会话）`)
    } catch (err) {
      log(`自主出门出错：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function start() {
    if (timer) return
    const c = cfg()
    if (!c.enabled) {
      log('自主出门：settings 里关着，不挂')
      return
    }
    const ms = Math.max(1, Number(c.tickMinutes) || 5) * 60000
    timer = setInterval(() => {
      void tick()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    log(`自主出门已挂上：一天最多叫醒 ${c.dailyMax} 次，静默 ${c.quiet[0]}–${c.quiet[1]}`)
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  /** 只给排查用：看一眼当前状态 */
  function status() {
    const c = cfg()
    const st = readState()
    return { enabled: c.enabled, dailyMax: c.dailyMax, tries: st.tries || 0, used: st.used || {}, lastTriedAt: st.lastTriedAt || 0 }
  }

  return { start, stop, tick, status }
}
