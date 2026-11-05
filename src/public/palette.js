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
        // 输入里带斜杠或 .md 的当作路径，其余当作标题：新笔记按标题自动生成路径。
        label: '新建笔记',
        hint: query ? (/[\\/]|\.md$/i.test(query) ? `路径 ${query}` : `标题「${query}」`) : '',
        icon: '写入',
        writes: true,
        fallback: true,
        defaultVisible: true,
        run: () => navigate(query
          ? `/new?${/[\\/]|\.md$/i.test(query) ? 'path' : 'title'}=${encodeURIComponent(query)}`
          : '/new')
      },
      {
        label: '计划',
        hint: '',
        icon: '工具',
        defaultVisible: true,
        run: () => navigate('/plan')
      },
      {
        label: '截止日期',
        hint: '',
        icon: '工具',
        run: () => navigate('/plan?view=list&filter=deadlines')
      },
      {
        label: '上手指南',
        hint: '上手清单、语法速查与 Git 同步',
        icon: '帮助',
        keywords: ['帮助', '新手', '指引', '导览', '快捷键', 'git', 'help', 'guide'],
        run: () => navigate('/guide')
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
    // 输入的就是「新建」「新建笔记」这类命令名的开头：给一个不带标题的「新建笔记」，
    // 排在最前面。否则回车会打开一篇标题里带「新建」的笔记，或者新建一篇叫「新建笔记」的笔记。
    const exactNew = !readOnly && needle.length >= 2 && '新建笔记'.startsWith(needle)
      ? [{ label: '新建笔记', hint: '', icon: '写入', writes: true, run: () => navigate('/new') }]
      : [];
    return {
      matched: [...exactNew, ...all.filter(command => !command.fallback && (
        command.label.toLowerCase().includes(needle)
        // 别名只按词头匹配，而且至少两个字符：单个字母不该把命令顶到笔记前面。
        || (needle.length >= 2 && (command.keywords || []).some(keyword => keyword.startsWith(needle)))
      ))],
      fallback: all.filter(command => command.fallback && !(exactNew.length && command.label === '新建笔记'))
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
      if (item.icon === '笔记') {
        // 结果几乎全是笔记，每行都写「笔记」是重复信息：只放一个淡色的文档图标
        // （样式里画）占住同一列，命令（写入、搜索……）照旧用文字标签。
        icon.className = 'palette-icon is-note';
        icon.setAttribute('aria-hidden', 'true');
      } else {
        icon.className = 'palette-icon';
        icon.textContent = item.icon || '项目';
      }

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

  // 当前列表是不是已经对应输入框里的内容。没对上之前按回车，要等搜索结果回来再选，
  // 不能选中上一轮留下的结果，也不能什么都不做。
  let settled = Promise.resolve();
  let fresh = true;

  async function refresh() {
    const query = input.value.trim();
    const token = ++requestToken;
    requestController?.abort();
    requestController = typeof AbortController === 'function' ? new AbortController() : null;
    // 命令是本地的，立刻按新输入排出来；笔记搜索结果到了再补上。
    // 旧结果先留着，列表不会每按一个键就清空再填回、上下跳动。
    const { matched, fallback } = commands(query);
    items = [...matched, ...items.filter(item => item.icon === '笔记'), ...fallback];
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
        // 与笔记列表一致，显示分区的中文名，不露出目录名。
        hint: ({ experiments: '研究项目', research: '研究笔记', calendar: '月历备注', learning: '学习笔记', reading: '阅读笔记', inbox: '收件箱', cards: '卡片' })[row.section] || row.section || '',
        icon: '笔记',
        run: () => navigate(`/note/${row.path.split('/').map(encodeURIComponent).join('/')}`)
      }));
    } catch (error) {
      if (error.name !== 'AbortError') searchError = error;
    }

    if (token !== requestToken) return;
    requestController = null;

    items = [...matched, ...notes, ...fallback];
    activeIndex = 0;
    fresh = true;
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
    fresh = false;
    settled = refresh();
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
    scheduleRefresh(120);
  });
  function scheduleRefresh(delay) {
    fresh = false;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = 0;
      settled = refresh();
    }, delay);
  }

  input.addEventListener('input', event => {
    fresh = false;
    // 旧查询的请求立刻作废：它的结果到了也不再显示。
    requestToken += 1;
    requestController?.abort();
    requestController = null;
    if (composing || event.isComposing) {
      if (debounce) clearTimeout(debounce);
      return;
    }
    scheduleRefresh(120);
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
      if (fresh) {
        choose(activeIndex);
        return;
      }
      // 输入后马上回车：先把这次搜索做完，再选第一项。
      if (debounce) {
        clearTimeout(debounce);
        debounce = 0;
        settled = refresh();
      }
      const token = requestToken;
      settled.then(() => {
        if (token === requestToken && dialog.open) choose(activeIndex);
      });
    }
  });
})();
