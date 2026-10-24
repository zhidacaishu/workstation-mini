(() => {
  const form = document.getElementById('check-form');
  const status = document.getElementById('check-status');
  const ui = window.workstationUI;

  function show(message, isError = false) {
    if (!status) return;
    status.hidden = false;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  if (form) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      const pathSelect = form.querySelector('[name=path]');
      const path = pathSelect.value;

      button.disabled = true;
      pathSelect.disabled = true;
      button.setAttribute('aria-busy', 'true');
      show('正在检查…');
      try {
        const result = await ui.requestJson('/mistakes/check', {
          method: 'POST',
          json: { path },
          fallbackMessage: '检查失败'
        });
        if (result.categories === 0) {
          show(`${path} 没有机械层面的问题。`);
        } else {
          show(`${path}：必改 ${result.hardCount} 处、人工复核 ${result.softCount} 处，已落库 ${result.recorded} 条。重新打开本页可查看新统计。`);
          ui.notify(`检查完成，已记录 ${result.recorded} 条错题`);
        }
      } catch (error) {
        show(error.message, true);
      } finally {
        button.disabled = false;
        pathSelect.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
  }

  for (const button of document.querySelectorAll('[data-make-card]')) {
    button.addEventListener('click', async () => {
      const original = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = '正在转换…';
      try {
        const result = await ui.requestJson('/mistakes/card', {
          method: 'POST',
          json: { id: button.dataset.makeCard },
          fallbackMessage: '转换失败'
        });
        button.textContent = '已建卡';
        ui.notify(`已存到 ${result.path}`);
      } catch (error) {
        button.textContent = original;
        button.disabled = false;
        ui.notify(error.message, { type: 'error' });
      } finally {
        button.removeAttribute('aria-busy');
      }
    });
  }
})();
