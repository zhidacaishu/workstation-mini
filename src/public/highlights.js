(() => {
  const button = document.getElementById('mark-seen');
  const box = document.getElementById('highlights');
  if (!button || !box) return;

  button.addEventListener('click', async () => {
    const { requestJson, notify } = window.workstationUI;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const paths = JSON.parse(decodeURIComponent(box.dataset.paths || '[]'));
      const result = await requestJson('/highlights/seen', {
        method: 'POST',
        json: { paths },
        fallbackMessage: '保存失败'
      });
      button.textContent = '已记录，明天换一批';
      notify(`已记录 ${result.marked} 篇回顾`);
    } catch (error) {
      button.disabled = false;
      notify(error.message, { type: 'error' });
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
})();
