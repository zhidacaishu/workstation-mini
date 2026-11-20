(() => {
  function ask({ message, detail, buttons, defaultId = 0, cancelId = 0, primaryId }) {
    if (document.querySelector('.message-dialog[open]')) return Promise.resolve(cancelId);
    const previousFocus = document.activeElement;
    const highlightedId = primaryId ?? defaultId;
    const dialog = document.createElement('dialog');
    dialog.className = 'message-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', 'message-heading');
    const copy = document.createElement('div');
    copy.className = 'message-copy';
    const heading = document.createElement('h2');
    heading.id = 'message-heading';
    heading.textContent = message;
    copy.append(heading);
    if (detail) {
      const description = document.createElement('p');
      description.id = 'message-detail';
      description.textContent = detail;
      dialog.setAttribute('aria-describedby', description.id);
      copy.append(description);
    }
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    buttons.forEach((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.autofocus = index === defaultId;
      button.classList.toggle('is-primary', index === highlightedId);
      button.addEventListener('click', () => dialog.close(String(index)));
      actions.append(button);
    });
    dialog.append(copy, actions);
    document.body.append(dialog);
    const answer = new Promise(resolve => dialog.addEventListener('close', () => {
      const choice = dialog.returnValue;
      dialog.remove();
      if (previousFocus && previousFocus !== document.body && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
      resolve(choice === '' ? cancelId : Number(choice));
    }, { once: true }));
    dialog.showModal();
    return answer;
  }

  const unloadAnswers = new WeakMap();
  function mayLeave(event) {
    // 主进程也会用合成事件查询脏状态；只有真正离开页面时才在这里询问。
    if (event.type !== 'beforeunload' || !event.isTrusted) return false;
    if (!unloadAnswers.has(event)) {
      const desktop = window.workstationDesktop || window.workstationSettings;
      unloadAnswers.set(event, desktop?.confirmLeave?.() === true);
    }
    return unloadAnswers.get(event);
  }

  window.workstationDialog = {
    ask,
    mayLeave,
    confirm: async (message, detail, action) =>
      await ask({ message, detail, buttons: ['取消', action], primaryId: 1 }) === 1
  };
})();
