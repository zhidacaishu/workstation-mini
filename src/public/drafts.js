(() => {
  const form = document.querySelector('[data-editor-form][data-draft-id]');
  if (!form) return;
  const status = form.querySelector('[data-draft-status]');
  const snapshot = () => ({
    path: form.querySelector('[name="path"]').value,
    raw: form.querySelector('[name="body"]').value,
    baseHash: form.querySelector('[name="expectedHash"]').value
  });
  let baseline = form.dataset.recovered === '1' ? null : snapshot();
  let sequence = 0;
  let timer;
  let queue = Promise.resolve();
  let persisted = false;
  const id = form.dataset.draftId;
  const same = (a, b) => a && b && a.path === b.path && a.raw === b.raw;
  const show = message => { if (status) status.textContent = message; };
  async function request(method, body) {
    const response = await fetch('/api/drafts/' + id, {
      method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('草稿保存失败');
  }
  function flush() {
    clearTimeout(timer);
    queue = queue.catch(() => {}).then(async () => {
      const current = snapshot();
      if (same(current, baseline)) {
        if (persisted) {
          await request('DELETE', { sequence });
          persisted = false;
        }
        show('');
        return;
      }
      if (!current.path || !/\.md$/i.test(current.path) || current.path === '.md') {
        show('填写有效笔记路径后，将自动保存本地草稿。');
        return;
      }
      const submitted = ++sequence;
      show('正在保存本地草稿…');
      // A lost response may still have committed a draft. Retain its identity so
      // a later successful note save can remove it with the matching sequence.
      persisted = true;
      await request('POST', { ...current, sequence: submitted });
      show(same(current, snapshot()) ? '草稿已保存在本机，可在“历史与草稿”恢复。' : '有新改动，等待保存草稿…');
    }).catch(() => show('本地草稿未确认保存，请保留窗口并手动保存笔记。'));
    return queue;
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(flush, 750); }
  form.addEventListener('input', schedule);
  form.addEventListener('change', schedule);
  window.workstationDrafts = {
    async saved(submitted) {
      baseline = { path: String(submitted.get('path') || ''), raw: String(submitted.get('body') || '') };
      await flush();
    },
    flush
  };
  // Existing drafts are never silently applied over the latest disk version.
  const initial = snapshot();
  fetch('/api/drafts?path=' + encodeURIComponent(initial.path))
    .then(response => response.ok ? response.json() : { count: 0 })
    .then(result => { if (result.count && sequence === 0) show('发现 ' + result.count + ' 份未保存草稿，请点击上方历史链接预览恢复。'); })
    .catch(() => {});
  if (form.dataset.recovered === '1') schedule();
})();
