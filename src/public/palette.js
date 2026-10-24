(() => {
  const dialog = document.getElementById('palette');
  const input = dialog?.querySelector('.palette-input');
  const list = dialog?.querySelector('.palette-list');
  const status = dialog?.querySelector('.palette-status');
  const postForm = document.getElementById('palette-post');
  if (!dialog || !input || !list || !postForm) return;

  const readOnly = dialog.dataset.readonly === '1';
  const ui = window.workstationUI || {};
  const notify = ui.notify || (() => {});
  const requestJson = ui.requestJson || (async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok === false) throw new Error(payload.message || `请求失败（${response.status}）`);
    return payload;
  });

  let items = [];
  let activeIndex = 0;
  let requestToken = 0;
  let opener = null;
  let debounce = 0;
  let requestController = null;
  let composing = false;
  const hasOpenDialog = ui.hasOpenDialog || (except =>
    [...(document.querySelectorAll?.('dialog[open]') || [])].some(candidate => candidate !== except));
  // app.js 正常情况下会提供这个判定；这里的兜底必须和它同样分平台，
  // 否则 app.js 万一没加载，macOS 上的 Ctrl+K 又会把系统的「删到行尾」抢走。
  const isExactPrimaryShortcut = ui.isExactPrimaryShortcut || ((event, key) => {
    if (event.key?.toLowerCase() !== key.toLowerCase()) return false;
    if (event.altKey || event.shiftKey) return false;
    return document.body?.dataset?.primaryModifier === 'meta'
      ? Boolean(event.metaKey) && !event.ctrlKey
      : Boolean(event.ctrlKey) && !event.metaKey;
  });

  function submitPost(action, fields = {}) {
    postForm.action = action;
    postForm.replaceChildren();
    for (const [name, value] of Object.entries(fields)) {
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = name;
      field.value = value;
      postForm.append(field);
    }
    postForm.submit();
  }

  function navigate(href) {
    window.location.href = href;
  }

  let reindexPending = false;
  let reloadTimer = null;

  function commandCatalog(query) {
    return [
      {
        label: '今天的日记',
        hint: '没有就按模板新建',
        icon: '写入',
        writes: true,
        defaultVisible: true,
        run: () => submitPost('/diary/today')
      },
      {
        label: '新建笔记',
        hint: query ? `路径 ${query}` : '',
        icon: '写入',
        writes: true,
        fallback: true,
        defaultVisible: true,
        run: () => navigate(`/new${query ? `?path=${encodeURIComponent(query)}` : ''}`)
      },
      {
        label: '日记',
        hint: '打点趋势与历年今日',
        icon: '页面',
        defaultVisible: true,
        run: () => navigate('/diary')
      },
      {
        label: '日历',
        hint: '按月看截止、时间块与复习负荷',
        icon: '页面',
        defaultVisible: true,
        run: () => navigate('/calendar')
      },
      {
        label: '截止日期',
        hint: '查看近期时间边界',
        icon: '工具',
        run: () => navigate('/deadlines')
      },
      {
        label: '周期回顾',
        hint: '复盘一段时间的进展',
        icon: '回顾',
        run: () => navigate('/retro')
      },
      {
        label: '每日简报',
        hint: '复制今日纯文本视图',
        icon: '工具',
        run: () => navigate('/briefing')
      },
      {
        label: '每日回顾',
        hint: '重新遇见旧笔记',
        icon: '回顾',
        run: () => navigate('/highlights')
      },
      {
        label: '知识库体检',
        hint: '检查断链与结构问题',
        icon: '工具',
        run: () => navigate('/health')
      },
      {
        label: '影子跟读',
        hint: '听力与口语练习',
        icon: '工具',
        run: () => navigate('/shadowing')
      },
      {
        label: '发表到博客',
        hint: '预览并导出公开文章',
        icon: '工具',
        run: () => navigate('/publish')
      },
      {
        label: query ? `全文搜索「${query}」` : '全文搜索',
        hint: '',
        icon: '搜索',
        fallback: true,
        run: () => navigate(`/search?q=${encodeURIComponent(query)}`)
      },
      {
        label: '重新扫描索引',
        hint: reindexPending ? '扫描正在进行' : '保留现有结果并强制重读 Markdown',
        icon: '维护',
        defaultVisible: true,
        run: async () => {
          if (reindexPending) {
            notify('索引扫描正在进行。', { type: 'info' });
            return;
          }
          reindexPending = true;
          try {
            const stats = await requestJson('/api/reindex', { method: 'POST' });
            if (stats.phase === 'degraded') {
              notify(`扫描完成，仍有 ${stats.failureTotal} 篇笔记需要处理。`, { type: 'info' });
            } else {
              notify(`索引扫描完成：新增 ${stats.added} / 更新 ${stats.updated}`);
            }
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => window.location.reload(), 650);
          } catch (error) {
            notify(`重新扫描索引失败：${error.message}`, { type: 'error' });
          } finally {
            if (!reloadTimer) reindexPending = false;
          }
        }
      }
    ].filter(command => !(readOnly && command.writes));
  }

  function commands(query) {
    const all = commandCatalog(query);
    if (!query) {
      return { matched: [], fallback: all.filter(command => command.defaultVisible) };
    }

    const needle = query.toLowerCase();
    return {
      matched: all.filter(command => !command.fallback && command.label.toLowerCase().includes(needle)),
      fallback: all.filter(command => command.fallback)
    };
  }

  function setStatus(message, isError = false) {
    if (!status) return;
    status.textContent = message;
    status.classList?.toggle('is-error', isError);
  }

  function updateItemActiveState(item, index) {
    const active = index === activeIndex;
    item.className = `palette-item${active ? ' active' : ''}`;
    item.setAttribute('aria-selected', String(active));
  }

  function updateActiveItem({ scroll = false } = {}) {
    [...list.children].forEach(updateItemActiveState);
    const active = list.children[activeIndex];
    if (!active) {
      input.removeAttribute?.('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView?.({ block: 'nearest' });
  }

  function render() {
    list.replaceChildren();
    items.forEach((item, index) => {
      const option = document.createElement('li');
      option.id = `palette-option-${index}`;
      option.setAttribute('role', 'option');
      updateItemActiveState(option, index);

      const icon = document.createElement('span');
      icon.className = 'palette-icon';
      icon.textContent = item.icon || '项目';

      const label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = item.label;

      option.append(icon, label);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'palette-hint-text';
        hint.textContent = item.hint;
        option.append(hint);
      }

      option.addEventListener('mouseenter', () => {
        activeIndex = index;
        updateActiveItem();
      });
      option.addEventListener('click', () => choose(index));
      list.append(option);
    });
    updateActiveItem();
  }

  async function refresh() {
    const query = input.value.trim();
    const token = ++requestToken;
    requestController?.abort();
    requestController = typeof AbortController === 'function' ? new AbortController() : null;
    items = [];
    activeIndex = 0;
    render();
    setStatus(query ? '正在搜索…' : '正在加载最近笔记…');

    let notes = [];
    let searchError = null;
    try {
      const payload = await requestJson(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: requestController?.signal
      });
      notes = (payload.results || []).slice(0, 6).map(row => ({
        label: row.title || row.path,
        hint: row.section || '',
        icon: '笔记',
        run: () => navigate(`/note/${row.path.split('/').map(encodeURIComponent).join('/')}`)
      }));
    } catch (error) {
      if (error.name !== 'AbortError') searchError = error;
    }

    if (token !== requestToken) return;
    requestController = null;

    const { matched, fallback } = commands(query);
    items = [...matched, ...notes, ...fallback];
    activeIndex = 0;
    render();

    if (searchError) {
      setStatus(`搜索暂时不可用：${searchError.message}。仍可使用下方命令。`, true);
    } else if (query && notes.length === 0 && matched.length === 0) {
      setStatus('没有直接匹配，可继续全文搜索。');
    } else if (!query && notes.length === 0) {
      setStatus('没有最近笔记，可从下面的命令开始。');
    } else {
      setStatus(query ? `找到 ${notes.length} 篇笔记` : `最近 ${notes.length} 篇笔记`);
    }
  }

  function choose(index) {
    const item = items[index];
    if (!item) return;
    dialog.close();
    item.run();
  }

  function open() {
    if (dialog.open || hasOpenDialog(dialog)) return false;
    opener = document.activeElement;
    input.value = '';
    items = [];
    render();
    dialog.showModal();
    input.setAttribute('aria-expanded', 'true');
    input.focus?.();
    refresh();
    return true;
  }

  dialog.addEventListener('close', () => {
    requestToken += 1;
    requestController?.abort();
    requestController = null;
    if (debounce) clearTimeout(debounce);
    debounce = 0;
    input.removeAttribute?.('aria-activedescendant');
    input.setAttribute('aria-expanded', 'false');
    setStatus('');
    const target = opener && opener !== document.body && opener.isConnected !== false
      ? opener
      : document.getElementById('main-content');
    opener = null;
    target?.focus?.();
  });

  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });

  document.addEventListener('keydown', event => {
    if (isExactPrimaryShortcut(event, 'k') && open()) event.preventDefault();
  });

  for (const trigger of document.querySelectorAll('[data-palette-open]')) {
    trigger.addEventListener('click', open);
  }

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  });
  input.addEventListener('input', event => {
    requestToken += 1;
    requestController?.abort();
    requestController = null;
    items = [];
    activeIndex = 0;
    render();
    if (debounce) clearTimeout(debounce);
    if (composing || event.isComposing) return;
    debounce = setTimeout(refresh, 120);
  });

  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % Math.max(items.length, 1);
      updateActiveItem({ scroll: true });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % Math.max(items.length, 1);
      updateActiveItem({ scroll: true });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex);
    }
  });
})();
