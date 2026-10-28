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
      ? `${failedAnswers.size} 次评分未保存，请刷新卡片后重新复习。`
      : '';
    const retrying = retryingAnswers.size
      ? `${retryingAnswers.size} 次评分响应中断，正在用同一事件自动重试…`
      : '';
    retryNotice([failures, retrying].filter(Boolean).join(' '));
    if (failuresEl) {
      failuresEl.textContent = failures;
      failuresEl.hidden = !failures;
    }
  }

  async function submitAnswer(payload) {
    let delay = 1000;
    for (;;) {
      try {
        const response = await fetch('/review/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500) {
            retryingAnswers.delete(payload.eventId);
            failedAnswers.add(payload.eventId);
            updateSaveNotice();
            return false;
          }
          throw new Error(String(response.status));
        }
        retryingAnswers.delete(payload.eventId);
        updateSaveNotice();
        return true;
      } catch {
        retryingAnswers.add(payload.eventId);
        updateSaveNotice();
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async function answer(rating) {
    const card = current();
    if (!card || !revealed) return;

    const payload = {
      eventId: createEventId(),
      cardId: card.id,
      rating,
      elapsedMs: Date.now() - shownAt
    };
    pendingAnswers += 1;
    updateBusyState();
    index += 1;
    render();

    try {
      if (await submitAnswer(payload)) answered += 1;
    } finally {
      pendingAnswers -= 1;
      updateBusyState();
      if (!current()) render();
    }
  }

  async function finish() {
    root.hidden = true;
    doneEl.hidden = false;
    summaryEl.textContent = `复习了 ${answered} 张。`;
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

  revealBtn.addEventListener('click', reveal);
  for (const button of ratingsEl.querySelectorAll('[data-rating]')) {
    button.addEventListener('click', () => answer(Number(button.dataset.rating)));
  }

  document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const ui = typeof window === 'undefined' ? {} : (window.workstationUI || {});
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
