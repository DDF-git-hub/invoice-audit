// 邮箱收票（主进程）
// 只读方式连接邮箱（IMAP），按发件人和日期搜索邮件，取出发票附件。
// 不会把邮件标为已读，也不会删除或移动邮件。
'use strict';
const zlib = require('zlib');
const X = require('./renderer/extract.js');

const PRESETS = {
  qq: { name: 'QQ 邮箱', host: 'imap.qq.com', port: 993, secure: true, domain: /@(qq|foxmail|vip\.qq)\.com$/i },
  exmail: { name: '腾讯企业邮', host: 'imap.exmail.qq.com', port: 993, secure: true },
  '163': { name: '网易 163 邮箱', host: 'imap.163.com', port: 993, secure: true, domain: /@163\.com$/i },
  '126': { name: '网易 126 邮箱', host: 'imap.126.com', port: 993, secure: true, domain: /@126\.com$/i },
  qiye163: { name: '网易企业邮', host: 'imap.qiye.163.com', port: 993, secure: true },
  aliyun: { name: '阿里企业邮箱', host: 'imap.qiye.aliyun.com', port: 993, secure: true },
  custom: { name: '其他邮箱（手动填写服务器）', host: '', port: 993, secure: true }
};

const INVOICE_EXT = /\.(pdf|ofd|xml|zip)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const MAX_MESSAGES = 300;

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function friendlyError(e) {
  const t = String((e && (e.responseText || e.response || e.message)) || e || '');
  if ((e && e.authenticationFailed) || /AUTHENTICATIONFAILED|authenticat|Login fail|password|授权码|LOGIN/i.test(t)) {
    return fail('mail_auth', '邮箱或授权码不对。QQ 邮箱要填「授权码」，不是登录密码；请确认已在邮箱设置里开启 IMAP 服务');
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(t) || (e && /ENOTFOUND|EAI_AGAIN/.test(e.code))) return fail('mail_net', '找不到邮箱服务器，请检查网络或服务器地址');
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|Timed out|socket/i.test(t) || (e && /ECONN|ETIMEDOUT/.test(e.code))) return fail('mail_net', '连不上邮箱服务器，请检查网络；公司网络可能拦截了邮箱端口 993');
  return fail('mail_error', '读取邮件出错：' + t.slice(0, 200));
}

async function connect(cfg) {
  const { ImapFlow } = require('imapflow');
  if (!cfg.host || !cfg.user || !cfg.pass) throw fail('mail_config', '请先填写邮箱地址和授权码');
  const client = new ImapFlow({
    host: cfg.host, port: Number(cfg.port) || 993, secure: cfg.secure !== false,
    auth: { user: cfg.user, pass: cfg.pass }, logger: false,
    clientInfo: { name: 'InvoiceAudit', version: '1.3' },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 120000
  });
  client.on('error', () => { /* 由调用处处理 */ });
  try { await client.connect(); } catch (e) { throw friendlyError(e); }
  return client;
}

async function test(cfg) {
  const client = await connect(cfg);
  try {
    const st = await client.status('INBOX', { messages: true });
    return { messages: st.messages };
  } catch (e) { throw friendlyError(e); }
  finally { await client.logout().catch(() => {}); }
}

