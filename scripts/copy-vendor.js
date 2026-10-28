// 把离线识别需要的组件复制到 renderer/vendor，打包进软件，使用时不需要联网：
//   pdf.js（读取 PDF）、jsQR（读取发票二维码）、tesseract.js + 中文模型（图片文字识别）
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, 'renderer', 'vendor', ...p);

function copy(src, dst) {
  if (!fs.existsSync(src)) throw new Error('找不到 ' + path.relative(root, src) + '，请先运行 npm install');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function download(url, dst) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return download(res.headers.location, dst).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error('下载失败 ' + res.statusCode + ' ' + url));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, Buffer.concat(chunks)); resolve(); });
    }).on('error', reject);
  });
}

// 中文识别模型：优先用 npm 包里的 best_int（准确率和速度的平衡），找不到再下载
function findChiSim() {
  const base = nm('@tesseract.js-data', 'chi_sim');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'chi_sim.traineddata.gz')));
  dirs.sort((a, b) => (b.includes('best_int') ? 1 : 0) - (a.includes('best_int') ? 1 : 0));
  return dirs.length ? path.join(base, dirs[0], 'chi_sim.traineddata.gz') : null;
}

async function main() {
  copy(nm('pdfjs-dist', 'build', 'pdf.min.js'), out('pdf.min.js'));
  copy(nm('pdfjs-dist', 'build', 'pdf.worker.min.js'), out('pdf.worker.min.js'));
  // 中文 PDF 常用不内嵌的宋体（STSong 等），需要字符映射表才能读出文字
  for (const d of ['cmaps', 'standard_fonts']) {
    const src = nm('pdfjs-dist', d);
    if (!fs.existsSync(src)) throw new Error('找不到 pdfjs-dist/' + d);
    fs.readdirSync(src).forEach((f) => copy(path.join(src, f), out(d, f)));
  }
  copy(nm('jsqr', 'dist', 'jsQR.js'), out('jsQR.js'));
  copy(nm('xlsx', 'dist', 'xlsx.full.min.js'), out('xlsx.full.min.js'));
  copy(nm('tesseract.js', 'dist', 'tesseract.min.js'), out('tesseract', 'tesseract.min.js'));
  copy(nm('tesseract.js', 'dist', 'worker.min.js'), out('tesseract', 'worker.min.js'));
  const coreDir = nm('tesseract.js-core');
  const cores = fs.readdirSync(coreDir).filter((f) => /^tesseract-core.*\.wasm\.js$/.test(f));
  if (!cores.length) throw new Error('tesseract.js-core 里没有找到 *.wasm.js');
  cores.forEach((f) => copy(path.join(coreDir, f), out('tesseract', 'core', f)));

  const lang = out('tesseract', 'lang', 'chi_sim.traineddata.gz');
  const local = findChiSim();
  if (local) copy(local, lang);
  else if (!fs.existsSync(lang)) {
    console.log('npm 包里没有中文模型，从 GitHub 下载……');
    const raw = path.join(path.dirname(lang), 'chi_sim.traineddata');
    await download('https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata', raw);
    fs.writeFileSync(lang, zlib.gzipSync(fs.readFileSync(raw)));
    fs.unlinkSync(raw);
  }
  const size = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + 'MB';
  console.log('识别组件已就绪：PDF、二维码、文字识别（核心 ' + cores.join('、') + '；中文模型 ' + size(lang) + (local ? '，来自 ' + path.relative(root, local) : '') + '）');
}
main().catch((e) => { console.error('准备识别组件失败：' + e.message); process.exit(1); });
