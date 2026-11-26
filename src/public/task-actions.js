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

  function updateOverdueBadge(count) {
    if (typeof count !== 'number') return;
    const nav = document.querySelector?.('[data-nav="plan"]');
    if (!nav) return;
    let badge = nav.querySelector('.nav-badge');
    if (count > 0) {
      const label = `${count} 项逾期`;
      let created = false;
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge is-warn';
        nav.append(badge);
        created = true;
      }
      if (badge.title !== label) {
        const changed = !created && Boolean(badge.title);
        badge.title = label;
        badge.removeAttribute('aria-label');
        const comma = document.createElement('span');
        comma.className = 'visually-hidden';
        comma.textContent = '，';
        const suffix = document.createElement('span');
        suffix.className = 'visually-hidden';
        suffix.textContent = ' 项逾期';
        badge.replaceChildren(comma, document.createTextNode(count > 99 ? '99+' : String(count)), suffix);
        if (created) window.workstationMotion?.enter?.(badge, { y: 0, scale: 0.84, easing: window.workstationMotion.EASE_SPRING });
        else if (changed) window.workstationMotion?.pulse?.(badge, { scale: 1.08 });
      }
    } else if (badge) {
      badge.remove();
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
      updateOverdueBadge(result.overdueCount);
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

  let lastTaskToastClose = null;
  let taskOpSeq = 0;

  // 普通提交和撤销共用同一套并发互斥与局部刷新保护，避免撤销期间输入备注或切日被旧响应覆盖。
  async function runTaskUndo({ undoToken, expectedHash, seq } = {}) {
    if (!undoToken) return true;
    if (seq !== undefined && seq !== taskOpSeq) return true;
    const plan = window.workstationPlan;
    if (window.workstationCalendar?.hasUnsavedChanges?.()) {
      window.workstationUI.notify('请先保存或还原备注，再撤销待办。', { type: 'info' });
      return false;
    }
    if (plan?.hasPendingUpdate?.() || plan?.hasUnsavedChanges?.()) {
      window.workstationUI.notify(plan.hasPendingUpdate()
        ? '正在保存其他待办，请稍候再试。'
        : '请先保存或还原其他待办的日期，再撤销。', { type: 'info' });
      return false;
    }
    const calendar = window.workstationCalendar;
    const startDate = calendar?.currentDate?.() || '';
    const startVersion = calendar?.currentEditVersion?.();
    const fields = [...document.querySelectorAll('[data-task-form] input, [data-task-form] button')];
    const disabledBefore = fields.map(field => field.disabled);
    let updateEnded = false;
    const finishUpdate = () => {
      if (updateEnded) return;
      updateEnded = true;
      plan?.endUpdate?.();
    };
    plan?.beginUpdate?.();
    fields.forEach(field => { field.disabled = true; });
    try {
      const result = await window.workstationUI.requestJson('/tasks/undo', {
        method: 'POST',
        json: { undoToken, expectedHash }
      });
      if (typeof result?.overdueCount === 'number') updateOverdueBadge(result.overdueCount);
      if (calendar) {
        try {
          const outcome = await calendar.refreshAfterTask({
            expectedDate: startDate,
            expectedEditVersion: startVersion
          });
          if (outcome?.preservedEdits || outcome?.staleDate) {
            window.workstationUI.notify('已撤销待办，当前编辑已保留。', {
              type: 'info',
              action: { label: '刷新页面', onClick: () => window.location.reload() }
            });
          } else {
            window.workstationUI.notify('已撤销更改');
          }
        } catch {
          window.workstationUI.notify('已撤销待办，请刷新查看最新列表。', {
            type: 'info',
            action: { label: '刷新页面', onClick: () => window.location.reload() }
          });
        }
        return true;
      }
      // 撤销写入已完成：先结束本次 pendingUpdate 计数，避免 hasUnsavedWork() 和 beforeunload 误拦截刷新。
      finishUpdate();
      if (window.workstationUI?.hasUnsavedWork?.()) {
        window.workstationUI.notify('已撤销待办，当前输入已保留。', {
          type: 'info',
          action: { label: '刷新页面', onClick: () => window.location.reload() }
        });
        return true;
      }
      window.workstationUI.flash?.({ message: '已撤销更改' });
      window.location.reload();
      return true;
    } catch (error) {
      window.workstationUI.notify(error.status === 409
        ? '笔记已在别处修改，无法自动撤销。'
        : `撤销失败：${error.message}`, { type: 'error' });
      return true;
    } finally {
      finishUpdate();
      fields.forEach((field, index) => {
        if (field.isConnected) field.disabled = disabledBefore[index];
      });
    }
  }

  window.workstationTasks = { undo: runTaskUndo };

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
    // 更新派生的计数、行号和版本之前，锁定会被替换的控件。
    const fields = plan
      ? [...document.querySelectorAll('[data-task-form] input, [data-task-form] button, [data-calendar-form] textarea, [data-calendar-form] button')]
      : [...document.querySelectorAll('[data-task-form] input, [data-task-form] button')];
    const disabledBefore = fields.map(field => field.disabled);
    const doneInput = form.querySelector('[name="done"]');
    const dueInput = form.querySelector('[name="due"]');
    const prevDone = Boolean(doneInput?.defaultChecked);
    const prevDue = dueInput ? String(dueInput.defaultValue || '') : '';
    const taskTitle = form.closest('li')?.querySelector('a')?.textContent?.trim() || '';
    const data = Object.fromEntries(new FormData(form));
    data.done = doneInput.checked;
    data.line = Number(data.line);
    const calendar = window.workstationCalendar;
    const startDate = calendar?.currentDate?.() || '';
    const startVersion = calendar?.currentEditVersion?.();
    form.dataset.busy = '1';
    form.setAttribute('aria-busy', 'true');
    fields.forEach(field => { field.disabled = true; });
    try {
      const result = await window.workstationUI.requestJson(form.action, { method: 'POST', json: data });
      const seq = ++taskOpSeq;
      lastTaskToastClose?.();
      lastTaskToastClose = null;
      const undoMessage = data.done !== prevDone
        ? (data.done
          ? (taskTitle ? `已完成「${taskTitle}」` : '已完成待办')
          : (taskTitle ? `已重新打开「${taskTitle}」` : '已重新打开待办'))
        : data.due !== prevDue
          ? (data.due ? `已改期至 ${data.due}` : '已取消截止日期')
          : '已更新待办';
      const undoData = result?.undoToken && result?.hash
        ? { undoToken: result.undoToken, expectedHash: result.hash }
        : null;
      if (calendar) {
        try {
          await calendar.refreshAfterTask({ expectedDate: startDate, expectedEditVersion: startVersion, exceptForm: form });
          plan?.saved(form);
          if (undoData) {
            lastTaskToastClose = window.workstationUI.notify(undoMessage, {
              type: 'success',
              action: {
                label: '撤销',
                onClick: () => runTaskUndo({ ...undoData, seq })
              }
            });
          }
          return;
        } catch {
          // 写入已经成功；局部读取失败时通过常规导航恢复最新状态。
        }
      }
      if (undoData) {
        window.workstationUI.flash?.({ kind: 'task-undo', message: undoMessage, ...undoData });
      }
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
