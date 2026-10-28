// 比较识别结果和期望值，返回不一致的字段
'use strict';
const KEYS = ['no', 'code', 'date', 'buyer', 'buyerTax', 'seller', 'sellerTax', 'amount', 'tax', 'total', 'rate', 'items', 'cat', 'type'];
function compare(f, exp) {
  const bad = [];
  for (const k of KEYS) {
    if (!(k in exp)) continue;
    const e = exp[k], v = f[k];
    let ok;
    if (typeof e === 'number') ok = v != null && Math.abs(Number(v) - e) < 0.011;
    else ok = String(v == null ? '' : v) === String(e);
    if (!ok) bad.push({ k, got: v, want: e });
  }
  if (exp.lines) {
    const got = f.lines || [];
    if (got.length !== exp.lines.length) bad.push({ k: 'lines', got: got.length + ' 行', want: exp.lines.length + ' 行' });
    else exp.lines.forEach((el, i) => {
      for (const k of Object.keys(el)) {
        const e = el[k], v = got[i][k];
        const ok = typeof e === 'number' ? v != null && Math.abs(Number(v) - e) <= Math.max(0.011, Math.abs(e) * 1e-9) : String(v == null ? '' : v) === String(e);
        if (!ok) bad.push({ k: 'lines[' + i + '].' + k, got: v, want: e });
      }
    });
  }
  return bad;
}
module.exports = { compare, KEYS };
