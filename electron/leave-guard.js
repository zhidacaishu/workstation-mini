// 页面有未保存的更改时，离开、关闭、退出都要先问一声。
//
// 平常由独立的消息窗口接收选择。自动化可指定 leave / stay，或用 prompt 操作真实弹窗。

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

function createLeaveGuard({ showMessage, isTestRun = false, testAnswer = process.env.WORKSTATION_TEST_LEAVE_ANSWER } = {}) {
  /** 返回 true 表示用户选择放弃更改、继续离开。 */
  return async function confirmLeave(window, kind = 'main') {
    if (isTestRun && testAnswer !== 'prompt') return testAnswer === 'leave';
    const prompt = PROMPTS[kind] || PROMPTS.main;
    const options = {
      buttons: [prompt.leave, prompt.stay],
      defaultId: 1,
      cancelId: 1,
      message: prompt.message,
      detail: prompt.detail
    };
    return await showMessage(window, options) === 0;
  };
}

module.exports = { createLeaveGuard, PROMPTS };
