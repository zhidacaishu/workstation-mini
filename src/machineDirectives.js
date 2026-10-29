/**
 * 机器指令行：`<!-- workstation:<名字>:v<版本> ... -->` 独占一行。
 *
 * 旧版文献笔记里的标注标记、卡片文件里的卡片元数据都是这种形式。它们写给程序看，
 * 阅读页、全文索引和待办抽取都要先去掉。
 *
 * 去掉时保留空行而不是删掉整行：待办的行号、阅读页的 #L 行锚、阅读页上直接勾选待办，
 * 都按原文的行号定位。以前顺手把连续空行压成一行，指令下面的待办行号就会和原文对不上，
 * 勾选时改到别的行或者报冲突。
 */
const DIRECTIVE_LINE = /^[ \t]*<!--[ \t]*workstation:[\w-]+:v\d+(?:[ \t]+.*)?-->[ \t]*$/gm;

function stripMachineDirectives(markdown) {
  return String(markdown ?? '').replace(DIRECTIVE_LINE, '');
}

module.exports = { DIRECTIVE_LINE, stripMachineDirectives };
