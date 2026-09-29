/*
 * توحيد صيغة الأوقات: 'YYYY-MM-DD HH:MM:SS' بالتوقيت المحلي —
 * نفس ما يخرجه datetime('now','localtime') في SQLite، وهو ما كانت
 * PostgreSQL ترجعه، وأحد الصيغ التي يقبلها محلّل lib/format.js.
 *
 * الصيغة ثابتة الطول، فالمقارنة النصية (BETWEEN) = مقارنة زمنية صحيحة.
 */

const pad = (n) => String(n).padStart(2, "0");
const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function format(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * يقبل: ISO (بـ Z أو بإزاحة)، 'YYYY-MM-DD HH:mm:ss'، 'YYYY-MM-DD'،
 * epoch (رقم أو نص)، أو Date. يرجّع fallback لو القيمة غير صالحة.
 */
function toLocalStamp(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? fallback : format(value);

  const raw = String(value).trim();
  if (LOCAL_STAMP.test(raw)) return raw; // بالفعل بالصيغة المحلية

  const date = /^\d{10,13}$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(date.getTime()) ? fallback : format(date);
}

function nowStamp() {
  return format(new Date());
}

module.exports = { toLocalStamp, nowStamp };
