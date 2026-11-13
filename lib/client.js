/**
 * dsh-offpeak · 客户端半插件
 *
 * 在输入框下方（conversation.composer.dock）常驻一行：左边是**本会话**的
 * 错峰开关，右边只在有调用正在等时给一个小按钮「立即运行」。
 * 任何状态解释文字都不渲染（v0.1.18，用户 2026-11-13 拍板：这一行只留开关与
 * 按钮）；唯一的文字反馈是「立即运行」失败时那一句错误。
 *
 * 开关只影响当前会话，默认开；状态留在宿主内存里，重启后自然回到开
 * （本版不做持久化，用户 2026-11-12 定）。
 *
 * 宿主侧契约（base path /dsh-offpeak，三条都要带 x-dsh-offpeak: 1）：
 *   GET  /dsh-offpeak/status?sessionId=<id>
 *     -> { enabled, sessionEnabled, inheritedOff, dryRun, peak, waiting,
 *          bypassing, releaseAt, releaseLabel, now, version }
 *   POST /dsh-offpeak/release?sessionId=<id>
 *     -> { ok: true, woken: <n> }
 *   POST /dsh-offpeak/toggle?sessionId=<id>&enabled=0|1
 *     -> { ok: true, ...status, now }
 *
 * `bypassing` 是宿主在用户刚点过「立即运行」/ 用过 `/peak now` 之后置上的旁路标记
 * （60 秒，命中时续期）。旁路生效期间这一轮根本不会被拦，所以此时也不该再给出
 * 「等待中」的动作入口。旁路字段缺失时按 false 处理，旧宿主仍然兼容。
 *
 * `releaseLabel` / `peak` 等展示用字段仍由宿主返回，但客户端自 v0.1.18 起不再读
 * 它们 —— 已经没有任何「几点开始」的文案需要拼装。
 *
 * 路由可能还不存在（宿主侧并行开发）。fetch 失败 / 非 2xx / JSON 解析失败
 * 一律当作「这一轮没读到」：手上有旧状态就继续保留旧的，一次都没读到过才整行
 * 不出现 —— 不报错、不显示占位。所以路由没装好时界面只是不出现开关，
 * 闸门照常工作。
 */
