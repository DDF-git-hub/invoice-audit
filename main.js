// 发票审核台 - Electron 主进程
// 负责：窗口、本地数据文件、AI 识别接口调用（API Key 只在主进程里使用，不暴露给页面）
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, net, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 测试时可以指定独立的数据目录
if (process.env.INVOICE_AUDIT_USERDATA) app.setPath('userData', process.env.INVOICE_AUDIT_USERDATA);

// 界面通过 app://bundle/ 加载（而不是 file://），这样内置文字识别组件可以正常读取本地的识别模型
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const RENDERER_DIR = path.join(__dirname, 'renderer');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveApp(request) {
  const u = new URL(request.url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.normalize(path.join(RENDERER_DIR, rel));
  if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString()).then(async (r) => {
    if (!r.ok) return r;
    const type = MIME[path.extname(file).toLowerCase()];
    return type ? new Response(await r.arrayBuffer(), { status: 200, headers: { 'content-type': type } }) : r;
  }).catch(() => new Response('Not found', { status: 404 }));
}

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
const dataDir = () => app.getPath('userData');
const LEDGER = () => path.join(dataDir(), 'ledger.json');
const SETTINGS = () => path.join(dataDir(), 'settings.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------------- AI 服务设置 ---------------- */
const PROVIDERS = {
  qwen:   { name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
  claude: { name: 'Claude（Anthropic）', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  openai: { name: '其他 OpenAI 兼容接口', baseUrl: '', model: '' }
};
function loadSettings() {
  const s = readJson(SETTINGS(), {});
  return { provider: PROVIDERS[s.provider] ? s.provider : 'qwen', model: s.model || '', baseUrl: s.baseUrl || '', keyEnc: s.keyEnc || '', keyPlain: s.keyPlain || '' };
}
function getKey(s) {
  try {
    if (s.keyEnc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(s.keyEnc, 'base64'));
  } catch (e) { /* 解密失败按未设置处理 */ }
  return s.keyPlain || '';
}
function publicSettings() {
  const s = loadSettings();
  const key = getKey(s);
  const p = PROVIDERS[s.provider];
  return {
    provider: s.provider,
    model: s.model || p.model,
    baseUrl: s.baseUrl || p.baseUrl,
    hasKey: !!key,
    keyTail: key ? key.slice(-4) : '',
    providers: PROVIDERS
  };
}
function saveSettings(input) {
  const s = loadSettings();
  const out = { provider: PROVIDERS[input.provider] ? input.provider : s.provider, model: String(input.model || '').trim(), baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''), keyEnc: s.keyEnc, keyPlain: s.keyPlain };
  if (typeof input.key === 'string' && input.key.trim()) {
    const key = input.key.trim();
    if (safeStorage.isEncryptionAvailable()) { out.keyEnc = safeStorage.encryptString(key).toString('base64'); out.keyPlain = ''; }
    else { out.keyEnc = ''; out.keyPlain = key; }
  }
  if (input.clearKey) { out.keyEnc = ''; out.keyPlain = ''; }
  writeJsonAtomic(SETTINGS(), out);
  return publicSettings();
}

/* ---------------- 调用 AI ---------------- */
function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function extractJson(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch (e) { /* 继续尝试 */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) { /* 继续 */ } }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* 继续 */ } }
  throw fail('parse', 'AI 返回的内容不是有效的 JSON');
}

async function callAI({ prompt, imageB64, text }) {
  const s = loadSettings();
  const key = getKey(s);
  if (!key) throw fail('no_key', '还没有填写 API Key');
  const p = PROVIDERS[s.provider];
  const model = s.model || p.model;
  const baseUrl = (s.baseUrl || p.baseUrl).replace(/\/+$/, '');
  if (!model) throw fail('config', '请填写模型名称');
  if (!baseUrl) throw fail('config', '请填写接口地址');
  const content = text != null ? prompt + text : prompt;

  let url, headers, body;
  if (s.provider === 'claude') {
    url = baseUrl + '/v1/messages';
    headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const parts = [];
    if (imageB64) parts.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } });
    parts.push({ type: 'text', text: content });
    body = { model, max_tokens: 2000, messages: [{ role: 'user', content: parts }] };
  } else {
    url = baseUrl + '/chat/completions';
    headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
    const msg = imageB64
      ? [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } }, { type: 'text', text: content }]
      : content;
    body = { model, temperature: 0, max_tokens: 2000, messages: [{ role: 'user', content: msg }] };
  }

  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    res = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw fail('network', ctl.signal.aborted ? 'AI 服务 2 分钟没有响应' : '连不上 AI 服务，请检查网络' + (s.provider === 'claude' ? '（在国内使用 Claude 通常需要代理）' : ''));
  } finally { clearTimeout(timer); }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = (data && (data.error && (data.error.message || data.error.code) || data.message)) || raw.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw fail('auth', 'API Key 无效或没有权限（' + detail + '）');
    if (res.status === 429) throw fail('rate', '调用太频繁或额度已用完（' + detail + '）');
    if (res.status === 404) throw fail('config', '接口地址或模型名称不对（' + detail + '）');
    if (res.status >= 500) throw fail('server', 'AI 服务暂时出错（' + res.status + '）');
    throw fail('http', '请求失败（' + res.status + '）：' + detail);
  }
  let out = '';
  if (s.provider === 'claude') out = (data && data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  else {
    const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    out = Array.isArray(c) ? c.map(x => x.text || '').join('') : (c || '');
  }
  if (!out) throw fail('empty', 'AI 没有返回内容');
  return out;
}

