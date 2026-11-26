// 科研工作台 · 统一动效内核
//
// 所有窗口（主窗口、设置、恢复）共用这套轻量、可打断、仅走 GPU 合成属性的动效原语：
// - 与 tokens.css 保持完全一致的曲线与时长预设；
// - 实时监听 prefers-reduced-motion: reduce，运行中切换时立即结束在途动画并保留终态；
// - 同一元素同 key 的在途动画会被立即取消并从当前帧自然接上；
// - 在缺少 Web Animations API 的测试环境自动静默降级，不改变同步 DOM 行为。
(() => {
  const EASE_STANDARD = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const EASE_ENTER = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)';
  const EASE_SPRING = 'cubic-bezier(0.34, 1.48, 0.64, 1)';

  const DUR = {
    press: 90,
    fast: 150,
    base: 210,
    enter: 240,
    exit: 150,
    move: 300
  };

  const running = new WeakMap();
  const activeAnimations = new Set();

  let reducedQuery = null;
  try {
    reducedQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  } catch {
    reducedQuery = null;
  }

  function reduced() {
    if (reducedQuery) return Boolean(reducedQuery.matches);
    try {
      return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    } catch {
      return false;
    }
  }

  function finishAllActive() {
    for (const animation of [...activeAnimations]) {
      try {
        if (typeof animation.finish === 'function') animation.finish();
        else animation.cancel?.();
      } catch {
        try { animation.cancel?.(); } catch {}
      }
      activeAnimations.delete(animation);
    }
  }

  reducedQuery?.addEventListener?.('change', event => {
    if (event?.matches) finishAllActive();
  });

  function cancel(element, key = 'default') {
    const map = running.get(element);
    const active = map?.get(key);
    if (!active) return;
    try { active.cancel(); } catch {}
    map.delete(key);
    activeAnimations.delete(active);
  }

  function animate(element, keyframes, options = {}, key = 'default') {
    if (!element || reduced() || typeof element.animate !== 'function') return null;
    // 连续点击时，新效果从屏幕上的当前帧开始。FLIP 已经自行测过位移。
    if (key !== 'flip' && running.get(element)?.has(key) && Array.isArray(keyframes)) {
      const style = window.getComputedStyle?.(element);
      if (style && keyframes.length) {
        const first = { ...keyframes[0] };
        for (const property of ['opacity', 'transform']) {
          if (property in first) first[property] = style[property];
        }
        keyframes = [first, ...keyframes.slice(1)];
      }
    }
    cancel(element, key);
    let animation;
    try {
      animation = element.animate(keyframes, {
        duration: DUR.base,
        easing: EASE_ENTER,
        ...options
      });
    } catch {
      return null;
    }
    let map = running.get(element);
    if (!map) {
      map = new Map();
      running.set(element, map);
    }
    map.set(key, animation);
    activeAnimations.add(animation);
    const cleanup = () => {
      if (map.get(key) === animation) map.delete(key);
      activeAnimations.delete(animation);
    };
    animation.addEventListener?.('finish', cleanup, { once: true });
    animation.addEventListener?.('cancel', cleanup, { once: true });
    return animation;
  }

  function enter(element, { x = 0, y = 6, scale = 1, duration = DUR.base, easing = EASE_ENTER } = {}) {
    if (!element) return null;
    const parts = [];
    if (x || y) parts.push(`translate3d(${x}px, ${y}px, 0)`);
    if (scale !== 1) parts.push(`scale(${scale})`);
    const fromTransform = parts.length ? parts.join(' ') : 'none';
    return animate(element, [
      { opacity: 0, transform: fromTransform },
      { opacity: 1, transform: 'none' }
    ], { duration, easing }, 'visibility');
  }

  function exit(element, { x = 0, y = 6, scale = 0.98, duration = DUR.exit, easing = EASE_EXIT } = {}) {
    if (!element) return null;
    const parts = [];
    if (x || y) parts.push(`translate3d(${x}px, ${y}px, 0)`);
    if (scale !== 1) parts.push(`scale(${scale})`);
    const toTransform = parts.length ? parts.join(' ') : 'none';
    return animate(element, [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: toTransform }
    ], { duration, easing }, 'visibility');
  }

  function pulse(element, { scale = 1.12, duration = DUR.base } = {}) {
    if (!element) return null;
    return animate(element, [
      { transform: 'scale(1)' },
      { transform: `scale(${scale})`, offset: 0.42 },
      { transform: 'scale(1)' }
    ], { duration, easing: EASE_SPRING }, 'pulse');
  }

  function nudge(element, { distance = 4, duration = DUR.enter } = {}) {
    if (!element) return null;
    return animate(element, [
      { transform: 'translate3d(0, 0, 0)' },
      { transform: `translate3d(${-distance}px, 0, 0)`, offset: 0.2 },
      { transform: `translate3d(${distance * 0.85}px, 0, 0)`, offset: 0.45 },
      { transform: `translate3d(${-distance * 0.5}px, 0, 0)`, offset: 0.7 },
      { transform: `translate3d(${distance * 0.25}px, 0, 0)`, offset: 0.88 },
      { transform: 'translate3d(0, 0, 0)' }
    ], { duration, easing: EASE_STANDARD }, 'nudge');
  }

  /**
   * FLIP（First-Last-Invert-Play）：用纯 GPU transform 解释元素位置变化。
   * 先记录当前实时屏幕坐标（含在途动画），再取消旧 FLIP 以读取无变换终点，
   * 保证连续打断时始终从当前渲染位置丝滑接续、绝不跳帧。
   */
  function flip(elements, mutate, { duration = DUR.move, easing = EASE_ENTER, liftElement = null } = {}) {
    const list = [...(elements || [])].filter(el => el && typeof el.getBoundingClientRect === 'function');
    if (reduced() || !list.length || typeof list[0]?.animate !== 'function') {
      mutate();
      return [];
    }
    const before = new Map();
    for (const el of list) {
      const rect = el.getBoundingClientRect();
      if (rect.width || rect.height) before.set(el, rect);
    }
    for (const el of before.keys()) cancel(el, 'flip');
    mutate();
    const pending = [];
    for (const [el, prev] of before) {
      if (!el.isConnected) continue;
      const next = el.getBoundingClientRect();
      if (!next.width && !next.height) continue;
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      pending.push({ el, dx, dy });
    }
    const animations = [];
    for (const { el, dx, dy } of pending) {
      const isLift = el === liftElement;
      const keyframes = isLift
        ? [
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale(1)` },
            { transform: `translate3d(${dx * 0.42}px, ${dy * 0.42 - 3}px, 0) scale(1.018)`, offset: 0.45 },
            { transform: 'translate3d(0, 0, 0) scale(1)' }
          ]
        : [
            { transform: `translate3d(${dx}px, ${dy}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' }
          ];
      const anim = animate(el, keyframes, { duration: isLift ? duration : Math.round(duration * 0.85), easing }, 'flip');
      if (anim) animations.push(anim);
    }
    return animations;
  }

  /**
   * 滑动指示胶囊 / 底线：读取相对容器内边缘的未变换布局框（offsetLeft/offsetWidth），
   * 不受按压缩放和容器边框偏移影响；窗口缩放时 0 延迟跟手。
   */
  function attachIndicator(container, { selector, isActive, className = 'motion-indicator' } = {}) {
    if (!container || typeof container.getBoundingClientRect !== 'function') return () => {};
    let indicator = container.querySelector(`:scope > .${className}`);
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = className;
      indicator.setAttribute('aria-hidden', 'true');
      container.prepend(indicator);
    }
    container.classList.add('has-motion-indicator');

    let ready = false;
    const sync = ({ immediate = false } = {}) => {
      const items = [...container.querySelectorAll(selector)];
      const active = items.find(item => isActive(item));
      if (!active) {
        indicator.style.opacity = '0';
        return;
      }
      let x;
      let width;
      if (active.offsetParent === container && active.offsetWidth > 0) {
        x = active.offsetLeft;
        width = active.offsetWidth;
      } else {
        const hostRect = container.getBoundingClientRect();
        const itemRect = active.getBoundingClientRect();
        if (!hostRect.width || !itemRect.width) return;
        const borderLeft = parseFloat(window.getComputedStyle?.(container)?.borderLeftWidth) || 0;
        x = itemRect.left - hostRect.left - borderLeft;
        width = itemRect.width;
      }
      const shouldSnap = immediate || !ready || reduced();
      if (shouldSnap) indicator.classList.add('is-snapping');
      indicator.style.opacity = '1';
      indicator.style.width = `${width}px`;
      indicator.style.transform = `translate3d(${x}px, 0, 0)`;
      if (shouldSnap) {
        void indicator.offsetWidth;
        indicator.classList.remove('is-snapping');
      }
      ready = true;
    };

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => sync({ immediate: true }));
      observer.observe(container);
    }
    document.fonts?.ready?.then(() => sync({ immediate: true }));
    sync({ immediate: true });
    return sync;
  }

  window.workstationMotion = {
    EASE_ENTER,
    EASE_EXIT,
    EASE_SPRING,
    EASE_STANDARD,
    DUR,
    reduced,
    cancel,
    animate,
    enter,
    exit,
    pulse,
    nudge,
    flip,
    attachIndicator
  };
})();
