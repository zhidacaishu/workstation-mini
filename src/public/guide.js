(() => {
  const api = window.workstationDesktop;
  const notify = (message, type = 'info') => window.workstationUI?.notify?.(message, { type });

  // ---------- 设置入口：侧栏按钮与上手指南里的「打开设置」 ----------

  async function openSettings() {
    try {
      if (api) await api.openSettings();
      else notify('请从应用菜单或系统托盘打开「设置」。');
    } catch (error) {
      notify(error.message, 'error');
    }
  }
  const settingsEntry = document.querySelector('[data-desktop-settings]');
  if (api && settingsEntry) {
    settingsEntry.hidden = false;
    settingsEntry.addEventListener('click', openSettings);
  }

  // ---------- 复制命令 ----------

  async function copyFrom(button) {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent);
      // 原文案只记一次：连点两下时，第二次记下的会是「已复制」，之后就再也变不回来。
      button.dataset.copyLabel ||= button.textContent;
      button.textContent = '已复制';
      clearTimeout(Number(button.dataset.copyTimer));
      button.dataset.copyTimer = String(setTimeout(() => { button.textContent = button.dataset.copyLabel; }, 1600));
    } catch {
      // 剪贴板不可用时退一步：选中文字，让用户自己复制。
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      notify('无法写入剪贴板，已选中命令，请手动复制。');
    }
  }

  // ---------- 上手清单：今日页隐藏、上手指南页恢复 ----------

  async function setChecklist(value) {
    if (api) await api.saveGuide({ checklist: value });
  }

  async function hideChecklist(button) {
    const card = button.closest('[data-onboarding-card]');
    button.disabled = true;
    try {
      await setChecklist('hidden');
      if (card) card.hidden = true;
      document.getElementById('main-content')?.focus();
      notify('已隐藏上手清单。需要时可以在「上手指南」里重新显示。', 'success');
    } catch (error) {
      button.disabled = false;
      notify('无法隐藏上手清单：' + error.message, 'error');
    }
  }

  async function showChecklist(button) {
    button.disabled = true;
    try {
      await setChecklist('shown');
      const notice = button.closest('[data-onboarding-restore]');
      if (notice) notice.hidden = true;
      notify('今日页会重新显示上手清单。', 'success');
    } catch (error) {
      button.disabled = false;
      notify('无法保存：' + error.message, 'error');
    }
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const action = target.closest('[data-guide-settings], [data-copy], [data-onboarding-hide], [data-onboarding-show], [data-guide-start]');
    if (!action) return;
    if (action.matches('[data-guide-settings]')) openSettings();
    else if (action.matches('[data-copy]')) copyFrom(action);
    else if (action.matches('[data-onboarding-hide]')) hideChecklist(action);
    else if (action.matches('[data-onboarding-show]')) showChecklist(action);
    else if (action.matches('[data-guide-start]')) tour?.open(1);
  });

  // ---------- 界面导览 ----------

  const tour = createTour();

  function createTour() {
    const dialog = document.getElementById('onboarding');
    const steps = [...document.querySelectorAll('template[data-guide-step]')];
    if (!dialog || !steps.length) return null;

    const card = dialog.querySelector('[data-guide-card]');
    const spot = dialog.querySelector('[data-guide-spot]');
    const title = dialog.querySelector('#guide-title');
    const body = dialog.querySelector('[data-guide-body]');
    const progress = dialog.querySelector('[data-guide-progress]');
    const dots = dialog.querySelector('[data-guide-dots]');
    const error = dialog.querySelector('[data-guide-error]');
    const next = dialog.querySelector('[data-guide-next]');
    const prev = dialog.querySelector('[data-guide-prev]');
    const later = dialog.querySelector('[data-guide-later]');
    // 第 0 步是欢迎页，后面每一步高亮侧栏里的一处入口。
    const stops = steps.length - 1;
    let state = { step: 0, status: 'active' };
    let busy = false;
    let opener = null;
    let frame = 0;
    let loadFailed = false;

    const loaded = api
      ? api.getGuide().then(value => { state = value; }).catch(() => { loadFailed = true; })
      : Promise.resolve();

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const current = () => clamp(state.step, 0, steps.length - 1);

    function message(text) {
      error.textContent = text;
      error.hidden = !text;
    }

    /** 目标可以是几个相邻的入口（比如「研究项目」和「计划」），取它们的外接矩形。 */
    function targetRect(template) {
      const rects = (template.dataset.target || '').split(',').map(selector => selector.trim()).filter(Boolean)
        .flatMap(selector => [...document.querySelectorAll(selector)])
        .filter(element => !dialog.contains(element) && element.getClientRects().length)
        .map(element => element.getBoundingClientRect());
      if (!rects.length) return null;
      const left = Math.min(...rects.map(rect => rect.left));
      const top = Math.min(...rects.map(rect => rect.top));
      const right = Math.max(...rects.map(rect => rect.right));
      const bottom = Math.max(...rects.map(rect => rect.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }

    function setBox(element, box) {
      element.style.left = box.left + 'px';
      element.style.top = box.top + 'px';
      element.style.width = box.width + 'px';
      element.style.height = box.height + 'px';
    }

    function place() {
      frame = 0;
      if (!dialog.open) return;
      const viewport = document.documentElement;
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      const rect = targetRect(steps[current()]);
      dialog.classList.toggle('is-centered', !rect);
      if (!rect) {
        // 没有目标（欢迎页，或目标不在当前页面上）：遮罩收成屏幕中心的一个点，卡片居中。
        setBox(spot, { left: width / 2, top: height / 2, width: 0, height: 0 });
        card.style.removeProperty('left');
        card.style.removeProperty('top');
        card.classList.remove('is-flipped');
        return;
      }
      const pad = 6;
      const margin = 16;
      const gap = 14;
      setBox(spot, { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 });
      const box = card.getBoundingClientRect();
      // 侧栏在左边，卡片默认放在目标右侧；放不下时才翻到左侧。
      let left = rect.right + pad + gap;
      if (left + box.width > width - margin) left = Math.max(margin, rect.left - pad - gap - box.width);
      const center = rect.top + rect.height / 2;
      const top = clamp(center - box.height / 2, margin, Math.max(margin, height - box.height - margin));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.classList.toggle('is-flipped', left < rect.left);
      card.style.setProperty('--tour-arrow', clamp(center - top, 20, box.height - 20) + 'px');
    }

    function schedulePlace() {
      if (!frame) frame = requestAnimationFrame(place);
    }

    function render() {
      const index = current();
      const template = steps[index];
      const isWelcome = index === 0;
      title.textContent = template.dataset.title;
      body.replaceChildren(template.content.cloneNode(true));
      progress.textContent = isWelcome ? '一分钟导览' : index + ' / ' + stops;
      dots.replaceChildren(...steps.slice(1).map((_, dot) => {
        const item = document.createElement('li');
        if (dot + 1 < index) item.className = 'is-done';
        if (dot + 1 === index) item.className = 'is-current';
        return item;
      }));
      dots.hidden = isWelcome;
      later.hidden = !isWelcome;
      prev.hidden = isWelcome;
      next.textContent = template.dataset.next || '下一步';
      dialog.classList.toggle('is-welcome', isWelcome);
      place();
    }

    function setBusy(value) {
      busy = value;
      for (const button of dialog.querySelectorAll('button')) button.disabled = value;
    }

    async function change(patch, { close = false } = {}) {
      if (busy) return false;
      // 用「下一步」「上一步」翻页时焦点留在那个按钮上，键盘用户一路按回车就能看完；
      // 以前每一步都把焦点挪到标题上，要再按两次 Tab 才回得来。
      const refocus = [next, prev].find(button => button === document.activeElement) || null;
      setBusy(true);
      message('');
      let ok = false;
      try {
        state = api ? { ...state, ...(await api.saveGuide(patch)) } : { ...state, ...patch };
        if (close) dialog.close();
        else render();
        ok = true;
        return true;
      } catch (e) {
        message('无法保存导览进度：' + e.message + '。请重试。');
        return false;
      } finally {
        setBusy(false);
        if (ok && dialog.open) (refocus && !refocus.hidden ? refocus : refocus ? next : title).focus();
      }
    }

    const goNext = () => current() === steps.length - 1
      ? change({ status: 'completed' }, { close: true })
      : change({ step: current() + 1, status: 'active' });
    const goPrev = () => change({ step: Math.max(0, current() - 1), status: 'active' });
    // 跳过和看完一样，都不再自动弹出；上手指南页随时可以重看。
    const dismiss = () => change({ status: 'skipped' }, { close: true });

    async function open(startStep) {
      await loaded;
      if (dialog.open || document.querySelector('dialog[open]')) return;
      opener = document.activeElement;
      if (startStep !== undefined) state = { ...state, step: startStep, status: 'active' };
      message('');
      dialog.showModal();
      render();
      title.focus();
      if (startStep !== undefined) await change({ step: startStep, status: 'active' });
    }

    next.addEventListener('click', goNext);
    prev.addEventListener('click', goPrev);
    for (const button of dialog.querySelectorAll('[data-guide-skip]')) button.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) dismiss(); });
    dialog.addEventListener('keydown', event => {
      if (event.isComposing || busy || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight' && current() < steps.length - 1) { event.preventDefault(); goNext(); }
      else if (event.key === 'ArrowLeft' && current() > 0) { event.preventDefault(); goPrev(); }
    });
    body.addEventListener('click', async event => {
      const link = event.target instanceof Element ? event.target.closest('[data-guide-finish]') : null;
      if (!link) return;
      event.preventDefault();
      if (!(await change({ status: 'completed' }, { close: true }))) return;
      if (location.pathname !== new URL(link.href).pathname) location.href = link.href;
    });
    dialog.addEventListener('close', () => {
      message('');
      const target = opener?.isConnected && opener !== document.body ? opener : document.getElementById('main-content');
      target?.focus();
    });
    // 窗口缩放、侧栏在矮窗口里滚动或重新排布、卡片内容变高，都要重新对齐高亮框和卡片。
    // 缩放停下后再补一次：侧栏在矮窗口里的紧凑布局可能比 resize 事件晚一帧生效。
    let settle = 0;
    window.addEventListener('resize', () => {
      schedulePlace();
      clearTimeout(settle);
      settle = setTimeout(schedulePlace, 150);
    });
    document.addEventListener('scroll', schedulePlace, { capture: true, passive: true });
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(schedulePlace);
      for (const element of [card, document.documentElement, document.querySelector('.workspace-sidebar')]) {
        if (element) observer.observe(element);
      }
    }
    document.fonts?.ready.then(schedulePlace);

    loaded.then(() => {
      // 自动导览只在首次打开时出现，而且不打断编辑和进行中的复习。
      const route = document.body.dataset.pagePath || location.pathname;
      if (api && !loadFailed && state.status === 'active' && !/^\/(edit|new|review)(\/|$)/.test(route)) open();
    });

    return { open };
  }
})();
