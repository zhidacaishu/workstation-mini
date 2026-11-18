(() => {
  async function parseResponse(response) {
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { message: response.ok ? '' : text.trim() };
      }
    }
    if (typeof response.json === 'function') {
      try {
        return await response.json();
      } catch {
        return {};
      }
    }
    return {};
  }

  async function requestJson(url, options = {}) {
    const { json, fallbackMessage, ...requestOptions } = options;
    const headers = { Accept: 'application/json', ...(requestOptions.headers || {}) };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestOptions.body = JSON.stringify(json);
    }

    const response = await fetch(url, { ...requestOptions, headers });
    const payload = await parseResponse(response);
    if (!response.ok) {
      const error = new Error(payload.message || fallbackMessage || `请求失败（${response.status}）`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function notify(message, { type = 'success', timeout } = {}) {
    const region = document.getElementById('toast-region');
    if (!region || !message) return () => {};

    const toast = document.createElement('div');
    toast.className = `toast is-${type}`;
    if (type === 'error') toast.setAttribute('role', 'alert');

    const text = document.createElement('p');
    text.textContent = message;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭通知');
    closeButton.textContent = '×';
    toast.append(text, closeButton);
    region.append(toast);

    let timer = 0;
    const close = () => {
      if (timer) window.clearTimeout(timer);
      toast.remove();
    };
    closeButton.addEventListener('click', close);
    const delay = timeout === undefined ? (type === 'error' ? 8000 : 4200) : timeout;
    if (delay > 0) timer = window.setTimeout(close, delay);
    return close;
  }

  function hasOpenDialog() {
    return Boolean(document.querySelector('dialog[open]'));
  }

  function isInteractiveTarget(target) {
    const element = target?.nodeType === 3 ? target.parentElement : target;
    if (!element) return false;
    const interactiveSelector = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'audio', 'video',
      '[contenteditable="true"]', '[role="button"]', '[role="link"]',
      '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="slider"]', '[role="tab"]', '[role="menuitem"]'
    ].join(',');
    return Boolean(element.closest?.(interactiveSelector));
  }

  /**
   * 主修饰键必须分平台，不能「Ctrl 或 Cmd 都认」。
   *
   * macOS 的文本域实现了一整套系统级的 emacs 绑定，其中 Ctrl+K 就是「删到行尾」。
   * 认了 Ctrl 就等于在编辑器里把这个键抢走 —— 用户想删到行尾，结果弹出一个模态
   * 命令面板，而 preventDefault 又把原生行为也吃掉了。反过来在 Windows/Linux 上
   * Meta 是系统键（开始菜单 / Super），同样不该被页面接管。
   *
   * 平台由服务端渲染进 body 的 data-primary-modifier —— HTTP 服务就在 Electron
   * 主进程里，那边的 process.platform 就是用户所在的平台，比嗅探 userAgent 可靠。
   * 读不到时按 control 处理：这是保守方向，Windows/Linux 上照常可用，
   * 而 macOS 顶多是 Cmd+K 不响应，不会去抢系统快捷键。
   */
  const primaryModifier = document.body?.dataset?.primaryModifier === 'meta' ? 'meta' : 'control';

  function isExactPrimaryShortcut(event, key) {
    if (event.key?.toLowerCase() !== key.toLowerCase()) return false;
    if (event.altKey || event.shiftKey) return false;
    return primaryModifier === 'meta'
      ? Boolean(event.metaKey) && !event.ctrlKey
      : Boolean(event.ctrlKey) && !event.metaKey;
  }

  window.workstationUI = {
    requestJson,
    notify,
    hasOpenDialog,
    isInteractiveTarget,
    isExactPrimaryShortcut
  };

  async function updateBoardStatus(select, { restoreFocus = true } = {}) {
    const form = select.form;
    const card = form?.closest('[data-board-card]');
    const board = form?.closest('[data-board]');
    if (!form || !card || !board) {
      form?.requestSubmit();
      return;
    }

    const oldStatus = card.dataset.status;
    const newStatus = select.value;
    if (!oldStatus || oldStatus === newStatus) return;

    const sourceColumn = card.closest('[data-board-column]');
    const targetColumn = [...board.querySelectorAll('[data-board-column]')]
      .find(column => column.dataset.status === newStatus);
    if (!targetColumn) {
      select.value = oldStatus;
      notify('找不到目标状态列。', { type: 'error' });
      return;
    }

    const updateColumn = column => {
      if (!column) return;
      const items = column.querySelector('[data-board-items]');
      const count = items?.querySelectorAll('[data-board-card]').length || 0;
      const counter = column.querySelector('[data-column-count]');
      if (counter) counter.textContent = String(count);
    };

    const data = Object.fromEntries(new FormData(form));
    card.classList.add('is-pending');
    card.setAttribute('aria-busy', 'true');
    select.disabled = true;

    try {
      const result = await requestJson(form.action, {
        method: 'POST',
        json: data,
        fallbackMessage: '状态更新失败'
      });
      const targetItems = targetColumn.querySelector('[data-board-items]');
      if (!targetItems || result.status !== newStatus) throw new Error('服务器没有确认新的状态。');
      card.dataset.status = newStatus;
      if (result.hash) {
        card.dataset.hash = result.hash;
        const expectedHash = form.querySelector('[name=expectedHash]');
        if (expectedHash) expectedHash.value = result.hash;
      }
      const active = newStatus !== 'done' && newStatus !== 'abandoned';
      const deadline = card.querySelector('[data-board-deadline]');
      if (deadline) {
        deadline.textContent = active ? deadline.dataset.activeLabel : deadline.dataset.inactiveLabel;
        deadline.classList.toggle('is-overdue', active && deadline.dataset.deadlineState === 'overdue');
        deadline.classList.toggle('is-today', active && deadline.dataset.deadlineState === 'today');
      }
      const resultLine = card.querySelector('[data-board-result]');
      const nextLine = card.querySelector('[data-board-next]');
      const showResult = newStatus === 'done' && Boolean(resultLine);
      if (resultLine) resultLine.hidden = !showResult;
      if (nextLine) nextLine.hidden = showResult;
      targetItems.append(card);
      updateColumn(sourceColumn);
      updateColumn(targetColumn);
      notify(`已移到“${select.selectedOptions[0]?.textContent || newStatus}”`);
    } catch (error) {
      select.value = oldStatus;
      notify(error.status === 409
        ? '条目已在别处修改，请刷新页面后重试。卡片没有移动。'
        : `状态更新失败：${error.message}`, { type: 'error' });
    } finally {
      card.classList.remove('is-pending');
      card.removeAttribute('aria-busy');
      select.disabled = false;
      // 提交是因为焦点离开了下拉框：不把焦点拽回来。
      if (restoreFocus) select.focus();
    }
  }

  // 下拉框选中即提交。但用键盘的方向键浏览选项时，每按一下就会触发一次 change：
  // 看板上按两下 ↓，项目状态就被连写两次；筛选按一下就跳页，键盘用户选不到后面的项。
  // 所以方向键带来的改动先等一等：停下来 1.2 秒、按回车，或者离开下拉框时才提交。
  const keyboardSelects = new WeakMap();
  const KEYBOARD_SETTLE_MS = 1200;
  function commitAutoSubmit(select, { restoreFocus = true } = {}) {
    const pending = keyboardSelects.get(select);
    if (pending) clearTimeout(pending.timer);
    keyboardSelects.delete(select);
    if (select.form?.matches('.statusform') && select.closest('[data-board]')) {
      updateBoardStatus(select, { restoreFocus });
      return;
    }
    select.form?.requestSubmit();
  }
  document.addEventListener('keydown', event => {
    const select = event.target?.closest?.('[data-auto-submit]');
    if (!select) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      const pending = keyboardSelects.get(select) || { dirty: false, timer: 0 };
      keyboardSelects.set(select, pending);
    } else if (event.key === 'Enter' && keyboardSelects.get(select)?.dirty) {
      event.preventDefault();
      commitAutoSubmit(select);
    }
  }, true);
  document.addEventListener('change', event => {
    const select = event.target.closest('[data-auto-submit]');
    if (!select) return;
    const pending = keyboardSelects.get(select);
    if (!pending) {
      commitAutoSubmit(select);
      return;
    }
    pending.dirty = true;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => commitAutoSubmit(select, { restoreFocus: document.activeElement === select }), KEYBOARD_SETTLE_MS);
  });
  document.addEventListener('focusout', event => {
    const select = event.target?.closest?.('[data-auto-submit]');
    const pending = select && keyboardSelects.get(select);
    if (!pending) return;
    if (pending.dirty) commitAutoSubmit(select, { restoreFocus: false });
    else keyboardSelects.delete(select);
  });

  // 更多操作是弹出菜单，和长期展开的帮助内容区别处理。
  function closeNoteMenus(target) {
    for (const menu of document.querySelectorAll('.note-more[open]')) {
      if (!menu.contains(target)) menu.open = false;
    }
  }

  document.addEventListener('click', event => closeNoteMenus(event.target));
  document.addEventListener('focusin', event => closeNoteMenus(event.target));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || hasOpenDialog()) return;
    const menu = document.querySelector('.note-more[open]');
    if (!menu) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
    event.preventDefault();
  });

  const cardEditor = document.querySelector('[data-card-editor]');
  if (cardEditor) {
    const snapshot = () => new URLSearchParams(new FormData(cardEditor));
    const initial = snapshot().toString();
    const errorMessage = cardEditor.querySelector('[data-card-error]');
    let saving = false;
    let saved = false;
    cardEditor.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      const body = snapshot();
      saving = true;
      cardEditor.inert = true;
      if (event.submitter) event.submitter.disabled = true;
      errorMessage.hidden = true;
      try {
        const result = await requestJson(cardEditor.action, { method: 'POST', body });
        saved = true;
        window.location.assign(result.redirect);
      } catch (error) {
        saved = false;
        errorMessage.textContent = '保存失败：' + error.message;
        errorMessage.hidden = false;
      } finally {
        if (!saved) {
          saving = false;
          cardEditor.inert = false;
          if (event.submitter) event.submitter.disabled = false;
        }
      }
    });
    window.addEventListener('beforeunload', event => {
      if (saved || (!saving && snapshot().toString() === initial)) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  // 其它需要确认的表单在 data-confirm 里写好提示语。
  document.addEventListener('submit', event => {
    const message = event.target.dataset?.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  });

  document.addEventListener('submit', event => {
    if (!event.target.matches('[data-confirm-delete]')) return;
    if (!window.confirm('删除这篇笔记？删除前会保存本地版本，可在“历史与草稿”恢复。')) event.preventDefault();
  });

  document.querySelector('[data-go-back]')?.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/';
  });

  const editorForm = document.querySelector('[data-editor-form]');
  if (editorForm) {
    const status = editorForm.querySelector('[data-editor-status]');
    const saveButton = editorForm.querySelector('[data-editor-save]');
    const serializeEditor = () => new URLSearchParams(new FormData(editorForm)).toString();
    // 恢复页的基线也是载入时的内容：没改就能离开。「恢复内容尚未保存」只是提示，
    // 不当成未保存的更改去拦截离开和退出。
    let baseline = serializeEditor();
    const recovered = editorForm.dataset?.recovered === '1';
    let saving = false;
    let navigating = false;

    const renderEditorState = (state, message) => {
      if (!status) return;
      status.className = `editor-status${state === 'dirty' ? ' is-dirty' : ''}${state === 'error' ? ' is-error' : ''}`;
      status.textContent = message;
    };
    const refreshEditorState = () => {
      if (saving) return;
      const dirty = serializeEditor() !== baseline;
      const newNote = editorForm.querySelector('[name="isNew"]')?.value === '1';
      const cleanMessage = recovered ? '已载入恢复内容，保存后才会写入笔记' : newNote ? '新笔记尚未保存' : '所有更改均已保存';
      renderEditorState(dirty ? 'dirty' : 'clean', dirty ? '有未保存的更改' : cleanMessage);
    };

    editorForm.addEventListener('input', refreshEditorState);
    editorForm.addEventListener('change', refreshEditorState);
    editorForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      saveButton.disabled = true;
      saveButton.setAttribute('aria-busy', 'true');
      const pathInput = editorForm.querySelector('[name="path"]');
      const pathWasReadOnly = Boolean(pathInput?.readOnly);
      let lockPath = false;
      if (pathInput) pathInput.readOnly = true;

      try {
        renderEditorState('saving', '正在保存…');
        const submitted = new FormData(editorForm);
        const response = await fetch(editorForm.action, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new URLSearchParams(submitted)
        });
        const payload = await parseResponse(response);
        if (!response.ok) {
          throw Object.assign(new Error(payload.message || `保存失败（${response.status}）`), { status: response.status });
        }
        const expectedHash = editorForm.querySelector('[name="expectedHash"]');
        const isNew = editorForm.querySelector('[name="isNew"]');
        const autoPath = editorForm.querySelector('[name="autoPath"]');
        const submittedPath = String(submitted.get('path') || '');
        // 服务端可能补了 .md、或因为重名换成了「标题 2」：路径框跟着改成真正保存的位置，
        // 后面继续编辑、再次保存都落在同一个文件上。
        const savedPath = payload.path || submittedPath;
        // 新笔记第一次保存之后，路径就固定在实际保存的位置，后面的保存都是修改这篇。
        const wasNew = isNew?.value === '1';
        if (pathInput && (wasNew || pathInput.value === submittedPath)) pathInput.value = savedPath;
        const samePath = !pathInput || pathInput.value === savedPath;
        if (samePath && expectedHash && payload.hash) expectedHash.value = payload.hash;
        if (samePath && isNew) isNew.value = '0';
        if (samePath && autoPath) autoPath.value = '0';
        if (samePath) pathInput?.removeAttribute?.('data-auto-path');
        if (samePath && wasNew) lockPath = true;
        const savedSnapshot = new URLSearchParams(submitted);
        savedSnapshot.set('path', savedPath);
        if (payload.hash) savedSnapshot.set('expectedHash', payload.hash);
        savedSnapshot.set('isNew', '0');
        if (autoPath) savedSnapshot.set('autoPath', '0');
        baseline = savedSnapshot.toString();
        await window.workstationDrafts?.saved(submitted, savedPath);
        const dirty = serializeEditor() !== baseline;
        if (dirty) {
          renderEditorState('dirty', '提交时的版本已保存；还有未保存的更改');
          notify('已保存提交时的版本，继续编辑的内容仍待保存。', { type: 'info' });
        } else {
          navigating = true;
          renderEditorState('clean', '已保存，正在打开笔记…');
          window.location.href = payload.redirect || response.url;
        }
      } catch (error) {
        renderEditorState('error', `保存失败：${error.message}`);
        if (error.status === 409 && editorForm.querySelector('[name="isNew"]')?.value !== '1') {
          // 别处改过这篇笔记：现在的内容先存成本机草稿，再问要不要载入最新版本。
          // 不载入就留在这里，可以把内容复制出来再刷新。
          const draftSaved = await window.workstationDrafts?.flush?.();
          if (draftSaved !== true) {
            renderEditorState('error', '草稿未确认保存，请保留此页面并复制内容备份后再处理冲突。');
            return;
          }
          if (window.confirm('这篇笔记已在别处修改，现在的内容不能直接覆盖它。\n\n你写的内容已存为本机草稿，可在「历史与草稿」找回。要载入最新版本吗？')) {
            navigating = true;
            window.location.reload();
            return;
          }
        } else {
          notify('保存失败，草稿仍保留在编辑器中。', { type: 'error' });
        }
      } finally {
        saving = false;
        saveButton.disabled = false;
        saveButton.removeAttribute('aria-busy');
        if (pathInput) pathInput.readOnly = lockPath || pathWasReadOnly;
      }
    });

    refreshEditorState();
    window.addEventListener('beforeunload', event => {
      if (navigating) return;
      const dirty = serializeEditor() !== baseline;
      if (!saving && !dirty) return;
      // 先把草稿发出去：接下来要是选了「离开」，刚打的几个字也能在「历史与草稿」里找回。
      if (dirty) window.workstationDrafts?.flush?.({ leaving: true });
      event.preventDefault();
      event.returnValue = '';
    });

    document.addEventListener('keydown', event => {
      if (!isExactPrimaryShortcut(event, 's') || hasOpenDialog()) return;
      event.preventDefault();
      if (!saving) editorForm.requestSubmit();
    });
  }

  function watchIndexStatus() {
    const banner = document.getElementById('index-banner');
    if (!banner) return;
    const message = document.getElementById('index-banner-message') || banner;
    const failures = document.getElementById('index-banner-failures');
    const summary = document.getElementById('index-banner-summary');
    const retry = document.getElementById('index-banner-retry');

    let timer = null;
    let generation = 0;
    let wasIncomplete = false;
    let lastPhase = '';

    function schedule(delay, token = generation) {
      if (token !== generation) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        poll(token);
      }, delay);
    }

    function renderFailures(status) {
      if (!failures) return;
      failures.replaceChildren();
      for (const failure of status.failures || []) {
        const item = document.createElement('li');
        const path = document.createElement('code');
        path.textContent = failure.path;
        const reason = document.createElement('span');
        reason.textContent = failure.reason;
        // 属性区写坏的笔记照样能打开（阅读页显示原文和「打开编辑器修复」），直接给个入口。
        if (failure.code === 'invalid-frontmatter' && /\.md$/i.test(failure.path || '')) {
          const link = document.createElement('a');
          link.href = '/note/' + String(failure.path).split('/').map(encodeURIComponent).join('/');
          link.append(path);
          item.append(link, reason);
        } else {
          item.append(path, reason);
        }
        failures.append(item);
      }
      failures.hidden = failures.children.length === 0;
      if (summary) {
        const shown = (status.failures || []).length;
        summary.textContent = status.failuresTruncated
          ? `另有 ${Math.max(0, status.failureTotal - shown)} 个失败项未在此列出。`
          : '';
        summary.hidden = !summary.textContent;
      }
    }

    function render(status) {
      lastPhase = status.phase;
      // 后台对账（窗口聚焦、定时轮询、外部改动）和单篇增量只是确认一遍有没有变化，
      // 搜索结果并没有变得不完整。为它们弹横幅只会在打字时冒出「刷新页面」这种误导。
      if (status.phase === 'indexing' && (status.scanKind === 'background' || status.scanKind === 'incremental')) {
        return wasIncomplete ? 1000 : 15000;
      }
      banner.dataset.phase = status.phase;
      banner.removeAttribute('role');
      banner.setAttribute('role', status.phase === 'error' ? 'alert' : 'status');

      if (status.phase === 'indexing') {
        const total = status.total || 0;
        message.textContent = total
          ? `正在建立索引 ${status.done}/${total}，搜索结果暂时不完整…`
          : '正在建立索引，搜索结果暂时不完整…';
        banner.hidden = false;
        wasIncomplete = true;
        renderFailures({ failures: [] });
        if (retry) retry.hidden = true;
        return 1000;
      }

      if (status.phase === 'degraded') {
        message.textContent = `索引已完成，但有 ${status.failureTotal} 篇笔记未能更新；其它 ${status.notes} 篇仍可使用。`;
        banner.hidden = false;
        wasIncomplete = true;
        renderFailures(status);
        if (retry) retry.hidden = false;
        return 9000;
      }

      if (status.phase === 'error') {
        message.textContent = status.fatal?.reason || '索引扫描失败，上一份可用结果仍会保留。';
        banner.hidden = false;
        wasIncomplete = true;
        renderFailures(status);
        // 库已损坏时重试没有用，只能重启重建。
        if (retry) retry.hidden = status.fatal?.retryable === false;
        return 9000;
      }

      renderFailures({ failures: [] });
      if (retry) retry.hidden = true;
      if (wasIncomplete) {
        message.textContent = `索引已恢复，共 ${status.notes} 篇笔记。刷新页面查看完整结果。`;
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
      return 15000;
    }

    async function poll(token = generation) {
      try {
        const status = await requestJson('/api/index-status');
        if (token !== generation) return;
        const delay = render(status);
        if (delay !== null) schedule(delay, token);
      } catch {
        if (token !== generation) return;
        const delay = lastPhase === 'indexing' ? 1000 : lastPhase === 'degraded' || lastPhase === 'error' ? 9000 : 15000;
        schedule(delay, token);
      }
    }

    retry?.addEventListener('click', async () => {
      if (retry.disabled) return;
      retry.disabled = true;
      banner.setAttribute('aria-busy', 'true');
      generation += 1;
      const token = generation;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        await requestJson('/api/index-retry', { method: 'POST' });
      } catch (error) {
        notify(`索引重试失败：${error.message}`, { type: 'error' });
      } finally {
        if (token !== generation) return;
        retry.disabled = false;
        banner.removeAttribute('aria-busy');
        poll(token);
      }
    });

    poll(generation);
  }

  watchIndexStatus();

  // 代码块右上角的「复制」。
  for (const pre of document.querySelectorAll?.('.prose pre') || []) {
    const code = pre.querySelector('code');
    if (!code || pre.closest('.code-block')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    pre.before(wrapper);
    wrapper.append(pre);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = '复制';
    button.setAttribute('aria-label', '复制这段代码');
    let timer = 0;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ''));
        button.textContent = '已复制';
        button.classList.add('is-done');
      } catch {
        button.textContent = '复制失败';
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { button.textContent = '复制'; button.classList.remove('is-done'); }, 1600);
    });
    wrapper.append(button);
  }

  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (hasOpenDialog() || isInteractiveTarget(document.activeElement)) return;

    // 资料库页有自己的搜索框，就聚焦它；其余页面没有输入框，直接唤起命令面板。
    const search = document.querySelector('.library-search input[type="search"]');
    event.preventDefault();
    if (!search) {
      document.querySelector('[data-palette-open]')?.click();
      return;
    }
    search.focus();
    search.select();
  });
})();
