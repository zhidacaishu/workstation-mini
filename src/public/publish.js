(() => {
  const form = document.getElementById('publish-form');
  if (!form) return;

  const status = document.getElementById('publish-status');
  const preview = document.getElementById('publish-preview');
  const actions = document.getElementById('publish-actions');
  const writeButton = document.getElementById('publish-write');
  const previewButton = form.querySelector('[type=submit]');
  const writeLocked = Boolean(writeButton?.disabled);
  const ui = window.workstationUI;
  let current = null;
  let previewToken = 0;
  let writeToken = 0;
  let writePending = false;
  let hasPreview = false;

  function show(message, isError = false) {
    status.hidden = false;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function invalidatePreview() {
    previewToken += 1;
    current = null;
    if (writeButton) writeButton.disabled = true;
    previewButton.disabled = writePending;
    previewButton.removeAttribute('aria-busy');
    if (hasPreview) show('内容已更改，请重新预览。');
  }

  form.addEventListener('input', invalidatePreview);
  form.addEventListener('change', invalidatePreview);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const token = ++previewToken;
    const body = Object.fromEntries(new FormData(form).entries());
    body.draft = form.querySelector('[name=draft]').checked;
    current = null;
    if (writeButton) writeButton.disabled = true;
    previewButton.disabled = true;
    previewButton.setAttribute('aria-busy', 'true');
    show('转换中…');

    try {
      const result = await ui.requestJson('/publish/preview', {
        method: 'POST',
        json: body,
        fallbackMessage: '转换失败'
      });
      if (token !== previewToken) return;

      current = result;
      hasPreview = true;
      preview.hidden = false;
      preview.textContent = result.mdx;
      actions.hidden = false;
      show(result.validation.ok
        ? `校验通过，将写入 src/content/blog/${result.slug}.mdx`
        : `校验没过：${result.validation.problems.join('；')}`, !result.validation.ok);
      if (writeButton) writeButton.disabled = writePending || writeLocked || !result.validation.ok;
    } catch (error) {
      if (token === previewToken) show(error.message, true);
    } finally {
      if (token === previewToken) {
        previewButton.disabled = false;
        previewButton.removeAttribute('aria-busy');
      }
    }
  });

  writeButton?.addEventListener('click', async () => {
    if (!current || writeLocked || writePending) return;
    const payload = { mdx: current.mdx, slug: current.slug };
    const token = ++writeToken;
    writePending = true;
    writeButton.disabled = true;
    previewButton.disabled = true;
    writeButton.setAttribute('aria-busy', 'true');
    try {
      const result = await ui.requestJson('/publish/write', {
        method: 'POST',
        json: payload,
        fallbackMessage: '写入失败'
      });
      if (token !== writeToken) return;
      show(`${result.path} 已写入。${result.note}`);
      ui.notify('文章已写入博客仓库');
    } catch (error) {
      if (token !== writeToken) return;
      show(error.message, true);
    } finally {
      if (token !== writeToken) return;
      writePending = false;
      previewButton.disabled = false;
      writeButton.disabled = writeLocked || !current;
      writeButton.removeAttribute('aria-busy');
    }
  });
})();
