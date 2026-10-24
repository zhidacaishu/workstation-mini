const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parsePages, planAssets, planMissingAssets, verifyAssets } = require('../scripts/release-assets');

test('分页资产只暴露安全 id、basename 与 size', () => {
  assert.deepEqual(parsePages(JSON.stringify([
    [{ id: 2, name: 'setup.exe', size: 10 }],
    [{ id: 4, name: 'latest.yml', size: 20 }]
  ])), [
    { id: 2, name: 'setup.exe', size: 10 },
    { id: 4, name: 'latest.yml', size: 20 }
  ]);
  for (const invalid of [
    {},
    [[{ id: 0, name: 'x', size: 1 }]],
    [[{ id: 1, name: '../x', size: 1 }]],
    [[{ id: 1, name: 'x', size: -1 }]]
  ]) assert.throws(() => parsePages(JSON.stringify(invalid)), /invalid/i);
});

test('远端资产名称与大小必须和本地白名单完全一致', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-release-assets-'));
  try {
    const first = path.join(root, 'setup.exe');
    const second = path.join(root, 'latest.yml');
    await fs.writeFile(first, 'installer');
    await fs.writeFile(second, 'metadata');
    const exact = [
      { id: 1, name: 'latest.yml', size: 8 },
      { id: 2, name: 'setup.exe', size: 9 }
    ];
    await assert.doesNotReject(() => verifyAssets(exact, [first, second]));
    assert.deepEqual(await planMissingAssets([exact[0]], [first, second]), [first]);
    assert.deepEqual(await planAssets([exact[0]], [first, second]), {
      existing: [{ id: 1, file: second }],
      missing: [first]
    });
    await assert.rejects(() => planMissingAssets([...exact, { id: 3, name: 'stale.zip', size: 1 }], [first, second]), /unexpected or mismatched/);
    await assert.rejects(() => verifyAssets([...exact, { id: 3, name: 'stale.zip', size: 1 }], [first, second]), /unexpected or mismatched/);
    await assert.rejects(() => verifyAssets(exact.map(item => item.name === 'setup.exe' ? { ...item, size: 10 } : item), [first, second]), /unexpected or mismatched/);
    await assert.rejects(() => verifyAssets([...exact, { id: 4, name: 'setup.exe', size: 9 }], [first, second]), /duplicate/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
