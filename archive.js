// 原始发票存档 + 操作记录（主进程）
//
// 存档：原始文件（PDF、OFD、XML、图片）按导入年月保存到 数据文件夹/archive/年/月/，
//       文件名前面加 SHA-256 的前 12 位。同一个文件导入多次只存一份。
//       入账时记下 SHA-256，以后可以随时校验原件有没有被改过。
// 操作记录：每条一行写进 audit-log.jsonl，只追加、不修改。
//       每条记录带上一条的哈希（hash 链），中间任何一条被改或删，校验时都能发现。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function fail(code, message) { const e = new Error(message); e.code = code; return e; }

/* ---------- 原始文件存档 ---------- */
const ARCH = (dir) => path.join(dir, 'archive');
function safeName(n) {
  const s = String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-80);
  return s || 'file';
}
// rel 只能指向 archive 文件夹里面
function resolveRel(dir, rel) {
  const base = ARCH(dir);
  const p = path.resolve(base, String(rel || '').replace(/^archive[\\/]/, ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw fail('archive_path', '存档路径不对');
  return p;
}
function put(dir, { name, data, date }) {
  const buf = Buffer.from(data);
  if (!buf.length) throw fail('archive_empty', '文件是空的');
  const hash = sha256(buf);
  const d = date ? new Date(date) : new Date();
  const ym = path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
  // 同一个文件以前存过（不管哪个月），直接用原来那份
  const found = findByHash(dir, hash);
  if (found) return { path: found, sha256: hash, size: buf.length, existed: true };
  const rel = path.join('archive', ym, hash.slice(0, 12) + '_' + safeName(name)).split(path.sep).join('/');
  const full = resolveRel(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf, { flag: 'wx' });
  try { fs.chmodSync(full, 0o444); } catch (e) { /* 设成只读，防止误改 */ }
  return { path: rel, sha256: hash, size: buf.length, existed: false };
}
function findByHash(dir, hash) {
  const base = ARCH(dir), pre = hash.slice(0, 12) + '_';
  if (!fs.existsSync(base)) return null;
  for (const y of fs.readdirSync(base)) {
    const yd = path.join(base, y);
    if (!fs.statSync(yd).isDirectory()) continue;
    for (const m of fs.readdirSync(yd)) {
      const md = path.join(yd, m);
      if (!fs.statSync(md).isDirectory()) continue;
      const f = fs.readdirSync(md).find((x) => x.startsWith(pre));
      if (f && sha256(fs.readFileSync(path.join(md, f))) === hash) return ['archive', y, m, f].join('/');
    }
  }
  return null;
}
function read(dir, rel) {
  const p = resolveRel(dir, rel);
  if (!fs.existsSync(p)) throw fail('archive_missing', '原件存档找不到了：' + rel);
  return fs.readFileSync(p);
}
function verify(dir, rel, want) {
  const p = resolveRel(dir, rel);
  if (!fs.existsSync(p)) return { ok: false, missing: true, msg: '原件存档找不到了' };
  const got = sha256(fs.readFileSync(p));
  return got === want ? { ok: true, sha256: got, msg: '原件完好，和入账时一致' } : { ok: false, sha256: got, msg: '原件和入账时不一致，可能被改过' };
}
function fullPath(dir, rel) { return resolveRel(dir, rel); }

/* ---------- 操作记录（hash 链） ---------- */
const LOG = (dir) => path.join(dir, 'audit-log.jsonl');
const GENESIS = '0'.repeat(64);
const tails = {};
function readLog(dir) {
  const f = LOG(dir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { return { seq: i + 1, broken: true, raw: l }; }
  });
}
function tail(dir) {
  if (tails[dir]) return tails[dir];
  const all = readLog(dir), last = all[all.length - 1];
  tails[dir] = last && !last.broken ? { seq: last.seq, hash: last.hash } : { seq: all.length, hash: GENESIS };
  return tails[dir];
}
function entryHash(prev, e) {
  const body = { seq: e.seq, at: e.at, who: e.who, act: e.act, type: e.type, id: e.id, label: e.label, detail: e.detail };
  return sha256(prev + JSON.stringify(body));
}
function append(dir, input) {
  const t = tail(dir);
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const e = { seq: t.seq + 1, at: new Date().toISOString(), who: s(input.who, 40) || '未设置', act: s(input.act, 40), type: s(input.type, 20), id: s(input.id, 60), label: s(input.label, 120), detail: s(input.detail, 2000) };
  e.prev = t.hash;
  e.hash = entryHash(t.hash, e);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG(dir), JSON.stringify(e) + '\n', 'utf8');
  tails[dir] = { seq: e.seq, hash: e.hash };
  return e;
}
function list(dir) { return readLog(dir); }
function verifyLog(dir) {
  const all = readLog(dir);
  let prev = GENESIS;
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e.broken) return { ok: false, count: all.length, badAt: i + 1, msg: '第 ' + (i + 1) + ' 条记录格式被破坏' };
    if (e.seq !== i + 1) return { ok: false, count: all.length, badAt: i + 1, msg: '第 ' + (i + 1) + ' 条前后有记录被删除或插入' };
    if (e.prev !== prev || entryHash(prev, e) !== e.hash) return { ok: false, count: all.length, badAt: i + 1, msg: '第 ' + (i + 1) + ' 条记录被修改过（' + (e.at || '').slice(0, 16).replace('T', ' ') + ' ' + (e.act || '') + '）' };
    prev = e.hash;
  }
  return { ok: true, count: all.length, msg: '共 ' + all.length + ' 条记录，校验通过，没有被修改或删除' };
}
function _reset(dir) { delete tails[dir]; }

module.exports = { put, read, verify, fullPath, append, list, verifyLog, sha256, _reset };
