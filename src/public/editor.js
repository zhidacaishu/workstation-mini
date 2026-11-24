// 写作区的辅助：续列表与缩进、[[ 双链补全、粘贴图片、分栏实时预览。
//
// 写作区仍然是一个普通的 textarea：没有引入编辑器库，文字怎么存就怎么显示。
// 这里所有改动都走 execCommand('insertText')，浏览器自己的撤销栈因此保持完整，
// 也会照常触发 input 事件 —— 「有未保存的更改」和草稿自动保存都靠它。

(() => {
  const areas = [...document.querySelectorAll('textarea[data-md-editor]')];
  if (!areas.length) return;

  const notify = (message, options) => window.workstationUI?.notify?.(message, options);

  /** 把 [start, end) 换成 text，并把光标放到指定位置。 */
  function replaceRange(area, start, end, text, caret = start + text.length, caretEnd = caret) {
    area.focus();
    area.setSelectionRange(start, end);
    let done = false;
    try {
      done = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
    } catch { /* 下面走兜底。 */ }
    if (!done) {
      area.setRangeText(text, start, end, 'end');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
    area.setSelectionRange(caret, caretEnd);
  }

  const lineStartOf = (value, position) => value.lastIndexOf('\n', position - 1) + 1;
  const lineEndOf = (value, position) => {
    const index = value.indexOf('\n', position);
    return index === -1 ? value.length : index;
  };

  // ---------- 续列表与缩进 ----------

  const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/;
  const INDENT = '  ';

  function continueList(area, event) {
    const { selectionStart: start, selectionEnd: end, value } = area;
    if (start !== end) return false;
    const lineStart = lineStartOf(value, start);
    const line = value.slice(lineStart, lineEndOf(value, start));
    const quote = /^([ \t]*(?:>[ \t]?)+)/.exec(line);
    if (quote && start - lineStart >= quote[0].length) {
      event.preventDefault();
      if (!line.slice(quote[0].length).trim()) replaceRange(area, lineStart, lineStart + line.length, '');
      else replaceRange(area, start, end, '\n' + quote[0]);
      return true;
    }
    const match = LIST_ITEM.exec(line);
    // 光标在标记里面（还没到正文）时按普通回车处理。
    if (!match || start - lineStart < match[0].length) return false;
    event.preventDefault();
    if (!line.slice(match[0].length).trim()) {
      // 空的列表项上再按回车：结束列表，把这一行的标记去掉。
      replaceRange(area, lineStart, lineStart + line.length, '');
      return true;
    }
    const [, indent, bullet, number, delimiter, gap, checkbox] = match;
    const marker = bullet || `${Number(number) + 1}${delimiter}`;
    replaceRange(area, start, end, `\n${indent}${marker}${gap}${checkbox ? '[ ] ' : ''}`);
    return true;
  }

  function indentSelection(area, event, outdent) {
    const { selectionStart: start, selectionEnd: end, value } = area;
    const lineStart = lineStartOf(value, start);
    const multiline = value.slice(start, end).includes('\n');
    const inList = LIST_ITEM.test(value.slice(lineStart, lineEndOf(value, start)));
    if (!multiline && !inList && !outdent) {
      event.preventDefault();
      replaceRange(area, start, end, INDENT);
      return;
    }
    event.preventDefault();
    const blockEnd = lineEndOf(value, multiline && value[end - 1] === '\n' ? end - 1 : end);
    const lines = value.slice(lineStart, blockEnd).split('\n');
    let firstDelta = 0;
    let totalDelta = 0;
    const next = lines.map((line, index) => {
      let changed = line;
      if (outdent) changed = line.replace(/^(?: {1,2}|\t)/, '');
      else if (line.trim() || lines.length === 1) changed = INDENT + line;
      const delta = changed.length - line.length;
      if (index === 0) firstDelta = delta;
      totalDelta += delta;
      return changed;
    }).join('\n');
    if (totalDelta === 0) return;
    const caret = Math.max(lineStart, start + firstDelta);
    replaceRange(area, lineStart, blockEnd, next, caret, Math.max(caret, end + totalDelta));
  }

  // ---------- [[ 双链补全 ----------

  let popup = null;
  let suggest = null; // { area, from, query, items, active, token }

  function closeSuggest() {
    if (popup) popup.hidden = true;
    if (suggest) suggest.area.removeAttribute('aria-activedescendant');
    suggest = null;
  }

  /** 光标在 textarea 里的像素位置：用一个同样排版的镜像元素量出来。 */
  function caretPoint(area, position) {
    const mirror = document.createElement('div');
    const style = getComputedStyle(area);
    for (const property of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize',
      'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize', 'textIndent', 'textTransform', 'wordSpacing']) {
      mirror.style[property] = style[property];
    }
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden', height: 'auto' });
    mirror.textContent = area.value.slice(0, position);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.append(marker);
    document.body.append(mirror);
    const box = area.getBoundingClientRect();
    const point = {
      left: box.left + marker.offsetLeft - area.scrollLeft,
      top: box.top + marker.offsetTop - area.scrollTop,
      height: marker.offsetHeight || parseFloat(style.lineHeight) || 20
    };
    mirror.remove();
    return point;
  }

  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement('ul');
    popup.className = 'link-suggest';
    popup.id = 'link-suggest';
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', '笔记补全');
    popup.hidden = true;
    // 按下时不让 textarea 失焦，点完还能接着写。
    popup.addEventListener('mousedown', event => {
      event.preventDefault();
      const item = event.target.closest('[data-index]');
      if (item && suggest) acceptSuggest(Number(item.dataset.index));
    });
    document.body.append(popup);
    return popup;
  }

  function renderSuggest() {
    const list = ensurePopup();
    const wasHidden = list.hidden;
    list.textContent = '';
    if (!suggest) return;
    if (!suggest.items.length) {
      const empty = document.createElement('li');
      empty.className = 'link-suggest-empty';
      empty.textContent = suggest.query ? '没有匹配的笔记，继续写会留下一个待建的双链' : '还没有笔记';
      list.append(empty);
    }
    suggest.items.forEach((item, index) => {
      const row = document.createElement('li');
      row.id = `link-suggest-${index}`;
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === suggest.active ? 'true' : 'false');
      const title = document.createElement('span');
      title.className = 'link-suggest-title';
      title.textContent = item.title;
      const path = document.createElement('span');
      path.className = 'link-suggest-path';
      path.textContent = item.path.replace(/\.md$/i, '');
      row.append(title, path);
      list.append(row);
    });
    const point = caretPoint(suggest.area, suggest.from);
    list.hidden = false;
    const width = list.offsetWidth;
    const height = list.offsetHeight;
    const left = Math.max(8, Math.min(point.left, window.innerWidth - width - 8));
    const below = point.top + point.height + 6;
    const above = below + height > window.innerHeight - 8;
    const top = above ? Math.max(8, point.top - height - 6) : below;
    list.dataset.placement = above ? 'above' : 'below';
    list.style.left = `${left}px`;
    list.style.top = `${top}px`;
    if (wasHidden) {
      window.workstationMotion?.enter?.(list, { y: above ? 5 : -5, scale: 0.98, duration: 150 });
    }
    if (suggest.items.length) suggest.area.setAttribute('aria-activedescendant', `link-suggest-${suggest.active}`);
  }

  function acceptSuggest(index) {
    if (!suggest || !suggest.items[index]) return;
    const { area, from } = suggest;
    const end = area.selectionStart;
    // 后面已经有 ]] 就不重复补。
    const closing = area.value.slice(end, end + 2) === ']]' ? '' : ']]';
    const text = `${suggest.items[index].target}${closing}`;
    closeSuggest();
    replaceRange(area, from, end, text, from + text.length + (closing ? 0 : 2));
  }

  async function updateSuggest(area) {
    const position = area.selectionStart;
    if (position !== area.selectionEnd) { closeSuggest(); return; }
    const before = area.value.slice(Math.max(0, position - 120), position);
    const open = before.lastIndexOf('[[');
    const typed = open === -1 ? null : before.slice(open + 2);
    // 只在「[[ 之后、还没写 ]]、没有换行、还没写别名」时补全。
    if (typed === null || /[\]\n|#]/.test(typed)) { closeSuggest(); return; }
    const from = position - typed.length;
    const token = {};
    suggest = { area, from, query: typed, items: suggest?.items || [], active: 0, token };
    try {
      const response = await fetch(`/api/link-suggest?q=${encodeURIComponent(typed)}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      // 请求回来时已经继续打了字或关掉了：这一次的结果作废。
      if (!suggest || suggest.token !== token) return;
      suggest.items = Array.isArray(payload.results) ? payload.results : [];
      renderSuggest();
    } catch {
      if (suggest?.token === token) closeSuggest();
    }
  }

  /**
   * 补全框还对得上光标吗：没有选中文字、光标仍在 [[ 之后，中间也还是一段能补全的文字。
   * 对得上时返回 [[ 到光标之间的文字，否则返回 null。
   */
  function suggestQueryAt(area) {
    if (!suggest || suggest.area !== area) return null;
    const position = area.selectionStart;
    if (position !== area.selectionEnd || position < suggest.from) return null;
    if (area.value.slice(suggest.from - 2, suggest.from) !== '[[') return null;
    const typed = area.value.slice(suggest.from, position);
    return /[\]\n|#]/.test(typed) ? null : typed;
  }

  function suggestKey(event) {
    if (!suggest || popup?.hidden) return false;
    // 补全框弹出后用方向键、Home、End 挪过光标：这一次的补全已经不对了，
    // 回车、Tab 照常起作用，不能把 [[ 到新光标之间的文字整段替换掉。
    if (suggestQueryAt(suggest.area) !== suggest.query) { closeSuggest(); return false; }
    const count = suggest.items.length;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSuggest(); return true; }
    if (!count) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      suggest.active = (suggest.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      renderSuggest();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      acceptSuggest(suggest.active);
      return true;
    }
    return false;
  }

  // ---------- 粘贴、拖入图片 ----------

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

  const areaUploads = new WeakMap();
  let uploadSequence = 0;
  let insertingUpload = null;
  let pendingUploads = 0;
  // 表单捕获阶段拦截，先于笔记/卡片各自的保存逻辑，避免保存临时占位链接。
  document.addEventListener('submit', event => {
    if (!pendingUploads) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    notify('图片正在保存，请完成后再保存。', { type: 'info' });
  }, true);
  window.addEventListener('beforeunload', event => {
    if (!pendingUploads) return;
    if (window.workstationDialog?.mayLeave(event)) return;
    event.preventDefault();
    event.returnValue = '';
  });

  async function uploadImages(area, files) {
    pendingUploads += 1;
    areaUploads.set(area, (areaUploads.get(area) || 0) + 1);
    area.setAttribute('aria-busy', 'true');
    try {
      await performUpload(area, files);
    } finally {
      pendingUploads -= 1;
      const remaining = areaUploads.get(area) - 1;
      areaUploads.set(area, remaining);
      if (!remaining) area.removeAttribute('aria-busy');
    }
  }

  async function performUpload(area, files) {
    const order = ++uploadSequence;
    let from = area.selectionStart, to = area.selectionEnd;
    let previous = area.value;
    let cancelled = false;
    let beforeInput = null;
    const rememberSelection = () => {
      beforeInput = { start: area.selectionStart, end: area.selectionEnd };
    };
    // 临时位置只在内存里。根据 input 后的光标和前后缀定位实际改动；
    // 若用户已经改写选区，保留其编辑。上传失败时正文和草稿天然完整。
    function trackEdit() {
      const value = area.value;
      const delta = value.length - previous.length;
      const selection = insertingUpload || beforeInput;
      beforeInput = null;
      let start, oldEnd;
      // 先用编辑前的真实选区，避免把“将 ABC 替换为 ABCDEF”误判成末尾输入。
      if (selection && value.startsWith(previous.slice(0, selection.start))
          && value.endsWith(previous.slice(selection.end)) && selection.end + delta >= selection.start) {
        start = selection.start;
        oldEnd = selection.end;
      } else {
        // 删除键、撤销、部分程序化编辑会修改选区之外的字符。
        let newEnd = value.length;
        oldEnd = previous.length;
        while (oldEnd && newEnd > area.selectionEnd && previous[oldEnd - 1] === value[newEnd - 1]) {
          oldEnd--; newEnd--;
        }
        start = 0;
        while (start < oldEnd && start < newEnd && previous[start] === value[start]) start++;
      }
      const insertBefore = insertingUpload && insertingUpload.order < order;
      if (insertingUpload && start === from && oldEnd === to) {
        from = to = insertBefore ? oldEnd + delta : start;
      } else if (oldEnd < from || (oldEnd === from && (start < from || from < to || insertBefore))) {
        from += delta;
        to += delta;
      } else if (start < to && oldEnd > from) {
        cancelled = true;
      }
      previous = value;
    }
    area.addEventListener('beforeinput', rememberSelection);
    area.addEventListener('input', trackEdit);
    notify('正在保存图片…', { type: 'info' });
    const links = [];
    try {
      for (const file of files) {
        try {
          const response = await fetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' }, body: file });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.markdown) throw new Error(payload.message || '图片保存失败（' + response.status + '）');
          links.push(payload.markdown);
        } catch (error) { notify(error.message, { type: 'error' }); }
      }
    } finally {
      area.removeEventListener('beforeinput', rememberSelection);
      area.removeEventListener('input', trackEdit);
    }
    if (!links.length) return;
    if (cancelled || previous !== area.value) {
      notify('原插入位置已修改。图片已保存在附件目录。', { type: 'info' });
      return;
    }
    const text = links.join('\n');
    const start = area.selectionStart, end = area.selectionEnd;
    const focused = document.activeElement;
    const adjust = position => position < from ? position
      : position >= to ? position + text.length - (to - from) : from + text.length;
    insertingUpload = { order, start: from, end: to };
    try {
      replaceRange(area, from, to, text, adjust(start), adjust(end));
    } finally {
      insertingUpload = null;
      if (focused && focused !== area) focused.focus({ preventScroll: true });
    }
  }

  const imageFiles = list => [...(list || [])].filter(file => IMAGE_TYPES.has(file.type));

  // ---------- 分栏实时预览 ----------

  const PREVIEW_COOKIE = 'editor_preview';
  const wide = window.matchMedia('(min-width: 1180px)');
  const readCookie = name => document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';

  function setupPreview(area) {
    const pane = document.querySelector(area.dataset.preview || '');
    const host = area.closest('[data-preview-host]');
    if (!pane || !host) return;
    const toggle = document.querySelector('[data-preview-toggle]');
    const kind = area.dataset.previewKind || 'note';
    // 没设过偏好时，宽窗口默认打开；窄窗口放不下两栏，始终单栏。
    let wanted = readCookie(PREVIEW_COOKIE) !== '0';
    let timer = 0;
    let token = null;
    let lastSent = null;

    const active = () => wanted && wide.matches;

    async function refresh() {
      if (!active()) return;
      const raw = area.value;
      const front = kind === 'card' ? (document.querySelector(area.dataset.previewFront || '')?.value || '') : '';
      const path = document.querySelector('[data-editor-form] [name="path"]')?.value || '';
      const key = `${front}\u0000${raw}`;
      if (key === lastSent) return;
      lastSent = key;
      const mine = token = {};
      try {
        const response = await fetch('/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ raw, kind, path, front })
        });
        const payload = await response.json().catch(() => ({}));
        if (token !== mine) return;
        if (!response.ok) throw new Error(payload.message || String(response.status));
        const body = pane.querySelector('[data-preview-body]') || pane;
        const heading = pane.querySelector('[data-preview-front]');
        if (heading) heading.innerHTML = payload.frontHtml || '';
        if (payload.error) {
          body.innerHTML = '';
          const note = document.createElement('p');
          note.className = 'editor-preview-note';
          note.textContent = payload.error;
          body.append(note);
        } else if (!String(payload.html || '').trim()) {
          body.innerHTML = '';
          const note = document.createElement('p');
          note.className = 'editor-preview-note';
          note.textContent = '写点什么，这里会显示排好的样子。';
          body.append(note);
        } else {
          body.innerHTML = payload.html;
        }
        syncScroll();
      } catch {
        lastSent = null;
      }
    }

    function schedule() {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 220);
    }

    // 预览跟着写作区滚：按滚动比例对齐，不追求逐行对应。
    function syncScroll() {
      const range = area.scrollHeight - area.clientHeight;
      const target = pane.scrollHeight - pane.clientHeight;
      if (range <= 0 || target <= 0) return;
      pane.scrollTop = (area.scrollTop / range) * target;
    }

    function apply({ animate = false } = {}) {
      const on = active();
      const wasOn = !pane.hidden;
      host.classList.toggle('has-preview', on);
      pane.hidden = !on;
      if (toggle) {
        toggle.hidden = !wide.matches;
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (on) {
        if (animate && !wasOn) window.workstationMotion?.enter?.(pane, { x: 10, y: 0, duration: 200 });
        lastSent = null;
        refresh();
      }
    }

    toggle?.addEventListener('click', () => {
      wanted = !active();
      document.cookie = `${PREVIEW_COOKIE}=${wanted ? '1' : '0'}; Max-Age=${365 * 86400}; Path=/; SameSite=Strict`;
      apply({ animate: true });
    });
    wide.addEventListener('change', apply);
    area.addEventListener('input', schedule);
    area.addEventListener('scroll', syncScroll, { passive: true });
    if (kind === 'card') document.querySelector(area.dataset.previewFront || '')?.addEventListener('input', schedule);
    apply();
  }

  // ---------- 接线 ----------

  for (const area of areas) {
    // Tab 用来缩进以后，键盘用户需要一个离开写作区的办法：先按 Esc，下一次 Tab 照常移动焦点。
    let escapeArmed = false;

    area.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (suggestKey(event)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') { escapeArmed = true; return; }
      if (event.key === 'Tab') {
        if (escapeArmed) { escapeArmed = false; return; }
        indentSelection(area, event, event.shiftKey);
        return;
      }
      escapeArmed = false;
      if (event.key === 'Enter' && !event.shiftKey) continueList(area, event);
    });

    area.addEventListener('input', () => updateSuggest(area));
    area.addEventListener('click', () => { if (suggest) updateSuggest(area); });
    // 键盘挪动光标不触发 input：松开按键时看一眼，光标已经不在弹出时那段文字的末尾就关掉
    // （按新位置重算的话，End 会把后面的字也算进查询，回车照样整段替换）。接着打字会重新弹出。
    area.addEventListener('keyup', event => {
      if (!suggest || event.isComposing) return;
      if (suggestQueryAt(area) !== suggest.query) closeSuggest();
    });
    area.addEventListener('blur', closeSuggest);
    area.addEventListener('scroll', () => { if (suggest) renderSuggest(); }, { passive: true });

    if (area.dataset.upload === '1') {
      let dragDepth = 0;
      const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
      const setDropHighlight = on => area.classList?.toggle('is-drop-target', on);
      area.addEventListener('paste', event => {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length) return;
        event.preventDefault();
        uploadImages(area, files);
      });
      area.addEventListener('dragenter', event => {
        if (!hasFiles(event)) return;
        dragDepth += 1;
        setDropHighlight(true);
      });
      area.addEventListener('dragover', event => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropHighlight(true);
      });
      area.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) setDropHighlight(false);
      });
      area.addEventListener('drop', event => {
        dragDepth = 0;
        setDropHighlight(false);
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length) return;
        event.preventDefault();
        uploadImages(area, files);
      });
    }

    if (area.dataset.preview) setupPreview(area);
  }

  window.addEventListener('resize', () => { if (suggest) renderSuggest(); });
})();
