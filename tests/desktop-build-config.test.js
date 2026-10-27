const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const { build } = require('../package.json');

test('macOS 目标只出 arm64 DMG，且不参与更新分发', () => {
  assert.deepEqual(build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(build.mac.identity, '-');
  assert.equal(build.mac.artifactName, 'workstation-mini-${version}-mac-arm64.${ext}');

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
  // Mini 不包含发布/自动更新配置，构建产物由用户本地生成。
  assert.equal(build.win.publish, undefined);
  assert.equal(build.publish, undefined);
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

test('应用图标：macOS 用自带多尺寸的 icns，Windows 的 ico 覆盖 16–256', () => {
  // icns 里 16/32pt 放的是专门画的简化版；交给 electron-builder 从 png 缩，
  // 小尺寸会糊成一团。
  assert.equal(build.mac.icon, 'build/icon.icns');
  const icns = fs.readFileSync(path.join(__dirname, '..', build.mac.icon));
  assert.equal(icns.subarray(0, 4).toString('latin1'), 'icns');
  for (const type of ['icp4', 'ic11', 'icp5', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10']) {
    assert.ok(icns.includes(Buffer.from(type, 'latin1')), `icns 缺少 ${type}`);
  }

  const ico = fs.readFileSync(path.join(__dirname, '..', build.win.icon));
  const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, index) => ico[6 + index * 16] || 256);
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
});
