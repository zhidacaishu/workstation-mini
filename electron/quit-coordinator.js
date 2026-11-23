// 问页面「现在能不能离开」最多等这么久。渲染进程卡死时 executeJavaScript 永远不返回，
// 以前「退出」和「保存设置」会一直挂在这里，只能强杀。
const VETO_CHECK_TIMEOUT_MS = 3000;

async function windowVetoesUnload(window, { timeoutMs = VETO_CHECK_TIMEOUT_MS } = {}) {
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  // 渲染进程已经崩溃：页面上不会再有能保存的东西，不让它挡住退出。
  if (contents?.isCrashed?.()) return false;
  let timer;
  try {
    const check = contents.executeJavaScript(`(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return !window.dispatchEvent(event) || event.defaultPrevented || event.returnValue !== true;
    })()`);
    // 卡死的页面回答不了，当成不拦：不然退出永远没有反应。
    const vetoed = await Promise.race([check, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    return window.isDestroyed() || window.webContents?.isDestroyed?.() ? false : vetoed;
  } catch (error) {
    if (window.isDestroyed() || window.webContents?.isDestroyed?.()) return false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * confirmDiscard(window)：某个窗口有未保存的更改时问用户「仍要退出吗」，返回 true
 * 就继续退出。不传的话和以前一样：显示那个窗口、取消这次退出。
 */
function createQuitCoordinator({ getWindows, onAccepted, onCancelled = () => {}, confirmDiscard = null } = {}) {
  let state = 'idle';
  let requestPromise = null;
  let acceptedPromise = null;

  // 退出副作用只跑一次：正常裁决通过和系统结束会话（forceAccept）可能先后到来。
  function accept() {
    if (acceptedPromise) return acceptedPromise;
    state = 'accepted';
    acceptedPromise = Promise.resolve().then(onAccepted).catch(error => {
      state = 'idle';
      acceptedPromise = null;
      throw error;
    });
    return acceptedPromise;
  }

  function activeWindows() {
    return getWindows().filter(window => window && !window.isDestroyed());
  }

  function reveal(window) {
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
  }

  function request() {
    if (acceptedPromise) return acceptedPromise;
    if (requestPromise) return requestPromise;

    state = 'deciding';
    requestPromise = (async () => {
      for (const window of activeWindows()) {
        const vetoed = await windowVetoesUnload(window);
        if (acceptedPromise) return acceptedPromise;
        if (vetoed) {
          reveal(window);
          const discard = await confirmDiscard?.(window);
          if (acceptedPromise) return acceptedPromise;
          if (discard) continue;
          state = 'idle';
          onCancelled(window);
          return { cancelled: true };
        }
      }

      return accept();
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
    // 系统要结束会话（Windows 关机、重启、注销）：不再问页面，直接走退出流程；
    // 页面上的草稿已经自动保存。正在问用户的那次裁决随之作废。
    forceAccept: accept,
    isAccepted: () => state === 'accepted'
  };
}

module.exports = { createQuitCoordinator, windowVetoesUnload, VETO_CHECK_TIMEOUT_MS };
