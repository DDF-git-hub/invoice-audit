// 用友 U8 凭证接口（主进程）
//
// 两种模式：
//   demo    演示环境：软件内置一个模拟的 U8 接收端，凭证保存在本机 u8-demo.json，返回凭证号。
//           用于演示完整流程，不连接任何真实的 U8。
//   openapi 正式环境：按用友 U8 OpenAPI 的方式调用（先取 token，再新增凭证）。
//           各家 U8 版本、开放平台配置不同，正式使用前必须在客户的测试账套上联调，
//           字段对照（凭证类别、科目编码、辅助核算）以客户 U8 的实际设置为准。
'use strict';
const fs = require('fs');
const path = require('path');

function fail(code, message) { const e = new Error(message); e.code = code; return e; }
const r2 = (n) => Math.round(n * 100) / 100;

/* ---------- 共用校验（两种模式都会做） ---------- */
function validate(v) {
  const errs = [];
  if (!v || !Array.isArray(v.entries) || !v.entries.length) errs.push('凭证没有分录');
  let d = 0, c = 0;
  (v.entries || []).forEach((e, i) => {
    if (!e.code) errs.push('第 ' + (i + 1) + ' 行没有科目');
    if (!(Number(e.debit) > 0) && !(Number(e.credit) > 0)) errs.push('第 ' + (i + 1) + ' 行金额为 0');
    d += Number(e.debit) || 0; c += Number(e.credit) || 0;
  });
  if (Math.abs(r2(d) - r2(c)) > 0.001) errs.push('借贷不平衡：借方 ' + r2(d).toFixed(2) + '，贷方 ' + r2(c).toFixed(2));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) errs.push('凭证日期不对');
  return { ok: !errs.length, errs, debit: r2(d), credit: r2(c) };
}

/* ---------- 演示环境 ---------- */
function demoFile(dir) { return path.join(dir, 'u8-demo.json'); }
function demoLoad(dir) { try { return JSON.parse(fs.readFileSync(demoFile(dir), 'utf8')); } catch (e) { return { vouchers: [] }; } }
function demoSave(dir, db) { fs.writeFileSync(demoFile(dir), JSON.stringify(db, null, 2), 'utf8'); }

async function demoTest(cfg) {
  await new Promise((r) => setTimeout(r, 400));
  if (!cfg.server) throw fail('u8_config', '请填写服务器地址');
  if (!cfg.account) throw fail('u8_config', '请填写账套号');
  return { msg: '已连接演示环境（模拟 U8）：账套 ' + cfg.account + '，' + (cfg.year || new Date().getFullYear()) + ' 年度，操作员 ' + (cfg.operator || '未填') };
}
async function demoPost(cfg, v, dir) {
  await new Promise((r) => setTimeout(r, 300));
  const chk = validate(v);
  if (!chk.ok) throw fail('u8_reject', 'U8 拒绝：' + chk.errs.join('；'));
  const db = demoLoad(dir);
  const dup = db.vouchers.find((x) => x.externalId === v.externalId);
  if (dup) throw fail('u8_dup', '这张凭证已经传过了（U8 凭证号 ' + dup.word + '-' + dup.no + '），不能重复生成');
  const period = v.date.slice(0, 7);
  const word = v.word || '记';
  const next = db.vouchers.filter((x) => x.period === period && x.word === word).reduce((m, x) => Math.max(m, Number(x.no)), 0) + 1;
  const rec = Object.assign({}, v, { no: String(next).padStart(4, '0'), period, word, account: cfg.account, maker: v.maker || cfg.operator || '', status: '未审核', receivedAt: new Date().toISOString() });
  db.vouchers.push(rec);
  demoSave(dir, db);
  return { no: rec.no, word, period, display: word + '-' + rec.no, status: '未审核' };
}

/* ---------- 正式环境：U8 OpenAPI（需要联调） ---------- */
async function openapiToken(cfg, net) {
  const base = String(cfg.server || '').replace(/\/+$/, '');
  if (!base || !cfg.appKey || !cfg.appSecret || !cfg.fromAccount) throw fail('u8_config', '请填写开放平台地址、AppKey、AppSecret 和企业账号');
  const url = base + '/system/token?from_account=' + encodeURIComponent(cfg.fromAccount) + '&app_key=' + encodeURIComponent(cfg.appKey) + '&app_secret=' + encodeURIComponent(cfg.appSecret);
  let r;
  try { r = await net.fetch(url); } catch (e) { throw fail('u8_net', '连不上 U8 开放平台：' + e.message); }
  const j = await r.json().catch(() => ({}));
  const token = j && (j.token && (j.token.id || j.token) || j.access_token);
  if (!r.ok || !token) throw fail('u8_auth', '获取 U8 令牌失败：' + (j.errmsg || j.message || r.status));
  return token;
}
function toOpenapiVoucher(cfg, v) {
  // 字段名按 U8 OpenAPI 凭证接口的常见写法；具体以客户开放平台文档为准，联调时在这里调整
  return {
    voucher: {
      voucher_type: v.word || '记', fiscal_year: v.date.slice(0, 4), accounting_period: Number(v.date.slice(5, 7)),
      date: v.date, enter: v.maker || cfg.operator || '', attachment_number: v.attachments || 0,
      entry: v.entries.map((e) => ({
        abstract: e.summary, account_code: e.code,
        natural_debit_currency: e.debit ? Number(e.debit).toFixed(2) : '0', natural_credit_currency: e.credit ? Number(e.credit).toFixed(2) : '0',
        dept_id: e.deptCode || undefined, person_id: e.personCode || undefined
      }))
    }
  };
}
async function openapiTest(cfg, net) {
  await openapiToken(cfg, net);
  return { msg: '已连接 U8 开放平台，令牌获取成功。生成凭证前请先在测试账套试传一张。' };
}
async function openapiPost(cfg, v, net) {
  const chk = validate(v);
  if (!chk.ok) throw fail('u8_reject', chk.errs.join('；'));
  const token = await openapiToken(cfg, net);
  const base = String(cfg.server).replace(/\/+$/, '');
  const qs = 'from_account=' + encodeURIComponent(cfg.fromAccount) + '&to_account=' + encodeURIComponent(cfg.toAccount || cfg.account) +
    '&app_key=' + encodeURIComponent(cfg.appKey) + '&token=' + encodeURIComponent(token) + '&tradeid=' + encodeURIComponent(v.externalId);
  let r;
  try { r = await net.fetch(base + '/api/voucher/add?' + qs, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toOpenapiVoucher(cfg, v)) }); }
  catch (e) { throw fail('u8_net', '连不上 U8：' + e.message); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.errcode && String(j.errcode) !== '0')) throw fail('u8_reject', 'U8 返回错误：' + (j.errmsg || j.message || r.status));
  const no = j.id || j.voucher_no || j.ino_id || '';
  return { no: String(no), word: v.word || '记', period: v.date.slice(0, 7), display: (v.word || '记') + '-' + no, status: '未审核' };
}

/* ---------- 对外 ---------- */
async function test(cfg, net) { return cfg.mode === 'openapi' ? openapiTest(cfg, net) : demoTest(cfg); }
async function post(cfg, v, dir, net) { return cfg.mode === 'openapi' ? openapiPost(cfg, v, net) : demoPost(cfg, v, dir); }
function demoList(dir) { return demoLoad(dir).vouchers.slice().reverse(); }

module.exports = { test, post, validate, demoList };