window.__ModuleLoader__.load({
  id: 'dsh-offpeak',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const POLL_MS = 5000;
    const STATUS_PATH = '/dsh-offpeak/status';
    const RELEASE_PATH = '/dsh-offpeak/release';
    const TOGGLE_PATH = '/dsh-offpeak/toggle';
    const REQUEST_HEADERS = { 'x-dsh-offpeak': '1' };

    // 文字与按钮仍然继承宿主的 currentColor（不猜 --dsh-* 变量名），
    // 但开关本体自 0.1.19 起**故意写死** iOS 的两条色值（#007AFF / #000000）——
    // 用户 2026-11-13 明确要求「打开就是蓝色，关掉就是黑色」，继承色做不到。
    //
    // 压暗只加在文字与「立即运行」上，不加在整行上：opacity 在父级无法被子级抵消，
    // 整行 0.62 会把 #007AFF 冲成浅蓝，正是「开关不明显」的原因之一。
    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      maxWidth: '100%',
      fontSize: '12px',
      lineHeight: '1.4',
      color: 'inherit',
    };

    // 「立即运行」失败时的错误句：它是按钮唯一的反馈，不是状态解释。
    // minWidth: 0 + 可压缩的 flex 是窄窗能折行的前提；没有文字时整段不渲染。
    const ERROR_STYLE = {
      minWidth: 0,
      flex: '0 1 auto',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
      opacity: 0.62,
    };

    const LABEL_STYLE = {
      flex: 'none',
      whiteSpace: 'nowrap',
      opacity: 0.62,
    };

    // 轨道和文字都装在同一个 button 里，所以这里只描述「轨道」那一块；
    // 按钮本身负责点击区大小（见 SWITCH_STYLE）。
    //
    // iOS UISwitch 的标准尺寸是 51×31pt，圆点 27pt。1px 描边用 **inset box-shadow**
    // 而不是 border：border 会吃掉 2px 盒内空间，圆点就只能在「上下 2px、左右 3px」
    // 处停下（不对称）；inset 描边不参与布局，圆点在四个方向都正好距轨道外沿 2px。
    // 这圈 rgba(120,120,128,0.4)（iOS separator 灰）是关态黑色在深色主题下
    // 唯一的轮廓来源 —— 去掉它，黑轨道会和深色背景糊成一片（深色主题下的两格自检见
    // tools/visual-check/harness.html，跑法见 README「客户端那一半」一节）。
    const TRACK_RING = 'inset 0 0 0 1px rgba(120,120,128,0.4)';

    const TRACK_STYLE = {
      position: 'relative',
      display: 'block',
      flex: 'none',
      boxSizing: 'border-box',
      width: '51px',
      height: '31px',
      padding: 0,
      margin: 0,
      border: 0,
      borderRadius: '999px',
      background: '#000000',
      boxShadow: TRACK_RING,
      color: 'inherit',
      transition: 'background-color 0.2s ease',
    };

    const TRACK_ON_STYLE = { ...TRACK_STYLE, background: '#007AFF' };

    // 圆点位置按轨道尺寸算：开 = 51 - 27 - 2 = 22px（距右 2px），关 = 距左 2px。
    // 白色 + 两道轻阴影，让它在黑色轨道上也能浮起来（iOS 的手感）。
    const knobStyle = (checked) => ({
      position: 'absolute',
      top: '2px',
      left: checked ? '22px' : '2px',
      width: '27px',
      height: '27px',
      borderRadius: '50%',
      background: '#ffffff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.25), 0 1px 1px rgba(0,0,0,0.12)',
      transition: 'left 0.2s ease',
    });

    // 整行（轨道 + 「错峰发送」）是一个按钮：点文字也能切。
    // minHeight 31px = 轨道高度，点击区贴着轨道；320px 窄窗下总宽约 105px，不会折行。
    const SWITCH_STYLE = {
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      minHeight: '31px',
      padding: 0,
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1.4',
      color: 'inherit',
      background: 'transparent',
      border: 0,
      cursor: 'pointer',
    };

    // 禁用态（跟随主会话关 / 总开关关 / 演练中 / 请求中）：整体 0.45。
    // 黑轨道只是变暗，1px 描边仍在，不会彻底消失。
    const SWITCH_DISABLED_STYLE = { ...SWITCH_STYLE, opacity: 0.45, cursor: 'default' };

    const BUTTON_STYLE = {
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '20px',
      padding: '0 8px',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid currentColor',
      borderRadius: '6px',
      opacity: 0.62,
      cursor: 'pointer',
    };

    const BUTTON_BUSY_STYLE = { ...BUTTON_STYLE, opacity: 0.3, cursor: 'default' };

    function buildUrl(path, sessionId, extra) {
      const base = path + '?sessionId=' + encodeURIComponent(String(sessionId));
      return extra ? base + '&' + extra : base;
    }

    // 读不到就是没有状态；这里绝不抛。
    async function readStatus(sessionId) {
      try {
        const res = await fetch(buildUrl(STATUS_PATH, sessionId), {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: REQUEST_HEADERS,
        });
        if (!res || !res.ok) return null;
        const data = await res.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        return data;
      } catch (err) {
        return null;
      }
    }

    /**
     * 叫醒本会话排队中的调用。
     * 返回对象而不是布尔，是因为调用点必须能区分「宿主回 2xx」和「403/500/断网」
     * —— 后者以前和成功同形，界面看不出失败。消息固定一句话，不把 status code
     * 透给用户（那是宿主内部细节，用户也读不懂）。
     */
    async function postRelease(sessionId) {
      try {
        const res = await fetch(buildUrl(RELEASE_PATH, sessionId), {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: REQUEST_HEADERS,
        });
        return { ok: !!(res && res.ok) };
      } catch (err) {
        return { ok: false };
      }
    }

    /** 切换本会话开关；成功时宿主直接回完整状态，失败返回 null。 */
    async function postToggle(sessionId, enabled) {
      try {
        const res = await fetch(
          buildUrl(TOGGLE_PATH, sessionId, 'enabled=' + (enabled ? '1' : '0')),
          {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: REQUEST_HEADERS,
          },
        );
        if (!res || !res.ok) return null;
        const data = await res.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        return data;
      } catch (err) {
        return null;
      }
    }

    function OffpeakSwitch(props) {
      const sessionId = props && props.sessionId;
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      // 「立即运行」失败的提示单独存：它和轮询结果无关，成功轮询一次就该消失。
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        if (!sessionId) {
          setStatus(null);
          return undefined;
        }
        let live = true;
        const read = () => {
          readStatus(sessionId).then((next) => {
            if (!live) return;
            if (next) {
              setStatus(next);
              // 读到了实况，「立即运行」那行错误就过期了：留着会一直挂在那儿，
              // 让用户以为每次都在失败。
              setError(null);
            }
            // 读失败时保留上一次的状态：清空会让整行消失、下一轮又冒出来，
            // 抖一下比显示一份旧结果更糟。状态文字已经去掉，这里无需再记账。
          });
        };
        read();
        const timer = setInterval(read, POLL_MS);
        return () => {
          live = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      // 一次都没读到过才整行不出现；有过状态就一直留着。
      if (!status) return null;

      const globalOn = status.enabled === true;
      const dryRun = status.dryRun === true;
      const checked = globalOn && status.sessionEnabled !== false;
      // 全局关闭 / 演练模式 / 从主会话继承到「关」时，这个开关没有可执行的含义：
      // 子代理自己改不了主会话的决定，只展示状态。
      const canToggle = globalOn && !dryRun && status.inheritedOff !== true;
      const waiting = checked && status.waiting === true && status.bypassing !== true;

      const onToggle = () => {
        if (busy || !sessionId || !canToggle) return;
        setBusy(true);
        setError(null);
        postToggle(sessionId, !checked).then((next) => {
          if (next) {
            setBusy(false);
            setStatus(next);
            return;
          }
          // 宿主没回状态（旧宿主 / 瞬时失败）就重读一次，别让开关停在半路。
          readStatus(sessionId).then((fresh) => {
            setBusy(false);
            if (fresh) setStatus(fresh);
          });
        });
      };

      const onRelease = () => {
        if (busy || !sessionId) return;
        setBusy(true);
        setError(null);
        postRelease(sessionId)
          .then((result) => {
            // 失败也要读一次：宿主可能已经醒了调用、只是响应没回来。
            const ok = !!(result && result.ok);
            return readStatus(sessionId).then((next) => ({ ok, next }));
          })
          .then(({ ok, next }) => {
            setBusy(false);
            if (next) setStatus(next);
            if (!ok) setError('没能立即运行：宿主没有响应');
          })
          .catch(() => {
            setBusy(false);
            setError('没能立即运行：宿主没有响应');
          });
      };

      const title = '错峰发送：主会话关掉时子代理一起关，重启后恢复为开';
      // 开 = 苹果蓝，关 = 纯黑；禁用态不再单独压暗轨道，交给按钮整体 opacity 0.45。
      const trackStyle = checked ? TRACK_ON_STYLE : TRACK_STYLE;
      const switchDisabled = busy || !canToggle;

      // 不再渲染任何状态解释。唯一的 span 是「立即运行」失败时的错误句；
      // error 为 null 时整段不渲染，否则 flex 的 gap 会在开关与按钮之间留空档。
      const errorText = error || null;

      return h(
        'div',
        { 'data-dsh-offpeak': 'switch', style: ROW_STYLE },
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': '错峰发送',
            title,
            disabled: switchDisabled,
            onClick: onToggle,
            style: switchDisabled ? SWITCH_DISABLED_STYLE : SWITCH_STYLE,
          },
          h(
            'span',
            { 'aria-hidden': 'true', style: trackStyle },
            h('span', { 'aria-hidden': 'true', style: knobStyle(checked) }),
          ),
          h('span', { style: LABEL_STYLE }, '错峰发送'),
        ),
        errorText ? h('span', { style: ERROR_STYLE }, errorText) : null,
        waiting
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: onRelease,
                style: busy ? BUTTON_BUSY_STYLE : BUTTON_STYLE,
                title: '叫醒本会话正在排队的调用，60 秒内不再等待',
              },
              '立即运行',
            )
          : null,
      );
    }

    return {
      inject: ['slots'],
      // 宿主只读 inject / apply，多余字段无害；readStatus 导出来是为了让测试
      // 直接验证读状态的行为，不必为了断言一次请求去渲染组件。
      readStatus,
      apply(ctx) {
        const register = () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-offpeak-notice',
              order: 12,
              inject: (sessionId) => ({ sessionId }),
            },
            OffpeakSwitch,
          );

        // 资源登记走 ctx.effect 并交回清理函数（宿主契约）。
        // 但 ctx.effect 若被守卫代理拒绝，绝不能因此丢掉整个开关 ——
        // 退回到直接登记：slots.register 本身也会把 disposer 挂到调用方 fiber 上。
        const mount = () => {
          const dispose = ctx.slots.inject('conversation.composer.dock', register);
          return typeof dispose === 'function' ? dispose : () => {};
        };

        if (typeof ctx.effect === 'function') {
          try {
            ctx.effect(mount, 'dsh-offpeak: composer dock switch');
            return;
          } catch (err) {
            console.error('[dsh-offpeak] ctx.effect 挂载失败，退回直接登记', err);
          }
        }

        try {
          mount();
        } catch (err) {
          console.error('[dsh-offpeak] 客户端开关挂载失败', err);
        }
      },
    };
  },
});
