const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const DESTINATION_EXISTS_EXIT = 73;

class ExclusiveRenameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function bundledHelperPath(platform = process.platform, arch = process.arch, {
  sourceDir = __dirname,
  resourcesPath = process.resourcesPath
} = {}) {
  const packaged = sourceDir.includes(`${path.sep}app.asar${path.sep}`);
  if (platform === 'darwin' && resourcesPath && packaged) {
    return path.join(resourcesPath, 'rename-exclusive');
  }
  return path.resolve(sourceDir, '..', '..', 'build', 'native', `${platform}-${arch}`, 'rename-exclusive');
}

function destinationExistsError() {
  return new ExclusiveRenameError('destination-exists', '目标资料库目录已经存在。');
}

/**
 * 这台机器上能不能做原子激活。
 *
 * Windows 直接用内核 rename 的 no-replace 语义，不需要 helper；darwin/linux
 * 要那个编译出来的小程序。构建它需要 C 编译器，而编译器不是运行这个应用的
 * 前提条件（见 scripts/build-native-helper.js），所以「没有 helper」是一个
 * 要能被提前问出来的正常状态 —— 否则用户会一路走完恢复流程，在最后一步
 * 激活时才撞上「无法原子激活新资料库」。
 */
function isHelperAvailable({
  platform = process.platform,
  arch = process.arch,
  helperPath = null
} = {}) {
  if (platform === 'win32') return true;
  if (!['darwin', 'linux'].includes(platform)) return false;
  try {
    fs.accessSync(helperPath || bundledHelperPath(platform, arch), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function renameExclusive(sourcePath, destinationPath, {
  platform = process.platform,
  arch = process.arch,
  runner = run,
  rename = fsp.rename,
  helperPath = bundledHelperPath(platform, arch)
} = {}) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) {
    throw new ExclusiveRenameError('activation-failed', '激活路径必须是绝对路径。');
  }

  if (platform === 'win32') {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const destinationExists = await fsp.lstat(destination).then(() => true, () => false);
      if (destinationExists) throw destinationExistsError();
      throw new ExclusiveRenameError('activation-failed', '无法原子激活新资料库。');
    }
  }

  if (!['darwin', 'linux'].includes(platform)) {
    throw new ExclusiveRenameError('activation-failed', '当前平台不支持原子激活。');
  }

  try {
    await runner(helperPath, [source, destination], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 30_000
    });
  } catch (error) {
    if (Number(error?.code) === DESTINATION_EXISTS_EXIT) throw destinationExistsError();
    throw new ExclusiveRenameError('activation-failed', '无法原子激活新资料库。');
  }
}

module.exports = {
  renameExclusive,
  bundledHelperPath,
  isHelperAvailable,
  ExclusiveRenameError,
  DESTINATION_EXISTS_EXIT
};
