(() => {
  const ui = window.workstationUI;
  const textarea = document.querySelector('[data-editor-form] textarea[name="body"]');
  if (!ui || !textarea) return;

  const dropZone = textarea.closest('[data-editor-form]') || textarea;

  function isImage(file) {
    return String(file.type || '').startsWith('image/');
  }

  /** 图片用 `![]()` 嵌入，其它文件用普通链接 —— PDF 不该被塞进 img 标签。 */
  function markdownFor(file, result) {
    const label = String(file.name || '附件').replace(/[[\]]/g, '');
    return isImage(file) ? `![${label}](${result.url})` : `[${label}](${result.url})`;
  }

  function uploadPlaceholder(file) {
    const id = window.crypto?.randomUUID?.() || `upload-${Date.now()}-${Math.random()}`;
    const visible = `![上传中 ${file.name}…]()`;
    // 注释是内部身份的一部分；替换时必须完整匹配，不能拿文件名猜位置。
    return `${visible}<!-- workstation-attachment-upload:${id} -->`;
  }

  function dispatchInput() {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * 在光标处插入文本。
   *
   * 用 execCommand('insertText') 而不是直接改 value：直接赋值会清掉浏览器的
   * 撤销栈，用户一个 Ctrl+Z 就把整篇正文退没了。execCommand 虽然被标记为
   * 废弃，但它是目前唯一能保住撤销历史的写法，各家浏览器也都还支持。
   */
  function insertAtCursor(text) {
    textarea.focus();
    if (!document.execCommand?.('insertText', false, text)) {
      const { selectionStart: start, selectionEnd: end, value } = textarea;
      textarea.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
    }
    dispatchInput();
  }

  function adjustedSelection(point, start, end, replacementLength) {
    if (point <= start) return point;
    if (point >= end) return point + replacementLength - (end - start);
    return start + replacementLength;
  }

  /** Replace precisely one intact internal placeholder, retaining the user's selection. */
  function replacePlaceholder(placeholder, replacement) {
    const value = textarea.value;
    const start = value.indexOf(placeholder);
    if (start < 0) return false;
    const end = start + placeholder.length;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;

    textarea.selectionStart = start;
    textarea.selectionEnd = end;
    textarea.focus();
    if (!document.execCommand?.('insertText', false, replacement)) {
      textarea.value = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
    }

    const changed = textarea.value !== value;
    if (!changed) return false;
    textarea.selectionStart = adjustedSelection(selectionStart, start, end, replacement.length);
    textarea.selectionEnd = adjustedSelection(selectionEnd, start, end, replacement.length);
    dispatchInput();
    return true;
  }

  async function uploadOne(file) {
    // 先插一个占位。大文件传起来要几秒，光标位置在这期间可能已经移走了，
    // 等传完再插会插到错的地方；占位符还能让用户看见「正在传」。
    let placeholder = '';

    try {
      placeholder = uploadPlaceholder(file);
      insertAtCursor(placeholder);
      const result = await ui.requestJson(
        `/attachments?name=${encodeURIComponent(file.name || 'file')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
          fallbackMessage: '附件上传失败。'
        }
      );

      const inserted = replacePlaceholder(placeholder, markdownFor(file, result));
      if (!inserted) ui.notify(`${file.name} 上传完成，但占位内容已被修改或删除，未插入附件链接。`, { type: 'error' });

      if (result.warning) {
        // 本地已经写好了，只是没推上去。这不是失败，但用户该知道 ——
        // 否则换台机器打开会发现图裂了却不知道为什么。
        ui.notify(`${file.name} 已存到本机，但未能上传到存储服务：${result.warning}`, { type: 'error' });
      }
      return inserted;
    } catch (error) {
      const removed = placeholder ? replacePlaceholder(placeholder, '') : true;
      if (!removed) ui.notify(`${file.name} 上传失败，且占位内容已被修改或删除，未改动正文。`, { type: 'error' });
      ui.notify(error.message, { type: 'error' });
      return false;
    }
  }

  async function uploadAll(files) {
    const list = [...files].filter(Boolean);
    if (list.length === 0) return;
    const finish = ui.beginEditorWork();
    // 串行上传：并发几个大文件会互相抢上行带宽，谁都传不完，
    // 而且占位符的替换也会互相打架。同一 paste/drop 批次共用一个 pending token，
    // 避免相邻文件之间短暂归零，让保存误把 marker 写入磁盘。
    let done = 0;
    try {
      for (const file of list) {
        if (await uploadOne(file)) done += 1;
      }
      if (done > 0) ui.notify(`已插入 ${done} 个附件。`);
    } finally {
      finish();
    }
  }

  textarea.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length === 0) return;
    // 剪贴板里同时有文件和文本时（截图工具常见），优先当附件处理。
    event.preventDefault();
    uploadAll(files);
  });

  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, event => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      dropZone.classList.add('is-dropping');
    });
  }

  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, () => dropZone.classList.remove('is-dropping'));
  }

  dropZone.addEventListener('drop', event => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length === 0) return;
    event.preventDefault();
    uploadAll(files);
  });
})();
