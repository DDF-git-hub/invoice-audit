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
    env: Object.assign({}, process.env, { INVOICE_AUDIT_USERDATA: ud, INVOICE_AUDIT_EXPORT_DIR: path.join(ud, 'export') }, process.env.MAIL_TEST ? { INVOICE_AUDIT_MAIL_NO_SEARCH: '1' } : {})
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

  // ---------- 邮箱收票（云端有测试邮箱时运行） ----------
  if (process.env.MAIL_TEST) {
    console.log('\n[邮箱收票]');
    const { seed, TO, ZHANG } = require('./mail-seed.js');
    const s = await seed(Number(process.env.MAIL_SMTP_PORT || 3025));
    const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) mustFail++; };
    const waitIdle = async (sel, ms) => {
      const t1 = Date.now();
      for (;;) {
        if (await page.evaluate((q) => !!document.querySelector(q), sel)) return true;
        if (Date.now() - t1 > ms) return false;
        await page.waitForTimeout(500);
      }
    };
    await page.evaluate(() => { location.hash = 'mail'; });
    await page.waitForSelector('#mail-preset');
    await page.selectOption('#mail-preset', 'custom');
    await page.fill('#mail-user', TO);
    await page.fill('#mail-pass', 'test-password');
    await page.fill('#mail-host', '127.0.0.1');
    await page.fill('#mail-port', String(process.env.MAIL_IMAP_PORT || 3143));
    await page.uncheck('#mail-secure');
    await page.screenshot({ path: path.join(out, '06-邮箱设置.png'), fullPage: true });
    await page.click('[data-act="mail-test"]');
    const connected = await waitIdle('[data-act="mail-edit"], .status-bad', 30000);
    const bad = await page.evaluate(() => { const b = document.querySelector('.status-bad'); return b ? b.textContent : ''; });
    check(connected && !bad, '连接测试邮箱' + (bad ? '：' + bad : ''));
    if (connected && !bad) {
      await page.fill('#mail-senders', ZHANG.address);
      await page.selectOption('#mail-days', '30');
      await page.click('[data-act="mail-scan"]');
      await page.waitForTimeout(500);
      await waitIdle('[data-act="mail-scan"]:not([disabled])', 120000);
      const r = await page.evaluate(() => ({
        msgs: document.querySelectorAll('.mailmsg').length,
        files: document.querySelectorAll('.mail-file').length,
        checked: document.querySelectorAll('.mail-file:checked').length,
        links: document.querySelectorAll('[data-act="mail-link"]').length,
        text: document.querySelector('#view').innerText,
        err: (document.querySelector('.errbox') || {}).textContent || ''
      }));
      await page.screenshot({ path: path.join(out, '07-邮件清单.png'), fullPage: true });
      check(!r.err, '检查邮件没有报错' + (r.err ? '：' + r.err : ''));
      check(r.msgs === s.expect.messages, '只列出张三的邮件：' + r.msgs + ' 封（应为 ' + s.expect.messages + '）');
      check(r.files === s.expect.files && r.checked === s.expect.files, '发票文件 ' + r.files + ' 个、默认勾选 ' + r.checked + ' 个（应为 ' + s.expect.files + '）');
      check(r.links === s.expect.deadLinks, '下载不了的链接单独列出：' + r.links + ' 个');
      check(!/lisi@|xzhangsan@|不应该被收进来/.test(r.text), '没有收进其他发件人的邮件');
      check(/发票\.pdf/.test(r.text), '压缩包里的 GBK 中文文件名正确：发票.pdf');
      await page.click('[data-act="mail-import"]');
      await page.waitForTimeout(1000);
      const t2 = Date.now();
      for (;;) {
        const done = await page.evaluate(() => !document.querySelector('.progress') && !document.querySelector('.chip.idle'));
        if (done || Date.now() - t2 > 5 * 60 * 1000) break;
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(1500);
      const led = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
      const mine = led.invoices.filter((i) => i.sender === ZHANG.address);
      check(mine.length === s.expect.files, '台账里张三提交的发票：' + mine.length + ' 张');
      check(mine.every((i) => i.senderName === ZHANG.name && i.mail && i.mail.subject), '每张都记下了提交人和邮件主题');
      const nos = mine.map((i) => i.f.no).sort();
      check(JSON.stringify(nos) === JSON.stringify(s.expect.nos.slice().sort()), '识别出的发票号码：' + nos.join('、'));
      await page.selectOption('#sender-filter', ZHANG.address).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, '08-按提交人筛选.png'), fullPage: true });
      const rows = await page.evaluate(() => document.querySelectorAll('tr[data-open]').length);
      check(rows === s.expect.files, '按提交人筛选后显示 ' + rows + ' 行');
      // 再检查一次：已经导入过的不再默认勾选
      await page.evaluate(() => { location.hash = 'mail'; });
      await page.waitForSelector('[data-act="mail-scan"]');
      await page.click('[data-act="mail-scan"]');
      await page.waitForTimeout(500);
      await waitIdle('[data-act="mail-scan"]:not([disabled])', 120000);
      const r2 = await page.evaluate(() => ({ checked: document.querySelectorAll('.mail-file:checked').length, seen: (document.querySelector('#view').innerText.match(/已导入过/g) || []).length }));
      check(r2.checked === 0 && r2.seen >= s.expect.files, '再次检查时已导入的发票标为「已导入过」且不勾选（已导入过 ' + r2.seen + '，勾选 ' + r2.checked + '）');
      await page.screenshot({ path: path.join(out, '09-再次检查.png'), fullPage: true });
      // 刚发来的邮件马上能查到
      const nodemailer = require('nodemailer');
      const tr = nodemailer.createTransport({ host: '127.0.0.1', port: Number(process.env.MAIL_SMTP_PORT || 3025), secure: false, ignoreTLS: true });
      await tr.sendMail({ from: ZHANG, to: TO, subject: '刚开的发票', attachments: [{ filename: '刚开的.pdf', content: fs.readFileSync(path.join(dir, 'sdp-geren.pdf')) }] });
      tr.close();
      const t3 = Date.now();
      await page.click('[data-act="mail-scan"]');
      await page.waitForTimeout(300);
      await waitIdle('[data-act="mail-scan"]:not([disabled])', 60000);
      const r3 = await page.evaluate(() => document.querySelector('#view').innerText);
      check(/刚开的\.pdf/.test(r3), '刚发来的邮件马上能查到（发送后 ' + ((Date.now() - t3) / 1000).toFixed(1) + ' 秒）');
    }
    s.srv.close();
  }

  // ---------- 导出 Excel ----------
  {
    console.log('\n[导出 Excel]');
    const XLSX = require('xlsx');
    const exportDir = path.join(ud, 'export');
    const chk = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) mustFail++; };
    const exportAs = async (sender, shot) => {
      await page.evaluate(() => { location.hash = 'ledger'; });
      await page.waitForTimeout(300);
      await page.click('#exportBtn');
      await page.waitForSelector('#ex-sender');
      await page.selectOption('#ex-sender', sender);
      if (shot) await page.screenshot({ path: path.join(out, shot) });
      const before = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).length : 0;
      await page.click('[data-act="ex-go"]');
      for (let k = 0; k < 40; k++) {
        const files = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
        if (files.length > before) { await page.waitForTimeout(300); return path.join(exportDir, files.sort((a, b) => fs.statSync(path.join(exportDir, b)).mtimeMs - fs.statSync(path.join(exportDir, a)).mtimeMs)[0]); }
        await page.waitForTimeout(250);
      }
      return null;
    };
    const led = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
    const f1 = await exportAs('', '10-导出窗口.png');
    chk(!!f1, '导出全部：' + (f1 ? path.basename(f1) : '没有生成文件'));
    if (f1) {
      const wb = XLSX.readFile(f1);
      chk(JSON.stringify(wb.SheetNames) === JSON.stringify(['发票汇总', '发票明细']), '两张表：' + wb.SheetNames.join('、'));
      const sum = XLSX.utils.sheet_to_json(wb.Sheets['发票汇总']), det = XLSX.utils.sheet_to_json(wb.Sheets['发票明细']);
      const ready = led.invoices.filter((i) => i.status === 'ready').length;
      chk(sum.length === ready, '发票汇总 ' + sum.length + ' 行（台账 ' + ready + ' 张）');
      const mx = det.filter((r) => r['发票号码'] === '26612000000425517093');
      const mxs = mx.map((r) => r['项目名称'] + '/' + r['单位'] + '/' + r['数量'] + '/' + r['单价'] + '/' + r['金额']);
      chk(mx.length >= 3 && mx.length % 3 === 0, '3 行明细的发票在明细表里有 ' + mx.length + ' 行：' + mxs.slice(0, 3).join('；'));
      const first = mx.find((r) => /红砖/.test(r['项目名称']));
      chk(first && first['单位'] === '块' && first['数量'] === 83500 && Math.abs(first['单价'] - 0.6237623762376) < 1e-9 && first['金额'] === 52084.16, '红砖这一行的单位、数量、单价、金额都对');
      chk(typeof sum[0]['发票号码'] === 'string' && sum.every((r) => !/E\+/.test(String(r['发票号码']))), '发票号码按文字保存，不会变成科学计数法');
    }
    if (process.env.MAIL_TEST) {
      const f2 = await exportAs('zhangsan@test.local');
      chk(!!f2 && /张三/.test(path.basename(f2)), '按提交人导出：' + (f2 ? path.basename(f2) : '没有生成文件'));
      if (f2) {
        const wb = XLSX.readFile(f2);
        const sum = XLSX.utils.sheet_to_json(wb.Sheets['发票汇总']);
        chk(sum.length === 4 && sum.every((r) => r['提交人邮箱'] === 'zhangsan@test.local'), '只导出了张三的 ' + sum.length + ' 张发票');
      }
    }
  }

  fs.writeFileSync(path.join(out, 'e2e-report.json'), JSON.stringify(report, null, 2));
  await app.close();
  if (errors.length) { console.log('页面有 ' + errors.length + ' 个脚本错误'); mustFail++; }
  console.log(mustFail ? '\n有 ' + mustFail + ' 项必须通过的检查失败' : '\n必须通过的检查全部通过');
  process.exit(mustFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