/* ---------- 附件和压缩包 ---------- */
function inflateRaw(u8) { return Promise.resolve(new Uint8Array(zlib.inflateRawSync(Buffer.from(u8)))); }
function sniff(buf) {
  const b = Buffer.from(buf.slice(0, 8));
  if (b.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (/^\s*</.test(b.toString('latin1'))) return 'xml';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  return '';
}
function isOfdZip(entries) { return entries.some((e) => /^OFD\.xml$/i.test(e.name)); }

// 把一个文件展开成若干发票文件（压缩包里的发票会被取出；OFD 本身也是压缩包，保持原样）
async function expand(name, buf, out, depth) {
  const kind = sniff(buf);
  if (/\.zip$/i.test(name) || (kind === 'zip' && !/\.ofd$/i.test(name))) {
    if (depth > 1) return;
    let entries;
    try { entries = await X.readZip(buf, inflateRaw); } catch (e) { return; }
    if (isOfdZip(entries)) { out.push({ name: name.replace(/\.zip$/i, '') + '.ofd', data: buf }); return; }
    for (const e of entries) {
      if (/\/$/.test(e.name) || /(^|\/)(__MACOSX|\.)/.test(e.name)) continue;
      if (!INVOICE_EXT.test(e.name) && !IMAGE_EXT.test(e.name)) continue;
      const data = await e.readBytes();
      await expand(e.name.split('/').pop(), data, out, depth + 1);
    }
    return;
  }
  if (INVOICE_EXT.test(name) || IMAGE_EXT.test(name)) out.push({ name, data: buf });
}

const LINK_HINT = /\.(pdf|ofd|xml|zip)(\?|#|$)|download|fapiao|invoice|einv|fpdown|nuonuo|baiwang|chinatax|piaoyi|51fapiao|bwjf|fp\./i;
function findLinks(mail) {
  const set = new Set();
  const add = (u) => { u = u.replace(/&amp;/g, '&').replace(/[)>\]"'，。；]+$/, ''); if (/^https?:\/\//i.test(u) && LINK_HINT.test(u) && u.length < 1500) set.add(u); };
  String(mail.html || '').replace(/href\s*=\s*["']([^"']+)["']/gi, (_, u) => { add(u); return ''; });
  String(mail.text || '').replace(/https?:\/\/[^\s<>"'，。；]+/gi, (u) => { add(u); return ''; });
  return Array.from(set).slice(0, 5);
}
async function tryDownload(url, net) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await net.fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 20 * 1048576) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const kind = sniff(buf);
    if (!kind || kind === 'xml' && !/<(?:[\w.-]+:)?(EInvoice|InvoiceNumber|FPHM)/i.test(Buffer.from(buf.slice(0, 4000)).toString('utf8'))) return null;
    let name = '';
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    if (m) { try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; } }
    if (!name) name = decodeURIComponent((new URL(r.url || url).pathname.split('/').pop() || '').slice(0, 80)) || '下载的发票';
    if (!/\.(pdf|ofd|xml|zip|jpe?g|png)$/i.test(name)) name += '.' + (kind === 'zip' ? 'zip' : kind);
    return { name, data: buf };
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

// 解析一封邮件（含转发进来的原邮件），取出发票文件和下载链接
async function collect(mail, out, links, depth) {
  const { simpleParser } = require('mailparser');
  for (const a of mail.attachments || []) {
    const ct = String(a.contentType || '').toLowerCase();
    const name = a.filename || '';
    if (ct === 'message/rfc822' || /\.eml$/i.test(name)) {
      if (depth < 2) { try { await collect(await simpleParser(a.content), out, links, depth + 1); } catch (e) { /* 忽略 */ } }
      continue;
    }
    const buf = new Uint8Array(a.content);
    if (IMAGE_EXT.test(name) || /^image\//.test(ct)) {
      // 跳过签名档图标、正文里嵌的小图片
      if (a.related || a.contentDisposition === 'inline' || buf.length < 40 * 1024) continue;
      out.push({ name: name || ('图片.' + (sniff(buf) || 'jpg')), data: buf });
      continue;
    }
    let nm = name;
    if (!nm) { const k = sniff(buf); if (!k) continue; nm = '附件.' + k; }
    await expand(nm, buf, out, 0);
  }
  findLinks(mail).forEach((u) => links.push(u));
}

function key(msgId, name, size) { return [msgId || '', name, size].join('|'); }

/* ---------- 按发件人搜索 ---------- */
// senders: 发件人邮箱数组；days: 最近几天；seen: 已导入记录（Set）；onProgress(text)
async function scan(cfg, opts, seen, net, onProgress) {
  const senders = (opts.senders || []).map((s) => String(s).trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+$/.test(s));
  if (!senders.length) throw fail('mail_input', '请填写至少一个发件人邮箱');
  const days = Math.max(1, Math.min(3650, Number(opts.days) || 30));
  const since = new Date(Date.now() - days * 864e5);
  onProgress('正在连接邮箱');
  const client = await connect(cfg);
  const messages = [];
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uidSet = new Set();
      for (const s of senders) {
        onProgress('正在搜索 ' + s + ' 的邮件');
        const r = await client.search({ from: s, since }, { uid: true });
        (r || []).forEach((u) => uidSet.add(u));
      }
      const uids = Array.from(uidSet).sort((a, b) => b - a).slice(0, MAX_MESSAGES);
      if (!uids.length) return { messages: [], senders, days };
      let i = 0;
      const { simpleParser } = require('mailparser');
      for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true }, { uid: true })) {
        i++;
        onProgress('正在读取第 ' + i + ' / ' + uids.length + ' 封邮件');
        let mail;
        try { mail = await simpleParser(msg.source); } catch (e) { continue; }
        const from = (mail.from && mail.from.value && mail.from.value[0]) || {};
        const addr = String(from.address || '').toLowerCase();
        // IMAP 的 FROM 搜索是模糊匹配，这里再精确核对一次
        if (senders.indexOf(addr) < 0) continue;
        const files = [], links = [];
        await collect(mail, files, links, 0);
        const msgId = mail.messageId || ('uid-' + msg.uid);
        const got = [];
        // 正文里的下载链接：能直接下载到发票文件的就下载
        const failedLinks = [];
        for (const u of links) {
          onProgress('正在下载邮件里的发票链接（第 ' + i + ' 封）');
          const d = await tryDownload(u, net);
          if (d) await expand(d.name, d.data, got, 0); else failedLinks.push(u);
        }
        const all = files.concat(got);
        // 同一封邮件里同名同大小的文件只保留一个
        const uniq = [];
        all.forEach((f) => { if (!uniq.some((u) => u.name === f.name && u.data.length === f.data.length)) uniq.push(f); });
        messages.push({
          uid: msg.uid, msgId, from: addr, fromName: from.name || '', subject: mail.subject || '（无主题）',
          date: mail.date ? mail.date.toISOString() : '',
          files: uniq.map((f, n) => ({ id: msg.uid + ':' + n, name: f.name, size: f.data.length, data: f.data, key: key(msgId, f.name, f.data.length), seen: seen.has(key(msgId, f.name, f.data.length)) })),
          links: got.length ? [] : failedLinks
        });
      }
    } finally { lock.release(); }
  } catch (e) { throw e.code && /^mail_/.test(e.code) ? e : friendlyError(e); }
  finally { await client.logout().catch(() => {}); }
  messages.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { messages, senders, days };
}

module.exports = { PRESETS, test, scan };
