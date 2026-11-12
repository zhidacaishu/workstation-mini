const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 本地缺少编译器时允许继续；依赖原子恢复 helper 的用例会自行跳过。
if (process.platform === 'darwin' || process.platform === 'linux') {
  const helper = spawnSync(process.execPath, [path.join(__dirname, 'build-native-helper.js'), '--optional'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
  if (helper.error) throw helper.error;
  if (helper.status !== 0) process.exit(helper.status ?? 1);
}

const electronPath = require('electron');
const argumentsFromCli = process.argv.slice(2);
const desktopOnly = argumentsFromCli.includes('--desktop');
const forwarded = argumentsFromCli.filter(argument => argument !== '--desktop');
const miniCoreTests = [
  'guide.test.js',
  'onboarding.test.js',
  'maintenance.test.js',
  'cardManagement.test.js',
  'newNote.test.js',
  'taskToggleClient.test.js',
  'taskRules.test.js',
  'math.test.js',
  'appClient.test.js',
  'calendarHttp.test.js',
  'planHttp.test.js',
  'planClient.test.js',
  'paletteClient.test.js',
  'config.test.js',
  'dates.test.js',
  'desktop-config.test.js',
  'desktop-build-config.test.js',
  'desktop-trusted-sender.test.js',
  'desktop-platform-policy.test.js',
  'desktop-quit-coordinator.test.js',
  'desktop-resource-links.test.js',
  'desktop-vault-resolution.test.js',
  'draftsClient.test.js',
  'indexer.test.js',
  'libraryHttp.test.js',
  'health.test.js',
  'featureBoundary.test.js',
  'noteQueue.test.js',
  'reliabilityFeatures.test.js',
  'recovery.test.js',
  'recoveryClient.test.js',
  'recoveryActivation.test.js',
  'review.test.js',
  'reviewClient.test.js',
  'selectionCardClient.test.js',
  'reviewForecast.test.js',
  'items.test.js',
  'itemHttp.test.js',
  'reviewHttp.test.js',
  'segment.test.js',
  'settingsClient.test.js',
  'server.test.js',
  'sync.test.js',
  'uiRedesign.test.js',
  'vault.test.js',
  'watcher.test.js',
  // 以前不在清单里，CI 从没跑过（单独跑都能通过）。
  'ci-workflow.test.js',
  'recovery-exclusive-rename.test.js',
  'recovery-git.test.js',
  'recovery-journal.test.js',
  'testNetwork.test.js'
];
// 原生窗口共享桌面焦点，按文件串行执行；纯逻辑/配置测试只在核心集跑一次。
const desktopTests = [
  'desktop-guide.test.js',
  'desktop-math.test.js',
  'desktop-local-history-smoke.test.js',
  'desktop-ui-layout.test.js',
  'desktop-ui-details.test.js',
  'desktop-ui-actions.test.js'
];
const testFiles = (desktopOnly ? desktopTests : miniCoreTests)
  .map(name => path.join('tests', name));

function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

/**
 * 桌面 smoke test 会真开一个 Electron 窗口，没有显示服务器就起不来。
 *
 * 产品发 Windows 和 Apple Silicon macOS，但开发和 CI 都可能在无头 Linux 上跑。
 * 不管的话，那边每次全量测试都固定挂掉 smoke test 这一条 —— 红色一旦成为常态，
 * 测试就不再是信号。所以这里自动套一层 xvfb-run，让无头 Linux 也真的开出窗口。
 *
 * 只在「Linux + 确实没有显示服务器」时介入：有 DISPLAY 就说明外面已经准备好了，
 * 再包一层反而会把测试挪进一块看不见的虚拟屏幕。
 */
function virtualDisplayWrapper() {
  if (process.platform !== 'linux') return null;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return null;

  const xvfbRun = findExecutable('xvfb-run');
  if (!xvfbRun) {
    console.warn(
      '[test] 无头 Linux 且找不到 xvfb-run，桌面 smoke test 会因为没有 X server 失败。\n'
      + '[test] 装上即可（Debian/Ubuntu：sudo apt-get install -y xvfb），其余测试不受影响。'
    );
    return null;
  }
  // -a 让 xvfb 自己挑一个没被占用的显示号，免得并行跑时撞在同一个上。
  return [xvfbRun, '-a'];
}

const electronArguments = ['--require', path.join(__dirname, 'http-test-transport.cjs'), '--test', ...(desktopOnly ? ['--test-concurrency=1'] : []), ...forwarded, ...testFiles];
const wrapper = virtualDisplayWrapper();
const [command, commandArguments] = wrapper
  ? [wrapper[0], [...wrapper.slice(1), electronPath, ...electronArguments]]
  : [electronPath, electronArguments];

const result = spawnSync(command, commandArguments, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
