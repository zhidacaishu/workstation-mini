const test = require('node:test');
const assert = require('node:assert/strict');
const { resourceTarget } = require('../electron/resource-links');

const origin = 'http://127.0.0.1:41234';

test('本应用的附件和媒体地址交给系统默认应用打开', () => {
  assert.deepEqual(resourceTarget(`${origin}/attachments/fig.png`, origin), { relative: 'attachments/fig.png' });
  assert.deepEqual(resourceTarget(`${origin}/media/%E5%BD%95%E9%9F%B3.mp3`, origin), { relative: 'audio/录音.mp3' });
  assert.deepEqual(resourceTarget(`${origin}/attachments/sub/a%20b.MP4?t=1#x`, origin), { relative: 'attachments/sub/a b.MP4' });
});

test('其它地址照常导航', () => {
  assert.equal(resourceTarget(`${origin}/note/a.md`, origin), null);
  assert.equal(resourceTarget(`${origin}/attachments/paper.pdf`, origin), null, '不是附件路由提供的类型');
  assert.equal(resourceTarget('http://127.0.0.1:9/attachments/fig.png', origin), null, '别的源');
  assert.equal(resourceTarget('not a url', origin), null);
  assert.equal(resourceTarget(`${origin}/attachments/fig.png`, ''), null);
});

test('附件前缀下的不安全路径不打开', () => {
  for (const pathname of ['/attachments/..%2F..%2Fsecret.png', '/attachments/.hidden/a.png', '/attachments//a.png',
    '/attachments/a%5Cb.png', '/media/%00.mp3', '/attachments/%E0%A4%A.png', '/attachments/C:%2Fx.png']) {
    assert.deepEqual(resourceTarget(`${origin}${pathname}`, origin), { invalid: true }, pathname);
  }
});

test('编码过的斜杠不能把 .. 和点目录夹带进一个路径段', () => {
  for (const pathname of ['/attachments/a%2F..%2F..%2F.git%2Fx.png', '/attachments/a%2F.workstation-local%2Fx.png',
    '/attachments/a%2Fb.png', '/media/sub%2F..%2F..%2Fnotes%2Fx.mp3']) {
    assert.deepEqual(resourceTarget(`${origin}${pathname}`, origin), { invalid: true }, pathname);
  }
});
