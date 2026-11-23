// 笔记里指向附件的链接（`[原图](attachments/fig.png)`、`![[录音.mp3]]`）点下去，
// 如果让主窗口直接导航到原始文件，页面就只剩一张图或一个播放条：没有侧栏，
// 桌面应用也没有后退按钮，只能重启。这类地址改成交给系统默认应用打开。
//
// 只认服务端 resourceRoutes 提供的两个前缀和那里允许的扩展名，其余地址照常导航。

const RESOURCE_PREFIXES = Object.freeze({ '/attachments/': 'attachments', '/media/': 'audio' });
const RESOURCE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp3|m4a|wav|ogg|opus|flac|webm|mp4|mov)$/i;

/**
 * 地址是本应用的附件时返回 { relative }（资料库内的正斜杠路径）；
 * 是附件前缀但路径不安全时返回 { invalid: true }；其它地址返回 null。
 */
function resourceTarget(value, origin) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!origin || url.origin !== origin) return null;
  const prefix = Object.keys(RESOURCE_PREFIXES).find(candidate => url.pathname.startsWith(candidate));
  if (!prefix) return null;
  let segments;
  try {
    segments = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent);
  } catch {
    return { invalid: true };
  }
  // 先拆再解码：%2F 解出来的斜杠会把 a/../../.git 塞进一个段里，所以解码后的段也不许带斜杠。
  const unsafe = segment => !segment || segment.startsWith('.') || /[/\\\0:]/.test(segment);
  if (segments.length === 0 || segments.some(unsafe)) return { invalid: true };
  const relative = `${RESOURCE_PREFIXES[prefix]}/${segments.join('/')}`;
  if (!RESOURCE_EXTENSION.test(relative)) return null;
  return { relative };
}

module.exports = { resourceTarget, RESOURCE_PREFIXES, RESOURCE_EXTENSION };
