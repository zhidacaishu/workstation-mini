async function windowVetoesUnload(window) {
  if (!window || window.isDestroyed()) return false;
  try {
    const vetoed = await window.webContents.executeJavaScript(`(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return !window.dispatchEvent(event) || event.defaultPrevented || event.returnValue !== true;
    })()`);
    return window.isDestroyed() || window.webContents?.isDestroyed?.() ? false : vetoed;
  } catch (error) {
    if (window.isDestroyed() || window.webContents?.isDestroyed?.()) return false;
    throw error;
  }
}

function createQuitCoordinator({ getWindows, onAccepted, onCancelled = () => {} } = {}) {
  let state = 'idle';
  let requestPromise = null;

  function activeWindows() {
    return getWindows().filter(window => window && !window.isDestroyed());
  }

  function reveal(window) {
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
  }

  function request() {
    if (requestPromise) return requestPromise;

    state = 'deciding';
    requestPromise = (async () => {
      for (const window of activeWindows()) {
        const vetoed = await windowVetoesUnload(window);
        if (vetoed) {
          reveal(window);
          state = 'idle';
          onCancelled(window);
          return { cancelled: true };
        }
      }

      state = 'accepted';
      return onAccepted();
    })().catch(error => {
      state = 'idle';
      throw error;
    }).finally(() => {
      if (state === 'idle') requestPromise = null;
    });
    return requestPromise;
  }

  return {
    request,
    isAccepted: () => state === 'accepted'
  };
}

module.exports = { createQuitCoordinator, windowVetoesUnload };
