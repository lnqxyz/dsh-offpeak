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
    // 里面这圈 rgba(120,120,128,0.4)（iOS separator 灰）只负责黑轨道内沿的层次。
    // 它**单靠自己**在深色主题下撑不起轮廓：落在宿主那种 #232329 面板上时，
    // 关态描边像素是 rgb(48,48,51)，对比度只有 1.19:1 —— 黑轨道看着就是一颗
    // 悬空的白点（禁用态整枚再压 0.45 后是 1.08:1，基本等于没有边）。
    //
    // 所以在轨道**外面**再描一圈 1px 的浅灰（box-shadow 不带 inset：不占布局，
    // 51×31 与圆点位置一个像素都没动）。这圈在深色面板上截图像素实测 3.42:1
    // （1px 抗锯齿吃掉一点，满覆盖算下来 3.67:1）；浅色面板上只有 1.29:1、
    // 几乎与白底同色，不会给黑轨道多画出一道看得见的边。
    // 轨道填充色本身没改 —— 用户要的「开就是蓝、关就是黑」照旧。
    const TRACK_RING = 'inset 0 0 0 1px rgba(120,120,128,0.4)';
    const TRACK_HALO_OFF = '0 0 0 1px rgba(210,210,218,0.5)';
    // 禁用态整枚按钮仍压 0.45（「暂时点不了」这件事要看得出来，既有断言也钉着 0.45），
    // 外面那圈跟着被压淡：若还用上面那道 0.5 的灰，压完只剩 1.78:1，等于白描。
    // 所以禁用时换一圈更亮的白——压完在深色面板上截图像素实测 3.66:1
    // （满覆盖 3.86:1），看得出它是个开关、只是现在点不了。
    // 禁用可能发生在蓝轨道上（演练中），所以这圈对开态同样生效。
    const TRACK_HALO_DISABLED = '0 0 0 1px rgba(255,255,255,0.92)';

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

    // 外圈只补在需要轮廓的组合上：蓝轨道在深色底上本来就有 3.89:1，多描一道白边
    // 只是多余的光边。所以「开 + 可点」不加圈，其余三组都加：
    //   关 + 可点 → 浅灰外圈（深色底 3.42:1）；关 + 禁用 → 亮白外圈（3.66:1）
    //   开 + 禁用 → 亮白外圈（蓝被整枚 0.45 压过一样会糊）
    const trackStyleFor = (checked, disabled) => {
      const base = checked ? TRACK_ON_STYLE : TRACK_STYLE;
      if (checked && !disabled) return base;
      const halo = disabled ? TRACK_HALO_DISABLED : TRACK_HALO_OFF;
      return { ...base, boxShadow: halo + ', ' + TRACK_RING };
    };

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
      // 「立即运行」失败的提示单独存：它和轮询结果无关，只有用户再次点「立即运行」
      // 发起新请求时才清。轮询**不许**碰它 —— 5 秒一轮，失败提示若被下一轮成功
      // 轮询擦掉，最短只闪几十毫秒，看起来就像按钮没反应。
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
              // 这里**不清** error：轮询只负责刷新状态，「立即运行」的失败提示
              // 得留到用户下次点它为止（清点见 onRelease 开头）。
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
        // 这里不碰 error：失败提示只归「立即运行」管，清点只有 onRelease 开头一处。
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

      const switchDisabled = busy || !canToggle;
      // 开 = 苹果蓝，关 = 纯黑；禁用态不单独压暗轨道，交给按钮整体 opacity 0.45。
      // 轮廓再按 disabled 补外圈（见 trackStyleFor）。
      const trackStyle = trackStyleFor(checked, switchDisabled);

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
        // role='status' 是隐式 aria-live='polite'：焦点还在「立即运行」按钮上时，
        // 新出现的这句也会被读屏念出来（普通 span 只会静默插进 DOM）。
        errorText ? h('span', { role: 'status', style: ERROR_STYLE }, errorText) : null,
        waiting
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: onRelease,
                style: busy ? BUTTON_BUSY_STYLE : BUTTON_STYLE,
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
