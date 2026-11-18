// 页面有未保存的更改时，离开、关闭、退出都要先问一声。
//
// Electron 不会替页面弹「确定离开吗」：beforeunload 拦下以后只发一个
// will-prevent-unload 事件，没人处理就静默取消 —— 点侧栏、点「取消」、关设置窗口
// 都像没反应一样，也没有办法放弃修改。这里统一弹原生对话框。
//
// 自动化测试里没有人来点对话框：不弹，按 WORKSTATION_TEST_LEAVE_ANSWER 回答
// （leave 或 stay，默认 stay，与以前的行为一致）。

const PROMPTS = {
  main: {
    message: '有未保存的更改',
    detail: '离开这个页面，还没保存的内容就会丢失。只有编辑器提示已保存到本机的草稿，才能在「历史与草稿」里找回。',
    leave: '离开',
    stay: '留下'
  },
  settings: {
    message: '设置还没有保存',
    detail: '关闭窗口会放弃这次修改的设置。',
    leave: '放弃修改',
    stay: '继续编辑'
  },
  quit: {
    message: '有未保存的更改，仍要退出吗？',
    detail: '退出后，还没保存的内容会丢失。只有编辑器提示已保存到本机的草稿，才能在「历史与草稿」里找回。',
    leave: '仍然退出',
    stay: '取消'
  },
  restart: {
    message: '主窗口有未保存的更改',
    detail: '应用新的设置需要重新载入主窗口，还没保存的内容会丢失。请先确认编辑器已保存本机草稿。',
    leave: '仍然应用',
    stay: '取消'
  }
};

function createLeaveGuard({ dialog, isTestRun = false, testAnswer = process.env.WORKSTATION_TEST_LEAVE_ANSWER } = {}) {
  /** 返回 true 表示用户选择放弃更改、继续离开。 */
  return function confirmLeave(window, kind = 'main') {
    if (isTestRun) return testAnswer === 'leave';
    const prompt = PROMPTS[kind] || PROMPTS.main;
    const options = {
      type: 'warning',
      buttons: [prompt.leave, prompt.stay],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: prompt.message,
      detail: prompt.detail
    };
    const parent = window && !window.isDestroyed?.() ? window : undefined;
    return (parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options)) === 0;
  };
}

module.exports = { createLeaveGuard, PROMPTS };
