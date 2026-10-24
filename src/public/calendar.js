/**
 * 日历页的渐进增强。
 *
 * 页面在没有 JS 时是完全可用的：格子是普通链接，排时间块是普通表单 POST 后
 * 重定向。这里做的两件事都只是「省一次整页刷新」——
 *   1. 左右方向键翻月（?month= 的链接已经在 DOM 里，直接跳）
 *   2. 排时间块走 fetch，成功后把新的时间块插进右侧栏
 * 任何一步失败都退回原来的表单提交行为。
 */
(() => {
  const root = document.getElementById('calendar');
  if (!root) return;

  const ui = window.workstationUI;

  // ── 键盘翻月 ────────────────────────────────────────
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (ui?.isInteractiveTarget(document.activeElement)) return;
    if ((ui?.hasOpenDialog || (() => Boolean(document.querySelector('dialog[open]'))))()) return;

    const rel = event.key === 'ArrowLeft' ? 'prev' : event.key === 'ArrowRight' ? 'next' : '';
    if (!rel) return;
    const link = document.querySelector(`.calnav a[rel=${rel}]`);
    if (!link) return;
    event.preventDefault();
    window.location.href = link.getAttribute('href');
  });

  // ── 排时间块 ────────────────────────────────────────
  const form = document.querySelector('[data-plan-form]');
  if (!form || !ui) return;

  // 列表一直在 DOM 里，空的时候用 hidden 藏起来 —— 比「没有就现造一个」少一整类
  // 「插到哪儿」的判断，也不会有误伤旁边节点的风险。
  const list = document.querySelector('[data-plan-list]');
  const empty = document.querySelector('[data-plan-empty]');

  function renderBlock(block) {
    const item = document.createElement('li');
    if (block.from) {
      const time = document.createElement('span');
      time.className = 'plan-time';
      time.textContent = `${block.from}–${block.to}`;
      item.append(time);
    }
    // textContent 而不是 innerHTML：内容是用户输入的。
    item.append(document.createTextNode(block.what));
    return item;
  }

  /**
   * 左边格子里的时间块也要跟着变。
   *
   * 不同步的话，刚排完一件事，主视图还显示着旧的 —— 一个「编辑完立刻就不准」的
   * 日历，之后你会不敢相信它上面的任何东西。
   */
  function syncGridCell(date, plan) {
    const cell = document.querySelector(`.calday[data-date="${date}"]`);
    const items = cell?.querySelector('.calday-items');
    if (!items) return;

    const total = document.querySelector('[data-plan-total]');
    const previous = Number(cell.dataset.planCount) || 0;
    if (total) total.textContent = String(Number(total.textContent) + plan.length - previous);
    cell.dataset.planCount = String(plan.length);
    const { weekday, entryCount, reviewDue } = cell.dataset;
    cell.setAttribute('aria-label', `${date} ${weekday}`
      + (Number(entryCount) ? `，${entryCount} 项截止` : '')
      + (plan.length ? `，${plan.length} 个时间块` : '')
      + (Number(reviewDue) ? `，${reviewDue} 张待复习` : ''));
    if (!cell.querySelector('.calday-diary')) {
      const dot = document.createElement('span');
      dot.className = 'calday-diary';
      dot.title = '这天写了日记';
      dot.setAttribute('aria-hidden', 'true');
      cell.querySelector('.calday-num')?.append(dot);
    }

    // 只重画时间块，截止和待办不受排期影响。模板里时间块本来就排在最后，
    // 「先删后加」不会打乱顺序。
    for (const stale of items.querySelectorAll('.calpill.is-plan')) stale.remove();
    for (const block of plan) {
      const pill = document.createElement('span');
      pill.className = 'calpill is-plan';
      if (block.from) {
        const time = document.createElement('b');
        time.textContent = block.from;
        pill.append(time, ' ');
      }
      pill.append(document.createTextNode(block.what));
      items.append(pill);
    }
  }

  let saving = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const button = form.querySelector('button');
    const what = form.querySelector('[name=what]');
    const original = button.textContent;
    const submittedWhat = what.value;

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '正在排…';

    try {
      const result = await ui.requestJson('/calendar/plan', {
        method: 'POST',
        json: {
          date: form.querySelector('[name=date]').value,
          from: form.querySelector('[name=from]').value,
          to: form.querySelector('[name=to]').value,
          what: submittedWhat,
          expectedHash: form.querySelector('[name=expectedHash]').value
        },
        fallbackMessage: '排期失败'
      });

      // 服务端回的是整理并排好序的完整列表，直接照它重画，避免本地再排一次序。
      if (list) {
        list.replaceChildren(...result.plan.map(renderBlock));
        list.hidden = result.plan.length === 0;
      }
      if (empty) empty.hidden = true;
      syncGridCell(result.date, result.plan);
      form.querySelector('[name=expectedHash]').value = result.hash;

      // 排时间块会顺带把那天的日记建出来，侧栏那个「按模板新建」按钮就过时了。
      // 点它不会有坏事（POST /diary/today 已存在就不覆盖），但它明摆着在说谎。
      const diarySlot = document.querySelector('[data-diary-slot]');
      if (diarySlot?.querySelector('form')) {
        const link = document.createElement('a');
        link.href = `/note/${result.path.split('/').map(encodeURIComponent).join('/')}`;
        link.textContent = '打开这天的日记';
        const paragraph = document.createElement('p');
        paragraph.append(link);
        diarySlot.replaceChildren(paragraph);
      }

      if (what.value === submittedWhat) what.value = '';
      ui.notify(`已排进 ${result.date}：${result.block}`);
    } catch (error) {
      ui.notify(error.status === 409 ? '这天的日记已在别处修改，请刷新页面后重试。输入内容已保留。' : error.message, { type: 'error' });
    } finally {
      saving = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = original;
    }
  });
})();
