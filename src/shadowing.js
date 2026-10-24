const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

const AUDIO_DIR = 'audio';

/**
 * SRT 解析。
 *
 * 影子跟读要的是「一句一句循环」，所以字幕的价值全在时间戳上 ——
 * 每句的起止决定了循环区间。解析失败的块直接跳过，一条坏时间轴不该
 * 让整份字幕报废。
 */
function parseSrt(text) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    // 第一行可能是序号，也可能直接是时间轴。
    const timingLine = lines.find(line => line.includes('-->'));
    if (!timingLine) continue;

    const match = timingLine.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!match) continue;

    const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);
    if (!(end > start)) continue;

    const textLines = lines.slice(lines.indexOf(timingLine) + 1);
    const cueText = textLines.join(' ').trim();
    if (!cueText) continue;

    cues.push({ index: cues.length, start, end, text: cueText });
  }
  return cues;
}

function isAvailable(binaryPath) {
  return Boolean(binaryPath) && fs.existsSync(binaryPath);
}

/**
 * 用 whisper.cpp 把音频转成 SRT。
 *
 * 选 whisper.cpp 而不是 faster-whisper：单个自包含二进制、无 Python 依赖、
 * `--output-srt` 直接出字幕、CPU 能跑、Windows 和 macOS 同一套用法。
 * 对「本地优先 + 双系统」这个前提，这些都是硬需求。
 *
 * 找不到二进制或模型时降级返回，不抛错 —— 已经有字幕的素材照样能练。
 */
async function transcribe(binaryPath, modelPath, audioPath, { language = 'en', timeoutMs = 30 * 60_000 } = {}) {
  if (!isAvailable(binaryPath)) {
    return { available: false, reason: `找不到 whisper.cpp：${binaryPath || '(未在应用设置中选择)'}` };
  }
  if (!isAvailable(modelPath)) {
    return { available: false, reason: `找不到 whisper 模型：${modelPath || '(未在应用设置中选择)'}` };
  }

  const outputBase = audioPath.replace(/\.[^.]+$/, '');
  try {
    await run(binaryPath, [
      '-m', modelPath,
      '-f', audioPath,
      '-l', language,
      '--output-srt',
      '--output-file', outputBase
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    return { available: true, ok: false, reason: String(error.stderr || error.message).trim() || '转写失败' };
  }

  const srtPath = `${outputBase}.srt`;
  try {
    const srt = await fsp.readFile(srtPath, 'utf8');
    return { available: true, ok: true, srtPath, cues: parseSrt(srt) };
  } catch {
    return { available: true, ok: false, reason: '转写完成但没找到生成的 SRT' };
  }
}

/** 列出可跟读的素材：audio/ 下每个目录一份，需要音频 + 同名字幕。 */
async function listClips(vaultDir) {
  const root = path.join(vaultDir, AUDIO_DIR);
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const clips = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    const files = await fsp.readdir(dir);

    const audio = files.find(name => /\.(m4a|mp3|wav|ogg|opus|flac|webm)$/i.test(name));
    const srt = files.find(name => /\.srt$/i.test(name));
    if (!audio) continue;

    let cues = [];
    if (srt) {
      try {
        cues = parseSrt(await fsp.readFile(path.join(dir, srt), 'utf8'));
      } catch {
        cues = [];
      }
    }
    clips.push({ id: entry.name, audio: `${AUDIO_DIR}/${entry.name}/${audio}`, hasSubtitles: Boolean(srt), cueCount: cues.length });
  }
  return clips.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadClip(vaultDir, clipId) {
  const clips = await listClips(vaultDir);
  const clip = clips.find(entry => entry.id === clipId);
  if (!clip) return null;

  const dir = path.join(vaultDir, AUDIO_DIR, clipId);
  const files = await fsp.readdir(dir);
  const srt = files.find(name => /\.srt$/i.test(name));
  const cues = srt ? parseSrt(await fsp.readFile(path.join(dir, srt), 'utf8')) : [];
  return { ...clip, cues };
}

module.exports = { AUDIO_DIR, parseSrt, transcribe, listClips, loadClip, isAvailable };
