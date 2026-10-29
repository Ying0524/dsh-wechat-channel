/**
 * dsh-wechat-channel — 浏览器半侧：设置里的「微信通道」。
 * 模块 id 必须等于 profile 里 bundle 的行名 dsh-wechat-channel。
 * 这里只负责开门：真正的面板还是宿主半侧的 /dsh-wechat/ui（同一台机器、同一个端口）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-channel',
  factory: (require) => {
    var react = require('react')
    var h = react.createElement

    function Frame() {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px 20px' } },
        h(
          'div',
          { style: { fontSize: 12, lineHeight: '18px', opacity: 0.65 } },
          '扫一次码就能用；消息进出都走这一个会话，微信那边不存任何上下文。',
        ),
        h('iframe', {
          src: '/dsh-wechat/ui',
          title: '微信通道',
          style: {
            width: '100%',
            height: 'calc(100vh - 190px)',
            minHeight: 460,
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
            borderRadius: 12,
            background: '#fff',
          },
        }),
      )
    }

    var exports = { inject: ['slots'] }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'wechat-channel', order: 40, label: '微信通道' },
          function () {
            return h(Frame)
          },
        )
      })
    }

    exports.apply = apply
    return exports
  },
})
