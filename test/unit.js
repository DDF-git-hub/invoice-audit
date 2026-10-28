// 识别单元测试（云端 Node 环境运行）：
//   PDF / XML / OFD 必须全部字段正确；二维码必须能读出；
//   图片文字识别（OCR）输出准确率报告，并把识别出的文字打印出来便于排查。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const X = require('../renderer/extract.js');
const { compare, KEYS } = require('./compare.js');

const dir = path.join(__dirname, 'fixtures');
const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const results = { failed: 0, ocr: [] };
const onlyOcr = process.argv.includes('--ocr-only');
const skipOcr = process.argv.includes('--no-ocr');

function line(ok, name, extra) { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : '')); }
function fmtBad(bad) { return bad.map((b) => b.k + ': ' + JSON.stringify(b.got) + ' ≠ ' + JSON.stringify(b.want)).join(' | '); }

async function pdfRows(file) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useSystemFonts: false,
    cMapUrl: path.join(root, 'cmaps') + path.sep, cMapPacked: true, standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep
  }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return X.rowsFromPdfItems(tc.items, vp.height);
}

function decodeImage(file) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) { const { PNG } = require('pngjs'); const p = PNG.sync.read(buf); return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height }; }
  const j = require('jpeg-js').decode(buf, { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(j.data), width: j.width, height: j.height };
}
function crop(img, x0, y0, w, h) {
  x0 = Math.floor(x0); y0 = Math.floor(y0); w = Math.floor(w); h = Math.floor(h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { data: out, width: w, height: h };
}
function qrOf(file) {
  const jsQR = require('jsqr');
  const img = decodeImage(file);
  const tries = [crop(img, 0, 0, img.width * 0.35, img.height * 0.45), img];
  for (const t of tries) { const r = jsQR(t.data, t.width, t.height, { inversionAttempts: 'dontInvert' }); if (r && r.data) return r.data; }
  return null;
}

async function ocrTest(langDir, label) {
  const { createWorker } = require('tesseract.js');
  const t0 = Date.now();
  const worker = await createWorker('chi_sim', 1, { langPath: langDir, gzip: true, cacheMethod: 'none' });
  await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
  console.log('\n[OCR] 模型：' + label + '（加载 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  let total = 0, right = 0;
  for (const name of Object.keys(exp).filter((k) => /\.(png|jpg)$/.test(k))) {
    const t1 = Date.now();
    const { data } = await worker.recognize(path.join(dir, name), {}, { text: true, tsv: true });
    const rows = data.tsv ? X.rowsFromTsv(data.tsv) : X.rowsFromText(data.text);
    const res = X.parseText(rows);
    const q = X.parseQr(qrOf(path.join(dir, name)));
    if (q) X.applyQr(res, q);
    X.snapBuyer(res, [{ name: '上海示例科技有限公司', taxId: '91310115MA1K4A2B3C' }]);
    X.score(res, 'ocr');
    const e = exp[name], keys = KEYS.filter((k) => k in e);
    const bad = compare(res.f, e);
    total += keys.length; right += keys.length - bad.length;
    line(!bad.length, name, '字段 ' + (keys.length - bad.length) + '/' + keys.length + '，置信度 ' + res.conf + '，耗时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's' + (bad.length ? '\n      ' + fmtBad(bad) : ''));
    if (process.env.OCR_DUMP) console.log('      ---- 识别文字 ----\n      ' + rows.join('\n      '));
    results.ocr.push({ model: label, file: name, ok: keys.length - bad.length, of: keys.length, bad });
  }
  await worker.terminate();
  console.log('  合计字段准确率：' + right + '/' + total + '（' + Math.round(right / total * 100) + '%）');
  return right / total;
}

(async () => {
  if (!onlyOcr) {
    console.log('[PDF 文字层]');
    for (const name of Object.keys(exp).filter((k) => k.endsWith('.pdf'))) {
      try {
        const res = X.parseText(await pdfRows(path.join(dir, name)));
        X.score(res, 'pdf-text');
        const bad = compare(res.f, exp[name]);
        if (bad.length) results.failed++;
        line(!bad.length, name, bad.length ? fmtBad(bad) + '\n      ' + res.text.replace(/\n/g, '\n      ') : '置信度 ' + res.conf);
      } catch (e) { results.failed++; line(false, name, '出错：' + e.message); }
    }
    console.log('[XML / OFD]');
    {
      const res = X.parseXml(fs.readFileSync(path.join(dir, 'sdp-canyin.xml'), 'utf8'));
      const bad = compare(res.f, exp['sdp-canyin.xml']);
      if (bad.length) results.failed++;
      line(!bad.length, 'sdp-canyin.xml', fmtBad(bad));
      const o = await X.parseOfd(fs.readFileSync(path.join(dir, 'sdp-zhuanpiao.ofd')), (b) => Promise.resolve(zlib.inflateRawSync(Buffer.from(b))));
      const bad2 = compare(o.res.f, exp['sdp-zhuanpiao.ofd']);
      if (bad2.length) results.failed++;
      line(!bad2.length, 'sdp-zhuanpiao.ofd', fmtBad(bad2));
    }
    console.log('[二维码]');
    for (const name of Object.keys(exp).filter((k) => /\.(png|jpg)$/.test(k))) {
      const id = name.replace(/-(screenshot|hd|photo)\.(png|jpg)$/, '');
      const got = qrOf(path.join(dir, name));
      const ok = got === exp._qr[id];
      if (!ok) results.failed++;
      line(ok, name, ok ? '' : '读到 ' + JSON.stringify(got));
    }
  }
  if (!skipOcr) {
    const base = path.dirname(require.resolve('@tesseract.js-data/chi_sim/package.json'));
    const variants = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'chi_sim.traineddata.gz')));
    console.log('\n可用中文模型：' + variants.join('、'));
    for (const v of variants) await ocrTest(path.join(base, v), v);
  }
  fs.mkdirSync(path.join(__dirname, '..', 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'test-output', 'unit-ocr.json'), JSON.stringify(results.ocr, null, 2));
  console.log(results.failed ? '\n有 ' + results.failed + ' 项必须通过的测试失败' : '\n必须通过的测试全部通过');
  process.exit(results.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
