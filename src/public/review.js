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
  const undoEl = document.getElementById('review-undo');
  const undoLastEl = document.getElementById('review-undo-last');
  const createEl = document.querySelector('#reviewer [data-card-create]');
  let returnTo = root.dataset?.returnTo || '/review';
  const baseReturnTo = returnTo;
  const round = window.workstationRound;
  const emptyEl = document.getElementById('review-empty');
  const deck = root.dataset.deck || '';
  let token;
  let restoring = false;
  let previousSteps = 0;
  const revisions = new Map();

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
  let saveTail = null;
  let anySynced = false;
  let syncMessage = '';
  let syncVersion = 0;
  // 评过分的卡（按卡计，不按次数）和本轮选过「忘了」的卡。
  const reviewedCards = new Map();
  const relearnedCards = new Set();
  const failedAnswers = new Set();
  const retryingAnswers = new Set();
  // 最近一次评分，供「撤销上一张」用；只留一步。
  let lastAnswer = null;
  let undoing = false;

  // 只保存已经落盘的进度。恢复不重发评分，服务端日志决定哪些卡仍可继续、哪一步可撤销。
  function checkpoint() {
    if (!round || !token || restoring || pendingAnswers || undoing || suspending) return;
    if (failedAnswers.size) { round.write(null); return; }
    const undo = lastAnswer && {
      id: lastAnswer.card.id, eventId: lastAnswer.payload.eventId,
      relearn: Boolean(lastAnswer.card.relearn), relearnAdded: lastAnswer.relearnAdded, firstRelearn: lastAnswer.firstRelearn
    };
    round.write({
      token, deck, steps: previousSteps + index, revealed, undo, anySynced, syncMessage,
      reviewed: [...reviewedCards], relearned: [...relearnedCards],
      remaining: queue.slice(index).map(card => ({
        id: card.id, relearn: Boolean(card.relearn), reviewCount: revisions.get(card.id)
      }))
    });
    window.workstationNavigation?.remember?.();
  }

  async function start() {
    const saved = round?.read();
    const requested = round && new URLSearchParams(window.location.search).get('round');
    if (requested && requested === saved?.token && saved.deck === deck) {
      restoring = true;
      root.hidden = true;
      emptyEl.hidden = true;
      try {
        const { cards, undoId } = await round.load(saved);
        const live = new Map(cards.map(card => [card.id, card]));
        for (const card of cards) revisions.set(card.id, card.reviewCount);
        queue = saved.remaining.filter(item => live.has(item.id) && live.get(item.id).reviewCount === item.reviewCount)
          .map(item => ({ ...live.get(item.id), relearn: item.relearn }));
        previousSteps = saved.steps;
        for (const [id, count] of saved.reviewed) { reviewedCards.set(id, count); answered += count; }
        for (const id of saved.relearned) relearnedCards.add(id);
        anySynced = saved.anySynced;
        syncMessage = saved.syncMessage || '';
        token = saved.token;
        // 只有本机日志里的最后一次有效评分可以撤销。
        const undo = saved.undo;
        if (undo && undo.eventId === undoId && live.has(undo.id)) {
          const card = { ...live.get(undo.id), relearn: undo.relearn };
          queue.unshift(card);
          index = 1;
          previousSteps -= 1;
          lastAnswer = { ...undo, card, index: 0, saved: true, payload: { eventId: undo.eventId } };
        }
        returnTo = round.url(deck, token);
        restoring = false;
        updateUndo();
        render();
        if (saved.revealed && current()?.id === saved.remaining[0]?.id) reveal();
        checkpoint();
      } catch {
        showReadError('未能恢复本轮复习。', window.location.href);
      }
      return;
    }
    if (queue.length) startNewRound();
  }

  function showReadError(text, href) {
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = text;
    const retry = document.createElement('a');
    retry.href = href;
    retry.textContent = '重新读取';
    message.append(retry);
    root.before(message);
  }

  function startNewRound() {
    if (round) {
      for (const card of queue) revisions.set(card.id, card.reviewCount);
      token = createEventId();
      returnTo = round.url(deck, token);
      history.replaceState(history.state, '', returnTo);
    }
    render();
    checkpoint();
  }

  function updateUndo() {
    const available = Boolean(lastAnswer) && !undoing;
    if (undoEl) {
      undoEl.hidden = !lastAnswer;
      undoEl.disabled = !available;
    }
    if (undoLastEl) {
      undoLastEl.hidden = !lastAnswer;
      undoLastEl.disabled = !available;
    }
  }

  function current() {
    return queue[index];
  }

  function updateBusyState() {
    if (pendingAnswers > 0 || undoing) root.setAttribute('aria-busy', 'true');
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
    // 挖空卡翻面时在题面原位填空（见 reveal），不用单独的答案区。
    backEl.innerHTML = card.question ? '' : card.back;
    backEl.hidden = true;
    ratingsEl.hidden = true;
    revealBtn.hidden = false;
    deckEl.textContent = card.deck || '';
    if (createEl) createEl.dataset.cardCreate = card.deckFile || '';
    if (relearnEl) relearnEl.hidden = !card.relearn;
    if (editEl) {
      editEl.hidden = false;
      editEl.href = '/cards/edit?id=' + encodeURIComponent(card.id) + '&returnTo=' + encodeURIComponent(returnTo);
    }
    if (suspendEl) {
      suspendEl.hidden = false;
      suspendEl.disabled = false;
    }
    if (meterEl?.style) meterEl.style.width = `${Math.round(((previousSteps + index) / Math.max(previousSteps + queue.length, 1)) * 100)}%`;
    remainingEl.textContent = String(queue.length - index);
    revealed = false;
    shownAt = Date.now();
  }

  function reveal() {
    if (restoring || revealed || !current()) return;
    revealed = true;
    const card = current();
    let answerEl = backEl;
    const clozeEl = card.question ? frontEl.querySelector('.cloze-question') : null;
    if (clozeEl) {
      // 挖空卡：把填好的句子换到题面的位置，答案高亮。题目和答案在同一处，眼睛不用挪。
      clozeEl.innerHTML = card.back;
      clozeEl.classList.add('is-revealed');
      answerEl = clozeEl;
    } else {
      backEl.hidden = false;
    }
    revealBtn.hidden = true;
    ratingsEl.hidden = false;
    // 焦点交给复习区（保住数字快捷键），读屏软件不会因此念出答案；用一个播报区念一遍。
    const announcer = document.getElementById('review-announcer');
    if (announcer) announcer.textContent = '答案：' + String(answerEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // Windows 隐藏按钮后可能仍保留焦点，显式交还给复习区域以恢复数字快捷键。
    root.focus({ preventScroll: true });
    checkpoint();
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
    if (!card || !revealed || suspending || undoing) return;

    const payload = {
      eventId: createEventId(),
      cardId: card.id,
      rating,
      elapsedMs: Date.now() - shownAt
    };
    pendingAnswers += 1;
    updateBusyState();
    // 「忘了」的卡在这一轮末尾再出现一次，直到想起来为止；随时可以离开，评分都已记录。
    const entry = {
      card,
      index,
      payload,
      relearnAdded: rating === 1,
      firstRelearn: rating === 1 && !relearnedCards.has(card.id),
      saved: null
    };
    if (rating === 1) {
      queue.push({ ...card, relearn: true });
      relearnedCards.add(card.id);
    }
    index += 1;
    lastAnswer = entry;
    updateUndo();
    render();
    // 鼠标评分后隐藏的评分按钮可能仍持有焦点，令空格、数字键和 Z 被当成
    // 按钮输入而跳过。下一张以及最后一张的保存期间，都交回仍可见的复习区。
    root.focus({ preventScroll: true });

    // 后一张可以立即作答，写入必须等前一张（含重试）结束，和服务端的撤销顺序一致。
    entry.saved = saveTail ? saveTail.then(() => submitAnswer(payload)) : submitAnswer(payload);
    saveTail = entry.saved;
    try {
      if (await entry.saved) {
        revisions.set(card.id, (revisions.get(card.id) || 0) + 1);
        window.workstationReviewCounts?.refresh();
        answered += 1;
        reviewedCards.set(card.id, (reviewedCards.get(card.id) || 0) + 1);
      } else {
        entry.failed = true;
      }
    } finally {
      if (saveTail === entry.saved) saveTail = null;
      pendingAnswers -= 1;
      updateBusyState();
      if (!current()) render();
      checkpoint();
    }
  }

  /**
   * 撤销上一张：记录这次评分已作废，回到那张卡的正面重新作答。
   * 评分还在保存就等它落盘；没保存上的那种不用找服务端，直接退回去。
   */
  async function undoLast() {
    const entry = lastAnswer;
    if (!entry || undoing || suspending) return;
    undoing = true;
    updateBusyState();
    updateUndo();
    for (const button of ratingsEl.querySelectorAll('[data-rating]')) button.disabled = true;
    if (suspendEl) suspendEl.disabled = true;
    try {
      const saved = await entry.saved;
      if (saved) {
        const response = await fetch('/review/undo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ eventId: entry.payload.eventId })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || `撤销失败（${response.status}）`);
        revisions.set(entry.card.id, Math.max(0, (revisions.get(entry.card.id) || 0) - 1));
        window.workstationReviewCounts?.refresh();
        answered = Math.max(0, answered - 1);
        const count = (reviewedCards.get(entry.card.id) || 0) - 1;
        if (count > 0) reviewedCards.set(entry.card.id, count);
        else reviewedCards.delete(entry.card.id);
      } else {
        failedAnswers.delete(entry.payload.eventId);
        updateSaveNotice();
      }
      if (entry.relearnAdded) {
        // 「忘了」时排到队尾的那一份重学也一并拿掉。
        for (let position = queue.length - 1; position >= index; position -= 1) {
          if (queue[position].id === entry.card.id && queue[position].relearn) {
            queue.splice(position, 1);
            break;
          }
        }
        if (entry.firstRelearn) relearnedCards.delete(entry.card.id);
      }
      index = entry.index;
      lastAnswer = null;
      // 撤销后还会再评一次，结束时要重新同步。
      anySynced = false;
      syncVersion += 1;
      syncMessage = '';
      render();
      root.focus({ preventScroll: true });
    } catch (error) {
      window.workstationUI?.notify?.(error.message, { type: 'error' });
    } finally {
      undoing = false;
      updateBusyState();
      for (const button of ratingsEl.querySelectorAll('[data-rating]')) button.disabled = false;
      if (suspendEl) suspendEl.disabled = false;
      updateUndo();
      checkpoint();
    }
  }
  undoEl?.addEventListener('click', undoLast);
  undoLastEl?.addEventListener('click', undoLast);

  async function finish() {
    if (reviewedCards.size === 0 && failedAnswers.size === 0 && !lastAnswer && emptyEl) {
      // 中途建卡、暂停或其他设备改动后，以服务端此刻的同组队列决定下一张。
      restoring = true;
      root.hidden = true;
      doneEl.hidden = true;
      emptyEl.hidden = true;
      token = '';
      returnTo = baseReturnTo;
      round?.write(null);
      history.replaceState(history.state, '', baseReturnTo);
      window.workstationNavigation?.remember?.();
      try {
        const { cards } = await window.workstationUI.requestJson(baseReturnTo, { cache: 'no-store' });
        queue = cards;
        index = 0;
        previousSteps = 0;
        anySynced = false;
        syncMessage = '';
        revisions.clear();
        relearnedCards.clear();
        restoring = false;
        if (queue.length) startNewRound();
        else emptyEl.hidden = false;
        if (document.activeElement === document.body || root.contains(document.activeElement)) {
          (queue.length ? root : emptyEl).focus({ preventScroll: true });
        }
      } catch {
        showReadError('未能读取当前复习队列。', baseReturnTo);
      }
      return;
    }
    root.hidden = true;
    doneEl.hidden = false;
    summaryEl.textContent = relearnedCards.size
      ? `复习了 ${reviewedCards.size} 张，其中 ${relearnedCards.size} 张本轮重学过。`
      : `复习了 ${reviewedCards.size} 张。`;
    summaryEl.textContent += syncMessage;
    if (doneTitle) doneTitle.textContent = failedAnswers.size ? '部分评分未保存' : '这一轮复习完了';
    updateSaveNotice();
    doneEl.focus();

    // 复习完成后立即提交事件日志，避免等到下一轮定时同步。
    if (answered > 0 && !anySynced) {
      anySynced = true;
      let message;
      const version = ++syncVersion;
      try {
        const response = await fetch('/review/sync', { method: 'POST' });
        if (!response.ok) throw new Error(String(response.status));
        const result = await response.json();
        if (result.ok === true && result.pushed === true) {
          message = ' 记录已同步。';
        } else if (result.ok === true && result.committed === true && result.pushed === false) {
          message = ' 记录已提交但尚未推送，仍保留在本地。';
        } else if (result.ok === true && result.skipped) {
          message = ` ${result.skipped}，记录仍保留在本地。`;
        } else if (result.ok === true) {
          message = ' 没有需要同步的改动，记录仍保留在本地。';
        } else if (result.blocked === 'recovery-required') {
          message = ' Git 正在等待恢复，记录仍保留在本地。';
        } else if (result.blocked === 'remote-branch-missing') {
          message = ' 远端还没有这个分支，先做一次完整同步再试，记录仍保留在本地。';
        } else if (result.blocked === 'staged-current-review') {
          message = ' 当前设备的复习日志已在 Git 暂存区；请先提交或取消暂存，记录仍保留在本地。';
        } else if (result.blocked) {
          message = ' 同步因安全检查被阻止，记录仍保留在本地。';
        } else {
          message = ' 同步失败，记录仍保留在本地。';
        }
      } catch {
        message = ' 记录已存在本地，同步失败。';
      }
      // 同步返回前可能已撤销或回到答题，过期回包不能修改新一轮的摘要。
      if (version === syncVersion && root.hidden) {
        syncMessage = message;
        summaryEl.textContent += message;
        checkpoint();
      }
    }
  }

  // 导航或退出会终止内存中的评分重试，待落盘时沿用编辑器的离开保护。
  window.addEventListener('beforeunload', event => {
    if (pendingAnswers === 0 && !undoing && !suspending) return;
    if (window.workstationDialog?.mayLeave(event)) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // 暂停当前这张：从本轮队列里拿掉（包括排在后面的重学），复习记录保留。
  let suspending = false;
  async function suspendCurrent() {
    const card = current();
    if (!card || !suspendEl || suspending || undoing) return;
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
      // 暂停改了队列，上一张的撤销不再对得上位置。
      lastAnswer = null;
      updateUndo();
      window.workstationReviewCounts?.refresh();
      window.workstationUI?.notify?.('已暂停这张卡，可以在卡组的卡片列表里恢复。', { type: 'success' });
      render();
      // 禁用按钮可能保留焦点，也可能退回 body；用户已移到其他控件时则不抢焦点。
      if (!root.hidden && (document.activeElement === suspendEl || document.activeElement === document.body)) {
        root.focus({ preventScroll: true });
      }
    } catch (error) {
      suspendEl.disabled = false;
      window.workstationUI?.notify?.(error.message, { type: 'error' });
    } finally {
      suspending = false;
      checkpoint();
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
    } else if (event.key === 'z' || event.key === 'Z') {
      if (!lastAnswer) return;
      event.preventDefault();
      undoLast();
    }
  });

  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  start();
})();
