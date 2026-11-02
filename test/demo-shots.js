// 演示截图：按演示讲稿的顺序操作一遍真实软件，每一步截一张图，要点击的地方用红框标出来。
// 云端运行：xvfb-run -a node test/demo-shots.js（需要测试邮箱服务器 GreenMail）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright-core');
const nodemailer = require('nodemailer');

const root = path.join(__dirname, '..');
const fx = path.join(__dirname, 'fixtures');
// DEMO_CLEAN=1：不画红框和标号（放简历、介绍材料用）
const CLEAN = !!process.env.DEMO_CLEAN;
const out = path.join(root, 'test-output', CLEAN ? 'demo-shots-clean' : 'demo-shots');
fs.mkdirSync(out, { recursive: true });
const SMTP = Number(process.env.MAIL_SMTP_PORT || 3025), IMAP = Number(process.env.MAIL_IMAP_PORT || 3143);
const TO = CLEAN ? 'fapiao2@demo.local' : 'fapiao@demo.local';
const shots = [];

(async () => {
  // 先给收票邮箱发几封邮件：张三两个邮箱各一封，李四一封（不应该被收进来）
  const tr = nodemailer.createTransport({ host: '127.0.0.1', port: SMTP, secure: false, ignoreTLS: true });
  const send = (o) => tr.sendMail(Object.assign({ to: TO }, o));
  await send({ from: { name: '张三', address: 'zhangsan@demo.local' }, subject: '10月客户招待餐费', text: '请报销', attachments: [{ filename: '餐费发票.pdf', content: fs.readFileSync(path.join(fx, 'sdp-canyin.pdf')) }] });
  await send({ from: { name: '张三', address: '12345678@qq.demo' }, subject: '办公用品发票', text: '见附件', attachments: [{ filename: '办公用品专票.pdf', content: fs.readFileSync(path.join(fx, 'sdp-zhuanpiao.pdf')) }] });
  await send({ from: { name: '李四', address: 'lisi@demo.local' }, subject: '打车发票', attachments: [{ filename: '打车.pdf', content: fs.readFileSync(path.join(fx, 'sdp-geren.pdf')) }] });
  tr.close();

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-demo-'));
  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], cwd: root, timeout: 90000,
    env: Object.assign({}, process.env, { INVOICE_AUDIT_USERDATA: ud, INVOICE_AUDIT_EXPORT_DIR: path.join(ud, 'export'), INVOICE_AUDIT_MAIL_NO_SEARCH: '1' }) });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('  [页面错误] ' + e.message));
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForSelector('.tiles', { timeout: 60000 });
  const wait = (ms) => page.waitForTimeout(ms);
  const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await wait(400); };

  // 红框标注：targets = [[定位器或选择器, 标号]]
  async function shot(name, targets, opt) {
    opt = opt || {};
    const boxes = [];
    for (let i = 0; i < (targets || []).length; i++) {
      const [t, label] = targets[i];
      const loc = typeof t === 'string' ? page.locator(t).first() : t;
      try {
        if (i === 0 && !opt.noScroll) { await loc.scrollIntoViewIfNeeded(); await page.evaluate(() => {}); }
        const b = await loc.boundingBox();
        if (b) boxes.push({ x: b.x, y: b.y, w: b.width, h: b.height, label: label == null ? '' : String(label) });
      } catch (e) { console.log('  ! 找不到要标注的元素：' + name + ' #' + i); }
    }
    if (opt.center && boxes[0]) {
      await page.evaluate((y) => window.scrollBy(0, y), boxes[0].y + boxes[0].h / 2 - 450);
      await wait(150);
      return shot(name, targets, Object.assign({}, opt, { center: false, noScroll: true }));
    }
    if (CLEAN) boxes.length = 0;
    if (!opt.keepToast) await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.hidden = true; });
    await page.evaluate((bx) => {
      bx.forEach((b) => {
        const d = document.createElement('div');
        d.className = '__mark';
        d.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;border:3px solid #E5262A;border-radius:8px;box-shadow:0 0 0 3px rgba(229,38,42,.18);' +
          'left:' + (b.x - 5) + 'px;top:' + (b.y - 5) + 'px;width:' + (b.w + 4) + 'px;height:' + (b.h + 4) + 'px';
        document.body.appendChild(d);
        if (b.label) {
          const n = document.createElement('div');
          n.className = '__mark';
          n.textContent = b.label;
          // 标号放在框的左外侧，不挡住字段名
          const outside = b.x > 46;
          n.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;background:#E5262A;color:#fff;font:700 15px/28px sans-serif;min-width:28px;height:28px;padding:0 6px;border-radius:14px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3);' +
            (outside ? 'left:' + (b.x - 42) + 'px;top:' + (b.y + Math.min(b.h / 2, 22) - 14) + 'px' : 'left:' + Math.max(2, b.x - 18) + 'px;top:' + Math.max(2, b.y - 18) + 'px');
          document.body.appendChild(n);
        }
      });
    }, boxes);
    const file = path.join(out, name + '.png');
    await page.screenshot({ path: file });
    await page.evaluate(() => document.querySelectorAll('.__mark').forEach((x) => x.remove()));
    shots.push(name);
    console.log('  ✓ ' + name + '（' + boxes.length + ' 处标注）');
  }
  async function idle(ms) {
    const t0 = Date.now();
    for (;;) {
      if (await page.evaluate(() => !document.querySelector('.progress') && !document.querySelector('.chip.idle .spin'))) return;
      if (Date.now() - t0 > ms) return;
      await wait(800);
    }
  }
  const row = (re) => page.locator('tr[data-open]').filter({ hasText: re }).first();
  const openRow = async (re) => { await go('ledger'); await row(re).click(); await page.waitForSelector('#rv-checks'); await wait(500); };

  // ---------- 演示前准备 ----------
  await page.click('[data-act="clear"]');
  await shot('01-清空台账', [['[data-act="clear-yes"]', 1]]);
  await page.click('[data-act="clear-yes"]');
  await wait(800);
  await page.click('[data-act="samples"]');
  await wait(800);
  await shot('02-加载示例发票', [['[data-act="samples"]', 1], ['.tiles', 2]]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#opBtn');
  await page.fill('#op-name', '财务-李会计');
  await shot('03-切换操作人', [['#op-name', 1], ['[data-act="op-ok"]', 2]], { noScroll: true });
  await page.click('[data-act="op-ok"]');
  await wait(300);
  await go('staff');
  await page.fill('#st-name', '张三');
  await page.fill('#st-dept', '市场部');
  await page.fill('#st-emails', 'zhangsan@demo.local\n12345678@qq.demo');
  await shot('04-登记员工和邮箱', [['#st-name', 1], ['#st-dept', 2], ['#st-grade', 3], ['#st-emails', 4], ['[data-act="st-save"]', 5]]);
  await page.click('[data-act="st-save"]');
  await wait(400);
  await shot('05-员工列表', [['section[aria-label="员工列表"]', null]]);
  // 收票邮箱（测试环境用本机测试邮箱，不截图）
  await go('mail');
  await page.selectOption('#mail-preset', 'custom');
  await page.fill('#mail-user', TO);
  await page.fill('#mail-pass', 'demo');
  await page.fill('#mail-host', '127.0.0.1');
  await page.fill('#mail-port', String(IMAP));
  await page.uncheck('#mail-secure');
  await page.click('[data-act="mail-test"]');
  await page.waitForSelector('[data-act="mail-edit"], .status-bad', { timeout: 30000 });
  // U8 演示环境
  await go('voucher-u8');
  await page.fill('#u8-operator', '李会计');
  await page.click('[data-act="u8-test"]');
  await page.waitForSelector('.status-ok, .status-bad', { timeout: 10000 });
  await shot('06-U8连接演示环境', [['#u8-mode', 1], ['[data-act="u8-test"]', 2], ['.status-ok', 3]]);

  // ---------- 1. 邮箱收票 ----------
  await go('mail');
  await page.click('button[data-act="mail-emp"]:has-text("张三")');
  await page.selectOption('#mail-days', '7');
  await shot('07-选员工检查邮件', [['button[data-act="mail-emp"]:has-text("张三")', 1], ['#mail-days', 2], ['[data-act="mail-scan"]', 3]]);
  await page.click('[data-act="mail-scan"]');
  await wait(500);
  for (let k = 0; k < 120; k++) { if (await page.evaluate(() => !!document.querySelector('[data-act="mail-scan"]:not([disabled])'))) break; await wait(500); }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(200);
  await shot('08-邮件清单', [['section[aria-label="邮件清单"] .mailmsg', 1], ['[data-act="mail-import"]', 2]], { noScroll: true });
  await page.click('[data-act="mail-import"]');
  await wait(600);
  if (await page.$('.progress')) await shot('09-正在识别', [['.progress', null]]);
  await idle(5 * 60 * 1000);
  await wait(800);

  // ---------- 2. 自动识别与审核 ----------
  await go('ledger');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('10-审核结果总览', [['.tiles', 1], ['section[aria-label="发票台账"] .tbl', 2], ['section:has(h2:text("问题分布"))', 3]], { noScroll: true });
  await shot('11-拦截和复核排在前面', [[row(/重复报销/), null], [row(/连号拆票/), null]], { center: true });

  // ---------- 3. 复核处理 ----------
  await openRow(/重复报销/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('12-复核页对照原件', [['#rv-paper', 1], ['#rv-checks .ck.fail', 2]], { noScroll: true });
  await shot('13-复核意见自动填写', [['#memo', 1], ['[data-dec="rejected"]', 2]], { center: true });
  await page.click('[data-dec="rejected"]');
  await wait(600);

  // ---------- 4. 职级与城市标准 ----------
  await openRow(/香格里拉/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('14-超出住宿标准', [['#rv-checks .ck:has-text("住宿标准")', 1]], { noScroll: true });
  await page.fill('#tr-nights', '3');
  await page.dispatchEvent('#tr-nights', 'change');
  await wait(500);
  await shot('15-改晚数后在标准内', [['#tr-nights', 1], ['#std-res', 2]], { center: true });
  await go('rules');
  await shot('16-职级与城市标准设置', [['section[aria-label="职级与城市标准"]', null]], { center: false });

  // ---------- 5. 生成凭证到 U8 ----------
  // 张三邮件导入的发票：需要复核的点「人工通过」（餐费那张截图）
  await go('ledger');
  const zIds = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-open]')).filter((r) => r.children[3] && r.children[3].innerText.trim() === '张三').map((r) => ({ id: r.getAttribute('data-open'), pass: /通过/.test(r.children[0].innerText), meal: /餐饮/.test(r.innerText) })));
  console.log('  张三的发票：' + JSON.stringify(zIds));
  zIds.sort((a, b) => (b.meal ? 1 : 0) - (a.meal ? 1 : 0));
  for (const z of zIds) {
    if (z.pass) continue;
    await go('review-' + z.id);
    await page.waitForSelector('[data-dec="approved"]');
    if (z.meal) { await page.fill('#memo', '客户招待 4 人，人均未超标，已核实，同意报销'); await shot('17-人工通过', [['#memo', 1], ['[data-dec="approved"]', 2]], { center: true }); }
    await page.click('[data-dec="approved"]');
    await wait(600);
  }
  await go('voucher');
  const card = 'section[aria-label="凭证 张三"]';
  await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
  await shot('18-凭证待确认分录', [[card + ' .vtbl', 1], [card + ' .status-ok', 2], [card + ' [data-act="v-confirm"]', 3]]);
  // 市场部是销售部门：办公费改记「销售费用-办公费」，并存成「市场部 + 办公用品」规则
  const zi = await page.evaluate((c) => Array.from(document.querySelectorAll(c + ' tr.vline [data-vf="code"]')).findIndex((x) => x.value === '660201'), card);
  const ci = page.locator(card + ' tr.vline [data-vf="code"]').nth(Math.max(zi, 0));
  await ci.fill('660101');
  await ci.press('Tab');
  await wait(400);
  await page.click(card + ' [data-act="v-confirm"]');
  await page.waitForSelector('#lm-0');
  await page.selectOption('#lm-0', 'dept');
  await shot('19-改科目存成规则', [['#lm-0', 1], ['[data-act="lm-ok"]', 2]], { noScroll: true });
  await page.click('[data-act="lm-ok"]');
  await wait(600);
  await go('voucher-done');
  await page.waitForSelector(card + ' [data-act="v-post"]');
  await shot('20-生成凭证到U8', [[card + ' [data-act="v-post"]', 1]], { center: true });
  await page.click(card + ' [data-act="v-post"]');
  await page.waitForSelector(card + ' [data-act="v-view"]', { timeout: 10000 });
  await wait(400);
  await page.click(card + ' [data-act="v-view"]');
  await page.waitForSelector('#v-viewer');
  await wait(300);
  await shot('21-查看U8凭证', [['#v-viewer .modal', null]], { noScroll: true });
  await page.click('[data-act="vv-close"]');

  // ---------- 6. 查询、原件、留痕 ----------
  await go('history');
  await page.fill('#hist-who', '张三');
  await page.click('[data-act="hist-range"][data-r="month"]');
  await wait(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('22-报销查询', [['#hist-who', 1], ['[data-act="hist-range"][data-r="month"]', 2], ['#hist-results', 3]], { noScroll: true });
  await go('review-' + (zIds[0] || {}).id);
  await page.waitForSelector('[data-act="arch-verify"]');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('[data-act="arch-verify"]');
  await wait(400);
  await shot('23-原件存档与校验', [['.arch', 1], ['#toast', 2]], { noScroll: true, keepToast: true });
  await shot('24-单张发票处理记录', [['section[aria-label="处理记录"]', null]], { center: true });
  await go('log');
  await page.click('[data-act="log-verify"]');
  await page.waitForSelector('#log-verify-res');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('25-操作记录与完整性校验', [['[data-act="log-verify"]', 1], ['#log-verify-res', 2], ['#log-rows', 3]], { noScroll: true });
  await go('ledger');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#exportBtn');
  await page.waitForSelector('#ex-sender');
  const zopt = await page.evaluate(() => (Array.from(document.querySelectorAll('#ex-sender option')).find((o) => o.textContent.indexOf('张三') === 0) || {}).value || '');
  if (zopt) await page.selectOption('#ex-sender', zopt);
  await shot('26-按报销人导出台账', [['#ex-sender', 1], ['#ex-scope', 2], ['[data-act="ex-go"]', 3]], { noScroll: true });
  await page.click('[data-act="ex-cancel"]');

  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(shots, null, 1));
  console.log('共 ' + shots.length + ' 张截图');
  await app.close();
  process.exit(0);
})().catch((e) => { console.error(e); fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(shots, null, 1)); process.exit(1); });
