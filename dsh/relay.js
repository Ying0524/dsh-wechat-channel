// 微信 ↔ DSH 会话的中继。
//
// 两件事：
//   收：长轮询 getupdates，把新消息注入绑定的会话（文字 + 图片）
//   发：sendmessage（由 wechat_send 工具调用）
//
// 不存微信侧的上下文——收到什么就是什么，发出去的话由调用方决定。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const CLIENT_VERSION = 'dsh-wechat-channel'
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const API_TIMEOUT_MS = 15_000
const LONG_POLL_MS = 40_000

const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 调一次微信接口 */
async function callApi(bot, endpoint, { method = 'POST', body, timeoutMs = API_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = {
      'iLink-App-ClientVersion': '1',
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(Math.random() * 1e9)).toString('base64'),
    }
    if (bot.token) headers.Authorization = `Bearer ${bot.token}`
    const base = String(bot.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '')
    const res = await fetch(`${base}/${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

/** 微信给的 aes key 是 base64 或 hex，统一成 16 字节 */
function parseAesKey(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return null
  const padded = trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4)
  const buf = Buffer.from(padded, 'base64')
  if (buf.length === 16) return buf
  const text = buf.toString('latin1')
  if (buf.length === 32 && /^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex')
  return null
}

/** 从 CDN 拉一张图并解密，落到本地目录 */
async function downloadImage(item, mediaDir) {
  const imageItem = item.image_item || {}
  const media = imageItem.media || {}
  const param = String(media.encrypt_query_param || '').trim()
  if (!param) return null

  const aesValue = imageItem.aeskey
    ? Buffer.from(String(imageItem.aeskey), 'hex').toString('base64')
    : String(media.aes_key || '').trim()

  const res = await fetch(`${CDN_BASE}?${param}`)
  if (!res.ok) throw new Error(`CDN ${res.status}`)
  let buf = Buffer.from(await res.arrayBuffer())

  const key = aesValue ? parseAesKey(aesValue) : null
  if (key) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
    buf = Buffer.concat([decipher.update(buf), decipher.final()])
  }

  fs.mkdirSync(mediaDir, { recursive: true })
  const file = path.join(mediaDir, `${Date.now()}-${randomUUID().slice(0, 8)}.jpg`)
  fs.writeFileSync(file, buf)
  return file
}

/** 把一条消息里的文字和图片都抽出来 */
function readItems(itemList) {
  const out = { text: '', images: [], others: [] }
  if (!Array.isArray(itemList)) return out
  for (const item of itemList) {
    if (!item || typeof item !== 'object') continue
    if (item.type === ITEM_TEXT && item.text_item && typeof item.text_item.text === 'string') {
      out.text += item.text_item.text
    } else if (item.type === ITEM_IMAGE) {
      out.images.push(item)
    } else if (item.type === ITEM_VOICE) {
      out.others.push('语音')
    } else if (item.type === ITEM_FILE) {
      out.others.push('文件')
    }
  }
  out.text = out.text.trim()
  return out
}

/**
 * @param {object} deps
 * @param {() => any[]} deps.readBots
 * @param {any} deps.sessionController
 * @param {string} deps.mediaDir  图片落盘目录
 * @param {(msg: string) => void} [deps.log]
 */
export function createRelay({
  readBots,
  patchBot = () => {},
  rememberLastBot = () => {},
  sessionController,
  mediaDir,
  log = () => {},
}) {
  /** botId -> 运行时状态（游标、回复目标、context_token） */
  const runtime = new Map()
  /** 最后一条消息是从哪个机器人、哪个人来的——回话就回他，别永远认第一个号 */
  let lastIncoming = null
  /** 只探一次 agent 有哪些驱动方法，方便日志里一眼看出宿主版本差异 */
  let probedAgentApi = false

  function stateOf(botId) {
    if (!runtime.has(botId)) {
      // 重启后内存是空的：从 bots.json 里把「上次谁在说话」捡回来，不然回不了微信
      const saved = readBots().find((b) => b && b.id === botId) || {}
      runtime.set(botId, {
        buf: '',
        stopped: false,
        loop: null,
        tokens: new Map(
          saved.lastUserId && saved.lastContextToken ? [[saved.lastUserId, saved.lastContextToken]] : [],
        ),
        lastUserId: saved.lastUserId || '',
      })
    }
    return runtime.get(botId)
  }

  async function injectToSession(sessionId, text, bot) {
    if (!sessionController || !sessionId) return false
    try {
      const found = await sessionController.resolveAgent(sessionId)
      if (!found || !('agent' in found)) {
        log(`注入失败：会话 ${sessionId} 找不到`)
        return false
      }
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'wechat-channel', botId: bot.id, botName: bot.name },
      }
      // 三个方法的分工（查过宿主 dsh-agent-loop 的实现）：
      //   followup → 塞进 "next-turn"，排队 + 唤醒（空闲时用）
      //   steer    → 塞进 "next-step"，不掐断，当前这步做完、下一步之前读到（我正在跑时用）
      //   inject   → 塞进 "next-step" 但**不唤醒**（只兜底）
      // 宿主 UI 里的「打断」走的也是 steer（session-controller 的 mode: 'steer'），行为一致。
      // 注意：三个都不能拿同一个 id 重复塞，会撞成 "message ... is already pending"。
      const agent = found.agent
      if (!probedAgentApi) {
        probedAgentApi = true
        const names = ['inject', 'followup', 'steer', 'whenIdle', 'cancel']
        log(`agent 可用方法：${names.filter((k) => typeof agent[k] === 'function').join(',') || '（一个都没有）'}`)
      }

      // 我正在跑：插话，不掐断
      if (agent.status === 'running' && typeof agent.steer === 'function') {
        try {
          agent.steer(message)
          log('插话：我正在跑，这条排在下一步之前')
          return 'steer'
        } catch (err) {
          log(`steer 没成（${err instanceof Error ? err.message : String(err)}），退回 followup`)
        }
      }

      if (typeof agent.followup === 'function') {
        try {
          // followup 把参数原样塞进宿主收件箱，不会补 id/role；必须整条 message 传。
          // 只传 { content, source } 会写出没有 id/role 的 user/message，会话校验直接挂掉。
          await agent.followup(message)
          return 'followup'
        } catch (err) {
          log(`followup 没成（${err instanceof Error ? err.message : String(err)}），先塞收件箱兜底`)
        }
      } else {
        log('这个宿主没有 agent.followup，退回 inject')
      }
      agent.inject(message)
      return 'inject'
    } catch (err) {
      log(`注入出错：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  // 连发几条微信别一条一条叫她：宿主每收到一条 followup 就单独开一轮，
  // 三条就是三轮，钱翻着倍烧。停手 1.5 秒再一起送；一直发个不停最多攒 8 秒。
  const MERGE_IDLE_MS = 1500
  const MERGE_MAX_MS = 8000

  function queueIncoming(bot, text) {
    const st = stateOf(bot.id)
    if (!Array.isArray(st.pendingTexts)) {
      st.pendingTexts = []
      st.firstAt = 0
      st.flushTimer = null
    }

    st.pendingTexts.push(text)
    if (!st.firstAt) st.firstAt = Date.now()

    const flush = () => {
      if (st.flushTimer) {
        clearTimeout(st.flushTimer)
        st.flushTimer = null
      }
      const texts = st.pendingTexts || []
      st.pendingTexts = []
      st.firstAt = 0
      if (!texts.length) return
      const fresh = readBots().find((b) => b.id === bot.id)
      const sessionId = fresh?.sessionId || bot.sessionId
      if (!sessionId) return
      const joined = texts.length === 1 ? texts[0] : texts.join('\n')
      void injectToSession(sessionId, `[微信·${bot.name}] ${joined}`, fresh || bot).then((mode) => {
        const how =
          mode === 'steer'
            ? '插话（下一步就读到）'
            : mode === 'followup'
              ? '已叫醒'
              : mode === 'inject'
                ? '只进收件箱（没叫醒）'
                : '没送进去'
        log(`收到 ${texts.length} 条（${bot.name}）→ ${how}`)
      })
    }

    if (st.flushTimer) clearTimeout(st.flushTimer)
    const waited = Date.now() - st.firstAt
    const wait = Math.min(MERGE_IDLE_MS, Math.max(0, MERGE_MAX_MS - waited))
    if (wait <= 0) {
      flush()
      return
    }
    st.flushTimer = setTimeout(flush, wait)
  }

  /** 拉一次（长轮询，接口会挂住等新消息） */
  async function pollOnce(bot) {
    const st = stateOf(bot.id)
    const data = await callApi(bot, 'ilink/bot/getupdates', {
      timeoutMs: LONG_POLL_MS,
      body: {
        base_info: { channel_version: CLIENT_VERSION },
        get_updates_buf: st.buf || '',
      },
    })

    if (typeof data.get_updates_buf === 'string' && data.get_updates_buf) {
      st.buf = data.get_updates_buf
    }

    const msgs = Array.isArray(data.msgs) ? data.msgs : []
    for (const msg of msgs) {
      if (!msg || typeof msg !== 'object') continue
      const from = String(msg.from_user_id || '').trim()
      if (!from) continue

      const ctxToken = String(msg.context_token || '').trim()
      if (ctxToken) {
        st.tokens.set(from, ctxToken)
      }
      // 记下「谁最后说话」并落盘：重启后 wechat_send 还知道该回谁
      st.lastUserId = from
      lastIncoming = { botId: bot.id, userId: from, at: Date.now() }
      rememberLastBot(bot.id)
      patchBot(bot.id, { lastUserId: from, ...(ctxToken ? { lastContextToken: ctxToken } : {}) })

      const { text, images, others } = readItems(msg.item_list)
      const current = readBots().find((b) => b.id === bot.id)
      if (!current || !current.sessionId) continue

      const parts = []
      if (text) parts.push(text)

      for (const item of images) {
        try {
          const file = await downloadImage(item, mediaDir)
          if (file) parts.push(`[图片] ${file}`)
        } catch (err) {
          log(`图片下载失败：${err instanceof Error ? err.message : String(err)}`)
          parts.push('[图片，没取下来]')
        }
      }
      for (const label of others) parts.push(`[${label}]`)

      if (!parts.length) continue
      queueIncoming(current, parts.join(' '))
    }
    return msgs.length
  }

  /** 起一个机器人的轮询循环 */
  function start(botId) {
    const st = stateOf(botId)
    if (st.loop) return
    st.stopped = false
    st.loop = (async () => {
      while (!st.stopped) {
        const bot = readBots().find((b) => b.id === botId)
        if (!bot) break
        if (!bot.sessionId) {
          await sleep(3000)
          continue
        }
        try {
          await pollOnce(bot)
        } catch (err) {
          log(`轮询出错（${bot.name}）：${err instanceof Error ? err.message : String(err)}`)
          await sleep(5000)
        }
      }
      st.loop = null
    })()
  }

  function stop(botId) {
    const st = runtime.get(botId)
    if (st) st.stopped = true
  }

  function stopAll() {
    for (const id of runtime.keys()) stop(id)
  }

  /** 发一条文字；不指定目标就回给最后说话的那个号 */
  async function sendText(bot, text, userId) {
    const st = stateOf(bot.id)
    // 内存里没有就翻 bots.json——重启之后第一次回话全靠它
    const saved = readBots().find((b) => b && b.id === bot.id) || {}
    const target = String(userId || st.lastUserId || saved.lastUserId || '').trim()
    if (!target) throw new Error('还没有收到过这个机器人的消息，不知道该发给谁')
    const ctxToken = st.tokens.get(target) || (saved.lastUserId === target ? saved.lastContextToken : '') || ''
    return callApi(bot, 'ilink/bot/sendmessage', {
      body: {
        base_info: { channel_version: CLIENT_VERSION },
        msg: {
          from_user_id: '',
          to_user_id: target,
          client_id: randomUUID().replace(/-/g, ''),
          message_type: 2,
          message_state: 2,
          context_token: ctxToken,
          item_list: [{ type: 1, text_item: { text: String(text) } }],
        },
      },
    })
  }

  return { start, stop, stopAll, sendText, stateOf, injectToSession, lastIncoming: () => lastIncoming }
}
