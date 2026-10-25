const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 本地时区的 YYYY-MM-DD。
 *
 * 使用本地时间而不是 UTC，避免在东八区凌晨落到前一天。
 */
function toLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = { WEEKDAYS, toLocalDate };