function wrap(fn) {
  return async (_e, arg) => {
    try { return { ok: true, data: await fn(arg) }; }
    catch (e) { return { ok: false, code: e.code || 'error', message: e.message || String(e) }; }
  };
}

/* ---------------- IPC ---------------- */
ipcMain.handle('data:load', wrap(async () => readJson(LEDGER(), null)));
ipcMain.handle('data:save', wrap(async (payload) => { writeJsonAtomic(LEDGER(), payload); return true; }));
ipcMain.handle('ai:get', wrap(async () => publicSettings()));
ipcMain.handle('ai:save', wrap(async (input) => saveSettings(input || {})));
ipcMain.handle('ai:test', wrap(async () => {
  const t = await callAI({ prompt: '这是连接测试。请只回复一个 JSON：{"ok":true}' });
  return extractJson(t);
}));
ipcMain.handle('ai:recognize', wrap(async ({ prompt, imageB64, text }) => {
  const t = await callAI({ prompt, imageB64, text });
  return extractJson(t);
}));
ipcMain.handle('file:saveCsv', wrap(async ({ name, data }) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出台账',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: 'CSV（Excel 可打开）', extensions: ['csv'] }]
  });
  if (r.canceled || !r.filePath) return { saved: false };
  fs.writeFileSync(r.filePath, data, 'utf8');
  shell.showItemInFolder(r.filePath);
  return { saved: true, path: r.filePath };
}));
/* ---------------- 自动更新 ---------------- */
// 安装版：后台下载新版本，下载好后提示重启更新。
// 免安装版：不能替换自己，只提示有新版本并给出下载链接。
const REPO = 'DDF-git-hub/invoice-audit';
const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
let updater = null;
let lastUpdate = null;
function sendUpdate(d) { lastUpdate = d; if (win && !win.isDestroyed()) win.webContents.send('update', d); }
function newer(a, b) {
  const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; }
  return false;
}
async function checkPortable() {
  try {
    const r = await net.fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { 'user-agent': 'invoice-audit', accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = await r.json();
    if (!newer(rel.tag_name, app.getVersion())) return;
    const asset = (rel.assets || []).find(a => /Portable/i.test(a.name));
    sendUpdate({ state: 'portable', version: String(rel.tag_name).replace(/^v/, ''), url: asset ? asset.browser_download_url : rel.html_url });
  } catch (e) { /* 网络不通时静默 */ }
}
function setupUpdates() {
  if (!app.isPackaged) return;
  if (isPortable) { checkPortable(); return; }
  try { updater = require('electron-updater').autoUpdater; } catch (e) { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', info => sendUpdate({ state: 'downloading', version: info.version, percent: 0 }));
  updater.on('download-progress', p => sendUpdate({ state: 'downloading', version: lastUpdate && lastUpdate.version, percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', info => sendUpdate({ state: 'ready', version: info.version }));
  updater.on('error', () => { if (lastUpdate && lastUpdate.state === 'downloading') sendUpdate({ state: 'failed', version: lastUpdate.version }); });
  updater.checkForUpdates().catch(() => {});
  setInterval(() => updater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}
ipcMain.handle('update:get', wrap(async () => ({ version: app.getVersion(), portable: isPortable, packaged: app.isPackaged, update: lastUpdate })));
ipcMain.handle('update:install', wrap(async () => { if (updater) setImmediate(() => updater.quitAndInstall(false, true)); return true; }));
ipcMain.handle('update:open', wrap(async (url) => { if (/^https:\/\/github\.com\//.test(url) || /^https:\/\/objects\.githubusercontent\.com\//.test(url)) await shell.openExternal(url); return true; }));
ipcMain.handle('update:check', wrap(async () => {
  if (!app.isPackaged) return { msg: '开发模式不检查更新' };
  if (isPortable) { await checkPortable(); return { msg: lastUpdate ? '' : '已经是最新版本' }; }
  if (!updater) return { msg: '自动更新不可用' };
  const r = await updater.checkForUpdates();
  return { msg: r && r.updateInfo && newer(r.updateInfo.version, app.getVersion()) ? '' : '已经是最新版本' };
}));
/* ---------------- 邮箱收票 ---------------- */
const mail = require('./mail.js');
const MAIL_SETTINGS = () => path.join(dataDir(), 'mail-settings.json');
const MAIL_SEEN = () => path.join(dataDir(), 'mail-seen.json');
function encrypt(v) { return safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(v).toString('base64') } : { plain: v }; }
function decrypt(o) {
  try { if (o && o.enc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(o.enc, 'base64')); } catch (e) { /* 解密失败按未设置 */ }
  return (o && o.plain) || '';
}
function mailCfg() {
  const s = readJson(MAIL_SETTINGS(), {});
  const preset = mail.PRESETS[s.preset] ? s.preset : 'qq';
  const p = mail.PRESETS[preset];
  return {
    preset, user: s.user || '',
    host: preset === 'custom' ? (s.host || '') : p.host,
    port: preset === 'custom' ? (Number(s.port) || 993) : p.port,
    secure: preset === 'custom' ? s.secure !== false : p.secure,
    pass: decrypt(s.pass)
  };
}
function mailPublic() {
  const c = mailCfg();
  const presets = {};
  Object.keys(mail.PRESETS).forEach((k) => { const p = mail.PRESETS[k]; presets[k] = { name: p.name, host: p.host, port: p.port, secure: p.secure }; });
  return { preset: c.preset, user: c.user, host: c.host, port: c.port, secure: c.secure, hasPass: !!c.pass, presets };
}
function mailSave(input) {
  const old = readJson(MAIL_SETTINGS(), {});
  const out = {
    preset: mail.PRESETS[input.preset] ? input.preset : (old.preset || 'qq'),
    user: String(input.user || '').trim(),
    host: String(input.host || '').trim(), port: Number(input.port) || 993, secure: input.secure !== false,
    pass: old.pass || null
  };
  if (typeof input.pass === 'string' && input.pass.trim()) out.pass = encrypt(input.pass.replace(/\s/g, ''));
  if (input.clearPass) out.pass = null;
  writeJsonAtomic(MAIL_SETTINGS(), out);
  return mailPublic();
}
let mailCache = null;
function mailProgress(text) { if (win && !win.isDestroyed()) win.webContents.send('mail-progress', text); }
ipcMain.handle('mail:get', wrap(async () => mailPublic()));
ipcMain.handle('mail:save', wrap(async (input) => mailSave(input || {})));
ipcMain.handle('mail:test', wrap(async () => mail.test(mailCfg())));
ipcMain.handle('mail:scan', wrap(async (opts) => {
  const seen = new Set(readJson(MAIL_SEEN(), []));
  const r = await mail.scan(mailCfg(), opts || {}, seen, net, mailProgress);
  mailCache = { id: String(Date.now()), messages: r.messages };
  return {
    scanId: mailCache.id, senders: r.senders, days: r.days,
    messages: r.messages.map((m) => ({ uid: m.uid, from: m.from, fromName: m.fromName, subject: m.subject, date: m.date, links: m.links,
      files: m.files.map((f) => ({ id: f.id, name: f.name, size: f.size, seen: f.seen })) }))
  };
}));
ipcMain.handle('mail:import', wrap(async ({ scanId, ids }) => {
  if (!mailCache || mailCache.id !== scanId) throw fail('mail_stale', '邮件列表已过期，请重新检查邮件');
  const want = new Set(ids || []);
  const seen = new Set(readJson(MAIL_SEEN(), []));
  const out = [];
  mailCache.messages.forEach((m) => m.files.forEach((f) => {
    if (!want.has(f.id)) return;
    out.push({ name: f.name, data: f.data, from: m.from, fromName: m.fromName, subject: m.subject, date: m.date });
    seen.add(f.key); f.seen = true;
  }));
  writeJsonAtomic(MAIL_SEEN(), Array.from(seen).slice(-20000));
  return out;
}));
ipcMain.handle('mail:openLink', wrap(async (url) => { if (/^https?:\/\//i.test(String(url))) await shell.openExternal(String(url)); return true; }));

ipcMain.handle('app:openDataDir', wrap(async () => { await shell.openPath(dataDir()); return true; }));
ipcMain.handle('app:info', wrap(async () => ({ dataDir: dataDir(), version: app.getVersion() })));

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 960, minHeight: 640,
    title: '发票审核台',
    backgroundColor: '#F3F5F8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://bundle/')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); }
  });
  win.loadURL('app://bundle/index.html');
  win.webContents.once('did-finish-load', () => setTimeout(setupUpdates, 3000));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  protocol.handle('app', serveApp);
  // 每次启动前备份一份台账，防止意外损坏
  try { if (fs.existsSync(LEDGER())) fs.copyFileSync(LEDGER(), LEDGER() + '.bak'); } catch (e) { /* 忽略 */ }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '打开数据文件夹', click: () => shell.openPath(dataDir()) }, { type: 'separator' }, { label: '退出', role: 'quit' }] },
    { label: '视图', submenu: [{ label: '刷新', role: 'reload' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }, { label: '实际大小', role: 'resetZoom' }, { type: 'separator' }, { label: '开发者工具', role: 'toggleDevTools' }] },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] }
  ]));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
