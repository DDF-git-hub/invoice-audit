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
    // 登记员工：张三有两个邮箱，李四一个
    await page.evaluate(() => { location.hash = 'staff'; });
    await page.waitForSelector('#st-name');
    await page.fill('#st-name', '张三');
    await page.fill('#st-dept', '市场部');
    await page.fill('#st-emails', 'zhangsan@test.local\nZhang.San@test2.local');
    await page.click('[data-act="st-save"]');
    await page.fill('#st-name', '李四');
    await page.fill('#st-emails', 'lisi@test.local');
    await page.click('[data-act="st-save"]');
    await page.fill('#st-name', '王五');
    await page.fill('#st-emails', 'zhangsan@test.local');
    await page.click('[data-act="st-save"]');
    const dupErr = await page.evaluate(() => (document.querySelector('.errbox') || {}).textContent || '');
    check(/已经登记给「张三」/.test(dupErr), '同一个邮箱不能登记给两个人：' + dupErr.slice(0, 40));
    await page.click('[data-act="st-cancel"]');
    const staffRows = await page.evaluate(() => document.querySelectorAll('section[aria-label="员工列表"] tbody tr').length);
    check(staffRows === 2, '员工列表 ' + staffRows + ' 人');
    await page.screenshot({ path: path.join(out, '11-员工.png'), fullPage: true });

    await page.evaluate(() => { location.hash = 'mail'; });
    await page.waitForSelector('#mail-preset');
    await page.selectOption('#mail-preset', 'custom');
    await page.fill('#mail-user', TO);
    await page.fill('#mail-pass', 'test-password');
    await page.fill('#mail-host', '127.0.0.1');
    await page.fill('#mail-port', String(process.env.MAIL_IMAP_PORT || 3143));
    await page.fill('#mail-smtp-port', String(process.env.MAIL_SMTP_PORT || 3025));
    await page.uncheck('#mail-secure');
    await page.screenshot({ path: path.join(out, '06-邮箱设置.png'), fullPage: true });
    await page.click('[data-act="mail-test"]');
    const connected = await waitIdle('[data-act="mail-edit"], .status-bad', 30000);
    const bad = await page.evaluate(() => { const b = document.querySelector('.status-bad'); return b ? b.textContent : ''; });
    check(connected && !bad, '连接测试邮箱' + (bad ? '：' + bad : ''));
    if (connected && !bad) {
      await page.click('button[data-act="mail-emp"]:has-text("张三")');
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
      check(r.msgs === s.expect.messages, '只列出张三两个邮箱的邮件：' + r.msgs + ' 封（应为 ' + s.expect.messages + '）');
      check(/zhang\.san@test2\.local/.test(r.text), '第二个邮箱发来的邮件也收到了');
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
      const zid = (led.cfg.employees.find((e) => e.name === '张三') || {}).id;
      const mine = led.invoices.filter((i) => i.employeeId === zid);
      check(mine.length === s.expect.files, '台账里归到张三名下的发票：' + mine.length + ' 张');
      check(mine.every((i) => i.mail && i.mail.subject) && mine.some((i) => i.sender === 'zhang.san@test2.local'), '每张都记下了邮件，两个邮箱的都归到张三');
      const nos = mine.map((i) => i.f.no).sort();
      check(JSON.stringify(nos) === JSON.stringify(s.expect.nos.slice().sort()), '识别出的发票号码：' + nos.join('、'));
      // 邮件正文：员工写的说明跟着发票保存，人数自动读出来
      const cy = mine.find((i) => i.file === '餐费.pdf');
      check(!!cy && /领导已同意/.test((cy.mail && cy.mail.text) || ''), '邮件正文跟着发票保存：' + (cy && cy.mail && cy.mail.text));
      check(!!cy && cy.trip && cy.trip.persons === 4, '从邮件里读出用餐人数：' + (cy && cy.trip && cy.trip.persons));
      if (cy) {
        await page.evaluate((id) => { location.hash = 'review-' + id; }, cy.id);
        await page.waitForSelector('#rv-checks');
        const ex = await page.evaluate(() => ({ card: (document.querySelector('section[aria-label="员工说明"]') || {}).innerText || '', checks: document.querySelector('#rv-checks').innerText }));
        check(/领导已同意/.test(ex.card) && /员工在邮件里附了说明/.test(ex.checks), '复核页显示「员工说明」，审核结果提示员工附了说明');
        await page.screenshot({ path: path.join(out, '07b-员工说明.png'), fullPage: true });
        await page.evaluate(() => { location.hash = 'ledger'; });
        await page.waitForTimeout(500);
      }
      await page.selectOption('#person-filter', 'emp:' + zid).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, '08-按提交人筛选.png'), fullPage: true });
      const rows = await page.evaluate(() => document.querySelectorAll('tr[data-open]').length);
      check(rows === s.expect.files, '按报销人筛选后显示 ' + rows + ' 行');
      global.__zid = zid;
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
      const f2 = await exportAs('emp:' + global.__zid);
      chk(!!f2 && /张三/.test(path.basename(f2)), '按提交人导出：' + (f2 ? path.basename(f2) : '没有生成文件'));
      if (f2) {
        const wb = XLSX.readFile(f2);
        const sum = XLSX.utils.sheet_to_json(wb.Sheets['发票汇总']);
        chk(sum.length === 5 && sum.every((r) => r['报销人'] === '张三' && r['部门'] === '市场部'), '只导出了张三的 ' + sum.length + ' 张发票（含两个邮箱）');
      }
      // 手动上传的发票指定报销人
      const manual = led.invoices.find((i) => i.file === 'sdp-geren.pdf');
      await page.evaluate((id) => { location.hash = 'review-' + id; }, manual.id);
      await page.waitForSelector('#rv-emp');
      const lid = await page.evaluate(() => Array.from(document.querySelectorAll('#rv-emp option')).find((o) => o.textContent.indexOf('李四') === 0).value);
      await page.selectOption('#rv-emp', lid);
      await page.waitForTimeout(800);
      // 报销查询
      await page.evaluate(() => { location.hash = 'history'; });
      await page.waitForSelector('#hist-who');
      await page.fill('#hist-who', '张三');
      await page.click('[data-act="hist-range"][data-r="today"]');
      await page.waitForTimeout(300);
      const h1 = await page.evaluate(() => ({ rows: document.querySelectorAll('#hist-results tr[data-open]').length, head: (document.querySelector('#hist-results .filters') || {}).innerText || '' }));
      await page.screenshot({ path: path.join(out, '12-报销查询.png'), fullPage: true });
      chk(h1.rows === 5 && /5 张/.test(h1.head), '查询张三今天的报销：' + h1.rows + ' 张（' + h1.head.replace(/\s+/g, ' ').slice(0, 60) + '）');
      const y = new Date(Date.now() - 864e5), ys = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
      await page.fill('#hist-from', ys); await page.fill('#hist-to', ys);
      await page.dispatchEvent('#hist-to', 'change');
      await page.waitForTimeout(300);
      const h2 = await page.evaluate(() => document.querySelectorAll('#hist-results tr[data-open]').length);
      chk(h2 === 0, '换成昨天：' + h2 + ' 张');
      await page.click('[data-act="hist-range"][data-r="today"]');
      await page.fill('#hist-who', '李四');
      await page.waitForTimeout(300);
      const h3 = await page.evaluate(() => document.querySelectorAll('#hist-results tr[data-open]').length);
      chk(h3 === 1, '手动指定给李四的发票能按李四查到：' + h3 + ' 张');
      await page.fill('#hist-who', '张三');
      await page.waitForTimeout(300);
      const before = fs.readdirSync(exportDir).length;
      await page.click('[data-act="hist-export"]');
      let f3 = null;
      for (let k = 0; k < 40 && !f3; k++) { const fl = fs.readdirSync(exportDir); if (fl.length > before) f3 = fl.find((n) => /张三_/.test(n)); await page.waitForTimeout(250); }
      chk(!!f3, '导出查询结果：' + (f3 || '没有生成文件'));
      if (f3) { const sum3 = XLSX.utils.sheet_to_json(XLSX.readFile(path.join(exportDir, f3)).Sheets['发票汇总']); chk(sum3.length === 5, '查询结果导出 ' + sum3.length + ' 张'); }

      // ---------- 凭证 ----------
      console.log('\n[凭证 → 用友 U8（演示环境）]');
      const ledNow = () => JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
      const approve = async (file, sender) => {
        const inv = ledNow().invoices.find((i) => i.file === file && (sender ? i.sender === sender : !i.sender));
        await page.evaluate((id) => { location.hash = 'review-' + id; }, inv.id);
        await page.waitForSelector('[data-dec="approved"]');
        await page.click('[data-dec="approved"]');
        await page.waitForTimeout(500);
        return inv;
      };
      await approve('餐费.pdf', 'zhangsan@test.local');
      await approve('发票.pdf', 'zhangsan@test.local');
      await page.waitForTimeout(400);
      const cym = ledNow().invoices.find((i) => i.file === '餐费.pdf' && i.sender === 'zhangsan@test.local');
      chk(!!cym && /员工说明/.test(cym.memo || '') && /领导已同意/.test(cym.memo || ''), '人工通过时复核意见带上了员工说明');
      await page.evaluate(() => { location.hash = 'voucher'; });
      await page.waitForSelector('section[aria-label="凭证 张三"]');
      const card = 'section[aria-label="凭证 张三"]';
      const lines = await page.evaluate((c) => Array.from(document.querySelectorAll(c + ' tr.vline')).map((tr) => ({
        dc: tr.querySelector('[data-vf="dc"]').value, code: tr.querySelector('[data-vf="code"]').value, amount: tr.querySelector('[data-vf="amount"]').value, dept: tr.querySelector('[data-vf="dept"]').value })), card);
      console.log('    ' + lines.map((l) => (l.dc === 'D' ? '借 ' : '贷 ') + l.code + ' ' + l.amount + (l.dept ? ' [' + l.dept + ']' : '')).join(' | '));
      const want = [['D', '660104', '1860.00'], ['D', '660201', '1592.92'], ['D', '22210101', '207.08'], ['C', '224101', '3660.00']];
      chk(lines.length === 4 && want.every((w) => lines.some((l) => l.dc === w[0] && l.code === w[1] && l.amount === w[2])), '张三两张发票合成一张凭证 4 行：招待费（市场部规则）、办公费、进项税、应付员工');
      chk(await page.evaluate((c) => /借贷平衡/.test(document.querySelector(c).innerText), card), '借贷平衡、辅助核算齐全');
      await page.screenshot({ path: path.join(out, '13-凭证待确认.png'), fullPage: true });
      // 改科目 → 确认时存成规则
      // 找招待费那一行（分录顺序跟发票顺序有关，不固定）
      const zi = await page.evaluate((c) => Array.from(document.querySelectorAll(c + ' tr.vline [data-vf="code"]')).findIndex((x) => x.value === '660104'), card);
      const codeInput = page.locator(card + ' tr.vline [data-vf="code"]').nth(Math.max(zi, 0));
      await codeInput.fill('660299');
      await codeInput.dispatchEvent('change');
      await page.waitForTimeout(300);
      await page.click(card + ' [data-act="v-confirm"]');
      await page.waitForSelector('#lm-0');
      await page.screenshot({ path: path.join(out, '14-存成规则.png') });
      await page.selectOption('#lm-0', 'seller');
      await page.click('[data-act="lm-ok"]');
      await page.waitForTimeout(800);
      const rule = (ledNow().cfg.acct.rules || []).find((r) => r.seller === '上海小南国餐饮有限公司');
      chk(rule && rule.code === '660299', '改法存成了规则：销售方「上海小南国餐饮有限公司」→ 660299');
      const vz = ledNow().vouchers.find((v) => v.personLabel === '张三');
      chk(vz && vz.status === 'confirmed' && vz.log.some((l) => /科目：660104 → 660299/.test(l.text)), '凭证已确认，改动留了记录');
      // U8 连接（演示环境）
      await page.evaluate(() => { location.hash = 'voucher-u8'; });
      await page.waitForSelector('#u8-operator');
      await page.fill('#u8-operator', 'demo');
      await page.click('[data-act="u8-test"]');
      await page.waitForSelector('.status-ok, .status-bad', { timeout: 10000 });
      const u8msg = await page.evaluate(() => (document.querySelector('.status-ok') || document.querySelector('.status-bad')).textContent);
      chk(/演示环境/.test(u8msg), 'U8 测试连接：' + u8msg);
      await page.screenshot({ path: path.join(out, '15-U8连接.png'), fullPage: true });
      // 生成凭证
      await page.evaluate(() => { location.hash = 'voucher-done'; });
      await page.waitForSelector(card + ' [data-act="v-post"]');
      await page.click(card + ' [data-act="v-post"]');
      await page.waitForSelector(card + ' [data-act="v-view"]', { timeout: 10000 });
      // 界面先更新、数据文件稍后保存：等文件里也变成「已生成」再检查
      for (let k = 0; k < 40; k++) { const x = ledNow().vouchers.find((v) => v.personLabel === '张三'); if (x && x.status === 'posted') break; await page.waitForTimeout(250); }
      const vp = ledNow().vouchers.find((v) => v.personLabel === '张三');
      chk(vp.status === 'posted' && vp.u8 && /^记-0001$/.test(vp.u8.display), '生成凭证，拿回 U8 凭证号：' + (vp.u8 && vp.u8.display));
      const demo = JSON.parse(fs.readFileSync(path.join(ud, 'u8-demo.json'), 'utf8'));
      const dv = demo.vouchers[0] || { entries: [] };
      const dsum = dv.entries.reduce((a, e) => a + e.debit, 0), csum = dv.entries.reduce((a, e) => a + e.credit, 0);
      chk(demo.vouchers.length === 1 && dv.entries.length === 4 && Math.abs(dsum - 3660) < 0.001 && Math.abs(csum - 3660) < 0.001 && dv.maker === 'demo', '演示 U8 收到 1 张凭证：4 行，借贷各 3,660.00，制单人 demo');
      chk(ledNow().invoices.filter((i) => i.voucher && i.voucher.display === '记-0001').length === 2, '两张发票都标上了凭证号');
      await page.click(card + ' [data-act="v-view"]');
      await page.waitForSelector('#v-viewer');
      await page.screenshot({ path: path.join(out, '16-凭证查看.png') });
      await page.click('[data-act="vv-close"]');
      // 李四没有部门：不能确认
      await approve('sdp-geren.pdf');
      await page.evaluate(() => { location.hash = 'voucher'; });
      await page.waitForSelector('section[aria-label="凭证 李四"]');
      const li = await page.evaluate(() => { const c = document.querySelector('section[aria-label="凭证 李四"]'); return { text: c.innerText, disabled: c.querySelector('[data-act="v-confirm"]').disabled }; });
      chk(/需要部门/.test(li.text) && li.disabled, '李四没有登记部门：提示「需要部门」，不能确认');
    }
  }

  // ---------- 原件存档、操作记录、职级城市标准（v1.8.0） ----------
  {
    console.log('\n[原件存档 / 操作记录 / 职级标准]');
    const crypto = require('crypto');
    const chk = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) mustFail++; };
    const led = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
    const files = led.invoices.filter((i) => i.source === 'file' || i.source === 'mail');
    const archived = files.filter((i) => i.archive && i.archive.sha256);
    chk(files.length > 0 && archived.length === files.length, '上传和邮件导入的发票都存了原件：' + archived.length + '/' + files.length);
    const one = led.invoices.find((i) => i.file === 'sdp-canyin.pdf');
    if (one && one.archive) {
      const p = path.join(ud, one.archive.path);
      const same = fs.existsSync(p) && crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') === one.archive.sha256;
      const orig = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'sdp-canyin.pdf'))).digest('hex');
      chk(same && orig === one.archive.sha256, '存档文件和上传的原件逐字节一致（SHA-256 ' + one.archive.sha256.slice(0, 12) + '…）');
      // 操作人 + 校验 + 处理记录
      await page.click('#opBtn');
      await page.fill('#op-name', '测试会计');
      await page.click('[data-act="op-ok"]');
      await page.evaluate((id) => { location.hash = 'review-' + id; }, one.id);
      await page.waitForSelector('[data-act="arch-verify"]');
      await page.click('[data-act="arch-verify"]');
      await page.waitForTimeout(500);
      const toast = await page.evaluate(() => document.querySelector('#toast').textContent);
      chk(/原件完好/.test(toast), '复核页校验原件：' + toast);
      await page.fill('#memo', 'e2e 测试驳回');
      await page.click('[data-dec="rejected"]');
      await page.waitForTimeout(800);
      const after = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8')).invoices.find((i) => i.id === one.id);
      chk(after.decision === 'rejected' && after.decidedBy === '测试会计' && !!after.decidedAt, '驳回记下了处理人和时间：' + after.decidedBy + ' ' + after.decidedAt);
      // 改一个字段
      await page.evaluate((id) => { location.hash = 'review-' + id; }, one.id);
      await page.waitForSelector('#f-items');
      await page.fill('#f-items', '*餐饮服务*餐费（e2e 修改）');
      await page.dispatchEvent('#f-items', 'change');
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(out, '17-原件与处理记录.png'), fullPage: true });
    }
    const logFile = path.join(ud, 'audit-log.jsonl');
    const logs = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    chk(logs.some((l) => l.act === '导入发票') && logs.some((l) => l.act === '原件存档') && logs.some((l) => l.act === '已驳回' && l.who === '测试会计'), '操作记录里有导入、存档、驳回（操作人 测试会计），共 ' + logs.length + ' 条');
    chk(logs.some((l) => l.act === '修改字段' && /e2e 修改/.test(l.detail) && l.who === '测试会计'), '改字段记下了旧值和新值');
    if (process.env.MAIL_TEST) chk(logs.some((l) => l.act === '确认分录') && logs.some((l) => l.act === '生成凭证'), '凭证确认和生成也有记录');
    await page.evaluate(() => { location.hash = 'log'; });
    await page.waitForSelector('[data-act="log-verify"]');
    await page.click('[data-act="log-verify"]');
    await page.waitForSelector('#log-verify-res');
    const vr = await page.evaluate(() => document.querySelector('#log-verify-res').textContent);
    chk(/校验通过/.test(vr), '操作记录完整性校验：' + vr);
    await page.screenshot({ path: path.join(out, '18-操作记录.png'), fullPage: true });
    // 篡改一条记录，校验能发现
    const raw = fs.readFileSync(logFile, 'utf8');
    fs.writeFileSync(logFile, raw.replace('测试会计', '别人'));
    await page.click('[data-act="log-verify"]');
    await page.waitForTimeout(500);
    const vr2 = await page.evaluate(() => document.querySelector('#log-verify-res').textContent);
    chk(/被修改过/.test(vr2), '改了记录文件后校验不通过：' + vr2);
    fs.writeFileSync(logFile, raw);

    // 职级 × 城市标准：示例里经理在上海住 2 晚，标准 700/晚，发票 1,580
    await page.evaluate(() => { location.hash = 'ledger'; });
    await page.waitForSelector('[data-act="samples"]');
    await page.click('[data-act="samples"]');
    await page.waitForTimeout(800);
    if (await page.$('#person-filter')) { await page.selectOption('#person-filter', ''); await page.waitForTimeout(300); }
    await page.click('[data-filter="all"]');
    await page.waitForTimeout(300);
    // 出差归集与补助：王芳（经理）杭州 3 天，去程火车、住 2 晚、一顿饭、回程火车
    const hz = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('tr[data-open]')).find((x) => /杭州西湖宾馆/.test(x.innerText)); return r && r.getAttribute('data-open'); });
    chk(!!hz, '示例里有出差发票');
    if (hz) {
      await page.evaluate((id) => { location.hash = 'review-' + id; }, hz);
      await page.waitForSelector('#rv-trip');
      const tt = await page.evaluate(() => document.querySelector('#rv-trip').innerText);
      chk(/共 3 天/.test(tt) && /杭州/.test(tt) && /360\.00/.test(tt) && (tt.match(/车票\/机票/g) || []).length === 2 && /楼外楼/.test(tt), '4 张发票归成一次出差：杭州 3 天，出差补助 ¥360.00');
      await page.screenshot({ path: path.join(out, '19b-出差归集.png'), fullPage: true });
      await page.evaluate(() => { location.hash = 'voucher'; });
      const vcard = 'section[aria-label="凭证 王芳（示例）"]';
      await page.waitForSelector(vcard, { timeout: 10000 }).catch(() => {});
      const vl = await page.evaluate((c) => { const el = document.querySelector(c); if (!el) return null; return { lines: Array.from(el.querySelectorAll('tr.vline')).map((tr) => ({ code: tr.querySelector('[data-vf="code"]').value, amount: tr.querySelector('[data-vf="amount"]').value, summary: tr.querySelector('[data-vf="summary"]').value })), ok: /借贷平衡/.test(el.innerText) }; }, vcard);
      const al = vl && vl.lines.find((l) => /出差补助/.test(l.summary));
      chk(!!al && al.amount === '360.00' && al.code === '660102' && vl.ok, '凭证里自动加上出差补助 360.00（记差旅费 660102），借贷平衡');
      await page.screenshot({ path: path.join(out, '19c-出差补助凭证.png'), fullPage: true });
      await page.evaluate(() => { location.hash = 'ledger'; });
      await page.waitForTimeout(400);
    }
    const sid = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('tr[data-open]')).find((x) => /香格里拉/.test(x.innerText)); return r && r.getAttribute('data-open'); });
    chk(!!sid, '示例里有职级标准的发票');
    if (sid) {
      await page.evaluate((id) => { location.hash = 'review-' + id; }, sid);
      await page.waitForSelector('#rv-std');
      const c1 = await page.evaluate(() => document.querySelector('#rv-checks').innerText);
      chk(/超出住宿标准/.test(c1) && /经理 · 上海（一类城市）700\.00 元\/晚 × 2 晚/.test(c1), '按 经理 × 上海 × 2 晚 判断超标');
      await page.screenshot({ path: path.join(out, '19-职级城市标准.png'), fullPage: true });
      await page.fill('#tr-nights', '3');
      await page.dispatchEvent('#tr-nights', 'change');
      await page.waitForTimeout(500);
      const c2 = await page.evaluate(() => document.querySelector('#rv-checks').innerText);
      chk(/在住宿标准内/.test(c2) && /× 3 晚/.test(c2), '改成 3 晚后在标准内');
      await page.fill('#tr-city', '昆山');
      await page.dispatchEvent('#tr-city', 'change');
      await page.waitForTimeout(500);
      const c3 = await page.evaluate(() => document.querySelector('#rv-checks').innerText);
      chk(/昆山（其他城市）400\.00 元\/晚 × 3 晚/.test(c3) && /超出住宿标准/.test(c3), '没列出的城市按其他城市 400/晚 算');
    }
    // 复核意见按审核发现自动填写
    await page.evaluate(() => { location.hash = 'ledger'; });
    await page.waitForTimeout(300);
    const did = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('tr[data-open]')).find((x) => /重复报销/.test(x.innerText) && /示例/.test(x.innerText)); return r && r.getAttribute('data-open'); });
    if (did) {
      await page.evaluate((id) => { location.hash = 'review-' + id; }, did);
      await page.waitForSelector('#memo');
      const mv = await page.inputValue('#memo');
      chk(/^审核发现：/.test(mv) && /重复报销/.test(mv), '复核意见自动填上审核发现：' + mv.replace(/\n/g, ' / ').slice(0, 50));
      await page.click('[data-dec="rejected"]');
      await page.waitForTimeout(800);
      const saved = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8')).invoices.find((i) => i.id === did);
      chk(saved && saved.decision === 'rejected' && /重复报销/.test(saved.memo) && /处理：驳回/.test(saved.memo), '不用手写也能驳回，意见里带上了审核发现和处理结果');
    } else chk(false, '示例里没找到重复报销的发票');
    await page.evaluate(() => { location.hash = 'rules'; });
    await page.waitForSelector('section[aria-label="职级与城市标准"]');
    await page.screenshot({ path: path.join(out, '20-规则设置.png'), fullPage: true });
  }

  // ---------- 回邮件通知报销人 ----------
  if (process.env.MAIL_TEST) {
    console.log('\n[邮件通知报销人]');
    const chk = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) mustFail++; };
    await page.evaluate(() => { location.hash = 'ledger'; });
    await page.waitForTimeout(500);
    const btns = await page.evaluate(() => Array.from(document.querySelectorAll('.notice-bar [data-act="ntf-open"]')).map((b) => b.getAttribute('data-to') + ' ' + b.textContent));
    console.log('    待通知：' + btns.join('；'));
    const target = 'zhangsan@test.local';
    const has = btns.some((b) => b.indexOf(target) === 0);
    chk(has, '审核台提示有问题发票还没通知报销人');
    if (has) {
      await page.click('.notice-bar [data-act="ntf-open"][data-to="' + target + '"]');
      await page.waitForSelector('#ntf-body');
      const subject = await page.inputValue('#ntf-subject'), body = await page.inputValue('#ntf-body');
      chk(/张三，您好/.test(body) && /问题：/.test(body) && /请：/.test(body), '回信草稿写好了问题和处理办法');
      chk(!/餐费\.pdf/.test(body), '已经人工通过的发票不在回信里');
      await page.screenshot({ path: path.join(out, '22-邮件通知报销人.png') });
      await page.click('[data-act="ntf-send"]');
      for (let k = 0; k < 40 && await page.$('#ntf-modal'); k++) await page.waitForTimeout(250);
      const err = await page.evaluate(() => { const e = document.querySelector('#ntf-err'); return e ? e.textContent : ''; });
      chk(!err, '发送成功' + (err ? '：' + err : ''));
      await page.waitForTimeout(800);
      // 去张三的邮箱看有没有收到
      const { ImapFlow } = require('imapflow');
      const c = new ImapFlow({ host: '127.0.0.1', port: Number(process.env.MAIL_IMAP_PORT || 3143), secure: false, auth: { user: target, pass: 'x' }, logger: false });
      let got = null, hdr = '';
      try {
        await c.connect();
        const lock = await c.getMailboxLock('INBOX');
        try { for await (const m of c.fetch('1:*', { envelope: true, headers: ['in-reply-to', 'references'] })) { if (m.envelope.subject === subject) { got = m.envelope; hdr = m.headers ? m.headers.toString() : ''; } } } finally { lock.release(); }
        await c.logout();
      } catch (e) { console.log('    读张三邮箱出错：' + e.message); }
      chk(!!got && /In-Reply-To:\s*<[^>]+>/i.test(hdr) && got.from[0].address === 'finance@test.local', '张三的邮箱收到回信（从收票邮箱发出，回复他原来的邮件）：' + subject);
      const led = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
      const notified = led.invoices.filter((i) => i.notice && i.notice.to === target);
      chk(notified.length > 0, '回信里的 ' + notified.length + ' 张发票标为已通知');
      const logs = fs.readFileSync(path.join(ud, 'audit-log.jsonl'), 'utf8');
      chk(/邮件通知报销人/.test(logs), '操作记录里有这次通知');
      const still = await page.evaluate((t) => !!document.querySelector('.notice-bar [data-to="' + t + '"]'), target);
      chk(!still, '通知过以后不再提示');
      // 员工回复说明（不带发票）→ 挂到原来的发票上
      const nmid = notified[0] && notified[0].notice && notified[0].notice.messageId;
      chk(!!nmid, '记下了通知邮件的编号');
      if (nmid) {
        const nodemailer = require('nodemailer');
        const tr2 = nodemailer.createTransport({ host: '127.0.0.1', port: Number(process.env.MAIL_SMTP_PORT || 3025), secure: false, ignoreTLS: true });
        await tr2.sendMail({ from: { name: '张三', address: target }, to: 'finance@test.local', subject: 'Re: ' + subject, inReplyTo: nmid, references: [nmid],
          text: '已找王总签字同意，审批截图稍后补上。\n\n------------------ 原始邮件 ------------------\n' + body.slice(0, 200) });
        tr2.close();
        await page.evaluate(() => { location.hash = 'mail'; });
        await page.waitForSelector('[data-act="mail-scan"]');
        await page.click('[data-act="mail-scan"]');
        await page.waitForTimeout(500);
        for (let k = 0; k < 240; k++) { if (await page.evaluate(() => !!document.querySelector('[data-act="mail-scan"]:not([disabled])'))) break; await page.waitForTimeout(500); }
        const nr = await page.evaluate(() => { const c = document.querySelector('.mail-file[data-fid^="note:"]'); return c ? { checked: c.checked, label: c.closest('label').innerText.replace(/\s+/g, ' ') } : null; });
        chk(!!nr && nr.checked, '员工的回复邮件列为「回复说明」并默认勾选：' + (nr && nr.label));
        await page.screenshot({ path: path.join(out, '23-回复说明.png'), fullPage: true });
        if (nr) {
          await page.click('[data-act="mail-none"]');
          await page.check('.mail-file[data-fid^="note:"]');
          await page.click('[data-act="mail-import"]');
          await page.waitForTimeout(1500);
          const led2 = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
          const withNote = led2.invoices.filter((i) => (i.notes || []).some((n) => /王总签字同意/.test(n.text) && !/原始邮件|您好/.test(n.text)));
          chk(withNote.length === notified.length, '回复说明挂到了通知过的 ' + withNote.length + ' 张发票上，引用的旧邮件已去掉');
          chk(withNote.every((i) => !i.decision || i.decision !== 'approved'), '有说明也不会自动通过，仍需财务判断');
        }
      }
    }
  }

  // ---------- 清空台账后可以重新演示 ----------
  if (process.env.MAIL_TEST) {
    console.log('\n[清空台账后重新演示]');
    const chk = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) mustFail++; };
    await page.evaluate(() => { location.hash = 'ledger'; });
    await page.waitForSelector('[data-act="clear"]');
    await page.click('[data-act="clear"]');
    await page.click('[data-act="clear-yes"]');
    await page.waitForTimeout(1500);
    const led = JSON.parse(fs.readFileSync(path.join(ud, 'ledger.json'), 'utf8'));
    chk(led.invoices.length === 0 && led.vouchers.length === 0, '发票和凭证都清空了');
    chk(!fs.existsSync(path.join(ud, 'mail-seen.json')) && !fs.existsSync(path.join(ud, 'u8-demo.json')), '邮件已导入标记、演示 U8 凭证都清掉了');
    chk(led.cfg.employees.some((e) => e.name === '张三') && fs.existsSync(path.join(ud, 'audit-log.jsonl')), '员工和操作记录保留');
    await page.evaluate(() => { location.hash = 'mail'; });
    await page.waitForSelector('[data-act="mail-scan"]');
    await page.click('[data-act="mail-scan"]');
    await page.waitForTimeout(500);
    for (let k = 0; k < 240; k++) { if (await page.evaluate(() => !!document.querySelector('[data-act="mail-scan"]:not([disabled])'))) break; await page.waitForTimeout(500); }
    const r = await page.evaluate(() => ({ files: document.querySelectorAll('.mail-file').length, checked: document.querySelectorAll('.mail-file:checked').length, seen: (document.querySelector('#view').innerText.match(/已导入过/g) || []).length }));
    chk(r.files > 0 && r.checked === r.files && r.seen === 0, '再检查邮件：' + r.files + ' 个文件都能重新导入（勾选 ' + r.checked + '，已导入过 ' + r.seen + '）');
    await page.screenshot({ path: path.join(out, '21-清空后重新收票.png'), fullPage: true });
  }

  fs.writeFileSync(path.join(out, 'e2e-report.json'), JSON.stringify(report, null, 2));
  await app.close();
  if (errors.length) { console.log('页面有 ' + errors.length + ' 个脚本错误'); mustFail++; }
  console.log(mustFail ? '\n有 ' + mustFail + ' 项必须通过的检查失败' : '\n必须通过的检查全部通过');
  process.exit(mustFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
