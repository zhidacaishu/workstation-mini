(() => {
  const list = document.getElementById('cues');
  const player = document.getElementById('player');
  const ui = window.workstationUI;
  const transcribe = document.getElementById('transcribe');

  if (transcribe) {
    const status = document.getElementById('transcribe-status');
    transcribe.addEventListener('click', async () => {
      transcribe.disabled = true;
      transcribe.setAttribute('aria-busy', 'true');
      status.hidden = false;
      status.classList.remove('is-error');
      status.textContent = '正在转写，长音频可能要几分钟…';
      try {
        const result = await ui.requestJson(`${window.location.pathname}/transcribe`, {
          method: 'POST',
          json: { language: 'en' },
          fallbackMessage: '转写失败'
        });
        status.textContent = `生成了 ${result.cues} 句，正在载入字幕…`;
        window.location.reload();
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('is-error');
        transcribe.disabled = false;
      } finally {
        transcribe.removeAttribute('aria-busy');
      }
    });
  }

  if (!list || !player) return;

  let cues = [];
  try { cues = JSON.parse(decodeURIComponent(list.dataset.cues || '[]')); } catch { cues = []; }
  if (cues.length === 0) return;

  const items = [...list.querySelectorAll('li')];
  const loopBox = document.getElementById('loop');
  const rateBox = document.getElementById('rate');
  const hideBox = document.getElementById('hide');
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let index = 0;
  let seeking = false;

  function setActive(i, { scroll = false } = {}) {
    index = Math.max(0, Math.min(cues.length - 1, i));
    items.forEach((element, itemIndex) => element.classList.toggle('is-active', itemIndex === index));
    if (scroll) items[index].scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function cueAt(time) {
    const found = cues.findIndex(cue => time >= cue.start && time < cue.end);
    if (found >= 0) return found;
    const upcoming = cues.findIndex(cue => time < cue.start);
    return upcoming >= 0 ? upcoming : cues.length - 1;
  }

  function play(i) {
    setActive(i, { scroll: true });
    player.currentTime = cues[index].start;
    player.play().catch(() => {});
  }

  setActive(cueAt(player.currentTime));
  player.addEventListener('play', () => setActive(cueAt(player.currentTime)));
  player.addEventListener('seeking', () => { seeking = true; });
  player.addEventListener('seeked', () => {
    seeking = false;
    setActive(cueAt(player.currentTime), { scroll: true });
  });
  player.addEventListener('timeupdate', () => {
    if (seeking) return;
    const cue = cues[index];
    if (!cue || player.currentTime < cue.end) return;
    if (loopBox?.checked) {
      player.currentTime = cue.start;
    } else if (index < cues.length - 1) {
      play(index + 1);
    } else {
      player.pause();
    }
  });

  rateBox?.addEventListener('change', () => { player.playbackRate = Number(rateBox.value) || 1; });
  hideBox?.addEventListener('change', () => { list.classList.toggle('is-hidden', hideBox.checked); });

  items.forEach((element, itemIndex) => {
    element.querySelector('[data-play-cue]')?.addEventListener('click', () => play(itemIndex));
  });

  document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const active = document.activeElement;
    const isInteractiveTarget = ui.isInteractiveTarget || (target => {
      const tag = target?.tagName;
      return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'AUDIO', 'VIDEO'].includes(tag)
        || Boolean(target?.isContentEditable);
    });
    if (isInteractiveTarget(active)) return;
    if ((ui.hasOpenDialog || (() => Boolean(document.querySelector('dialog[open]'))))()) return;

    if (event.key === ' ') { event.preventDefault(); player.paused ? player.play() : player.pause(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); play(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); play(index - 1); }
    else if (event.key?.toLowerCase() === 'r') { event.preventDefault(); play(index); }
  });

  for (const button of list.querySelectorAll('[data-make-card]')) {
    button.addEventListener('click', async () => {
      const cue = cues[Number(button.dataset.makeCard)];
      if (!cue) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        const result = await ui.requestJson('/cards/add', {
          method: 'POST',
          json: { front: cue.text, back: '', deckFile: 'listening', type: 'en-phrase' },
          fallbackMessage: '建卡失败'
        });
        button.textContent = '已建卡';
        ui.notify(`已存到 ${result.path}`);
      } catch (error) {
        button.disabled = false;
        ui.notify(error.message, { type: 'error' });
      } finally {
        button.removeAttribute('aria-busy');
      }
    });
  }
})();
