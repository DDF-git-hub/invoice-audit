// 给云端测试邮箱发一批模拟邮件（只在测试里使用）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');

const dir = path.join(__dirname, 'fixtures');
const TO = 'finance@test.local';
const ZHANG = { name: '张三', address: 'zhangsan@test.local' };

// 用 Windows 资源管理器打包时的样子：中文文件名用 GBK 编码，不带 UTF-8 标记，不压缩
function gbkZip(entries) {
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc32 = (b) => { let r = -1; for (const x of b) r = (r >>> 8) ^ table[(r ^ x) & 255]; return (r ^ -1) >>> 0; };
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = e.nameBytes, data = e.data, crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// 提供“下载链接”的本地网页服务
function startLinkServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/download/fp.pdf')) {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="old-zhusu-link.pdf"' });
        res.end(fs.readFileSync(path.join(dir, 'old-zhusu.pdf')));
      } else { res.writeHead(404); res.end('not found'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function seed(smtpPort) {
  const { srv, port } = await startLinkServer();
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true });
  const send = (o) => t.sendMail(Object.assign({ to: TO }, o));
  const file = (n) => fs.readFileSync(path.join(dir, n));
  const inner = await new MailComposer({
    from: '诺诺发票 <noreply@nuonuo.example>', to: ZHANG.address, subject: '您收到一张电子发票',
    text: '您好，附件是您的电子发票。', attachments: [{ filename: '铁路电子客票.pdf', content: file('rail.pdf') }]
  }).compile().build();
  const gbkName = Buffer.concat([Buffer.from([0xb7, 0xa2, 0xc6, 0xb1]), Buffer.from('.pdf')]); // “发票.pdf”
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

  await send({ from: ZHANG, subject: '餐费发票', text: '请报销', attachments: [{ filename: '餐费.pdf', content: file('sdp-canyin.pdf') }] });
  await send({ from: ZHANG, subject: '办公用品发票（压缩包）', text: '见附件', attachments: [{ filename: 'fapiao.zip', content: gbkZip([{ nameBytes: gbkName, data: file('sdp-zhuanpiao.pdf') }, { nameBytes: Buffer.from('readme.txt'), data: Buffer.from('hello') }]) }] });
  await send({ from: ZHANG, subject: 'Fw: 您收到一张电子发票', text: '转发', attachments: [{ filename: 'forward.eml', content: inner, contentType: 'message/rfc822' }] });
  await send({ from: ZHANG, subject: '周报', html: '<p>本周工作</p><img src="cid:logo">', attachments: [{ filename: 'logo.png', content: tinyPng, cid: 'logo' }] });
  await send({ from: ZHANG, subject: '住宿发票下载', html: '<p>点击下载发票：<a href="http://127.0.0.1:' + port + '/download/fp.pdf">下载</a></p>' });
  await send({ from: ZHANG, subject: '发票链接（已失效）', text: '下载地址：http://127.0.0.1:' + port + '/invoice/missing' });
  await send({ from: { name: '李四', address: 'lisi@test.local' }, subject: '打车发票', attachments: [{ filename: '打车.pdf', content: file('sdp-geren.pdf') }] });
  await send({ from: { name: '冒充', address: 'xzhangsan@test.local' }, subject: '不应该被收进来', attachments: [{ filename: 'x.pdf', content: file('sdp-geren.pdf') }] });
  t.close();
  return { srv, expect: { messages: 6, files: 4, deadLinks: 1, nos: ['26312000000207718804', '26112000000310087642', '26319166000003651200', '38291746'] } };
}

module.exports = { seed, TO, ZHANG };
