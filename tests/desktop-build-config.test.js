const test = require('node:test');
const assert = require('node:assert/strict');

const { build } = require('../package.json');

test('macOS 目标只出 arm64 DMG，且不参与更新分发', () => {
  assert.deepEqual(build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(build.mac.identity, '-');
  assert.equal(build.mac.artifactName, 'research-workstation-${version}-mac-arm64-experimental.${ext}');

  // `publish: null` 是这里唯一让 macOS 真的不生成更新清单的开关。
  //
  // 顶层 build.publish 配了 generic provider，而 electron-builder 写更新信息
  // （dist/latest-mac.yml 和 .app 内的 app-update.yml）只看有没有 publish 配置，
  // **不看 --publish never** —— 那个参数只挡上传。少了这一行，本地 mac 构建
  // 就会产出一份没人维护、也没人验证过的更新清单，和 README「不生成
  // latest-mac.yml、不发更新请求」直接矛盾。
  assert.equal(build.mac.publish, null);
  assert.deepEqual(build.mac.binaries, ['Contents/Resources/rename-exclusive']);
  assert.deepEqual(build.mac.extraResources, [{
    from: 'build/native/darwin-${arch}/rename-exclusive',
    to: 'rename-exclusive'
  }]);
});

test('Windows 目标保留 x64 NSIS 与自身的发布配置', () => {
  assert.deepEqual(build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  // Windows 是唯一走自动更新的平台，顶层 publish 必须仍然对它生效。
  assert.equal(build.win.publish, undefined);
  assert.equal(build.publish[0].provider, 'generic');
});

test('两个平台的托盘资源都随包分发', () => {
  const shipped = new Set(build.extraResources.map(entry => entry.to));
  // Windows 用 tray.png，macOS 菜单栏用 template 版本（含 @2x）。
  // 少任何一个，createTray 会在启动时直接抛错，应用连界面都开不出来。
  for (const name of ['tray.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
    assert.equal(shipped.has(name), true, `缺少托盘资源 ${name}`);
  }
});

test('原生模块解包到 ASAR 之外', () => {
  // better-sqlite3 的 .node 在 ASAR 里加载不了，Windows 和 macOS 都一样。
  assert.deepEqual(build.asarUnpack, ['node_modules/**/*.node']);
});
