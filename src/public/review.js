// 复习会话。
//
// 队列在页面渲染时直接嵌入，整轮复习在窗口内完成，每答一张异步提交一次。
// 评分是高频动作，不能每答一次就刷新整个页面。

(() => {
  const root = document.getElementById('reviewer');
  if (!root) return;

  const frontEl = document.getElementById('review-front');
  const backEl = document.getElementById('review-back');
  const revealBtn = document.getElementById('review-reveal');
  const ratingsEl = document.getElementById('review-ratings');
  const remainingEl = document.getElementById('review-remaining');
  const deckEl = document.getElementById('review-deck');
  const doneEl = document.getElementById('review-done');
  const summaryEl = document.getElementById('review-summary');
  const doneTitle = document.getElementById('review-done-title');
  const failuresEl = document.getElementById('review-failures');
  const meterEl = document.getElementById('review-meter-fill');
  const relearnEl = document.getElementById('review-relearn');
  const editEl = document.getElementById('review-edit');
  const suspendEl = document.getElementById('review-suspend');
  const returnTo = root.dataset?.returnTo || '/review';

  let queue;
  try {
    queue = JSON.parse(decodeURIComponent(root.dataset.queue || '[]'));
  } catch {
    queue = [];
  }

  let index = 0;
  let revealed = false;
  let shownAt = Date.now();
  let answered = 0;
  let pendingAnswers = 0;
  let anySynced = false;
  // 评过分的卡（按卡计，不按次数）和本轮选过「忘了」的卡。
  const reviewedCards = new Set();
  const relearnedCards = new Set();
  const failedAnswers = new Set();
  const retryingAnswers = new Set();

  function current() {
    return queue[index];
  }

  function updateBusyState() {
    if (pendingAnswers > 0) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
  }

  function render() {
    const card = current();
    if (!card) {
      if (pendingAnswers > 0) {
        frontEl.textContent = '正在保存最后的评分…';
        backEl.hidden = true;
        ratingsEl.hidden = true;
        revealBtn.hidden = true;
        remainingEl.textContent = '0';
        // 没有当前卡了：「编辑」「暂停这张」无从谈起。
        if (editEl) editEl.hidden = true;
        if (suspendEl) suspendEl.hidden = true;
        return;
      }
      finish();
      return;
    }

    root.hidden = false;
    doneEl.hidden = true;

    // 挖空卡的题面是挖掉答案的正文，普通卡的题面就是正面。
    frontEl.innerHTML = card.question
      ? `${card.front}<div class="cloze-question">${card.question}</div>`
      : card.front;
    backEl.innerHTML = card.back;
    backEl.hidden = true;
    ratingsEl.hidden = true;
    revealBtn.hidden = false;
    deckEl.textContent = card.deck || '';
    if (relearnEl) relearnEl.hidden = !card.relearn;
    if (editEl) {
      editEl.hidden = false;
      editEl.href = '/cards/edit?id=' + encodeURIComponent(card.id) + '&returnTo=' + encodeURIComponent(returnTo);
    }
    if (suspendEl) {
      suspendEl.hidden = false;
      suspendEl.disabled = false;
    }
    if (meterEl?.style) meterEl.style.width = `${Math.round((index / Math.max(queue.length, 1)) * 100)}%`;
    remainingEl.textContent = String(queue.length - index);
    revealed = false;
    shownAt = Date.now();
  }

  function reveal() {
    if (revealed || !current()) return;
    revealed = true;
    backEl.hidden = false;
    revealBtn.hidden = true;
    ratingsEl.hidden = false;
    // 焦点交给复习区（保住数字快捷键），读屏软件不会因此念出答案；用一个播报区念一遍。
    const announcer = document.getElementById('review-announcer');
    if (announcer) announcer.textContent = '答案：' + String(backEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // Windows 隐藏按钮后可能仍保留焦点，显式交还给复习区域以恢复数字快捷键。
    root.focus({ preventScroll: true });
  }

  function createEventId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function retryNotice(message) {
    let notice = document.getElementById('review-retry');
    if (!notice) {
      notice = document.createElement('p');
      notice.id = 'review-retry';
      notice.className = 'review-retry';
      root.append(notice);
    }
    notice.textContent = message;
    notice.setAttribute('role', 'status');
  }

  function updateSaveNotice() {
    const failures = failedAnswers.size
      ? `${failedAnswers.size} 次评分未保存${lastFailureMessage ? `（${lastFailureMessage}）` : ''}，请处理后刷新页面重新复习。`
      : '';
    const retrying = retryingAnswers.size
      ? `${retryingAnswers.size} 次评分还没保存上，正在重试…`
      : '';
    retryNotice([failures, retrying].filter(Boolean).join(' '));
    if (failuresEl) {
      failuresEl.textContent = failures;
      failuresEl.hidden = !failures;
    }
  }

  // 服务端出错（磁盘满、没有写权限）不会自己好：最多重试这么多次，然后如实报告。
  // 以前无限重试，页面停在「正在保存最后的评分…」，离不开也退不出。
  const MAX_ATTEMPTS = 5;
  let lastFailureMessage = '';

  async function submitAnswer(payload) {
    let delay = 1000;
    for (let attempt = 1; ; attempt += 1) {
      let serverMessage = '';
      try {
        const response = await fetch('/review/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          retryingAnswers.delete(payload.eventId);
          updateSaveNotice();
          return true;
        }
        const body = await Promise.resolve().then(() => response.json()).catch(() => ({}));
        serverMessage = body?.message || `服务端返回 ${response.status}`;
        if (response.status >= 400 && response.status < 500) {
          lastFailureMessage = serverMessage;
          retryingAnswers.delete(payload.eventId);
          failedAnswers.add(payload.eventId);
          updateSaveNotice();
          return false;
        }
      } catch {
        serverMessage = '连接不上本地服务';
      }
      if (attempt >= MAX_ATTEMPTS) {
        lastFailureMessage = serverMessage;
        retryingAnswers.delete(payload.eventId);
        failedAnswers.add(payload.eventId);
        updateSaveNotice();
        return false;
      }
      retryingAnswers.add(payload.eventId);
      updateSaveNotice();
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 8_000);
    }
  }

  async function answer(rating) {
    const card = current();
    // 正在暂停这张卡时不评分：否则它会被记一次分，还被算成「本轮重学」。
    if (!card || !revealed || suspending) return;

    const payload = {
      eventId: createEventId(),
      cardId: card.id,
      rating,
      elapsedMs: Date.now() - shownAt
    };
    pendingAnswers += 1;
    updateBusyState();
    // 「忘了」的卡在这一轮末尾再出现一次，直到想起来为止；随时可以离开，评分都已记录。
    if (rating === 1) {
      queue.push({ ...card, relearn: true });
      relearnedCards.add(card.id);
    }
    index += 1;
    render();

    try {
      if (await submitAnswer(payload)) {
        answered += 1;
        reviewedCards.add(card.id);
      }
    } finally {
      pendingAnswers -= 1;
      updateBusyState();
      if (!current()) render();
    }
  }

  async function finish() {
    root.hidden = true;
    doneEl.hidden = false;
    summaryEl.textContent = relearnedCards.size
      ? `复习了 ${reviewedCards.size} 张，其中 ${relearnedCards.size} 张本轮重学过。`
      : `复习了 ${reviewedCards.size} 张。`;
    if (doneTitle) doneTitle.textContent = failedAnswers.size ? '部分评分未保存' : '这一轮复习完了';
    updateSaveNotice();
    doneEl.focus();

    // 复习完成后立即提交事件日志，避免等到下一轮定时同步。
    if (answered > 0 && !anySynced) {
      anySynced = true;
      try {
        const response = await fetch('/review/sync', { method: 'POST' });
        if (!response.ok) throw new Error(String(response.status));
        const result = await response.json();
        if (result.ok === true && result.pushed === true) {
          summaryEl.textContent += ' 记录已同步。';
        } else if (result.ok === true && result.committed === true && result.pushed === false) {
          summaryEl.textContent += ' 记录已提交但尚未推送，仍保留在本地。';
        } else if (result.ok === true && result.skipped) {
          summaryEl.textContent += ` ${result.skipped}，记录仍保留在本地。`;
        } else if (result.ok === true) {
          summaryEl.textContent += ' 没有需要同步的改动，记录仍保留在本地。';
        } else if (result.blocked === 'recovery-required') {
          summaryEl.textContent += ' Git 正在等待恢复，记录仍保留在本地。';
        } else if (result.blocked === 'remote-branch-missing') {
          summaryEl.textContent += ' 远端还没有这个分支，先做一次完整同步再试，记录仍保留在本地。';
        } else if (result.blocked === 'staged-current-review') {
          summaryEl.textContent += ' 当前设备的复习日志已在 Git 暂存区；请先提交或取消暂存，记录仍保留在本地。';
        } else if (result.blocked) {
          summaryEl.textContent += ' 同步因安全检查被阻止，记录仍保留在本地。';
        } else {
          summaryEl.textContent += ' 同步失败，记录仍保留在本地。';
        }
      } catch {
        summaryEl.textContent += ' 记录已存在本地，同步失败。';
      }
    }
  }

  // 导航或退出会终止内存中的评分重试，待落盘时沿用编辑器的离开保护。
  window.addEventListener('beforeunload', event => {
    if (pendingAnswers === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // 暂停当前这张：从本轮队列里拿掉（包括排在后面的重学），复习记录保留。
  let suspending = false;
  async function suspendCurrent() {
    const card = current();
    if (!card || !suspendEl || suspending) return;
    suspending = true;
    suspendEl.disabled = true;
    try {
      const response = await fetch('/cards/suspend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id: card.id, suspended: true })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `暂停失败（${response.status}）`);
      queue = queue.filter((item, position) => position < index || item.id !== card.id);
      window.workstationUI?.notify?.('已暂停这张卡，可以在卡组的卡片列表里恢复。', { type: 'success' });
      render();
    } catch (error) {
      suspendEl.disabled = false;
      window.workstationUI?.notify?.(error.message, { type: 'error' });
    } finally {
      suspending = false;
    }
  }
  suspendEl?.addEventListener('click', suspendCurrent);

  revealBtn.addEventListener('click', reveal);
  for (const button of ratingsEl.querySelectorAll('[data-rating]')) {
    button.addEventListener('click', () => answer(Number(button.dataset.rating)));
  }

  document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const ui = window.workstationUI || {};
    const active = document.activeElement;
    const isInteractiveTarget = ui.isInteractiveTarget || (target => {
      const tag = target?.tagName;
      return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'AUDIO', 'VIDEO'].includes(tag)
        || Boolean(target?.isContentEditable);
    });
    if (isInteractiveTarget(active)) return;
    if ((ui.hasOpenDialog || (() => Boolean(document.querySelector('dialog[open]'))))()) return;

    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      reveal();
    } else if (['1', '2', '3', '4'].includes(event.key)) {
      event.preventDefault();
      answer(Number(event.key));
    }
  });

  render();
})();
