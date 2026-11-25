(() => {
  const form = document.querySelector('[data-editor-form][data-draft-id]');
  if (!form) return;
  const status = form.querySelector('[data-draft-status]');
  // 与服务端 withNoteExtension 一致：路径可以不写 .md。
  const notePath = value => {
    const cleaned = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!cleaned) return '';
    return /\.md$/i.test(cleaned) ? cleaned : cleaned + '.md';
  };
  const pathInput = form.querySelector('[name="path"]');
  const snapshot = () => ({
    path: notePath(pathInput.value),
    folder: pathInput.dataset?.folder,
    raw: form.querySelector('[name="body"]').value,
    baseHash: form.querySelector('[name="expectedHash"]').value
  });
  // 恢复页也以载入时的内容为基线：不改就不另存一份重复的草稿。
  let baseline = snapshot();
  let sequence = 0;
  let timer;
  let queue = Promise.resolve();
  let persisted = false;
  const id = form.dataset.draftId;
  const same = (a, b) => a && b && a.path === b.path && a.raw === b.raw;
  const show = message => { if (status) status.textContent = message; };
  // 离开页面时发出的草稿请求要带 keepalive，页面卸载后浏览器才会把它发完。
  // keepalive 的请求体上限约 64KB，更长的草稿只能按普通请求尽力发出。
  const KEEPALIVE_LIMIT = 60_000;
  async function request(method, body, { leaving = false } = {}) {
    const payload = JSON.stringify(body);
    const response = await fetch('/api/drafts/' + id, {
      method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload,
      // 按每个字符最多 3 个 UTF-8 字节估算，宁可少用 keepalive，也不让请求因超限直接失败。
      ...(leaving && payload.length * 3 < KEEPALIVE_LIMIT ? { keepalive: true } : {})
    });
    if (!response.ok) throw new Error('草稿保存失败');
  }
  function flush({ leaving = false } = {}) {
    clearTimeout(timer);
    // 要离开页面时立刻发：排在前一个请求后面的话，页面可能已经没了。
    if (leaving) {
      const current = snapshot();
      if (same(current, baseline)) return queue;
      const submitted = ++sequence;
      persisted = true;
      const sent = request('POST', { ...current, sequence: submitted }, { leaving: true }).catch(() => {});
      queue = queue.catch(() => {}).then(() => sent);
      return queue;
    }
    queue = queue.catch(() => {}).then(async () => {
      const current = snapshot();
      if (same(current, baseline)) {
        if (persisted) {
          await request('DELETE', { sequence });
          persisted = false;
        }
        show('');
        return true;
      }
      const submitted = ++sequence;
      show('正在保存本地草稿…');
      // A lost response may still have committed a draft. Retain its identity so
      // a later successful note save can remove it with the matching sequence.
      persisted = true;
      await request('POST', { ...current, sequence: submitted });
      const confirmed = same(current, snapshot());
      show(confirmed ? '草稿已保存在本机，可在「历史与草稿」恢复。' : '有新改动，等待保存草稿…');
      return confirmed;
    }).catch(() => {
      show('本地草稿未确认保存，请保留窗口并手动保存笔记。');
      window.workstationUI?.notify?.('本地草稿没能保存，请手动保存笔记。', { type: 'error' });
      return false;
    });
    return queue;
  }
  function schedule() {
    clearTimeout(timer);
    show(same(snapshot(), baseline) ? '' : '有新改动，等待保存草稿…');
    timer = setTimeout(flush, 750);
  }
  form.addEventListener('input', schedule);
  form.addEventListener('change', schedule);
  window.workstationDrafts = {
    // savedPath 是服务端实际保存的位置（可能补了 .md、或重名换成「标题 2」）。
    // 用它做基线，否则路径一变，这里会误以为还有改动，又存一份假草稿。
    async saved(submitted, savedPath) {
      baseline = { path: notePath(savedPath || submitted.get('path')), raw: String(submitted.get('body') || '') };
      await flush();
    },
    flush
  };
  // Existing drafts are never silently applied over the latest disk version.
  const initial = snapshot();
  if (initial.path && form.dataset.recovered !== '1') {
    fetch('/api/drafts?path=' + encodeURIComponent(initial.path))
      .then(response => response.ok ? response.json() : { count: 0 })
      .then(result => { if (result.count && sequence === 0) show('这篇笔记有 ' + result.count + ' 份未保存的草稿，可以在右边的「版本与草稿」里预览和恢复。'); })
      .catch(() => {});
  }
})();
