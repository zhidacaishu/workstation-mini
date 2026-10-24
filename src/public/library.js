(() => {
  const { requestJson, notify } = window.workstationUI;
  const dialog = document.querySelector('[data-annotation-dialog]');
  const form = dialog?.querySelector('[data-annotation-form]');
  const pdfDialog = document.querySelector('[data-pdf-dialog]');
  const pdfSubmit = pdfDialog?.querySelector('[data-pdf-dialog-submit]');
  const pdfStatus = pdfDialog?.querySelector('[data-pdf-dialog-status]');
  const pollingDocuments = new Set();
  let activeButton = null;
  let activeRow = null;
  let activePdfButton = null;
  let pdfSubmitting = false;
  let saving = false;

  function noteUrl(notePath) {
    return `/note/${String(notePath).split('/').map(encodeURIComponent).join('/')}`;
  }

  function setButtonBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.setAttribute('aria-busy', 'true');
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.removeAttribute('aria-busy');
    }
    button.disabled = busy;
  }

  const pdfStateLabels = {
    unparsed: '尚未解析',
    queued: '等待解析',
    preparing: '准备文件',
    uploading: '正在上传',
    submitted: '已提交',
    pending: '等待 MinerU',
    running: 'MinerU 解析中',
    downloading: '下载结果',
    indexing: '建立索引',
    ready: '可以检索',
    failed: '解析失败'
  };
  const activePdfStates = new Set([
    'queued', 'preparing', 'uploading', 'submitted', 'pending', 'running',
    'downloading', 'indexing'
  ]);

  function pdfRow(documentId) {
    if (!/^[a-f0-9]{32}$/.test(String(documentId || ''))) return null;
    return document.querySelector(`[data-pdf-row][data-document-id="${documentId}"]`);
  }

  function updatePdfRow(status) {
    const row = pdfRow(status.documentId);
    if (!row) return;
    const state = pdfStateLabels[status.state] ? status.state : 'unparsed';
    row.dataset.pdfState = state;
    const stateNode = row.querySelector('[data-pdf-status]');
    if (stateNode) {
      stateNode.textContent = pdfStateLabels[state];
      stateNode.className = `chip pdf-state pdf-state-${state}`;
    }
    const progress = row.querySelector('[data-pdf-progress]');
    if (progress) {
      const total = Number(status.progress?.totalPages) || 0;
      const extracted = Math.min(Number(status.progress?.extractedPages) || 0, total);
      progress.textContent = total > 0 ? `${extracted} / ${total} 页` : '';
      progress.hidden = total < 1;
    }
    const message = row.querySelector('[data-pdf-message]');
    if (message) {
      message.textContent = status.error || '';
      message.hidden = !status.error;
    }
    const button = row.querySelector('[data-parse-pdf]');
    if (button && activePdfStates.has(state)) setButtonBusy(button, true, '解析中…');
  }

  function showPdfPollingError(documentId, message) {
    const node = pdfRow(documentId)?.querySelector('[data-pdf-message]');
    if (!node) return;
    node.textContent = `暂时无法读取解析状态：${message}`;
    node.hidden = false;
  }

  function pollPdf(documentId) {
    if (pollingDocuments.has(documentId)) return;
    pollingDocuments.add(documentId);

    const check = async () => {
      try {
        const status = await requestJson(`/library/pdfs/${documentId}/status`, {
          fallbackMessage: '读取 PDF 解析状态失败'
        });
        updatePdfRow(status);
        if (activePdfStates.has(status.state)) {
          window.setTimeout(check, 1500);
          return;
        }
        pollingDocuments.delete(documentId);
        notify(status.state === 'ready' ? 'PDF 解析和索引已完成。' : (status.error || 'PDF 解析失败。'), {
          type: status.state === 'ready' ? 'success' : 'error'
        });
        window.location.reload();
      } catch (error) {
        pollingDocuments.delete(documentId);
        showPdfPollingError(documentId, error.message);
      }
    };

    check();
  }

  function openPdfConfirmation(button) {
    if (!pdfDialog || !pdfSubmit) return;
    activePdfButton = button;
    pdfDialog.querySelector('[data-pdf-dialog-file]').textContent = button.dataset.fileName || 'PDF 附件';
    pdfDialog.querySelector('[data-pdf-dialog-title-text]').textContent = button.dataset.literatureTitle || '';
    pdfStatus.textContent = '只有点击“确认上传并解析”才会开始。';
    pdfStatus.classList.remove('is-error');
    pdfDialog.showModal();
    pdfSubmit.focus();
  }

  function closePdfConfirmation() {
    if (pdfSubmitting || !pdfDialog?.open) return;
    pdfDialog.close();
  }

  function setOutputEnabled(name, enabled) {
    const fields = form?.querySelector(`[data-output-fields="${name}"]`);
    if (!fields) return;
    fields.hidden = !enabled;
    for (const control of fields.querySelectorAll('input, textarea, select')) control.disabled = !enabled;
  }

  function selectedOutputs() {
    const outputs = {};
    if (form.querySelector('[data-output-toggle="note"]').checked) {
      outputs.note = {
        title: form.elements.noteTitle.value.trim(),
        body: form.elements.noteBody.value.trim()
      };
    }
    if (form.querySelector('[data-output-toggle="card"]').checked) {
      outputs.card = {
        deckFile: form.elements.cardDeck.value.trim(),
        front: form.elements.cardFront.value.trim(),
        back: form.elements.cardBack.value.trim()
      };
    }
    if (form.querySelector('[data-output-toggle="task"]').checked) {
      outputs.task = { title: form.elements.taskTitle.value.trim() };
    }
    return outputs;
  }

  function updateSubmitLabel() {
    if (!form) return;
    const count = form.querySelectorAll('[data-output-toggle]:checked').length;
    form.querySelector('[data-dialog-submit]').textContent = count ? '生成所选内容并完成' : '仅标记已处理';
  }

  function openProcessing(button) {
    if (!dialog || !form) return;
    activeButton = button;
    activeRow = button.closest('[data-annotation-row]');
    form.reset();
    for (const name of ['note', 'card', 'task']) setOutputEnabled(name, false);

    const text = button.dataset.text || '';
    const comment = button.dataset.comment || '';
    dialog.dataset.annotationId = button.dataset.annotationId;
    dialog.dataset.notePath = button.dataset.notePath;
    dialog.dataset.noteHash = button.dataset.noteHash;
    form.querySelector('[data-annotation-source]').textContent = text;
    const commentNode = form.querySelector('[data-annotation-comment]');
    commentNode.textContent = comment;
    commentNode.hidden = !comment;
    form.elements.noteTitle.value = comment || text;
    form.elements.noteBody.value = comment || text;
    form.elements.cardDeck.value = 'inbox';
    form.elements.cardFront.value = text;
    form.elements.cardBack.value = comment || text;
    form.elements.taskTitle.value = comment || text;
    const status = form.querySelector('[data-annotation-status]');
    status.textContent = '未选择输出时，仅将标注记为已处理。';
    status.classList.remove('is-error');
    updateSubmitLabel();
    dialog.showModal();
    form.querySelector('[data-output-toggle="note"]').focus();
  }

  function closeProcessing() {
    if (saving || !dialog?.open) return;
    dialog.close();
  }

  function finishProcessing(result) {
    const item = activeRow?.closest('[data-literature-item]');
    activeRow?.remove();
    const remaining = item?.querySelectorAll('[data-annotation-row]').length || 0;
    const count = item?.querySelector('[data-pending-count]');
    if (count) {
      count.textContent = `${remaining} 条待加工`;
      count.classList.toggle('due-today', remaining > 0);
    }
    if (result.hash && item) {
      item.dataset.noteHash = result.hash;
      for (const button of item.querySelectorAll('[data-process-annotation]')) button.dataset.noteHash = result.hash;
    }
    dialog.close();
    notify(result.outputs.length ? '标注已加工，所选内容均已生成。' : '标注已记为处理完成。');
  }

  if (form) {
    for (const toggle of form.querySelectorAll('[data-output-toggle]')) {
      setOutputEnabled(toggle.dataset.outputToggle, false);
      toggle.addEventListener('change', () => {
        setOutputEnabled(toggle.dataset.outputToggle, toggle.checked);
        updateSubmitLabel();
      });
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      saving = true;
      const submit = form.querySelector('[data-dialog-submit]');
      const status = form.querySelector('[data-annotation-status]');
      setButtonBusy(submit, true, '正在保存…');
      for (const control of form.querySelectorAll('input, textarea, select, button')) {
        if (control !== submit) control.disabled = true;
      }
      dialog.setAttribute('aria-busy', 'true');
      status.classList.remove('is-error');
      status.textContent = '正在确认输出并更新文献笔记…';

      try {
        const result = await requestJson('/library/annotations/process', {
          method: 'POST',
          json: {
            notePath: dialog.dataset.notePath,
            annotationId: dialog.dataset.annotationId,
            expectedHash: dialog.dataset.noteHash,
            outputs: selectedOutputs()
          },
          fallbackMessage: '加工标注失败'
        });
        finishProcessing(result);
      } catch (error) {
        const completed = error.payload?.completedOutputs || [];
        const prefix = completed.length
          ? `已生成${completed.map(name => ({ note: '永久笔记', card: '复习卡', task: '待办' }[name] || name)).join('、')}；这些内容会在重试时复用。`
          : '';
        status.textContent = error.status === 409
          ? `${prefix}文献笔记已经变化，请刷新页面后重试。`
          : `${prefix}${error.message}`;
        status.classList.add('is-error');
        notify(status.textContent, { type: 'error' });
      } finally {
        saving = false;
        setButtonBusy(submit, false);
        for (const toggle of form.querySelectorAll('[data-output-toggle]')) {
          toggle.disabled = false;
          setOutputEnabled(toggle.dataset.outputToggle, toggle.checked);
        }
        form.querySelector('[data-dialog-close]').disabled = false;
        form.querySelector('[data-dialog-cancel]').disabled = false;
        dialog.removeAttribute('aria-busy');
      }
    });

    form.querySelector('[data-dialog-close]').addEventListener('click', closeProcessing);
    form.querySelector('[data-dialog-cancel]').addEventListener('click', closeProcessing);
    dialog.addEventListener('cancel', event => {
      if (saving) event.preventDefault();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeProcessing();
    });
    dialog.addEventListener('close', () => {
      const target = activeButton?.isConnected ? activeButton : document.getElementById('main-content');
      activeButton = null;
      activeRow = null;
      target?.focus();
    });
  }

  if (pdfDialog && pdfSubmit) {
    pdfSubmit.addEventListener('click', async () => {
      if (pdfSubmitting || !activePdfButton) return;
      pdfSubmitting = true;
      const button = activePdfButton;
      setButtonBusy(pdfSubmit, true, '正在排队…');
      pdfDialog.querySelector('[data-pdf-dialog-close]').disabled = true;
      pdfDialog.querySelector('[data-pdf-dialog-cancel]').disabled = true;
      pdfDialog.setAttribute('aria-busy', 'true');
      pdfStatus.classList.remove('is-error');
      pdfStatus.textContent = '正在验证本机附件并加入单任务队列…';

      try {
        const status = await requestJson('/library/pdfs/parse', {
          method: 'POST',
          json: {
            libraryId: button.dataset.libraryId,
            attachmentKey: button.dataset.attachmentKey
          },
          fallbackMessage: 'PDF 解析排队失败'
        });
        updatePdfRow(status);
        setButtonBusy(button, true, '解析中…');
        pdfDialog.close();
        notify('PDF 已加入解析队列。');
        pollPdf(status.documentId);
      } catch (error) {
        pdfStatus.textContent = error.message;
        pdfStatus.classList.add('is-error');
        notify(error.message, { type: 'error' });
      } finally {
        pdfSubmitting = false;
        setButtonBusy(pdfSubmit, false);
        pdfDialog.querySelector('[data-pdf-dialog-close]').disabled = false;
        pdfDialog.querySelector('[data-pdf-dialog-cancel]').disabled = false;
        pdfDialog.removeAttribute('aria-busy');
      }
    });

    pdfDialog.querySelector('[data-pdf-dialog-close]').addEventListener('click', closePdfConfirmation);
    pdfDialog.querySelector('[data-pdf-dialog-cancel]').addEventListener('click', closePdfConfirmation);
    pdfDialog.addEventListener('cancel', event => {
      if (pdfSubmitting) event.preventDefault();
    });
    pdfDialog.addEventListener('click', event => {
      if (event.target === pdfDialog) closePdfConfirmation();
    });
    pdfDialog.addEventListener('close', () => {
      const target = activePdfButton?.isConnected ? activePdfButton : document.getElementById('main-content');
      activePdfButton = null;
      target?.focus();
    });
  }

  for (const row of document.querySelectorAll?.('[data-pdf-row]') || []) {
    if (activePdfStates.has(row.dataset.pdfState)) pollPdf(row.dataset.documentId);
  }

  document.addEventListener('click', async event => {
    const pdfButton = event.target.closest('[data-parse-pdf]');
    if (pdfButton) {
      openPdfConfirmation(pdfButton);
      return;
    }

    const processButton = event.target.closest('[data-process-annotation]');
    if (processButton) {
      openProcessing(processButton);
      return;
    }

    const makeButton = event.target.closest('[data-make-lit]');
    if (makeButton) {
      setButtonBusy(makeButton, true, '正在建立…');
      try {
        const result = await requestJson('/library/lit', {
          method: 'POST',
          json: { key: makeButton.dataset.makeLit },
          fallbackMessage: '建笔记失败'
        });
        window.location.href = noteUrl(result.path);
      } catch (error) {
        setButtonBusy(makeButton, false);
        notify(error.message, { type: 'error' });
      }
      return;
    }

    const syncButton = event.target.closest('[data-sync-lit]');
    if (!syncButton) return;
    const item = syncButton.closest('[data-literature-item]');
    setButtonBusy(syncButton, true, '正在同步…');
    try {
      const result = await requestJson('/library/lit/sync', {
        method: 'POST',
        json: { key: syncButton.dataset.syncLit, expectedHash: item.dataset.noteHash },
        fallbackMessage: '同步标注失败'
      });
      const summary = result.migrated ? '旧标注区已迁移。' : '';
      notify(`${summary}新增 ${result.added} 条，当前 ${result.pending} 条待加工。`);
      window.location.reload();
    } catch (error) {
      setButtonBusy(syncButton, false);
      const message = error.status === 409 ? '文献笔记已经变化，请刷新页面后再同步。' : error.message;
      notify(message, { type: 'error' });
    }
  });
})();
