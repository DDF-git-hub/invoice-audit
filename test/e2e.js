// 端到端测试：真正启动软件，上传全部模拟发票，等识别完成后检查台账里的结果，并截图。
// 云端用 xvfb-run 运行：xvfb-run -a npm run test:e2e
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright-core');
const { compare, KEYS } = require('./compare.js');

const root = path.join(__dirname, '..');
const dir = path.join(__dirname, 'fixtures');
const out = path.join(root, 'test-output');
const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
fs.mkdirSync(out, { recursive: true });

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-audit-'));
  const errors = [];
  const app = await electron.launch({
    executablePath: require('electron'), args: [root, '--no-sandbox'], cwd: root, timeout: 90000,
    env: Object.assign({}, process.env, { INVOICE_AUDIT_USERDATA: ud })
  });
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [页面 ' + m.type() + '] ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => { errors.push(e.message); console.log('  [页面错误] ' + e.message); });
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.waitForSelector('.tiles', { timeout: 60000 });
  console.log('软件已启动：' + page.url());

  // 清空示例数据，只保留这次上传的发票
  await page.click('[data-act="clear"]');
  await page.click('[data-act="clear-yes"]');

  const names = Object.keys(exp).filter((k) => !k.startsWith('_'));
  await page.setInputFiles('#fileInput', names.map((n) => path.join(dir, n)));
  console.log('已上传 ' + names.length + ' 张，等待识别……');
  const t0 = Date.now();
  const timer = setInterval(async () => {
    const s = await page.evaluate(() => { const p = document.querySelector('.progress'); return p ? p.textContent : ''; }).catch(() => '');
    console.log('  ' + Math.round((Date.now() - t0) / 1000) + 's ' + s.replace(/\s+/g, ' ').trim());
  }, 20000);
  // 软件的安全策略不允许 eval，这里用 evaluate 轮询，不用 waitForFunction
  for (;;) {
    const done = await page.evaluate(() => !document.querySelector('.progress') && !document.querySelector('.chip.idle') && document.querySelectorAll('tr[data-open]').length > 0);
    if (done) break;
    if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('识别超过 20 分钟没有完成');
    await page.waitForTimeout(1500);
  }
  clearInterval(timer);
  console.log('识别完成，用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, '01-台账.png'), fullPage: true });

  const ledger = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
  let mustFail = 0, okFields = 0, allFields = 0;
  const report = [];
  for (const name of names) {
    const inv = ledger.invoices.find((i) => i.file === name);
    const e = exp[name];
    const isImage = /\.(png|jpg)$/.test(name);
    if (!inv) { console.log('  ✗ ' + name + '  台账里没有这张'); mustFail++; continue; }
    const bad = inv.status === 'ready' ? compare(inv.f, e) : KEYS.filter((k) => k in e).map((k) => ({ k, got: '(识别失败)', want: e[k] }));
    const methodOk = inv.method === e.method;
    const keys = KEYS.filter((k) => k in e);
    okFields += keys.length - bad.length; allFields += keys.length;
    const pass = !bad.length && methodOk;
    if (!pass && !isImage) mustFail++;
    report.push({ name, method: inv.method, conf: inv.conf, status: inv.status, err: inv.err, notes: inv.aiNotes, bad });
    console.log((pass ? '  ✓ ' : isImage ? '  △ ' : '  ✗ ') + name.padEnd(30) + ' 方式 ' + inv.method + (methodOk ? '' : '（应为 ' + e.method + '）') + '  置信度 ' + inv.conf +
      '  字段 ' + (keys.length - bad.length) + '/' + keys.length + (inv.err ? '  错误：' + inv.err : '') + (inv.aiNotes ? '  备注：' + inv.aiNotes : '') +
      (bad.length ? '\n      ' + bad.map((b) => b.k + ': ' + JSON.stringify(b.got) + ' ≠ ' + JSON.stringify(b.want)).join(' | ') : ''));
  }
  console.log('全部字段准确率：' + okFields + '/' + allFields + '（' + Math.round(okFields / allFields * 100) + '%）');

  // 截两张复核页：一张 PDF、一张照片
  for (const [file, shot] of [['sdp-canyin.pdf', '02-复核-PDF.png'], ['sdp-zhuanpiao-photo.jpg', '03-复核-照片.png'], ['sdp-canyin-screenshot.png', '04-复核-截图.png']]) {
    const inv = ledger.invoices.find((i) => i.file === file);
    if (!inv) continue;
    await page.evaluate((id) => { location.hash = 'review-' + id; }, inv.id);
    await page.waitForSelector('#rv-checks', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, shot), fullPage: true });
  }
  await page.evaluate(() => { location.hash = 'ai'; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, '05-AI设置.png'), fullPage: true });

  fs.writeFileSync(path.join(out, 'e2e-report.json'), JSON.stringify(report, null, 2));
  await app.close();
  if (errors.length) { console.log('页面有 ' + errors.length + ' 个脚本错误'); mustFail++; }
  console.log(mustFail ? '\n有 ' + mustFail + ' 项必须通过的检查失败' : '\n必须通过的检查全部通过');
  process.exit(mustFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
