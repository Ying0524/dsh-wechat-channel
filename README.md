# dsh-wechat-channel

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接一条**微信通道**。

微信只负责收发，不是「另一个 AI」。

---

## 这是什么

一个转接口。你从微信发一句话，它进到 DSH 里**你绑定的那个会话**；那个会话里回的话，再发回微信。

所以：

- 记忆、人设、上下文，全在 DSH 那一份
- 微信那边一条记录都不留，也不读它的历史
- 换个通道聊天，还是同一个人

## 为什么这么设计

大部分微信接法会**另开一个会话**给微信，于是你就有了两条鱼：一条在 DSH，一条在微信，各记各的账。

这个插件不这么干。它只做两件事：

```
微信 → 长轮询 → 注入绑定的会话 → 她看到
会话里的话 → 显式调用工具 → 发回微信
```

上下文永远只有一份。

## 用的什么接口

腾讯官方的 `ilink` 接口（也就是微信里那个 ClawBot）：

- `https://ilinkai.weixin.qq.com`
- **扫码登录**，拿 `bot_token` + `account_id`
- **长轮询**收消息 —— 不需要公网回调地址，家里宽带也能跑
- 不修改、不注入、不读取微信客户端，跟那些 hook 方案不是一条路

## 安装

```bash
# 在 profile 目录下，把源码目录链接进来
pnpm add "link:/path/to/dsh-wechat-channel"
```

然后在 profile 的 `package.json` 里把它加进 bundle 列表：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-wechat-channel"]
    }
  }
}
```

重启 dsh。

## 使用

1. 打开 DSH 设置 → 微信通道
2. 点「新建机器人」→ 出二维码 → 手机微信扫码确认
3. 选一个会话绑上
4. 在微信里发一句试试

## 兼容性

这个插件**不 import 任何 `@deepseek-ai/*` 包**，只通过 cordis 的 `ctx.inject(['webServer'])` 拿宿主服务。

因此：

- 不声明 `peerDependencies`，不会被版本范围卡住
- 不写 `dsh.compatibility.dshReleases` 白名单，dsh 升级不会把它判成「不兼容」
- 唯一的运行时依赖是 `qrcode-generator`（纯 JS，无原生模块）

如果哪天 dsh 改了 `webServer` 的服务名或 `register()` 的签名，这个插件会失效 —— 那是唯一需要跟着改的地方。

## 设计取舍

| 选择 | 原因 |
|---|---|
| 不存微信侧上下文 | 一份记忆就够了，两份必然分叉 |
| 默认回「最后说话的那个号」 | 哪个号在说话，就说明你现在在用哪个号 |
| 发言必须显式调用工具 | 避免 DSH 里的每句话都跑到微信去 |
| 发送正文写进会话日志 | 出了事能对账，不是黑箱 |
| **发送只认绑定** | 每个会话只能发给自己绑的那些号；别的会话一个都碰不到，回执不会串 |
| 官方接口而非 hook | 封号不是闹着玩的 |

## 自主出门（她什么时候来找你）

心跳插件停掉之后，这条通道自己留了一扇窗：到点把一句话注入绑定会话，**叫醒 agent 一声**。

说不说、说什么、发哪个号，全由那一轮的 agent 决定 —— 插件不替她编话，也不会偷偷发消息。

规矩写在 `<DSH_HOME>/wechat-channel/settings.json` 的 `selfBeat` 段里，缺哪项就用默认值：

| 字段 | 默认 | 意思 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dailyMax` | `2` | 一天最多叫醒几次 |
| `minGapHours` | `2` | 两次之间至少隔几小时 |
| `skipIfActiveMinutes` | `30` | 用户刚说过话就别再找 |
| `quiet` | `["23:00","08:00"]` | 静默时段（可跨夜） |
| `windows` | 傍晚 18:10–19:10、夜里 21:00–22:00 | 只在人松散下来的时候叫 |
| `tickMinutes` | `5` | 多久看一次表 |

每扇窗一天最多用一次，窗内**随机取一个分钟**（同一天固定、换一天就变），所以不像闹钟。

状态存在 `<DSH_HOME>/wechat-channel/selfbeat.json`，重启不丢。

## 开发

```
dsh/index.js     宿主侧：HTTP 路由、扫码、工具注册
dsh/relay.js     收发中继：长轮询、注入会话、发消息
dsh/selfbeat.js  自主出门：到点叫醒她，说不说由她定
dsh/client.js    设置页那一栏
cordis.patch.yml 挂载声明
```

调试时可以直接打接口验证：

```bash
curl "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3" \
     -H "iLink-App-ClientVersion: 1"
```

## License

MIT
