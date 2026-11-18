(() => {
  // ---------- 笔记阅读页：直接勾选待办 ----------
  //
  // 勾选框带着它在原文里的行号（与索引里的待办同一套行号）。提交时带上整篇笔记的
  // 版本号，成功后换成新版本号，连续勾几条也不会互相冲突；外部改过笔记则提示刷新。
  const localToday = () => {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  };

  function refreshDueTag(item, done) {
    const today = localToday();
    for (const tag of item.querySelectorAll('time.task-due')) {
      if (tag.closest('li.task-item') !== item) continue;
      const date = tag.getAttribute('datetime');
      if (!date) continue;
      const [year, month, day] = date.split('-');
      const short = `${Number(month)}/${Number(day)}`;
      const label = year === today.slice(0, 4) ? short : `${year}/${short}`;
      tag.classList.remove('is-overdue', 'is-today');
      if (!done && date < today) { tag.classList.add('is-overdue'); tag.textContent = `逾期 ${label}`; }
      else if (!done && date === today) { tag.classList.add('is-today'); tag.textContent = '今天'; }
      else tag.textContent = label;
    }
  }

  document.addEventListener('change', async event => {
    const box = event.target;
    if (!box?.matches?.('.prose input.task-toggle')) return;
    const prose = box.closest('.prose');
    const notePath = document.body?.dataset?.notePath;
    if (!prose || !notePath) return;
    const done = box.checked;
    // 一次只提交一条：版本号要等上一条的结果回来才知道。正在提交时又点了别的，
    // 撤回这次点击并说明原因。
    if (prose.dataset.taskBusy === '1') {
      box.checked = !done;
      window.workstationUI.notify('上一条待办还在保存，稍等一下再勾。', { type: 'info' });
      return;
    }
    prose.dataset.taskBusy = '1';
    // 不禁用正在操作的这个勾选框：被禁用的元素会丢掉键盘焦点，用空格连续勾选就断了。
    const boxes = [...prose.querySelectorAll('input.task-toggle')].filter(item => item !== box);
    boxes.forEach(item => { item.disabled = true; });
    box.setAttribute('aria-disabled', 'true');
    try {
      const result = await window.workstationUI.requestJson('/tasks/update', {
        method: 'POST',
        json: { path: notePath, line: Number(box.dataset.taskLine), expectedHash: prose.dataset.noteHash, done }
      });
      prose.dataset.noteHash = result.hash;
      // 删除笔记等表单也带着版本号，一起换成新的。
      for (const input of document.querySelectorAll('input[name="expectedHash"]')) input.value = result.hash;
      const item = box.closest('li.task-item');
      item?.classList.toggle('is-done', done);
      box.classList.toggle('is-done', done);
      box.setAttribute('aria-label', String(box.getAttribute('aria-label') || '').replace(/^标记为(?:未)?完成：/, done ? '标记为未完成：' : '标记为完成：'));
      if (item) refreshDueTag(item, done);
    } catch (error) {
      box.checked = !done;
      window.workstationUI.notify(error.status === 409 ? '这篇笔记已在别处修改，请刷新页面后再勾选。' : error.message, { type: 'error' });
    } finally {
      boxes.forEach(item => { item.disabled = false; });
      box.removeAttribute('aria-disabled');
      delete prose.dataset.taskBusy;
    }
  });

  // ---------- 今日页与计划页 ----------

  // 今日页的待办只有一个勾选框：勾上即提交，改期留给计划页。
  document.addEventListener('change', event => {
    const toggle = event.target;
    if (!toggle?.matches?.('[data-task-toggle]')) return;
    const form = toggle.form;
    if (form?.matches?.('[data-task-quick]')) form.requestSubmit();
  });

  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-task-form]')) return;
    event.preventDefault();
    if (form.dataset.busy === '1') return;
    if (window.workstationCalendar?.hasUnsavedChanges()) {
      const done = form.querySelector('[name="done"]');
      done.checked = done.defaultChecked;
      window.workstationUI.notify('请先保存备注，再更新待办。', { type: 'info' });
      return;
    }
    const plan = window.workstationPlan;
    if (plan?.hasPendingUpdate() || plan?.hasUnsavedChanges(form)) {
      const done = form.querySelector('[name="done"]');
      done.checked = done.defaultChecked;
      window.workstationUI.notify(plan.hasPendingUpdate()
        ? '正在保存其他待办，请稍候再试。'
        : '请先保存或还原其他待办的日期，再更新此待办。', { type: 'info' });
      return;
    }
    // 成功后会刷新整个计划页：等待期间统一锁定会受刷新影响的输入，
    // 避免另一行日期或当天备注在请求途中产生新改动。
    // 成功后会刷新页面：等待期间锁住页面上所有待办，另一条的勾选不会在刷新时被吞掉。
    const fields = plan
      ? [...document.querySelectorAll('[data-task-form] input, [data-task-form] button, [data-calendar-form] textarea, [data-calendar-form] button')]
      : [...document.querySelectorAll('[data-task-form] input, [data-task-form] button')];
    const disabledBefore = fields.map(field => field.disabled);
    const data = Object.fromEntries(new FormData(form));
    data.done = form.querySelector('[name="done"]').checked;
    data.line = Number(data.line);
    form.dataset.busy = '1';
    form.setAttribute('aria-busy', 'true');
    fields.forEach(field => { field.disabled = true; });
    try {
      await window.workstationUI.requestJson(form.action, { method: 'POST', json: data });
      // Reload all derived counts, date ordering and other tasks in the same note.
      plan?.saved(form);
      window.location.reload();
    } catch (error) {
      const toggle = form.querySelector('[data-task-toggle]');
      if (toggle) toggle.checked = toggle.defaultChecked;
      window.workstationUI.notify(error.message, { type: 'error' });
      fields.forEach((field, index) => { field.disabled = disabledBefore[index]; });
      form.dataset.busy = '0';
      form.removeAttribute('aria-busy');
    }
  });
})();
