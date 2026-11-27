(() => {
  const prose = document.querySelector('.prose');
  const createButton = document.querySelector('[data-card-create]');
  if (!prose && !createButton) return;

  const notePath = document.body.dataset.notePath || '';
  const ui = window.workstationUI || {};
  const notify = ui.notify || (() => {});
  const requestJson = ui.requestJson || (async (url, options = {}) => {
    const response = await fetch(url, {
      method: options.method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(options.json)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.message || '保存失败'), { payload });
    return payload;
  });

  let bubble = null;
  let bubbleText = '';
  let bubbleRange = null;
  let activeDialog = null;
  let restoreFocus = null;
  let saving = false;
  let hasEdits = () => false;
  let selectionFrame = 0;
  const scheduleFrame = window.requestAnimationFrame || (callback => callback());

  if (createButton) {
    const saved = window.sessionStorage.getItem('card-created');
    if (saved) {
      window.sessionStorage.removeItem('card-created');
      notify('已存到 ' + saved);
      const reviewer = document.querySelector?.('#reviewer:not([hidden])');
      const visibleButton = [...(document.querySelectorAll?.('[data-card-create]') || [])]
        .find(el => !el.closest?.('[hidden]'));
      (reviewer || visibleButton || createButton).focus({ preventScroll: true });
    }
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-card-create]');
      if (button) openForm('', button);
    });
  }
  window.addEventListener('beforeunload', event => {
    if (!activeDialog || (!saving && !hasEdits())) return;
    if (window.workstationDialog?.mayLeave(event)) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function removeBubble() {
    bubble?.remove();
    bubble = null;
    bubbleText = '';
    bubbleRange = null;
  }

  function cleanupDialog(dialog) {
    if (activeDialog !== dialog) return;
    dialog.remove();
    activeDialog = null;
    hasEdits = () => false;
    const reviewer = document.querySelector?.('#reviewer:not([hidden])');
    const target = reviewer && reviewer.contains?.(restoreFocus)
      ? reviewer
      : restoreFocus && restoreFocus !== document.body && restoreFocus.isConnected !== false
        ? restoreFocus
        : document.getElementById('main-content') || prose;
    restoreFocus = null;
    target?.focus?.({ preventScroll: true });
  }

  function closeForm() {
    const dialog = activeDialog;
    if (!dialog || saving) return;
    if (dialog.open) dialog.close();
    cleanupDialog(dialog);
  }

  function showBubble(text, range) {
    if (saving || activeDialog) return;
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'selection-card';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button primary';
      button.textContent = '建卡片';
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => openForm(bubbleText));

      bubble.append(button);
      document.body.append(bubble);
    }
    bubbleText = text;
    bubbleRange = range;
    positionBubble();
  }

  function positionBubble() {
    if (!bubble) return;
    const rect = bubbleRange.getBoundingClientRect();
    const viewport = window.getComputedStyle(document.documentElement);
    const visibleTop = parseFloat(viewport.scrollPaddingTop) || 0;
    const visibleBottom = window.innerHeight - (parseFloat(viewport.scrollPaddingBottom) || 0);
    let left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
    let top = Math.max(visibleTop, rect.top), bottom = Math.min(visibleBottom, rect.bottom);
    // 代码、表格等有自己的滚动区域，Range 返回的矩形包含已经被裁掉的文字。
    const node = bubbleRange.commonAncestorContainer;
    for (let el = node.nodeType === 1 ? node : node.parentElement; el && el !== prose; el = el.parentElement) {
      const style = window.getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = el.getBoundingClientRect();
      if (style.overflowX !== 'visible') { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (style.overflowY !== 'visible') { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    bubble.hidden = right <= left || bottom <= top;
    if (bubble.hidden) return;
    const above = top - bubble.offsetHeight - 8;
    const below = bottom + 8;
    let buttonTop = visibleTop + 8;
    if (above >= visibleTop) buttonTop = above;
    else if (below + bubble.offsetHeight <= visibleBottom) buttonTop = below;
    const maxLeft = window.innerWidth - bubble.offsetWidth - 8;
    bubble.style.top = `${window.scrollY + buttonTop}px`;
    bubble.style.left = `${window.scrollX + Math.max(8, Math.min(maxLeft, left))}px`;
  }

  function openForm(selected, trigger) {
    if (saving || activeDialog) return;
    const focusedBeforeOpen = trigger || document.activeElement;
    removeBubble();
    restoreFocus = focusedBeforeOpen;

    const dialog = document.createElement('dialog');
    dialog.className = 'selection-form';
    dialog.setAttribute('aria-labelledby', 'selection-form-title');
    dialog.innerHTML = `
      <form class="selection-form-inner" data-card-form>
        <h2 id="selection-form-title">新建卡片</h2>
        <div class="card-compose-faces">
          <label class="card-compose-face" for="compose-front">正面
            <input id="compose-front" type="text" name="front" placeholder="写下问题" autocomplete="off" aria-required="true">
          </label>
          <div class="card-compose-face">
            <div class="card-compose-caption"><label for="compose-back">背面</label><small id="compose-format">Markdown · $公式$ · {{挖空}}</small></div>
            <textarea id="compose-back" name="back" rows="4" aria-describedby="compose-format" placeholder="写下答案（可稍后补充）"></textarea>
          </div>
        </div>
        <div class="card-compose-destination">
          <label for="compose-deck">卡组文件</label>
          <div class="card-compose-file"><span aria-hidden="true">cards/</span>
            <input id="compose-deck" type="text" name="deckFile" list="compose-decks" placeholder="inbox" autocomplete="off" spellcheck="false">
            <span aria-hidden="true">.md</span>
          </div>
        </div>
        <datalist id="compose-decks"></datalist>
        <p class="selection-status" role="status" aria-live="polite" hidden></p>
        <div class="actions">
          <button class="button quiet" type="button" data-cancel>取消</button>
          <button class="button primary" type="submit" data-save>保存</button>
        </div>
      </form>
    `;
    document.body.append(dialog);
    activeDialog = dialog;

    const form = dialog.querySelector('[data-card-form]');
    const front = form.querySelector('[name=front]');
    const deckField = form.querySelector('[name=deckFile]');
    deckField.value = trigger?.dataset.cardCreate || '';
    const choices = form.querySelector('datalist');
    if (choices && typeof Option === 'function') {
      requestJson('/api/card-decks').then(files => {
        if (dialog.isConnected && Array.isArray(files)) {
          choices.replaceChildren(...files.map(({ file, deck }) => new Option(deck, file)));
        }
      }).catch(() => {}); // 建议不可用时仍可直接输入文件名。
    }
    const saveButton = form.querySelector('[data-save]');
    const onMac = document.body.dataset.primaryModifier === 'meta';
    saveButton.title = onMac ? '保存（⌘Enter 或 ⌘S）' : '保存（Ctrl+Enter 或 Ctrl+S）';
    saveButton.setAttribute('aria-keyshortcuts', onMac ? 'Meta+Enter Meta+S' : 'Control+Enter Control+S');
    const status = form.querySelector('.selection-status');

    const showStatus = (message, isError = false) => {
      status.hidden = false;
      status.textContent = message;
      status.classList.toggle('is-error', isError);
      if (isError) window.workstationMotion?.nudge?.(status);
    };

    // 按 Esc、点遮罩或取消时：没改过就直接关闭；有未保存的改动时先确认，避免误丢内容。
    const snapshot = () => [...form.querySelectorAll('input, textarea, select')].map(field => field.value).join('\u0000');
    let initial = '';
    async function discardIfConfirmed() {
      if (saving) return;
      if (snapshot() === initial || await window.workstationDialog.confirm('放弃这张卡片？', '已填的内容不会保存。', '放弃卡片', { danger: true })) closeForm();
    }
    dialog.addEventListener('close', () => cleanupDialog(dialog), { once: true });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      discardIfConfirmed();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) discardIfConfirmed();
    });
    form.querySelector('[data-cancel]').addEventListener('click', discardIfConfirmed);
    form.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (ui.isExactPrimaryShortcut?.(event, 'Enter') || ui.isExactPrimaryShortcut?.(event, 's')) {
        event.preventDefault();
        if (!event.repeat && !saving) form.requestSubmit();
      } else if (event.key === 'Enter' && event.target === front && !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        form.querySelector('[name=back]').focus();
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;

      const payload = {
        front: front.value.trim(),
        back: form.querySelector('[name=back]').value,
        deckFile: deckField.value.trim() || 'inbox',
        source: notePath
      };
      if (!payload.front) {
        showStatus('正面不能为空。', true);
        front.focus();
        return;
      }

      const focusedField = document.activeElement;
      saving = true;
      const controls = [...form.querySelectorAll('input, textarea, button')];
      const disabledBefore = controls.map(control => control.disabled);
      for (const control of controls) control.disabled = true;
      dialog.setAttribute('aria-busy', 'true');
      saveButton.setAttribute('aria-busy', 'true');
      showStatus('正在保存…');
      try {
        const save = json => requestJson('/cards/add', {
          method: 'POST',
          json,
          fallbackMessage: '保存失败'
        });
        let result;
        try {
          result = await save(payload);
        } catch (error) {
          if (!error.payload?.duplicate) throw error;
          showStatus('发现重复卡片，请确认是否继续保存。');
          const confirmed = await window.workstationDialog.confirm('保存重复卡片？', error.message, '仍然保存');
          if (!confirmed) { showStatus('可以修改卡片后再保存。'); return; }
          showStatus('正在保存…');
          result = await save({ ...payload, allowDuplicate: true });
        }
        saving = false;
        if (activeDialog === dialog) closeForm();
        if (trigger && (!document.getElementById('reviewer') || trigger.closest?.('.review-empty'))) {
          window.sessionStorage.setItem('card-created', result.path);
          window.location.reload();
        } else {
          if (trigger) document.querySelector('#reviewer:not([hidden])')?.focus({ preventScroll: true });
          window.workstationReviewCounts?.refresh();
          notify(`已存到 ${result.path}`);
        }
      } catch (error) {
        showStatus(`保存失败：${error.message}`, true);
      } finally {
        saving = false;
        controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
        dialog.removeAttribute('aria-busy');
        saveButton.removeAttribute('aria-busy');
        if (activeDialog === dialog && focusedField?.isConnected) focusedField.focus();
      }
    });

    dialog.showModal();
    if (selected.includes('\n')) {
      form.querySelector('[name=back]').value = selected;
      front.placeholder = '根据选中的内容写下问题';
    } else front.value = selected;
    initial = snapshot();
    hasEdits = () => snapshot() !== initial;
    front.focus();
    front.select();
  }

  // Treat a formula as one selectable unit, including partially selected glyphs.
  // Serialize from a cloned range so neither the note DOM nor KaTeX's MathML is changed.
  function selectedMarkdown(selection) {
    const range = selection.getRangeAt(0);
    if (!range.cloneRange) return selection.toString();
    const selected = range.cloneRange();
    const elementOf = node => node.nodeType === 1 ? node : node.parentElement;
    const firstMath = elementOf(selected.startContainer)?.closest('[data-math-source]');
    const lastMath = elementOf(selected.endContainer)?.closest('[data-math-source]');
    if (firstMath && prose.contains(firstMath)) selected.setStartBefore(firstMath);
    if (lastMath && prose.contains(lastMath)) selected.setEndAfter(lastMath);
    const fragment = selected.cloneContents();
    for (const formula of fragment.querySelectorAll('[data-math-source]')) {
      formula.replaceWith(document.createTextNode(formula.dataset.mathSource));
    }
    const read = node => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeName === 'BR') return '\n';
      const text = [...node.childNodes].map(read).join('');
      return /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(node.nodeName) ? text + '\n' : text;
    };
    return read(fragment);
  }

  function refreshSelection() {
    selectionFrame = 0;
    if (saving || activeDialog) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return removeBubble();

    if (!prose.contains(selection.anchorNode) || !prose.contains(selection.focusNode)) return removeBubble();
    const text = selectedMarkdown(selection).trim();
    if (!text || text.length > 2000) return removeBubble();

    showBubble(text, selection.getRangeAt(0));
  }

  if (!prose) return;
  window.addEventListener('resize', positionBubble);
  window.addEventListener('scroll', positionBubble, { capture: true, passive: true });
  if (window.ResizeObserver) new window.ResizeObserver(positionBubble).observe(prose);
  document.addEventListener('selectionchange', () => {
    if (selectionFrame || saving || activeDialog) return;
    selectionFrame = scheduleFrame(refreshSelection);
  });

  document.addEventListener('mousedown', event => {
    if (bubble && !bubble.contains(event.target)) removeBubble();
  });
})();
