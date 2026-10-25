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

  const pendingEditorWork = new Set();
  const editorWorkWaiters = new Set();
  let editorIdleCheckScheduled = false;

  function scheduleEditorIdleCheck() {
    if (editorIdleCheckScheduled || pendingEditorWork.size > 0) return;
    editorIdleCheckScheduled = true;
    Promise.resolve().then(() => {
      editorIdleCheckScheduled = false;
      if (pendingEditorWork.size > 0) return;
      for (const resolve of editorWorkWaiters) resolve();
      editorWorkWaiters.clear();
    });
  }

  function beginEditorWork() {
    const token = {};
    pendingEditorWork.add(token);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      pendingEditorWork.delete(token);
      scheduleEditorIdleCheck();
    };
  }

  function hasPendingEditorWork() {
    return pendingEditorWork.size > 0;
  }

  function waitForEditorWork() {
    if (pendingEditorWork.size === 0) return Promise.resolve();
    return new Promise(resolve => editorWorkWaiters.add(resolve));
  }

  window.workstationUI = {
    requestJson,
    notify,
    hasOpenDialog,
    isInteractiveTarget,
    isExactPrimaryShortcut,
    beginEditorWork,
    hasPendingEditorWork,
    waitForEditorWork
  };

  async function updateBoardStatus(select) {
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
      const empty = column.querySelector('.board-empty');
      if (counter) counter.textContent = String(count);
      if (empty) empty.hidden = count > 0;
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
      select.focus();
    }
  }

  document.addEventListener('change', event => {
    const select = event.target.closest('[data-auto-submit]');
    if (!select) return;
    if (select.form?.matches('.statusform') && select.closest('[data-board]')) {
      updateBoardStatus(select);
      return;
    }
    select.form?.requestSubmit();
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
    let baseline = editorForm.dataset?.recovered === '1' ? '' : serializeEditor();
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
      renderEditorState(dirty ? 'dirty' : 'clean', dirty ? '有未保存的更改' : '所有更改均已保存');
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
      if (pathInput) pathInput.readOnly = true;

      try {
        if (window.workstationUI.hasPendingEditorWork()) {
          renderEditorState('saving', '正在等待附件上传…');
          while (window.workstationUI.hasPendingEditorWork()) {
            await window.workstationUI.waitForEditorWork();
          }
          renderEditorState('saving', '附件上传完成，正在保存…');
        } else {
          renderEditorState('saving', '正在保存…');
        }
        const submitted = new FormData(editorForm);
        const response = await fetch(editorForm.action, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new URLSearchParams(submitted)
        });
        const payload = await parseResponse(response);
        if (!response.ok) {
          throw new Error(payload.message || `保存失败（${response.status}）`);
        }
        const expectedHash = editorForm.querySelector('[name="expectedHash"]');
        const isNew = editorForm.querySelector('[name="isNew"]');
        const submittedPath = String(submitted.get('path') || '');
        const samePath = !pathInput || pathInput.value === submittedPath;
        if (samePath && expectedHash && payload.hash) expectedHash.value = payload.hash;
        if (samePath && isNew) isNew.value = '0';
        const savedSnapshot = new URLSearchParams(submitted);
        if (payload.hash) savedSnapshot.set('expectedHash', payload.hash);
        savedSnapshot.set('isNew', '0');
        baseline = savedSnapshot.toString();
        await window.workstationDrafts?.saved(submitted);
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
        notify('保存失败，草稿仍保留在编辑器中。', { type: 'error' });
      } finally {
        saving = false;
        saveButton.disabled = false;
        saveButton.removeAttribute('aria-busy');
        if (pathInput) pathInput.readOnly = pathWasReadOnly;
      }
    });

    refreshEditorState();
    window.addEventListener('beforeunload', event => {
      if (navigating) return;
      const dirty = serializeEditor() !== baseline;
      if (!saving && !window.workstationUI.hasPendingEditorWork() && !dirty) return;
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
        item.append(path, reason);
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
