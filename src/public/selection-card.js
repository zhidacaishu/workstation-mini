(() => {
  const prose = document.querySelector('.prose');
  if (!prose) return;

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
    if (!response.ok) throw new Error(payload.message || '保存失败');
    return payload;
  });

  let bubble = null;
  let bubbleText = '';
  let activeDialog = null;
  let restoreFocus = null;
  let saving = false;
  let selectionFrame = 0;
  const scheduleFrame = window.requestAnimationFrame || (callback => callback());

  function removeBubble() {
    bubble?.remove();
    bubble = null;
    bubbleText = '';
  }

  function cleanupDialog(dialog) {
    if (activeDialog !== dialog) return;
    dialog.remove();
    activeDialog = null;
    const target = restoreFocus && restoreFocus !== document.body && restoreFocus.isConnected !== false
      ? restoreFocus
      : document.getElementById('main-content') || prose;
    restoreFocus = null;
    target?.focus?.();
  }

  function closeForm() {
    const dialog = activeDialog;
    if (!dialog || saving) return;
    if (dialog.open) dialog.close();
    cleanupDialog(dialog);
  }

  function showBubble(text, rect) {
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

    const top = window.scrollY + rect.top - bubble.offsetHeight - 8;
    const maxLeft = window.scrollX + window.innerWidth - bubble.offsetWidth - 8;
    bubble.style.top = `${top < window.scrollY + 60 ? window.scrollY + rect.bottom + 8 : top}px`;
    bubble.style.left = `${Math.max(8, Math.min(maxLeft, window.scrollX + rect.left))}px`;
  }

  function openForm(selected) {
    if (saving || activeDialog) return;
    const focusedBeforeOpen = document.activeElement;
    removeBubble();
    restoreFocus = focusedBeforeOpen;

    const dialog = document.createElement('dialog');
    dialog.className = 'selection-form';
    dialog.setAttribute('aria-labelledby', 'selection-form-title');
    dialog.innerHTML = `
      <form class="selection-form-inner" data-card-form>
        <h2 id="selection-form-title">新建卡片</h2>
        <label>正面<input type="text" name="front" value=""></label>
        <label>背面<textarea name="back" rows="3"></textarea></label>
        <label>存到 cards/<input type="text" name="deckFile" value="inbox"></label>
        <p class="muted">背面可以留空，之后再补。写 <code>{{挖空}}</code> 会变成挖空卡。</p>
        <div class="actions">
          <button class="button primary" type="submit" data-save>保存</button>
          <button class="button" type="button" data-cancel>取消</button>
        </div>
        <p class="selection-status" role="status" aria-live="polite" hidden></p>
      </form>
    `;
    document.body.append(dialog);
    activeDialog = dialog;

    const form = dialog.querySelector('[data-card-form]');
    const front = form.querySelector('[name=front]');
    const saveButton = form.querySelector('[data-save]');
    const status = form.querySelector('.selection-status');

    const showStatus = (message, isError = false) => {
      status.hidden = false;
      status.textContent = message;
      status.classList.toggle('is-error', isError);
    };

    dialog.addEventListener('close', () => cleanupDialog(dialog), { once: true });
    dialog.addEventListener('cancel', event => {
      if (saving) event.preventDefault();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeForm();
    });
    form.querySelector('[data-cancel]').addEventListener('click', closeForm);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;

      const payload = {
        front: front.value.trim(),
        back: form.querySelector('[name=back]').value.trim(),
        deckFile: form.querySelector('[name=deckFile]').value.trim() || 'inbox',
        source: notePath
      };
      if (!payload.front) {
        showStatus('正面不能为空。', true);
        front.focus();
        return;
      }

      saving = true;
      const controls = [...form.querySelectorAll('input, textarea, button')];
      const disabledBefore = controls.map(control => control.disabled);
      for (const control of controls) control.disabled = true;
      dialog.setAttribute('aria-busy', 'true');
      saveButton.setAttribute('aria-busy', 'true');
      showStatus('正在保存…');
      try {
        const result = await requestJson('/cards/add', {
          method: 'POST',
          json: payload,
          fallbackMessage: '保存失败'
        });
        notify(`已存到 ${result.path}`);
        saving = false;
        if (activeDialog === dialog) closeForm();
      } catch (error) {
        showStatus(`保存失败：${error.message}`, true);
      } finally {
        saving = false;
        controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
        dialog.removeAttribute('aria-busy');
        saveButton.removeAttribute('aria-busy');
      }
    });

    dialog.showModal();
    front.value = selected;
    front.focus();
    front.select();
  }

  function refreshSelection() {
    selectionFrame = 0;
    if (saving || activeDialog) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return removeBubble();

    const text = selection.toString().trim();
    if (!text || text.length > 200) return removeBubble();
    if (!prose.contains(selection.anchorNode) || !prose.contains(selection.focusNode)) return removeBubble();

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return removeBubble();
    showBubble(text, rect);
  }

  document.addEventListener('selectionchange', () => {
    if (selectionFrame || saving || activeDialog) return;
    selectionFrame = scheduleFrame(refreshSelection);
  });

  document.addEventListener('mousedown', event => {
    if (bubble && !bubble.contains(event.target)) removeBubble();
  });
})();
