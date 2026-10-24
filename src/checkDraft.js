const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { promisify } = require('node:util');

const run = promisify(execFile);

// check_draft.py 的退出码，见 academic-writing 的 README。
const EXIT = { CLEAN: 0, HARD: 1, SOFT_ONLY: 2, INPUT_ERROR: 3 };

const BANNER = /^={10,}$/;
const TIER_TITLES = { 必改: 'hard', 需人工判断: 'soft' };
// [全角标点残留]  30 处
const CATEGORY = /^\[(.+?)\]\s+(\d+)\s*处\s*$/;
// 　　... 另有 5 处，同类问题
const TRUNCATED = /^\s*\.\.\.\s*另有\s*(\d+)\s*处/;
// 　　L3: '。' …context…  → note
const INSTANCE = /^\s{2}(.+?)\s*$/;
const LINE_PREFIX = /^L(\d+):\s*/;

/**
 * 解析 check_draft.py 的文本输出。
 *
 * 它没有 --json，只有给人看的排版输出，所以这里是纯文本解析。有一个坑必须处理：
 * 渲染时每个类别只打印前 25 条，然后补一行「... 另有 N 处」。
 * **表头的「N 处」才是真实数量**，实例列表是被截断的。
 *
 * 只数实例行的话，恰恰是你犯得最多的那几类错误会被系统性低估 ——
 * 而那正是错题本最该抓住的东西。所以统计一律以表头计数为准，
 * 被截掉的部分单独记成 truncated，不假装它不存在。
 */
function parseReport(text) {
  const lines = String(text ?? '').split('\n');
  const findings = [];

  let tier = '';
  let current = null;
  let expectingTitle = false;

  const flush = () => {
    if (current) findings.push(current);
    current = null;
  };

  for (const line of lines) {
    if (BANNER.test(line.trim())) {
      // 横幅成对出现，中间夹着标题行。
      expectingTitle = !expectingTitle;
      continue;
    }
    if (expectingTitle) {
      const title = line.trim();
      if (TIER_TITLES[title]) tier = TIER_TITLES[title];
      continue;
    }

    const category = line.match(CATEGORY);
    if (category) {
      flush();
      current = {
        tier,
        category: category[1].trim(),
        count: Number(category[2]),
        instances: [],
        truncated: 0
      };
      continue;
    }

    if (!current) continue;

    const truncated = line.match(TRUNCATED);
    if (truncated) {
      current.truncated = Number(truncated[1]);
      continue;
    }

    // 尾部说明不是实例。
    if (/^注：/.test(line.trim())) {
      flush();
      continue;
    }

    const instance = line.match(INSTANCE);
    if (instance && instance[1]) {
      const raw = instance[1];
      const lineMatch = raw.match(LINE_PREFIX);
      const withoutLine = raw.replace(LINE_PREFIX, '');
      const [detail, note] = withoutLine.split(/\s*→\s*/);
      current.instances.push({
        line: lineMatch ? Number(lineMatch[1]) : null,
        detail: (detail || '').trim(),
        note: (note || '').trim()
      });
    }
  }
  flush();

  return findings;
}

function isAvailable(scriptPath) {
  return Boolean(scriptPath) && fs.existsSync(scriptPath);
}

/**
 * 对一份稿件跑检查器。
 *
 * 检查器不可用时返回 available:false 而不是抛错 —— 它是外部工具，
 * 在没装 academic-writing 的机器上（比如只读实例）整个错题本不该因此瘫掉。
 */
async function checkDraft(scriptPath, filePath, { python = 'python3' } = {}) {
  if (!isAvailable(scriptPath)) {
    return { available: false, reason: `找不到检查器：${scriptPath || '(未配置)'}` };
  }

  let stdout = '';
  let code = EXIT.CLEAN;
  try {
    const result = await run(python, [scriptPath, filePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    // 退出码 1 和 2 是「发现问题」，不是运行失败 —— 这正是我们要的结果。
    if (error.code === EXIT.HARD || error.code === EXIT.SOFT_ONLY) {
      stdout = error.stdout || '';
      code = error.code;
    } else {
      return {
        available: true,
        ok: false,
        reason: String(error.stderr || error.message || '').trim() || '检查器运行失败'
      };
    }
  }

  const findings = parseReport(stdout);
  return {
    available: true,
    ok: true,
    exitCode: code,
    findings,
    hardCount: findings.filter(f => f.tier === 'hard').reduce((sum, f) => sum + f.count, 0),
    softCount: findings.filter(f => f.tier === 'soft').reduce((sum, f) => sum + f.count, 0),
    raw: stdout
  };
}

module.exports = { EXIT, parseReport, checkDraft, isAvailable };
