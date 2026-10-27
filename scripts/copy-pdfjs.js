// 把 PDF 组件复制到界面目录，软件离线也能打开 PDF 发票
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');
const dst = path.join(__dirname, '..', 'renderer', 'vendor');
fs.mkdirSync(dst, { recursive: true });
for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log('PDF 组件已就绪');
