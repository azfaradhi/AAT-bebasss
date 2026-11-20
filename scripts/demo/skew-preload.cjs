// Preload for the clock-skew drill: shifts the process wall clock (Date) by the number read from SKEW_FILE; monotonic clocks are untouched, like a real NTP step.
const fs = require('node:fs');
const file = process.env.SKEW_FILE;
let cached = 0, at = 0;
const realNow = Date.now.bind(Date);
function offset() {
  const t = realNow();
  if (t - at > 50) { at = t; try { cached = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { cached = 0; } }
  return cached;
}
if (file) {
  const RealDate = Date;
  function SkewDate(...a) { return a.length ? new RealDate(...a) : new RealDate(realNow() + offset()); }
  SkewDate.prototype = RealDate.prototype;
  SkewDate.now = () => realNow() + offset();
  SkewDate.parse = RealDate.parse;
  SkewDate.UTC = RealDate.UTC;
  globalThis.Date = SkewDate;
}
