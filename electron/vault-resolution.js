/**
 * 决定这次启动用哪个资料库。
 *
 * 这里只有决策，没有任何 Electron 依赖 —— 对话框怎么弹、目录怎么探测，
 * 全部由调用方注入。抽出来是因为这段逻辑出过两个真问题（启动时静默换库、
 * 取消选择时清空已保存路径），而它原本埋在 main.js 里，
 * 是全项目唯一测不到的地方。
 *
 * **不变量：已经保存过资料库时，绝不返回空路径，也绝不自己换一个目录。**
 * 资料库放在移动硬盘、网络位置或云盘上是常态，开机自启时它们经常还没准备好。
 * 静默退回约定目录会让笔记写进错的库，并把它推到错的远端 —— 而且毫无提示。
 * 所以路径不可用时只有四条出路：等它回来、由人另选一个、恢复到新目录、退出。
 */

function cleanPath(value) {
  return String(value ?? '').trim();
}

/**
 * 已保存的资料库这次访问不到时的问答循环。
 *
 * 注意「另选目录又取消」要回到三选一，而不是掉出循环 ——
 * 掉出去就只剩「返回空路径」这一种表达，那正是清空已保存配置的老毛病。
 */
async function resolveMissingVault(missingPath, { pathExists, askMissingVault, promptForDirectory }) {
  for (;;) {
    const answer = await askMissingVault(missingPath);
    if (answer === 'quit') return { quit: true };

    if (answer === 'choose') {
      const chosen = cleanPath(await promptForDirectory('replace'));
      if (chosen) return { vaultDir: chosen };
      continue;
    }

    if (answer === 'restore') return { restore: true, missingVaultDir: missingPath };

    // 'retry'，以及任何意料之外的答复。宁可多问一次，
    // 也不能把「没看懂的回答」变成悄悄换库或清空路径。
    if (pathExists(missingPath)) return { vaultDir: missingPath };
  }
}

/**
 * @param {object} options
 * @param {string} options.savedVaultDir      上次保存的资料库；没有则空串
 * @param {string} options.conventionalVaultDir 约定位置（用户目录下的 workstation-vault）
 * @param {(target: string) => boolean} options.pathExists
 * @param {(missingPath: string) => Promise<'retry'|'choose'|'restore'|'quit'>} options.askMissingVault
 * @param {(purpose: 'replace') => Promise<string>} options.promptForDirectory
 *        返回选中的目录；用户取消时返回空串
 * @returns {Promise<{vaultDir: string} | {firstRun: true} | {restore: true, missingVaultDir: string} | {quit: true}>}
 */
async function resolveVaultDir({
  savedVaultDir = '',
  conventionalVaultDir = '',
  pathExists,
  askMissingVault,
  promptForDirectory
}) {
  const saved = cleanPath(savedVaultDir);
  if (saved) {
    if (pathExists(saved)) return { vaultDir: saved };
    return resolveMissingVault(saved, { pathExists, askMissingVault, promptForDirectory });
  }

  // 还没保存过任何资料库：认一下约定位置，认不到就进入明确的首次启动流程。
  const conventional = cleanPath(conventionalVaultDir);
  if (conventional && pathExists(conventional)) return { vaultDir: conventional };

  return { firstRun: true };
}

module.exports = { resolveVaultDir };
