(function(){
'use strict';
var $ = function(s, el){ return (el||document).querySelector(s); };
var $$ = function(s, el){ return Array.prototype.slice.call((el||document).querySelectorAll(s)); };
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

var CATS = ['餐饮','住宿','交通','办公用品','其他'];
var RULES = [
  {id:'dup',       name:'重复报销',       how:'发票号码在台账里已经出现过', lv:'block'},
  {id:'buyerName', name:'购买方抬头不符', how:'名称不在公司抬头列表里', lv:'block'},
  {id:'buyerTax',  name:'购买方税号不符', how:'税号与对应公司不一致', lv:'block'},
  {id:'sum',       name:'金额不平',       how:'金额 + 税额 与价税合计相差超过 0.01 元', lv:'block'},
  {id:'future',    name:'开票日期在未来', how:'开票日期晚于今天', lv:'block'},
  {id:'nearDup',   name:'疑似重复',       how:'同一销售方、同一天、同一金额，号码不同', lv:'review'},
  {id:'overLimit', name:'超出报销标准',   how:'按左边各类别的单张上限判断，处理方式在左边设置', lv:null},
  {id:'stale',     name:'超过报销期限',   how:'开票日期距今超过设定天数', lv:'review'},
  {id:'taxRate',   name:'税率或税额异常', how:'税率不在允许范围，或税额与金额×税率对不上', lv:'review'},
  {id:'bigAmt',    name:'大额发票',       how:'单张超过设定金额', lv:'review'},
  {id:'sellerTax', name:'销售方税号格式异常', how:'不是 15、18 或 20 位的有效格式', lv:'review'},
  {id:'lineSum',   name:'明细合计不一致', how:'各行明细的金额或税额相加，与票面合计对不上', lv:'review'},
  {id:'unclear',   name:'识别不清',       how:'识别置信度低于 80%，或关键字段缺失', lv:'review'}
];
var FIELDS = [
  {k:'type', label:'发票类型'}, {k:'cat', label:'费用类别', sel:true},
  {k:'no', label:'发票号码', mono:true}, {k:'code', label:'发票代码（数电票没有）', mono:true},
  {k:'date', label:'开票日期', mono:true, ph:'YYYY-MM-DD'}, {k:'rate', label:'税率（%）', mono:true, num:true},
  {k:'buyer', label:'购买方名称', wide:true}, {k:'buyerTax', label:'购买方税号', mono:true, wide:true},
  {k:'seller', label:'销售方名称', wide:true}, {k:'sellerTax', label:'销售方税号', mono:true, wide:true},
  {k:'amount', label:'金额（不含税）', mono:true, num:true}, {k:'tax', label:'税额', mono:true, num:true},
  {k:'total', label:'价税合计', mono:true, num:true}, {k:'items', label:'项目名称'}
];
var TAX_RE = /^([0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}|[0-9A-Z]{15}|[0-9A-Z]{20})$/;

function defaultCfg(){
  var rules = {};
  RULES.forEach(function(r){ rules[r.id] = {on:true, lv:r.lv}; });
  return {
    companies:[{name:'上海示例科技有限公司', taxId:'91310115MA1K4A2B3A'},{name:'示例科技（杭州）有限公司', taxId:'91330106MA2H7C4D5E'}],
    limits:{'餐饮':{v:500,lv:'review'},'住宿':{v:600,lv:'review'},'交通':{v:300,lv:'review'},'办公用品':{v:2000,lv:'review'},'其他':{v:null,lv:'review'}},
    days:90, big:10000, rates:[0,1,3,5,6,9,13], rules:rules
  };
}

/* ---------- 存储（本机数据文件，由主进程读写） ---------- */
var cfg = defaultCfg(), invoices = [], storageOk = true, saveTimer = null, dataDir = '';
function applyLoaded(p){
  if (!p) return false;
  if (p.cfg){ var d = defaultCfg(); cfg = Object.assign(d, p.cfg);
    RULES.forEach(function(r){ if(!cfg.rules[r.id]) cfg.rules[r.id] = {on:true, lv:r.lv}; });
    CATS.forEach(function(k){ if(!cfg.limits[k]) cfg.limits[k] = d.limits[k]; });
  }
  invoices = Array.isArray(p.invoices) ? p.invoices : [];
  invoices.forEach(function(i){
    if (i.status === 'recognizing'){ i.status = 'error'; i.err = '上次识别被中断，可重新上传或手动补录'; }
    if (i.status === 'error' && !i.errCode && /^还没设置 AI/.test(i.err || '')) i.errCode = 'no_ai';
  });
  return true;
}
function save(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    var payload = {v:1, savedAt:new Date().toISOString(), cfg:cfg, invoices:invoices.map(function(i){ var o = Object.assign({}, i); if (o.status === 'recognizing'){ o.status = 'error'; o.err = '识别被中断，可重新上传或手动补录'; } return o; })};
    window.api.saveData(payload).then(function(r){
      storageOk = !!(r && r.ok);
      if (!storageOk) toast('保存失败：' + (r && r.message || '无法写入数据文件'));
      var h = $('#saveHint'); if (h) h.textContent = storageOk ? '已保存到本机' : '保存失败';
    });
  }, 250);
}

/* ---------- 工具 ---------- */
function uid(){ return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function num(v){ if (v === null || v === undefined || v === '') return null; var n = Number(String(v).replace(/[¥￥,，\s元]/g,'')); return isFinite(n) ? n : null; }
function r2(n){ return Math.round(n*100)/100; }
function fmt(n){ return n == null ? '—' : '¥' + Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2, maximumFractionDigits:2}); }
function fmtN(n){ return n == null ? '—' : Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2, maximumFractionDigits:2}); }
function normName(s){ return String(s||'').replace(/\s/g,'').replace(/（/g,'(').replace(/）/g,')'); }
function normTax(s){ return String(s||'').replace(/\s/g,'').toUpperCase(); }
function normNo(s){ return String(s||'').replace(/\D/g,''); }
function parseRate(v){
  if (v === null || v === undefined || v === '') return null;
  var s = String(v).trim();
  if (/免税|0%|^0$/.test(s)) return 0;
  if (/不征税/.test(s)) return null;
  var n = Number(s.replace(/[%％\s]/g,''));
  if (!isFinite(n)) return null;
  if (/[%％]/.test(s)) return r2(n);
  return n > 0 && n < 1 ? r2(n*100) : r2(n);
}
function normDate(v){
  var m = String(v||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) { m = String(v||'').match(/^(\d{4})(\d{2})(\d{2})$/); }
  if (!m) return '';
  return m[1] + '-' + ('0'+m[2]).slice(-2) + '-' + ('0'+m[3]).slice(-2);
}
function todayMid(){ var d = new Date(); d.setHours(0,0,0,0); return d; }
function isoOffset(days){ var d = todayMid(); d.setDate(d.getDate()+days); return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
function daysSince(iso){ var p = iso.split('-').map(Number); var d = new Date(p[0], p[1]-1, p[2]); if (isNaN(d)) return null; return Math.round((todayMid() - d)/864e5); }
function rmbUpper(n){
  if (n == null || !isFinite(n)) return '—';
  var fen = Math.round(Math.abs(n)*100), D = '零壹贰叁肆伍陆柒捌玖';
  var U = ['','拾','佰','仟','万','拾','佰','仟','亿','拾','佰','仟'];
  var is = String(Math.floor(fen/100)), s = '';
  for (var i = 0; i < is.length; i++){ s += D[+is[i]] + U[is.length-1-i]; }
  s = s.replace(/零[拾佰仟]/g,'零').replace(/零+/g,'零').replace(/零(亿|万)/g,'$1').replace(/亿万/,'亿').replace(/零$/,'');
  if (!s) s = '零';
  s += '圆';
  var j = Math.floor(fen%100/10), f = fen%10;
  if (!j && !f) s += '整'; else { s += j ? D[j]+'角' : '零'; if (f) s += D[f]+'分'; }
  return (n < 0 ? '负' : '') + s;
}
function dateCN(iso){ var p = String(iso||'').split('-'); return p.length === 3 ? p[0]+'年'+p[1]+'月'+p[2]+'日' : '—'; }
var toastTimer;
function toast(msg){ var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.hidden = true; }, 3200); }

/* ---------- 审核规则引擎 ---------- */
function audit(inv, all){
  var f = inv.f, R = cfg.rules, checks = [];
  function add(id, bad, title, detail, fields, lvOverride){
    if (!R[id] || !R[id].on) return;
    var lv = lvOverride || R[id].lv || 'review';
    checks.push({id:id, k: bad ? (lv === 'block' ? 'fail' : 'warn') : 'ok', title:title, detail:detail || '', fields: bad ? (fields||[]) : []});
  }
  var a = num(f.amount), t = num(f.tax), T = num(f.total), rate = f.rate === '' ? null : (f.rate == null ? null : Number(f.rate));

  var need = [['no','发票号码'],['date','开票日期'],['total','价税合计'],['seller','销售方名称'],['buyer','购买方名称']];
  var miss = need.filter(function(p){ return f[p[0]] === '' || f[p[0]] == null; });
  if (miss.length) add('unclear', true, '关键字段缺失', '缺少：' + miss.map(function(p){ return p[1]; }).join('、') + '，请对照原件补录', miss.map(function(p){ return p[0]; }));
  else add('unclear', false, '票面信息完整', '发票号码、日期、金额、购销双方齐全');
  var isOcr = inv.method === 'ocr';
  if (inv.conf != null && inv.conf < 0.8) add('unclear', true, '识别置信度低', (METHOD[inv.method] || '识别') + '置信度 ' + Math.round(inv.conf*100) + '%，建议对照原件核对' + (inv.aiNotes ? '。' + inv.aiNotes : ''), []);
  // 文字识别（OCR）可能认错一两个字：这类差异转人工复核，不直接拦截
  var ocrHint = '，也可能是文字识别误差，请对照原件';

  if (f.buyer){
    var comp = cfg.companies.filter(function(c){ return normName(c.name) === normName(f.buyer); })[0];
    var nearCo = isOcr && !comp ? cfg.companies.filter(function(c){ return X.editDistance(normName(c.name), normName(f.buyer)) <= 2; })[0] : null;
    if (!comp && nearCo){ comp = nearCo; add('buyerName', true, '购买方名称与抬头差一两个字', '识别为「' + f.buyer + '」，公司抬头是「' + nearCo.name + '」' + ocrHint, ['buyer'], 'review'); }
    else if (!comp) add('buyerName', true, '购买方抬头不符', '「' + f.buyer + '」不在公司抬头列表里' + (isOcr ? ocrHint : ''), ['buyer'], isOcr ? 'review' : null);
    if (comp) {
      if (!nearCo) add('buyerName', false, '购买方抬头一致', comp.name);
      if (!f.buyerTax) add('buyerTax', true, '未识别到购买方税号', '公司报销的发票需要有购买方税号', ['buyerTax'], 'review');
      else if (normTax(f.buyerTax) !== normTax(comp.taxId)){
        var close = isOcr && X.editDistance(normTax(f.buyerTax), normTax(comp.taxId)) <= 2;
        add('buyerTax', true, '购买方税号与公司不一致', '票面 ' + f.buyerTax + '，' + comp.name + ' 应为 ' + comp.taxId + (close ? ocrHint : ''), ['buyerTax'], close ? 'review' : null);
      }
      else add('buyerTax', false, '购买方税号一致', comp.taxId);
    }
  }

  if (a != null && t != null && T != null){
    var diff = r2(a + t - T);
    if (Math.abs(diff) > 0.01) add('sum', true, '金额不平', fmtN(a) + ' + ' + fmtN(t) + ' = ' + fmtN(r2(a+t)) + '，票面价税合计 ' + fmtN(T) + '，差 ' + fmtN(Math.abs(diff)) + (isOcr ? ocrHint : ''), ['amount','tax','total'], isOcr ? 'review' : null);
    else add('sum', false, '金额平衡', fmtN(a) + ' + ' + fmtN(t) + ' = ' + fmtN(T));
  }

  var L = (f.lines || []).filter(function(l){ return l && num(l.amount) != null; });
  if (L.length && a != null){
    var la = r2(L.reduce(function(x, l){ return x + num(l.amount); }, 0));
    var lt = L.every(function(l){ return num(l.tax) != null; }) ? r2(L.reduce(function(x, l){ return x + num(l.tax); }, 0)) : null;
    var badA = Math.abs(la - a) > 0.05, badT = lt != null && t != null && Math.abs(lt - t) > 0.05;
    if (badA || badT) add('lineSum', true, '明细合计不一致', L.length + ' 行明细' + (badA ? '金额合计 ' + fmtN(la) + '，票面金额 ' + fmtN(a) : '') + (badA && badT ? '；' : '') + (badT ? '税额合计 ' + fmtN(lt) + '，票面税额 ' + fmtN(t) : '') + (isOcr ? ocrHint : ''), ['amount']);
    else add('lineSum', false, '明细合计一致', L.length + ' 行明细，金额合计 ' + fmtN(la) + (lt != null ? '，税额合计 ' + fmtN(lt) : ''));
  }

  if (rate != null && isFinite(rate)){
    if (cfg.rates.indexOf(rate) < 0) add('taxRate', true, '税率不在允许范围', '票面税率 ' + rate + '%，允许 ' + cfg.rates.map(function(x){ return x + '%'; }).join('、'), ['rate']);
    else if (a != null && t != null){
      var exp = a * rate / 100;
      if (Math.abs(exp - t) > Math.max(0.06, exp*0.01)) add('taxRate', true, '税额计算不一致', '金额 × ' + rate + '% = ' + fmtN(r2(exp)) + '，票面税额 ' + fmtN(t), ['tax','rate']);
      else add('taxRate', false, '税率与税额正确', rate + '% 在允许范围，税额计算一致');
    }
  }

  if (f.date){
    var ds = daysSince(f.date);
    if (ds == null) add('unclear', true, '开票日期无法识别', f.date, ['date']);
    else if (ds < 0) add('future', true, '开票日期在未来', f.date + '，比今天晚 ' + (-ds) + ' 天', ['date']);
    else if (ds > cfg.days) add('stale', true, '超过报销期限', '开票已 ' + ds + ' 天，期限 ' + cfg.days + ' 天', ['date']);
    else add('stale', false, '在报销期限内', '开票 ' + ds + ' 天，期限 ' + cfg.days + ' 天');
  }

  var no = normNo(f.no);
  if (no){
    var prev = all.filter(function(o){ return o.id !== inv.id && o.status === 'ready' && normNo(o.f.no) === no && o.createdAt < inv.createdAt; })[0];
    if (prev) add('dup', true, '重复报销', '与 ' + new Date(prev.createdAt).toLocaleDateString('zh-CN') + ' 录入的' + (prev.file ? '「' + prev.file + '」' : '发票') + '号码相同', ['no']);
    else add('dup', false, '无重复', '发票号码在台账中唯一');
  }

  if (f.seller && f.date && T != null){
    var near = all.filter(function(o){ return o.id !== inv.id && o.status === 'ready' && normName(o.f.seller) === normName(f.seller) && o.f.date === f.date && num(o.f.total) === T && normNo(o.f.no) !== no; })[0];
    if (near) add('nearDup', true, '疑似重复', '与 ' + (near.f.no || '另一张发票') + ' 同销售方、同日、同金额，可能一笔消费开了两张', ['seller','date','total']);
  }

  var lim = cfg.limits[f.cat];
  if (lim && lim.v != null && T != null){
    if (T > lim.v) add('overLimit', true, '超出' + f.cat + '单张上限', fmt(T) + '，上限 ' + fmt(lim.v), ['total','cat'], lim.lv);
    else add('overLimit', false, '在报销标准内', f.cat + '单张上限 ' + fmt(lim.v));
  }

  if (T != null && cfg.big != null && T > cfg.big) add('bigAmt', true, '大额发票', '单张 ' + fmt(T) + '，超过 ' + fmt(cfg.big), ['total']);
  if (f.sellerTax && !TAX_RE.test(normTax(f.sellerTax))) add('sellerTax', true, '销售方税号格式异常', f.sellerTax, ['sellerTax']);

  if (inv.qr && inv.qr.mismatch && inv.qr.mismatch.length) add('unclear', true, '与二维码不一致', inv.qr.mismatch.join('、') + '的识别结果和发票二维码不同，已按二维码修正，请核对', []);
  checks.push({id:'verify', k:'skip', title:'真伪查验', detail:'演示版未接入查验接口', fields:[]});
  var order = {fail:0, warn:1, ok:2, skip:3};
  checks.sort(function(x,y){ return order[x.k] - order[y.k]; });
  var level = checks.some(function(c){ return c.k === 'fail'; }) ? 'block' : checks.some(function(c){ return c.k === 'warn'; }) ? 'review' : 'pass';
  return {level:level, checks:checks};
}
function auditAll(){
  var m = {};
  invoices.forEach(function(i){ if (i.status === 'ready') m[i.id] = audit(i, invoices); });
  return m;
}
var LV = {block:{t:'拦截', i:'✕'}, review:{t:'复核', i:'▲'}, pass:{t:'通过', i:'●'}};
var DEC = {approved:'已人工通过', rejected:'已驳回', returned:'已退回补充说明'};
function chip(inv, au){
  if (inv.status === 'recognizing') return '<span class="chip idle"><span class="spin"></span>' + (inv.stage === '排队中' ? '排队中' : '识别中') + '</span>';
  if (inv.status === 'error') return inv.errCode === 'no_ai' ? '<span class="chip review">待补录</span>' : '<span class="chip block">识别失败</span>';
  var l = LV[au.level]; return '<span class="chip ' + au.level + '">' + l.i + ' ' + l.t + '</span>';
}
function sortedList(audits){
  var rank = {block:0, review:1, pass:2};
  return invoices.slice().sort(function(a,b){
    function r(i){ if (i.status === 'recognizing') return -2; if (i.status === 'error') return -1; return rank[audits[i.id].level] + (i.decision ? 3 : 0); }
    return r(a) - r(b) || b.createdAt - a.createdAt;
  });
}
function reviewQueue(audits){
  return sortedList(audits).filter(function(i){ return i.status === 'error' || (i.status === 'ready' && audits[i.id].level !== 'pass' && !i.decision); });
}

/* ---------- 示例数据 ---------- */
function makeSamples(){
  var base = Date.now() - 60000, buyer = '上海示例科技有限公司', bt = '91310115MA1K4A2B3A';
  var S = [
    ['数电票（普通发票）','住宿','26312000000184620371',-14,buyer,bt,'上海锦江之星酒店管理有限公司','91310000132205678K',528.30,31.70,560.00,6,'*住宿服务*住宿费',0.97,'锦江之星_1013.pdf'],
    ['数电票（普通发票）','住宿','26312000000184620371',-14,buyer,bt,'上海锦江之星酒店管理有限公司','91310000132205678K',528.30,31.70,560.00,6,'*住宿服务*住宿费',0.96,'IMG_4790.jpg'],
    ['数电票（普通发票）','其他','26442000000091273518',-7,buyer,'91310115MA1K4A2B3D','深圳顺丰速运有限公司','91440300279467123Q',345.63,10.37,356.00,3,'*物流辅助服务*收派服务费',0.95,'顺丰_1020.pdf'],
    ['数电票（专用发票）','办公用品','26112000000310087642',-19,buyer,bt,'北京京东世纪贸易有限公司','91110302MA01B2C3D4',1415.93,184.07,1590.00,13,'*计算机外部设备*显示器',0.93,'京东_显示器.pdf'],
    ['数电票（普通发票）','餐饮','26312000000207718804',-5,buyer,bt,'上海小南国餐饮有限公司','91310101607412385X',1754.72,105.28,1860.00,6,'*餐饮服务*餐费',0.96,'小南国_1022.pdf'],
    ['数电票（普通发票）','餐饮','26312000000207718911',-5,buyer,bt,'上海小南国餐饮有限公司','91310101607412385X',1754.72,105.28,1860.00,6,'*餐饮服务*餐费',0.94,'小南国_1022_2.pdf'],
    ['增值税电子普通发票','住宿','',-150,buyer,bt,'杭州西湖国宾馆','91330100143059876R',528.30,31.70,560.00,6,'*住宿服务*住宿费',0.62,'IMG_3302.jpg'],
    ['数电票（普通发票）','交通','26312000000198854026',-9,buyer,bt,'上海强生出租汽车有限公司','91310000132211459W',83.98,2.52,86.50,3,'*运输服务*客运服务费',0.98,'出租车_1018.jpg'],
    ['电子发票（铁路电子客票）','交通','26312000000199120375',-8,buyer,bt,'中国铁路上海局集团有限公司','91310000MA1FL8RT2N',260.55,23.45,284.00,9,'*运输服务*铁路旅客运输',0.97,'火车票_上海杭州.pdf'],
    ['数电票（普通发票）','办公用品','26312000000201436688',-3,buyer,bt,'上海晨光文具股份有限公司','91310000759312468J',341.59,44.41,386.00,13,'*文具*签字笔、笔记本',0.98,'晨光_1024.pdf']
  ];
  return S.map(function(s, i){
    return {id:uid() + i, createdAt: base + i*1000, source:'sample', file:s[14], status:'ready', conf:s[13], aiNotes: s[13] < 0.8 ? '发票号码区域被折痕遮挡' : '', decision:null, memo:'',
      f:{type:s[0], cat:s[1], no:s[2], code:'', date:isoOffset(s[3]), buyer:s[4], buyerTax:s[5], seller:s[6], sellerTax:s[7], amount:s[8], tax:s[9], total:s[10], rate:s[11], items:s[12]}};
  });
}
function emptyFields(){ return {type:'', cat:'其他', no:'', code:'', date:'', buyer:'', buyerTax:'', seller:'', sellerTax:'', amount:null, tax:null, total:null, rate:null, items:'', lines:[]}; }

/* ---------- 识别（内置优先，AI 可选） ---------- */
var X = window.InvoiceExtract;
var METHOD = {'pdf-text':'PDF 文字直接读取', xml:'数电票 XML', ofd:'OFD 文字读取', ocr:'内置文字识别（OCR）', ai:'AI 识别', manual:'手动录入', sample:'示例数据'};
var aiState = 'loading', aiInfo = null, aiTest = null;
var fileMap = {}; // 本次会话的原始文件，用于重新识别
var queue = [], busy = false;
var PROMPT = '你是中国发票信息抽取助手。附件是一张发票（可能是数电票、增值税专用/普通发票、铁路电子客票、出租车票、定额发票等）。\n' +
  '请只输出一个 JSON 对象，不要任何其他文字，字段如下：\n' +
  '{"invoice_type":"发票类型，如 数电票（普通发票）","invoice_code":"发票代码，没有则空字符串","invoice_number":"发票号码","issue_date":"YYYY-MM-DD","buyer_name":"购买方名称","buyer_tax_id":"购买方纳税人识别号/统一社会信用代码","seller_name":"销售方名称","seller_tax_id":"销售方纳税人识别号","amount":不含税金额合计(数字),"tax_amount":税额合计(数字),"total":价税合计(数字),"tax_rate":"主要税率，如 6%，免税写 免税","items":"主要项目名称，30字以内","category":"餐饮|住宿|交通|办公用品|其他 之一","confidence":0到1之间的数字，表示整体识别把握,"notes":"看不清、被遮挡或可疑之处，没有则空字符串"}\n' +
  '另外输出 "lines" 数组，发票上每一行明细一个对象：{"name":"项目名称","spec":"规格型号","unit":"单位","quantity":数量(数字或null),"price":单价(数字或null),"amount":金额(数字),"tax_rate":"税率如 6%","tax":税额(数字)}，按票面顺序，不要合并。\n' +
  '规则：看不清的字段填空字符串或 null，绝不猜测；金额只填数字；日期统一成 YYYY-MM-DD；不是发票的图片 confidence 填 0 并在 notes 说明。';
var PROMPT_XML = '你是中国发票信息抽取助手。下面是一张数电票的 XML 原文。' + PROMPT.split('\n').slice(1).join('\n') + '\n\nXML 原文：\n';

function initAI(){
  return window.api.getAI().then(function(r){
    aiInfo = r && r.ok ? r.data : null;
    aiState = aiInfo && aiInfo.hasKey ? 'on' : 'nokey';
  });
}
function callAI(req){
  return window.api.recognize(req).then(function(r){ if (r && r.ok) return r.data; throw {code:(r && r.code) || 'error', message:r && r.message}; });
}
function aiErr(e){
  var code = e && e.code;
  var M = {
    ofd:'读不出这个 OFD 文件，请上传同一张发票的 PDF 版', no_ai:'没有识别出发票内容，可以对照原件手动补录',
    decode:'读不出这个文件，请换成 JPG、PNG、PDF、XML 或 OFD', pdf:'PDF 打不开或已损坏，请重新下载后上传，或截图后上传图片',
    ocr:'内置文字识别没能启动，请重新识别；仍不行可以手动补录', xml:'读不出这个 XML 里的发票信息，请上传 PDF 版'
  };
  if (/^(auth|rate|network|server|http|config|parse|empty|no_key)$/.test(code) && e.message) return e.message + (code === 'parse' || code === 'empty' ? '，可以点「重新识别」' : '');
  return M[code] || (e && e.message) || '识别出错，可以点「重新识别」';
}

/* 图片和 PDF 处理 */
function loadImage(blob){
  return new Promise(function(res, rej){
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function(){ URL.revokeObjectURL(url); res(img); };
    img.onerror = function(){ URL.revokeObjectURL(url); rej({code:'decode'}); };
    img.src = url;
  });
}
function drawTo(src, w, h){
  var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  var x = c.getContext('2d', {willReadFrequently:true}); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function scaled(c, maxW, minW){
  var w = c.width, s = 1;
  if (maxW && w > maxW) s = maxW / w;
  if (minW && w < minW) s = minW / w;
  return s === 1 ? c : drawTo(c, c.width * s, c.height * s);
}
function canvasToBlob(c, q){ return new Promise(function(res, rej){ c.toBlob(function(b){ b ? res(b) : rej({code:'decode'}); }, 'image/jpeg', q || 0.85); }); }
function blobToDataURL(b){ return new Promise(function(res){ var r = new FileReader(); r.onload = function(){ res(r.result); }; r.onerror = function(){ res(null); }; r.readAsDataURL(b); }); }
function previewOf(c){ return canvasToBlob(scaled(c, 1100), 0.72).then(blobToDataURL); }
function loadPdf(){
  if (!window.pdfjsLib) return Promise.reject({code:'pdf'});
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  return Promise.resolve(window.pdfjsLib);
}
function openPdf(file){
  return loadPdf().then(function(lib){ return file.arrayBuffer().then(function(buf){ return lib.getDocument({data:buf, isEvalSupported:false, cMapUrl:'vendor/cmaps/', cMapPacked:true, standardFontDataUrl:'vendor/standard_fonts/'}).promise; }); })
    .then(function(doc){ return doc.getPage(1); })
    .catch(function(e){ throw (e && e.code) ? e : {code:'pdf'}; });
}
function pdfRows(page){
  var vp = page.getViewport({scale:1});
  return page.getTextContent().then(function(tc){ return X.rowsFromPdfItems(tc.items, vp.height); }).catch(function(){ return []; });
}
function pdfCanvas(page, targetW){
  var vp = page.getViewport({scale:1}), v = page.getViewport({scale:Math.min(4, targetW / vp.width)});
  var c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
  var x = c.getContext('2d', {willReadFrequently:true}); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  return page.render({canvasContext:x, viewport:v}).promise.then(function(){ return c; });
}
function inflateRaw(u8){
  var s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(s).arrayBuffer().then(function(b){ return new Uint8Array(b); });
}

/* 二维码 */
function decodeQr(c){
  if (!window.jsQR) return null;
  function tryRegion(sx, sy, sw, sh, outW){
    var s = outW / sw, t = document.createElement('canvas');
    t.width = Math.round(sw * s); t.height = Math.round(sh * s);
    var x = t.getContext('2d', {willReadFrequently:true}); x.fillStyle = '#fff'; x.fillRect(0, 0, t.width, t.height);
    x.drawImage(c, sx, sy, sw, sh, 0, 0, t.width, t.height);
    var d = x.getImageData(0, 0, t.width, t.height);
    var r = window.jsQR(d.data, t.width, t.height, {inversionAttempts:'dontInvert'});
    return r && r.data ? r.data : null;
  }
  var W = c.width, H = c.height, tries = [
    [0, 0, W * 0.35, H * 0.45, 900], [0, 0, W, H, Math.min(W, 1600)], [W * 0.6, 0, W * 0.4, H * 0.45, 900], [0, 0, W, H, Math.min(W, 2400)]
  ];
  for (var i = 0; i < tries.length; i++) {
    try { var s = tryRegion.apply(null, tries[i]); if (s && X.parseQr(s)) return s; } catch (e) { /* 继续 */ }
  }
  return null;
}

/* 内置文字识别（Tesseract，离线） */
var ocr = {worker:null, starting:null, onProgress:null, idle:null};
function ocrWorker(){
  clearTimeout(ocr.idle);
  if (ocr.worker) return Promise.resolve(ocr.worker);
  if (ocr.starting) return ocr.starting;
  if (!window.Tesseract) return Promise.reject({code:'ocr'});
  var base = new URL('vendor/tesseract/', location.href).href;
  ocr.starting = window.Tesseract.createWorker('chi_sim', 1, {
    workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang',
    gzip: true, cacheMethod: 'none', workerBlobURL: false,
    logger: function(m){ if (ocr.onProgress && m && m.status === 'recognizing text') ocr.onProgress(m.progress || 0); },
    errorHandler: function(){ /* 由 recognize 的 Promise 处理 */ }
  }).then(function(w){
    return w.setParameters({preserve_interword_spaces:'1', user_defined_dpi:'300'}).then(function(){ ocr.worker = w; ocr.starting = null; return w; });
  }).catch(function(e){ ocr.starting = null; throw {code:'ocr', message: '内置文字识别没能启动（' + ((e && e.message) || e) + '），请重新识别'}; });
  return ocr.starting;
}
function ocrRelease(){
  clearTimeout(ocr.idle);
  ocr.idle = setTimeout(function(){ if (ocr.worker && !busy){ ocr.worker.terminate(); ocr.worker = null; } }, 3 * 60 * 1000);
}
function grayscale(c){
  var x = c.getContext('2d', {willReadFrequently:true}), d = x.getImageData(0, 0, c.width, c.height), p = d.data, i, lo = 255, hi = 0;
  var hist = new Uint32Array(256);
  for (i = 0; i < p.length; i += 4){ var g = (p[i] * 0.299 + p[i+1] * 0.587 + p[i+2] * 0.114) | 0; p[i] = g; hist[g]++; }
  var n = p.length / 4, acc = 0;
  for (i = 0; i < 256; i++){ acc += hist[i]; if (acc > n * 0.01){ lo = i; break; } }
  acc = 0;
  for (i = 255; i >= 0; i--){ acc += hist[i]; if (acc > n * 0.01){ hi = i; break; } }
  var span = Math.max(40, hi - lo);
  for (i = 0; i < p.length; i += 4){ var v = Math.max(0, Math.min(255, ((p[i] - lo) * 255 / span) | 0)); p[i] = p[i+1] = p[i+2] = v; }
  x.putImageData(d, 0, 0);
  return c;
}
function ocrRows(c, onProgress){
  var img = grayscale(scaled(c, 2600, 2000));
  return ocrWorker().then(function(w){
    ocr.onProgress = onProgress;
    return w.recognize(img, {}, {text:true, tsv:true});
  }).then(function(r){
    ocr.onProgress = null; ocrRelease();
    var d = (r && r.data) || {};
    var rows = d.tsv ? X.rowsFromTsv(d.tsv) : [];
    if (!rows.length) rows = X.rowsFromText(d.text);
    return rows;
  }, function(e){ ocr.onProgress = null; throw (e && e.code) ? e : {code:'ocr', message: '内置文字识别出错（' + ((e && e.message) || e) + '）'}; });
}

/* 识别流程 */
var lastPaint = 0;
function stage(inv, text){
  inv.stage = text;
  var now = Date.now();
  if (now - lastPaint > 300){ lastPaint = now; render(); }
}
function fileKind(file){
  var n = file.name.toLowerCase(), t = file.type || '';
  if (/\.xml$/.test(n) || /xml/.test(t)) return 'xml';
  if (/\.ofd$/.test(n)) return 'ofd';
  if (/\.pdf$/.test(n) || t === 'application/pdf') return 'pdf';
  return 'image';
}
function finish(inv, res, method){
  X.score(res, method);
  var f = res.f;
  if (CATS.indexOf(f.cat) < 0) f.cat = '其他';
  inv.f = f; inv.method = method; inv.conf = res.conf;
  inv.aiNotes = (res.notes || []).join('；');
  inv.status = 'ready'; inv.err = ''; inv.errCode = ''; inv.stage = '';
}
function applyAI(inv, r){
  r = r || {};
  var cat = CATS.indexOf(r.category) >= 0 ? r.category : '其他';
  inv.f = {
    type: String(r.invoice_type || ''), cat: cat, no: String(r.invoice_number || '').replace(/\s/g,''), code: String(r.invoice_code || '').replace(/\s/g,''),
    date: normDate(r.issue_date), buyer: String(r.buyer_name || '').trim(), buyerTax: normTax(r.buyer_tax_id), seller: String(r.seller_name || '').trim(), sellerTax: normTax(r.seller_tax_id),
    amount: num(r.amount), tax: num(r.tax_amount), total: num(r.total), rate: parseRate(r.tax_rate), items: String(r.items || ''),
    lines: (Array.isArray(r.lines) ? r.lines : []).slice(0, 200).map(function(l){ l = l || {}; return {name:String(l.name || ''), spec:String(l.spec || ''), unit:String(l.unit || ''), qty:num(l.quantity), price:num(l.price), amount:num(l.amount), rate:parseRate(l.tax_rate), tax:num(l.tax)}; })
  };
  var c = Number(r.confidence); inv.conf = isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
  inv.aiNotes = String(r.notes || '');
  inv.method = 'ai'; inv.status = 'ready'; inv.err = ''; inv.errCode = ''; inv.stage = '';
}
function withQr(inv, qrText){
  var q = X.parseQr(qrText);
  if (!q) return;
  var res = {f:inv.f, notes:[]};
  X.applyQr(res, q);
  if (res.notes.length) inv.aiNotes = [inv.aiNotes].concat(res.notes).filter(Boolean).join('；');
  inv.qr = {no:q.no, date:q.date, amount:q.amount, mismatch:(res.qr && res.qr.mismatch) || []};
}
// 图片类：配置了 AI 就用 AI（更准），否则或 AI 出错时用内置 OCR
function fromImage(inv, c, qrText, opts){
  var useAI = aiState === 'on' && !(opts && opts.noAI);
  if (useAI){
    stage(inv, 'AI 识别中');
    return canvasToBlob(scaled(c, 1600), 0.88).then(blobToDataURL)
      .then(function(d){ return callAI({prompt:PROMPT, imageB64:String(d).split(',')[1]}); })
      .then(function(r){ applyAI(inv, r); withQr(inv, qrText); })
      .catch(function(e){
        var why = aiErr(e);
        return fromImage(inv, c, qrText, {noAI:true}).then(function(){
          inv.aiNotes = ['AI 识别失败（' + why + '），已改用内置识别'].concat(inv.aiNotes ? [inv.aiNotes] : []).join('；');
        });
      });
  }
  stage(inv, '文字识别 0%');
  return ocrRows(c, function(p){ stage(inv, '文字识别 ' + Math.round(p * 100) + '%'); }).then(function(rows){
    var res = X.parseText(rows, {ocr:true});
    var q = X.parseQr(qrText);
    if (q) X.applyQr(res, q);
    X.snapBuyer(res, cfg.companies);
    finish(inv, res, 'ocr');
    if (q) inv.qr = {no:q.no, date:q.date, amount:q.amount, mismatch:(res.qr && res.qr.mismatch) || []};
  });
}
function recognize(inv, file, opts){
  opts = opts || {};
  var kind = fileKind(file);
  inv.qr = null;
  stage(inv, '读取文件');
  if (kind === 'xml'){
    return file.text().then(function(txt){
      var res = X.parseXml(txt);
      if (res.f.no && res.f.total != null) return finish(inv, res, 'xml');
      if (aiState === 'on'){ stage(inv, 'AI 识别中'); return callAI({prompt:PROMPT_XML, text:txt.slice(0, 80000)}).then(function(r){ applyAI(inv, r); if (inv.conf == null) inv.conf = 0.99; }); }
      if (!res.f.no && res.f.total == null) throw {code:'xml'};
      finish(inv, res, 'xml');
    });
  }
  if (kind === 'ofd'){
    return file.arrayBuffer().then(function(buf){ return X.parseOfd(buf, inflateRaw); })
      .then(function(o){ finish(inv, o.res, o.method); })
      .catch(function(e){ throw (e && e.code) ? e : {code:'ofd'}; });
  }
  if (kind === 'pdf'){
    return openPdf(file).then(function(page){
      return Promise.all([pdfRows(page), pdfCanvas(page, 2000)]).then(function(r){
        var rows = r[0], c = r[1];
        return previewOf(c).then(function(d){ inv.img = d; }).then(function(){
          stage(inv, '读取二维码');
          var qrText = decodeQr(c);
          var res = X.parseText(rows);
          if (!opts.forceImage && X.looksReadable(res)){
            var q = X.parseQr(qrText);
            if (q) X.applyQr(res, q);
            finish(inv, res, 'pdf-text');
            if (q) inv.qr = {no:q.no, date:q.date, amount:q.amount, mismatch:(res.qr && res.qr.mismatch) || []};
            return;
          }
          return fromImage(inv, c, qrText, opts);  // 扫描版 PDF：按图片识别
        });
      });
    });
  }
  return loadImage(file).then(function(img){
    var c = drawTo(img, img.naturalWidth, img.naturalHeight);
    return previewOf(c).then(function(d){ inv.img = d; }).then(function(){
      stage(inv, '读取二维码');
      return fromImage(inv, c, decodeQr(c), opts);
    });
  });
}
function enqueue(files, metas){
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  list.forEach(function(file, i){
    var inv = {id:uid() + i, createdAt:Date.now() + i, source:'file', file:file.name, status:'recognizing', stage:'排队中', conf:null, aiNotes:'', decision:null, memo:'', f:emptyFields()};
    var meta = metas && metas[i];
    if (meta){ inv.source = 'mail'; inv.sender = meta.sender || ''; inv.senderName = meta.senderName || ''; inv.mail = meta.mail || null; }
    invoices.unshift(inv); fileMap[inv.id] = file; queue.push({inv:inv});
  });
  save();
  if (route().v !== 'ledger') location.hash = 'ledger';
  render(); pump();
}
function pump(){
  if (busy) return;
  var job = queue.shift();
  if (!job){ render(); return; }
  var inv = job.inv;
  busy = true; inv.status = 'recognizing'; render();
  recognize(inv, fileMap[inv.id], job.opts).catch(function(e){
    inv.status = 'error'; inv.err = aiErr(e); inv.errCode = (e && e.code) || ''; inv.stage = '';
    if (!inv.f.buyer && cfg.companies[0]){ inv.f.buyer = cfg.companies[0].name; inv.f.buyerTax = cfg.companies[0].taxId; }
  })
  .then(function(){ busy = false; save(); render(); pump(); });
}

/* ---------- 路由与渲染 ---------- */
var ui = {filter:'all', q:'', sender:'', confirmClear:false, confirmDel:false};
function route(){
  var h = (location.hash || '').replace(/^#/, '');
  if (h === 'rules') return {v:'rules'};
  if (h === 'ai') return {v:'ai'};
  if (h === 'mail') return {v:'mail'};
  if (h === 'review') return {v:'review'};
  var m = h.match(/^review-([A-Za-z0-9]+)$/);
  if (m) return {v:'review', id:m[1]};
  return {v:'ledger'};
}
function render(){
  var r = route();
  $$('.nav a').forEach(function(a){ a.classList.toggle('on', a.getAttribute('data-nav') === r.v); if (a.getAttribute('data-nav') === r.v) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  var el = $('#view');
  if (r.v === 'rules') el.innerHTML = viewRules();
  else if (r.v === 'ai') el.innerHTML = viewAI();
  else if (r.v === 'mail') el.innerHTML = viewMail();
  else if (r.v === 'review') el.innerHTML = viewReview(r.id);
  else el.innerHTML = viewLedger();
}

function viewLedger(){
  var A = auditAll(), ready = invoices.filter(function(i){ return i.status === 'ready'; });
  var cnt = {block:0, review:0, pass:0}, sum = 0;
  ready.forEach(function(i){ cnt[A[i.id].level]++; sum += num(i.f.total) || 0; });
  var manual = cnt.block + cnt.review, pct = ready.length ? Math.round(manual / ready.length * 100) : 0;
  var processing = invoices.filter(function(i){ return i.status === 'recognizing'; });
  var errors = invoices.filter(function(i){ return i.status === 'error'; }).length;

  var h = '<section class="tiles" aria-label="本批概况">' +
    '<div class="tile"><span class="k">台账发票</span><span class="v">' + ready.length + '<small> 张</small></span><span class="d">价税合计 ' + fmt(r2(sum)) + (errors ? ' · ' + errors + ' 张待补录' : '') + '</span></div>' +
    '<div class="tile k-pass"><span class="k">● 自动通过</span><span class="v">' + cnt.pass + '</span><span class="d">规则全部通过，无需人工</span></div>' +
    '<div class="tile k-review"><span class="k">▲ 待复核</span><span class="v">' + cnt.review + '</span><span class="d">超标、疑似重复、识别不清</span></div>' +
    '<div class="tile k-block"><span class="k">✕ 已拦截</span><span class="v">' + cnt.block + '</span><span class="d">重复报销、抬头错误、金额不平</span></div>' +
    '<div class="tile inv"><span class="k">需要人工看的比例</span><span class="v">' + pct + '%</span><span class="d">' + (ready.length ? '原来 ' + ready.length + ' 张都要看，现在 ' + manual + ' 张' : '上传发票后自动计算') + '</span></div>' +
  '</section>';

  var aiNote = aiState === 'on' ? '<span class="muted" style="font-size:12px">已开启 AI：照片和扫描件用 AI 识别，PDF、XML 直接读取。</span>'
    : '<span class="muted" style="font-size:12px">不需要联网和 API Key。照片识别想更准，可以在 <a href="#ai">AI 设置</a> 里开启 AI。</span>';

  h += '<div class="cols"><div class="col-main">' +
    '<section class="drop" id="drop" aria-label="上传发票">' +
      '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);flex:none"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/></svg>' +
      '<div class="drop-text"><strong>把发票拖到这里，或点击选择文件</strong><span class="muted" style="font-size:13px">支持 PDF、OFD、数电票 XML、JPG、PNG，可一次选多张。自动识别字段并按规则审核。</span>' + aiNote + '</div>' +
      '<div class="drop-actions"><button class="btn lg primary" type="button" data-act="pick">上传发票</button><button class="btn lg" type="button" data-act="manual">手动录入</button></div>' +
    '</section>';

  if (processing.length || queue.length){
    var total = processing.length + queue.length;
    var cur = processing.filter(function(i){ return i.stage && i.stage !== '排队中'; })[0];
    h += '<div class="progress" role="status"><span class="spin"></span><span class="names">正在识别 ' + total + ' 张' + (cur ? '：' + esc(cur.file) + ' · ' + esc(cur.stage) : '') + '</span><span>PDF 一两秒，图片约 10–30 秒</span></div>';
  }

  var list = sortedList(A).filter(function(i){
    if (ui.filter !== 'all'){ if (i.status !== 'ready' || A[i.id].level !== ui.filter) return false; }
    if (ui.sender && (ui.sender === '__none' ? !!i.sender : (i.sender || '') !== ui.sender)) return false;
    if (ui.q){ var q = ui.q.toLowerCase(); return [i.f.no, i.f.seller, i.f.buyer, i.file, i.f.items, i.sender, i.senderName].join(' ').toLowerCase().indexOf(q) >= 0; }
    return true;
  });

  h += '<section class="card" aria-label="发票台账"><div class="filters">' +
    pill('all','全部', invoices.length) + pill('block','拦截', cnt.block) + pill('review','复核', cnt.review) + pill('pass','通过', cnt.pass) +
    (function(){
      var ss = {}; invoices.forEach(function(i){ if (i.sender) ss[i.sender] = senderLabel(i); });
      var keys = Object.keys(ss);
      if (!keys.length) return '';
      return '<label class="sr" for="sender-filter">提交人</label><select id="sender-filter" class="inp" style="width:auto;height:34px;border-radius:17px"><option value="">全部提交人</option>' +
        keys.sort().map(function(k){ return '<option value="' + esc(k) + '"' + (ui.sender === k ? ' selected' : '') + '>' + esc(ss[k] + '（' + k + '）') + '</option>'; }).join('') + '<option value="__none"' + (ui.sender === '__none' ? ' selected' : '') + '>手动上传的</option></select>';
    })() +
    '<label class="search" for="q"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q" placeholder="搜索发票号、销售方、文件名" value="' + esc(ui.q) + '"></label></div>';

  if (!invoices.length){
    h += '<div class="empty"><strong style="color:var(--ink)">台账是空的</strong><span>上传几张发票试试，或者先加载示例数据看看审核效果。</span><button class="btn" type="button" data-act="samples">加载示例发票</button></div>';
  } else if (!list.length){
    h += '<div class="empty">没有符合条件的发票</div>';
  } else {
    h += '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>风险</th><th>发票号码</th><th>开票日期</th><th>提交人</th><th>销售方</th><th>类别</th><th class="num">价税合计</th><th>审核发现</th></tr></thead><tbody>';
    list.forEach(function(i){
      var au = A[i.id], issue;
      if (i.status === 'recognizing') issue = '<span class="muted">' + esc(i.file) + (i.stage ? ' · ' + esc(i.stage) : '') + '</span>';
      else if (i.status === 'error') issue = (i.errCode === 'no_ai' ? '未设置 AI 识别，点开对照原件补录，或设置 AI 后重新识别' : esc(i.err)) + ' <span class="muted">· ' + esc(i.file) + '</span>';
      else { var bad = au.checks.filter(function(c){ return c.k === 'fail' || c.k === 'warn'; }); issue = bad.length ? esc(bad.map(function(c){ return c.title; }).join('；')) : '<span class="muted">—</span>'; }
      h += '<tr data-open="' + i.id + '" tabindex="0" aria-label="查看 ' + esc(i.f.seller || i.file) + '">' +
        '<td>' + chip(i, au) + (i.decision ? '<span class="decision">' + DEC[i.decision] + '</span>' : '') + '</td>' +
        '<td class="mono nowrap" style="font-size:12px">' + esc(i.f.no || '—') + (i.source === 'sample' ? ' <span class="chip sample">示例</span>' : '') + '</td>' +
        '<td class="mono nowrap" style="font-size:12px">' + esc(i.f.date || '—') + '</td>' +
        '<td class="nowrap"' + (i.sender ? ' title="' + esc(i.sender) + '"' : '') + '>' + (i.sender ? esc(senderLabel(i)) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + esc(i.f.seller || '—') + '</td>' +
        '<td class="muted nowrap">' + esc(i.status === 'ready' ? i.f.cat : '—') + '</td>' +
        '<td class="num mono">' + fmt(num(i.f.total)) + '</td>' +
        '<td class="issue">' + issue + '</td></tr>';
    });
    h += '</tbody></table></div><div class="tbl-foot"><span>共 ' + list.length + ' 条 · 拦截和复核排在前面，点一行进入复核</span><span>识别结果可在复核页修改</span></div>';
  }
  h += '</section></div>';

  // 侧栏
  var tally = {};
  ready.forEach(function(i){ A[i.id].checks.forEach(function(c){ if (c.k === 'fail' || c.k === 'warn'){ var key = RULES.filter(function(r){ return r.id === c.id; })[0]; var n = key ? key.name : c.title; tally[n] = (tally[n]||0) + 1; } }); });
  var tl = Object.keys(tally).map(function(k){ return [k, tally[k]]; }).sort(function(a,b){ return b[1]-a[1]; }).slice(0,7);
  var mx = tl.length ? tl[0][1] : 1;
  h += '<aside class="col-side"><section class="card pad stack"><h2 class="h">问题分布</h2>' +
    (tl.length ? '<div class="bars">' + tl.map(function(p){ return '<div class="bar-row"><div class="lbl"><span>' + esc(p[0]) + '</span><span class="mono muted">' + p[1] + '</span></div><div class="bar"><i style="width:' + Math.round(p[1]/mx*100) + '%"></i></div></div>'; }).join('') + '</div>' : '<span class="sub">还没有发现问题</span>') +
  '</section>';
  var lim = cfg.limits;
  h += '<section class="card pad stack"><h2 class="h">当前生效规则</h2>' +
    '<div class="kv"><span>公司抬头</span><span class="muted">' + cfg.companies.length + ' 个主体</span></div>' +
    ['餐饮','住宿','交通'].map(function(k){ return '<div class="kv"><span>' + k + '单张上限</span><span class="mono">' + (lim[k].v == null ? '不限' : fmt(lim[k].v)) + '</span></div>'; }).join('') +
    '<div class="kv"><span>开票后报销期限</span><span class="mono">' + cfg.days + ' 天</span></div>' +
    '<a href="#rules" style="font-size:13px;text-decoration:none;font-weight:500">修改规则 →</a></section>';
  h += '<section class="card pad stack"><h2 class="h">台账数据</h2><div class="actions">' +
    '<button class="btn sm" type="button" data-act="samples">加载示例发票</button>' +
    (invoices.length ? (ui.confirmClear ? '<button class="btn sm danger" type="button" data-act="clear-yes">确认清空 ' + invoices.length + ' 张</button><button class="linkbtn muted" type="button" data-act="clear-no">取消</button>' : '<button class="btn sm" type="button" data-act="clear">清空台账</button>') : '') +
    '<button class="btn sm" type="button" data-act="open-dir">打开数据文件夹</button><button class="btn sm" type="button" data-act="upd-check">检查更新</button></div>' + (appVer ? '<p class="note">当前版本 v' + esc(appVer) + (isPortable ? '（免安装版）' : '') + '</p>' : '') + '<p class="note">台账只保存在这台电脑：' + esc(dataDir) + '。换电脑或备份时，复制这个文件夹里的 ledger.json 即可。</p></section>';
  h += '<p class="note">真伪查验需要接入税务数字账户或有资质的第三方查验接口，演示版暂未接入，标为「未接入」。</p></aside></div>';
  return h;
}
function pill(k, t, n){ return '<button type="button" class="pill ' + k + (ui.filter === k ? ' on' : '') + '" data-filter="' + k + '" aria-pressed="' + (ui.filter === k) + '">' + t + ' ' + n + '</button>'; }

function viewReview(id){
  var A = auditAll(), q = reviewQueue(A), all = sortedList(A);
  var inv = id ? invoices.filter(function(i){ return i.id === id; })[0] : q[0];
  if (!inv){
    return '<div class="card"><div class="empty"><strong style="color:var(--ink)">' + (invoices.length ? '没有待复核的发票' : '台账是空的') + '</strong><span>' + (invoices.length ? '拦截和复核的发票都处理完了，可以回台账导出。' : '先去审核台上传发票。') + '</span><a class="btn" href="#ledger">返回审核台</a></div></div>';
  }
  ui.curId = inv.id;
  var inQ = q.indexOf(inv), list = inQ >= 0 ? q : all, pos = list.indexOf(inv);
  var prev = list[pos-1], next = list[pos+1];
  var au = A[inv.id];
  var title = (inv.f.seller || inv.file || '未命名发票') + (num(inv.f.total) != null ? ' · ' + fmt(num(inv.f.total)) : '');
  var h = '<div class="rv-head"><a href="#ledger" style="text-decoration:none;font-size:13px">← 返回台账</a><span id="rv-chip">' + chip(inv, au) + '</span>' +
    (inv.decision ? '<span class="chip idle">' + DEC[inv.decision] + '</span>' : '') +
    '<h1 id="rv-title">' + esc(title) + '</h1>' +
    '<div class="pager"><span>' + (inQ >= 0 ? '待处理' : '全部') + '第 ' + (pos+1) + ' / ' + list.length + ' 张</span>' +
    '<a class="btn sm" ' + (prev ? 'href="#review-' + prev.id + '"' : 'aria-disabled="true" style="opacity:.45;pointer-events:none"') + '>上一张</a>' +
    '<a class="btn sm" ' + (next ? 'href="#review-' + next.id + '"' : 'aria-disabled="true" style="opacity:.45;pointer-events:none"') + '>下一张</a></div></div>';

  h += '<div class="cols"><section class="rv-left" aria-label="发票原件">';
  if (inv.img) h += '<div class="card pad"><img class="orig" src="' + inv.img + '" alt="发票原件：' + esc(inv.file) + '"></div>';
  h += '<div class="card pad stack"><div class="sub">' + (inv.img ? '按识别结果还原，黄色是触发规则的字段' : '票面信息（黄色是触发规则的字段）') + '</div><div class="paper-wrap" id="rv-paper">' + paper(inv, au) + '</div></div>';
  h += '<p class="note">' + (inv.source === 'sample' ? '这是示例数据。' : inv.source === 'manual' ? '手动录入。' : '来源文件：' + esc(inv.file) + '。') + (inv.sender ? ' 来自邮件：' + esc(inv.senderName ? inv.senderName + ' <' + inv.sender + '>' : inv.sender) + (inv.mail && inv.mail.subject ? '「' + esc(inv.mail.subject) + '」' : '') + (inv.mail && inv.mail.date ? ' ' + esc(fmtDateTime(inv.mail.date)) : '') + '。' : '') + (inv.method && METHOD[inv.method] ? ' 识别方式：' + METHOD[inv.method] + '。' : '') + (inv.conf != null ? ' 置信度 ' + Math.round(inv.conf*100) + '%。' : '') + (inv.qr ? ' 二维码：已读取' + (inv.qr.mismatch && inv.qr.mismatch.length ? '，' + esc(inv.qr.mismatch.join('、')) + '已按二维码修正' : '，号码和日期一致') + '。' : '') + (inv.aiNotes ? ' 识别备注：' + esc(inv.aiNotes) : '') + '</p></section>';

  h += '<div class="rv-right">';
  if (inv.status === 'error') h += '<div class="errbox" role="alert">' + esc(inv.err) + '</div>';
  if (inv.status === 'recognizing') h += '<div class="progress"><span class="spin"></span>正在识别 ' + esc(inv.file) + '…</div>';
  h += '<section class="card pad stack" aria-label="审核结果" id="rv-checks">' + checksHtml(inv, au) + '</section>';
  h += '<section class="card pad stack" aria-label="识别字段"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap"><h2 class="h">识别字段</h2><span class="sub">改错后自动重新审核</span></div><div class="fgrid" id="rv-fields">' + fieldsHtml(inv, au) + '</div>' +
    (fileMap[inv.id] ? '<div class="actions"><button class="btn sm" type="button" data-act="retry" data-id="' + inv.id + '"' + (inv.status === 'recognizing' ? ' disabled' : '') + '>重新识别</button>' +
      (aiState === 'on' && inv.method !== 'ai' ? '<button class="btn sm" type="button" data-act="retry-ai" data-id="' + inv.id + '"' + (inv.status === 'recognizing' ? ' disabled' : '') + '>用 AI 重新识别</button>' : '') +
      (aiState !== 'on' && inv.method === 'ocr' ? '<a class="btn sm" href="#ai">开启 AI 识别更准</a>' : '') + '</div>' : '') + '</section>';
  h += '<section class="card pad stack" aria-label="复核处理">' +
    '<label class="fld" for="memo">复核意见<textarea id="memo" rows="3" data-id="' + inv.id + '" placeholder="例如：已确认为 8 人客户招待，人均未超标，同意报销">' + esc(inv.memo) + '</textarea></label>' +
    '<div class="actions"><button class="btn lg danger" type="button" data-dec="rejected" data-id="' + inv.id + '">驳回</button><button class="btn lg" type="button" data-dec="returned" data-id="' + inv.id + '">退回补充说明</button>' +
    '<button class="btn lg primary grow" type="button" data-dec="approved" data-id="' + inv.id + '"' + (inv.status !== 'ready' ? ' disabled' : '') + '>人工通过</button></div>' +
    '<div class="actions" style="font-size:12px">' + (inv.decision ? '<button class="linkbtn muted" type="button" data-dec="" data-id="' + inv.id + '">撤销处理结果</button>' : '') +
    (ui.confirmDel ? '<button class="linkbtn" style="color:var(--block)" type="button" data-act="del-yes" data-id="' + inv.id + '">确认删除这张发票</button><button class="linkbtn muted" type="button" data-act="del-no">取消</button>' : '<button class="linkbtn muted" type="button" data-act="del">从台账删除</button>') +
    '</div></section></div></div>';
  return h;
}
function checksHtml(inv, au){
  if (!au) return '<h2 class="h">审核结果</h2><span class="sub">识别完成后自动审核</span>';
  var bad = au.checks.filter(function(c){ return c.k === 'fail' || c.k === 'warn'; }).length;
  var I = {ok:'✓', warn:'▲', fail:'✕', skip:'–'};
  return '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h2 class="h">审核结果</h2><span class="sub">' + au.checks.length + ' 项检查' + (bad ? ' · ' + bad + ' 项有问题' : ' · 全部通过') + '</span></div>' +
    au.checks.map(function(c){ return '<div class="ck ' + c.k + '"><span class="ic" aria-hidden="true">' + I[c.k] + '</span><div><span class="t">' + esc(c.title) + '</span><span class="dd">' + esc(c.detail) + '</span></div></div>'; }).join('');
}
function hlSet(au){ var s = {}; if (au) au.checks.forEach(function(c){ (c.fields||[]).forEach(function(k){ s[k] = c.k; }); }); return s; }
function fieldsHtml(inv, au){
  var hs = hlSet(au), f = inv.f;
  return FIELDS.map(function(d){
    var v = f[d.k]; if (v == null) v = '';
    var ctl;
    if (d.sel) ctl = '<select id="f-' + d.k + '" data-f="' + d.k + '">' + CATS.map(function(c){ return '<option' + (c === v ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>';
    else ctl = '<input id="f-' + d.k + '" data-f="' + d.k + '"' + (d.mono ? ' class="mono"' : '') + (d.num ? ' inputmode="decimal"' : '') + ' value="' + esc(v) + '"' + (d.ph ? ' placeholder="' + d.ph + '"' : '') + '>';
    return '<label class="fld' + (d.wide ? ' wide' : '') + (hs[d.k] ? ' hl' : '') + '" for="f-' + d.k + '">' + d.label + ctl + '</label>';
  }).join('');
}
function fmtQty(v){ v = num(v); if (v == null) return ''; return String(Math.round(v * 1e8) / 1e8); }
function linesTable(f, m){
  var L = f.lines || [];
  var h = '<table><thead><tr><th>项目名称</th><th>规格型号</th><th>单位</th><th class="r">数量</th><th class="r">单价</th><th class="r">金额</th><th class="r">税率</th><th class="r">税额</th></tr></thead><tbody class="mono">';
  if (!L.length){
    h += '<tr><td style="font-family:var(--f-sans)">' + m('items', f.items) + '</td><td></td><td></td><td></td><td></td><td class="r">' + m('amount', num(f.amount) == null ? '' : fmtN(num(f.amount))) + '</td><td class="r">' + m('rate', f.rate == null || f.rate === '' ? '' : f.rate + '%') + '</td><td class="r">' + m('tax', num(f.tax) == null ? '' : fmtN(num(f.tax))) + '</td></tr>';
  } else {
    L.forEach(function(l){
      h += '<tr><td style="font-family:var(--f-sans)"><span class="v">' + esc(l.name || '—') + '</span></td><td style="font-family:var(--f-sans)">' + esc(l.spec || '') + '</td><td style="font-family:var(--f-sans)">' + esc(l.unit || '') + '</td>' +
        '<td class="r">' + esc(fmtQty(l.qty)) + '</td><td class="r">' + esc(fmtQty(l.price)) + '</td><td class="r"><span class="v">' + (num(l.amount) == null ? '' : fmtN(num(l.amount))) + '</span></td>' +
        '<td class="r">' + (l.rate == null || l.rate === '' ? '' : esc(l.rate) + '%') + '</td><td class="r">' + (num(l.tax) == null ? '' : fmtN(num(l.tax))) + '</td></tr>';
    });
    h += '<tr class="sumrow"><td style="font-family:var(--f-sans)">合计（' + L.length + ' 行）</td><td></td><td></td><td></td><td></td><td class="r">' + m('amount', num(f.amount) == null ? '' : '¥' + fmtN(num(f.amount))) + '</td><td></td><td class="r">' + m('tax', num(f.tax) == null ? '' : '¥' + fmtN(num(f.tax))) + '</td></tr>';
  }
  return h + '</tbody></table>';
}
function paper(inv, au){
  var f = inv.f, hs = hlSet(au);
  function m(k, txt){ var t = esc(txt == null || txt === '' ? '—' : txt); return hs[k] ? '<mark>' + t + '</mark>' : '<span class="v">' + t + '</span>'; }
  var T = num(f.total);
  return '<div class="paper"><div class="ph"><div class="qr" aria-hidden="true">二维码</div><div class="pt">' + esc(/专用/.test(f.type) ? '电子发票（增值税专用发票）' : /铁路/.test(f.type) ? '电子发票（铁路电子客票）' : '电子发票（普通发票）') + '</div>' +
    '<div class="meta">' + (f.code ? '发票代码：' + m('code', f.code) + '<br>' : '') + '发票号码：' + m('no', f.no) + '<br>开票日期：' + m('date', dateCN(f.date)) + '</div></div>' +
    '<div class="parties"><div><b>购买方信息</b><div>名称：' + m('buyer', f.buyer) + '</div><div>统一社会信用代码：<span class="mono">' + m('buyerTax', f.buyerTax) + '</span></div></div>' +
    '<div><b>销售方信息</b><div>名称：' + m('seller', f.seller) + '</div><div>统一社会信用代码：<span class="mono">' + m('sellerTax', f.sellerTax) + '</span></div></div></div>' +
    linesTable(f, m) +
    '<div class="tot"><span>价税合计（大写）<span class="v">' + rmbUpper(T) + '</span></span><span>（小写）<span class="mono">' + m('total', T == null ? '' : '¥' + T.toFixed(2)) + '</span></span></div>' +
    '<div class="tot"><span>费用类别：' + m('cat', f.cat) + '</span><span>' + esc(f.type || '') + '</span></div></div>';
}
function refreshReview(inv){
  var au = inv.status === 'ready' ? audit(inv, invoices) : null;
  var c = $('#rv-checks'); if (c) c.innerHTML = checksHtml(inv, au);
  var p = $('#rv-paper'); if (p) p.innerHTML = paper(inv, au);
  var ch = $('#rv-chip'); if (ch) ch.innerHTML = chip(inv, au);
  var t = $('#rv-title'); if (t) t.textContent = (inv.f.seller || inv.file || '未命名发票') + (num(inv.f.total) != null ? ' · ' + fmt(num(inv.f.total)) : '');
  var hs = hlSet(au);
  $$('#rv-fields .fld').forEach(function(l){ var k = l.getAttribute('for').slice(2); l.classList.toggle('hl', !!hs[k]); });
}

function viewRules(){
  var h = '<div class="rl-head"><div class="stack" style="gap:4px"><h1>审核规则</h1><span class="muted" style="font-size:13px">改动立即生效，台账里所有发票会按新规则重新审核。</span></div>' +
    '<div class="actions grow" style="margin-left:auto"><button class="btn lg" type="button" data-act="reset-cfg">恢复默认规则</button></div></div>';
  h += '<div class="cols"><div class="col-main" style="flex:1 1 540px">';
  h += '<section class="card pad stack"><div><h2 class="h">公司抬头</h2><span class="sub">发票的购买方必须是下面之一，名称和税号都要对得上。默认的两家是示例，请换成你们公司的。</span></div>' +
    '<div class="tbl-wrap"><table class="rtbl"><thead><tr><th>公司名称</th><th>纳税人识别号</th><th></th></tr></thead><tbody>' +
    cfg.companies.map(function(c, i){ return '<tr><td><input class="inp" aria-label="公司名称" data-co="' + i + '" data-key="name" value="' + esc(c.name) + '"></td><td><input class="inp mono" aria-label="纳税人识别号" data-co="' + i + '" data-key="taxId" value="' + esc(c.taxId) + '"></td><td style="text-align:right"><button class="linkbtn muted" type="button" data-act="co-del" data-i="' + i + '">删除</button></td></tr>'; }).join('') +
    '</tbody></table></div><button class="btn dashed" style="align-self:flex-start" type="button" data-act="co-add">＋ 添加公司主体</button></section>';
  h += '<section class="card pad stack"><div><h2 class="h">报销标准</h2><span class="sub">按费用类别设单张上限，留空表示不限</span></div><div class="tbl-wrap"><table class="rtbl"><thead><tr><th>类别</th><th>单张上限（元）</th><th>超出时</th></tr></thead><tbody>' +
    CATS.map(function(k){ var l = cfg.limits[k]; return '<tr><td>' + k + '</td><td><input class="inp mono" style="max-width:140px" inputmode="decimal" aria-label="' + k + '单张上限" data-lim="' + k + '" value="' + (l.v == null ? '' : l.v) + '" placeholder="不限"></td><td><select class="lv ' + l.lv + '" aria-label="' + k + '超出时处理" data-limlv="' + k + '"><option value="review"' + (l.lv === 'review' ? ' selected' : '') + '>转人工复核</option><option value="block"' + (l.lv === 'block' ? ' selected' : '') + '>直接拦截</option></select></td></tr>'; }).join('') +
    '</tbody></table></div></section>';
  h += '<section class="card pad stack"><h2 class="h">时间、金额与税率</h2><div class="fgrid">' +
    '<label class="fld" for="c-days">开票后多少天内可报销<input id="c-days" class="mono" inputmode="numeric" data-num="days" value="' + cfg.days + '"></label>' +
    '<label class="fld" for="c-big">单张超过多少元提醒复核<input id="c-big" class="mono" inputmode="decimal" data-num="big" value="' + (cfg.big == null ? '' : cfg.big) + '"></label></div>' +
    '<div class="stack" style="gap:8px"><span class="sub">允许的税率（点击切换）</span><div class="rates">' +
    [0,1,1.5,3,5,6,9,13].map(function(r){ var on = cfg.rates.indexOf(r) >= 0; return '<button type="button" class="rate' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-rate="' + r + '">' + r + '%</button>'; }).join('') +
    '</div></div></section></div>';
  h += '<section class="card pad" style="flex:1 1 500px;min-width:0;display:flex;flex-direction:column;gap:4px"><div style="padding-bottom:8px"><h2 class="h">检查项与处理方式</h2><span class="sub">拦截：不能报销，需换票或退回。复核：交给人看一眼。只要有一项拦截，整张发票就是拦截。</span></div>' +
    RULES.map(function(r){ var s = cfg.rules[r.id];
      var sel = r.lv === null ? '<span class="sub">按类别设置</span>' : '<select class="lv ' + s.lv + '" aria-label="' + r.name + '的处理方式" data-rlv="' + r.id + '"><option value="block"' + (s.lv === 'block' ? ' selected' : '') + '>拦截</option><option value="review"' + (s.lv === 'review' ? ' selected' : '') + '>复核</option></select>';
      return '<div class="rule' + (s.on ? '' : ' off') + '"><input type="checkbox" id="r-' + r.id + '" data-ron="' + r.id + '"' + (s.on ? ' checked' : '') + '><label class="rt" for="r-' + r.id + '"><b>' + r.name + '</b><span>' + r.how + '</span></label>' + sel + '</div>';
    }).join('') +
    '<div class="rule off"><input type="checkbox" disabled aria-label="真伪查验（未接入）"><div class="rt"><b>真伪查验</b><span>需接入税务数字账户或第三方查验接口，正式版再开</span></div><span class="chip idle">未接入</span></div>' +
  '</section></div>';
  return h;
}

function viewAI(){
  var info = aiInfo || {provider:'qwen', providers:{}, model:'', baseUrl:'', hasKey:false, keyTail:''};
  var P = info.providers || {};
  var d = ui.aiDraft || {provider:info.provider, model:info.model, baseUrl:info.baseUrl};
  var HELP = {
    qwen:'<ol><li>打开阿里云百炼控制台 <a href="https://bailian.console.aliyun.com/" target="_blank" rel="noopener">bailian.console.aliyun.com</a>，用阿里云账号登录并开通服务</li><li>在「API-KEY」页面创建一个 Key，复制粘贴到左边</li><li>模型用 qwen-vl-max 识别更准，qwen-vl-plus 更便宜</li></ol>',
    claude:'<ol><li>在 <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a> 创建 API Key</li><li>在中国大陆使用通常需要电脑开代理，软件会使用系统的代理设置</li></ol>',
    openai:'<ol><li>填写服务商提供的接口地址（一般以 /v1 结尾）、模型名称和 API Key</li><li>模型必须能识别图片，例如智谱的 glm-4v 系列</li></ol>'
  };
  var h = '<div class="rl-head"><div class="stack" style="gap:4px"><h1>AI 识别（可选）</h1><span class="muted" style="font-size:13px">不设置也能用：PDF、OFD、XML 直接读取，照片和截图用内置文字识别，全部在本机完成。开启 AI 后，照片和扫描件改用 AI 识别，准确率更高；发票图片会发送给所选服务商，API Key 加密保存在这台电脑上。</span></div></div>';
  h += '<div class="cols"><section class="card pad stack" style="flex:999 1 560px;min-width:0"><div class="fgrid">' +
    '<label class="fld wide" for="ai-provider">服务商<select id="ai-provider">' + Object.keys(P).map(function(k){ return '<option value="' + k + '"' + (k === d.provider ? ' selected' : '') + '>' + esc(P[k].name) + (k === 'qwen' ? '（国内推荐）' : '') + '</option>'; }).join('') + '</select></label>' +
    '<label class="fld wide" for="ai-key">API Key<input id="ai-key" type="password" autocomplete="off" class="mono" value="' + esc(ui.aiKeyDraft || '') + '" placeholder="' + (info.hasKey && d.provider === info.provider ? '已保存（尾号 ' + esc(info.keyTail) + '），不修改就留空' : '粘贴 API Key') + '"></label>' +
    '<label class="fld" for="ai-model">模型<input id="ai-model" class="mono" value="' + esc(d.model) + '"></label>' +
    '<label class="fld" for="ai-base">接口地址<input id="ai-base" class="mono" value="' + esc(d.baseUrl) + '" placeholder="https://…/v1"></label>' +
    '</div><div class="actions"><button class="btn lg primary" type="button" data-act="ai-save">保存</button><button class="btn lg" type="button" data-act="ai-test"' + (ui.aiTesting ? ' disabled' : '') + '>' + (ui.aiTesting ? '<span class="spin"></span>正在测试…' : '保存并测试连接') + '</button>' +
    (info.hasKey ? '<button class="linkbtn muted grow" type="button" data-act="ai-clear">删除已保存的 Key</button>' : '') + '</div>';
  if (aiTest) h += '<div class="' + (aiTest.ok ? 'status-ok' : 'status-bad') + '" role="status">' + esc(aiTest.msg) + '</div>';
  else h += '<div class="sub">' + (info.hasKey ? '当前使用：' + esc((P[info.provider] || {}).name || '') + ' · ' + esc(info.model) : '还没有设置。设置好之前，可以用「手动录入」体验审核流程。') + '</div>';
  h += '</section><aside class="col-side"><section class="card pad stack"><h2 class="h">怎么获取 API Key</h2><div class="help">' + (HELP[d.provider] || '') + '</div><p class="note">费用按服务商的价格计算，可以在服务商的控制台查看用量。</p></section></aside></div>';
  return h;
}
function aiForm(){
  return {provider:$('#ai-provider').value, key:$('#ai-key').value, model:$('#ai-model').value, baseUrl:$('#ai-base').value};
}
function saveAIForm(f){
  f = f || aiForm();
  return window.api.saveAI(f).then(function(r){
    if (!r || !r.ok) throw {message:(r && r.message) || '保存失败'};
    aiInfo = r.data; aiState = aiInfo.hasKey ? 'on' : 'nokey'; ui.aiDraft = null; ui.aiKeyDraft = '';
  });
}

/* ---------- 邮箱收票 ---------- */
var mailInfo = null;
var mailUi = {editing:false, draft:null, passDraft:'', status:null, testing:false, senders:'', days:'30', scanning:false, progress:'', result:null, sel:{}, error:'', importing:false};
function loadMailInfo(){ return window.api.mailGet().then(function(r){ if (r && r.ok) mailInfo = r.data; }); }
function mailReady(){ return mailInfo && mailInfo.user && mailInfo.hasPass; }
function parseSenders(s){
  var out = [];
  String(s || '').split(/[\s,，;；、]+/).forEach(function(x){ x = x.trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x) && out.indexOf(x) < 0) out.push(x); });
  return out;
}
function fmtSize(n){ return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
function fmtDateTime(iso){ if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2) + ' ' + ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2); }
var MAIL_HELP = {
  qq: '<ol><li>在电脑上登录 QQ 邮箱网页版 <a href="https://mail.qq.com" target="_blank" rel="noopener">mail.qq.com</a>，点右上角「设置」→「账号与安全」（旧版是「设置 → 账户」）</li><li>找到「POP3/IMAP/SMTP/Exchange/CardDAV 服务」，开启「IMAP/SMTP 服务」</li><li>按提示用手机发短信验证，页面会显示一串 16 位的「授权码」，复制粘贴到左边</li></ol><p class="note">授权码只显示一次，可以随时重新生成。修改 QQ 密码后，旧的授权码可能失效，需要重新生成。</p>',
  exmail: '<ol><li>登录腾讯企业邮网页版，进入「设置 → 收发信设置」，开启 IMAP/SMTP 服务</li><li>如果开启了微信动态密码或安全登录，在「设置 → 微信绑定 → 客户端专用密码」里生成一个专用密码，填到左边</li><li>没开启安全登录的，直接填邮箱密码</li></ol>',
  '163': '<ol><li>登录 163 邮箱网页版，点「设置 → POP3/SMTP/IMAP」</li><li>开启「IMAP/SMTP 服务」，按提示发短信验证</li><li>复制生成的「授权密码」填到左边</li></ol>',
  '126': '<ol><li>登录 126 邮箱网页版，点「设置 → POP3/SMTP/IMAP」</li><li>开启「IMAP/SMTP 服务」，按提示发短信验证</li><li>复制生成的「授权密码」填到左边</li></ol>',
  qiye163: '<ol><li>登录网易企业邮，「设置 → 客户端设置」开启 IMAP</li><li>如果开启了客户端授权密码，生成一个填到左边；否则填邮箱密码</li></ol>',
  aliyun: '<ol><li>登录阿里企业邮箱网页版，「设置 → 账户与安全 → 三方客户端安全密码」生成一个密码</li><li>把这个密码填到左边</li></ol>',
  custom: '<p class="help">填写邮箱服务商提供的 IMAP 服务器地址和端口（一般是 993，使用 SSL）。密码一般要填邮箱设置里生成的客户端授权码。</p>'
};
function viewMail(){
  var info = mailInfo || {preset:'qq', presets:{}, user:'', hasPass:false};
  var h = '<div class="rl-head"><div class="stack" style="gap:4px"><h1>邮箱收票</h1><span class="muted" style="font-size:13px">输入发件人邮箱，只收这些人发来的发票邮件。软件只读取邮件，不会标记已读、删除或移动邮件。</span></div></div>';
  if (!mailReady() || mailUi.editing){
    var d = mailUi.draft || {preset:info.preset, user:info.user, host:info.host, port:info.port, secure:info.secure};
    var P = info.presets || {};
    h += '<div class="cols"><section class="card pad stack" style="flex:999 1 520px;min-width:0"><h2 class="h">连接收票邮箱</h2><div class="fgrid">' +
      '<label class="fld wide" for="mail-preset">邮箱类型<select id="mail-preset">' + Object.keys(P).map(function(k){ return '<option value="' + k + '"' + (k === d.preset ? ' selected' : '') + '>' + esc(P[k].name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="fld wide" for="mail-user">邮箱地址<input id="mail-user" class="mono" autocomplete="off" value="' + esc(d.user || '') + '" placeholder="例如 fapiao@qq.com"></label>' +
      '<label class="fld wide" for="mail-pass">授权码<input id="mail-pass" type="password" class="mono" autocomplete="off" value="' + esc(mailUi.passDraft) + '" placeholder="' + (info.hasPass ? '已保存，不修改就留空' : '粘贴邮箱设置里生成的授权码（不是登录密码）') + '"></label>' +
      (d.preset === 'custom' ? '<label class="fld" for="mail-host">IMAP 服务器<input id="mail-host" class="mono" value="' + esc(d.host || '') + '" placeholder="imap.example.com"></label>' +
        '<label class="fld" for="mail-port">端口<input id="mail-port" class="mono" inputmode="numeric" value="' + esc(d.port || 993) + '"></label>' +
        '<label class="fld wide" for="mail-secure" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="mail-secure"' + (d.secure !== false ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:var(--accent)">使用 SSL 加密连接（一般都要勾选）</label>' : '') +
      '</div><div class="actions"><button class="btn lg primary" type="button" data-act="mail-test"' + (mailUi.testing ? ' disabled' : '') + '>' + (mailUi.testing ? '<span class="spin"></span>正在连接…' : '保存并测试连接') + '</button>' +
      (mailReady() ? '<button class="btn lg" type="button" data-act="mail-cancel">取消</button>' : '') + '</div>';
    if (mailUi.status) h += '<div class="' + (mailUi.status.ok ? 'status-ok' : 'status-bad') + '" role="status">' + esc(mailUi.status.msg) + '</div>';
    h += '<p class="note">授权码用 Windows 系统加密保存在这台电脑上，只用来读取邮件。</p></section>' +
      '<aside class="col-side"><section class="card pad stack"><h2 class="h">怎么获取授权码</h2><div class="help">' + (MAIL_HELP[d.preset] || '') + '</div></section></aside></div>';
    return h;
  }
  var pname = ((info.presets || {})[info.preset] || {}).name || '';
  h += '<div class="card pad" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span>收票邮箱：<b class="mono">' + esc(info.user) + '</b></span><span class="muted">' + esc(pname) + '</span><button class="linkbtn grow" type="button" data-act="mail-edit">修改设置</button></div>';
  var recent = (cfg.recentSenders || []).slice(0, 12);
  h += '<section class="card pad stack" aria-label="检查邮件"><div class="fgrid">' +
    '<label class="fld wide" for="mail-senders">发件人邮箱<input id="mail-senders" class="mono" autocomplete="off" value="' + esc(mailUi.senders) + '" placeholder="例如 zhangsan@company.com，可以填几个，用逗号隔开"></label>' +
    (recent.length ? '<div class="wide" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="sub">最近用过：</span>' + recent.map(function(s){ return '<button type="button" class="pill" data-sender="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') + '</div>' : '') +
    '<label class="fld" for="mail-days">时间范围<select id="mail-days">' + [['7','最近 7 天'],['30','最近 30 天'],['90','最近 3 个月'],['180','最近半年'],['365','最近一年']].map(function(o){ return '<option value="' + o[0] + '"' + (mailUi.days === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    '</div><div class="actions"><button class="btn lg primary" type="button" data-act="mail-scan"' + (mailUi.scanning ? ' disabled' : '') + '>' + (mailUi.scanning ? '<span class="spin"></span>正在检查…' : '检查邮件') + '</button>' +
    '<span class="muted" id="mail-progress" style="font-size:13px">' + esc(mailUi.scanning ? mailUi.progress : '') + '</span></div>' +
    (mailUi.error ? '<div class="errbox" role="alert">' + esc(mailUi.error) + '</div>' : '') +
    '<p class="note">只搜索收件箱。收取的内容：附件里的 PDF、OFD、XML、压缩包和发票图片，转发的邮件也可以；正文里只有下载链接的，能直接下载的会自动下载。</p></section>';

  var R = mailUi.result;
  if (R){
    var nFiles = 0, nSeen = 0, nSel = 0;
    R.messages.forEach(function(m){ m.files.forEach(function(f){ nFiles++; if (f.seen) nSeen++; if (mailUi.sel[f.id]) nSel++; }); });
    h += '<section class="card" aria-label="邮件清单"><div class="filters" style="justify-content:space-between"><div><b>' + esc(R.senders.join('、')) + '</b> <span class="muted">最近 ' + R.days + ' 天：' + R.messages.length + ' 封邮件，' + nFiles + ' 个发票文件' + (nSeen ? '（' + nSeen + ' 个已导入过）' : '') + '</span></div>' +
      (nFiles ? '<div class="actions"><button class="linkbtn" type="button" data-act="mail-all">全选</button><button class="linkbtn muted" type="button" data-act="mail-none">全不选</button></div>' : '') + '</div>';
    if (!R.messages.length) h += '<div class="empty">没有找到这些发件人在最近 ' + R.days + ' 天发来的邮件。可以换个时间范围，或者确认发件人邮箱有没有写错。</div>';
    R.messages.forEach(function(m){
      h += '<div class="mailmsg"><div class="mailhead"><span><b>' + esc(m.fromName || m.from) + '</b>' + (m.fromName ? ' <span class="muted mono" style="font-size:12px">' + esc(m.from) + '</span>' : '') + '</span><span class="muted mono" style="font-size:12px">' + esc(fmtDateTime(m.date)) + '</span></div>' +
        '<div class="mailsubj">' + esc(m.subject) + '</div>';
      if (!m.files.length && !m.links.length) h += '<div class="muted" style="font-size:12px">这封邮件里没有发票文件</div>';
      m.files.forEach(function(f){
        h += '<label class="mailfile" for="mf-' + esc(f.id) + '"><input type="checkbox" class="mail-file" id="mf-' + esc(f.id) + '" data-fid="' + esc(f.id) + '"' + (mailUi.sel[f.id] ? ' checked' : '') + '><span class="mono" style="min-width:0;overflow-wrap:anywhere">' + esc(f.name) + '</span><span class="muted" style="font-size:12px">' + fmtSize(f.size) + '</span>' + (f.seen ? '<span class="chip idle">已导入过</span>' : '') + '</label>';
      });
      m.links.forEach(function(u){
        h += '<div class="mailfile"><span class="chip review">只有下载链接</span><span class="muted" style="font-size:12px;min-width:0;overflow-wrap:anywhere">软件没能直接下载，请打开链接下载后再上传</span><button class="linkbtn" type="button" data-act="mail-link" data-url="' + esc(u) + '">打开链接</button></div>';
      });
      h += '</div>';
    });
    if (nFiles) h += '<div class="tbl-foot" style="align-items:center"><span>同一张发票导入两次会被「重复报销」规则拦下</span><button class="btn lg primary" type="button" data-act="mail-import"' + (!nSel || mailUi.importing ? ' disabled' : '') + '>导入选中的 ' + nSel + ' 个文件</button></div>';
    h += '</section>';
  }
  return h;
}
function mailForm(){
  var g = function(id){ var e = $('#' + id); return e ? e : null; };
  return {preset: g('mail-preset').value, user: g('mail-user').value.trim(), pass: g('mail-pass').value,
    host: g('mail-host') ? g('mail-host').value.trim() : '', port: g('mail-port') ? g('mail-port').value.trim() : 993, secure: g('mail-secure') ? g('mail-secure').checked : true};
}
function mailAction(act, t){
  if (act === 'mail-edit'){ mailUi.editing = true; mailUi.draft = null; mailUi.status = null; render(); return true; }
  if (act === 'mail-cancel'){ mailUi.editing = false; mailUi.draft = null; mailUi.passDraft = ''; mailUi.status = null; render(); return true; }
  if (act === 'mail-test'){
    var f = mailForm();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.user)){ mailUi.status = {ok:false, msg:'请填写正确的邮箱地址'}; render(); return true; }
    if (!f.pass && !(mailInfo && mailInfo.hasPass)){ mailUi.status = {ok:false, msg:'请粘贴授权码'}; render(); return true; }
    mailUi.testing = true; mailUi.status = null; mailUi.draft = {preset:f.preset, user:f.user, host:f.host, port:f.port, secure:f.secure}; mailUi.passDraft = ''; render();
    window.api.mailSave(f).then(function(r){
      if (!r || !r.ok) throw {message:(r && r.message) || '保存失败'};
      mailInfo = r.data;
      return window.api.mailTest();
    }).then(function(r){
      if (r && r.ok){ mailUi.status = null; mailUi.editing = false; mailUi.draft = null; toast('连接成功，收件箱里有 ' + r.data.messages + ' 封邮件'); }
      else mailUi.status = {ok:false, msg:'连接失败：' + ((r && r.message) || '未知错误')};
    }, function(e){ mailUi.status = {ok:false, msg:e.message}; }).then(function(){ mailUi.testing = false; render(); });
    return true;
  }
  if (act === 'mail-scan'){
    var input = $('#mail-senders'); if (input) mailUi.senders = input.value;
    var senders = parseSenders(mailUi.senders);
    if (!senders.length){ mailUi.error = '请填写发件人邮箱，例如 zhangsan@company.com'; render(); return true; }
    mailUi.days = ($('#mail-days') || {}).value || mailUi.days;
    mailUi.scanning = true; mailUi.error = ''; mailUi.progress = '正在连接邮箱'; mailUi.result = null; mailUi.sel = {}; render();
    window.api.mailScan({senders:senders, days:Number(mailUi.days)}).then(function(r){
      if (!r || !r.ok){ mailUi.error = (r && r.message) || '检查邮件失败'; return; }
      mailUi.result = r.data;
      r.data.messages.forEach(function(m){ m.files.forEach(function(f){ if (!f.seen) mailUi.sel[f.id] = true; }); });
      cfg.recentSenders = senders.concat((cfg.recentSenders || []).filter(function(s){ return senders.indexOf(s) < 0; })).slice(0, 12);
      save();
    }).then(function(){ mailUi.scanning = false; render(); });
    return true;
  }
  if (act === 'mail-all' || act === 'mail-none'){
    (mailUi.result ? mailUi.result.messages : []).forEach(function(m){ m.files.forEach(function(f){ if (act === 'mail-all') mailUi.sel[f.id] = true; else delete mailUi.sel[f.id]; }); });
    render(); return true;
  }
  if (act === 'mail-link'){ window.api.mailOpenLink(t.getAttribute('data-url')); return true; }
  if (act === 'mail-import'){
    var ids = Object.keys(mailUi.sel).filter(function(k){ return mailUi.sel[k]; });
    if (!ids.length) return true;
    mailUi.importing = true; render();
    window.api.mailImport(mailUi.result.scanId, ids).then(function(r){
      mailUi.importing = false;
      if (!r || !r.ok){ mailUi.error = (r && r.message) || '导入失败'; render(); return; }
      var files = [], metas = [];
      r.data.forEach(function(x){
        var ext = (x.name.match(/\.(\w+)$/) || [])[1] || '';
        var type = {pdf:'application/pdf', xml:'text/xml', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp'}[ext.toLowerCase()] || '';
        files.push(new File([x.data], x.name, {type:type}));
        metas.push({sender:x.from, senderName:x.fromName, mail:{subject:x.subject, date:x.date}});
      });
      mailUi.result.messages.forEach(function(m){ m.files.forEach(function(f){ if (mailUi.sel[f.id]){ f.seen = true; delete mailUi.sel[f.id]; } }); });
      toast('已导入 ' + files.length + ' 个文件，正在识别');
      enqueue(files, metas);
    });
    return true;
  }
  return false;
}
if (window.api.onMailProgress) window.api.onMailProgress(function(t){ mailUi.progress = t; var el = $('#mail-progress'); if (el && mailUi.scanning) el.textContent = t; });
function senderLabel(i){ return i.sender ? (i.senderName || i.sender.split('@')[0]) : ''; }

/* ---------- 事件 ---------- */
function findInv(id){ return invoices.filter(function(i){ return i.id === id; })[0]; }
document.addEventListener('click', function(e){
  var t = e.target.closest('[data-act],[data-filter],[data-dec],[data-open],[data-rate],[data-sender]');
  if (!t) return;
  if (t.hasAttribute('data-sender')){
    var inp = $('#mail-senders'), list = parseSenders(inp ? inp.value : mailUi.senders), sv = t.getAttribute('data-sender');
    if (list.indexOf(sv) < 0) list.push(sv);
    mailUi.senders = list.join(', '); if (inp){ inp.value = mailUi.senders; inp.focus(); }
    return;
  }
  if (t.hasAttribute('data-open')){ if (e.target.closest('a,button')) return; location.hash = 'review-' + t.getAttribute('data-open'); return; }
  if (t.hasAttribute('data-filter')){ ui.filter = t.getAttribute('data-filter'); render(); return; }
  if (t.hasAttribute('data-rate')){ var r = Number(t.getAttribute('data-rate')), i = cfg.rates.indexOf(r); if (i >= 0) cfg.rates.splice(i,1); else cfg.rates.push(r); cfg.rates.sort(function(a,b){ return a-b; }); save(); render(); return; }
  if (t.hasAttribute('data-dec')){
    var inv = findInv(t.getAttribute('data-id')); if (!inv) return;
    var d = t.getAttribute('data-dec'), memo = $('#memo'); if (memo) inv.memo = memo.value;
    if (d && d !== 'approved' && !inv.memo.trim()){ toast('请先在复核意见里写明原因，方便报销人修改'); if (memo) memo.focus(); return; }
    inv.decision = d || null; save();
    if (!d){ render(); toast('已撤销处理结果'); return; }
    toast(DEC[d]);
    var A = auditAll(), q = reviewQueue(A);
    location.hash = q.length ? 'review-' + q[0].id : 'ledger';
    if (!q.length) toast(DEC[d] + '，待复核的发票已全部处理');
    return;
  }
  var act = t.getAttribute('data-act');
  if (act === 'pick') $('#fileInput').click();
  else if (/^mail-/.test(act)) mailAction(act, t);
  else if (act === 'ex-cancel') closeExport();
  else if (act === 'ex-go') doExport();
  else if (act === 'open-dir') window.api.openDataDir();
  else if (act === 'upd-install'){ window.api.installUpdate(); toast('正在重启并更新…'); }
  else if (act === 'upd-open'){ if (upd && upd.url) window.api.openUpdate(upd.url); }
  else if (act === 'upd-check'){ t.disabled = true; window.api.checkUpdate().then(function(r){ t.disabled = false; toast(r && r.ok ? (r.data.msg || '发现新版本，见页面顶部提示') : '检查更新失败，请检查网络'); }); }
  else if (act === 'ai-save'){ saveAIForm().then(function(){ aiTest = null; render(); toast(aiState === 'on' ? '已保存，可以上传发票了' : '已保存，但还没有填写 API Key'); }, function(e){ toast(e.message); }); }
  else if (act === 'ai-test'){
    ui.aiTesting = true; aiTest = null; var form = aiForm(); ui.aiDraft = {provider:form.provider, model:form.model, baseUrl:form.baseUrl}; ui.aiKeyDraft = ''; render();
    saveAIForm(form).then(function(){ return window.api.testAI(); }).then(function(r){
      aiTest = r && r.ok ? {ok:true, msg:'连接成功，可以开始识别发票了'} : {ok:false, msg:'连接失败：' + ((r && r.message) || '未知错误')};
    }, function(e){ aiTest = {ok:false, msg:'连接失败：' + (e && e.message || '未知错误')}; }).then(function(){ ui.aiTesting = false; render(); });
  }
  else if (act === 'ai-clear'){ window.api.saveAI({provider:(aiInfo || {}).provider, model:(aiInfo || {}).model, baseUrl:(aiInfo || {}).baseUrl, clearKey:true}).then(function(r){ if (r && r.ok){ aiInfo = r.data; aiState = 'nokey'; aiTest = null; render(); toast('已删除 API Key'); } }); }
  else if (act === 'manual'){ var n = {id:uid(), createdAt:Date.now(), source:'manual', file:'', status:'ready', conf:null, aiNotes:'', decision:null, memo:'', f:emptyFields()}; n.f.buyer = cfg.companies[0] ? cfg.companies[0].name : ''; n.f.buyerTax = cfg.companies[0] ? cfg.companies[0].taxId : ''; invoices.unshift(n); save(); location.hash = 'review-' + n.id; }
  else if (act === 'samples'){ invoices = makeSamples().concat(invoices.filter(function(i){ return i.source !== 'sample'; })); save(); render(); toast('已加载 10 张示例发票'); }
  else if (act === 'clear'){ ui.confirmClear = true; render(); }
  else if (act === 'clear-no'){ ui.confirmClear = false; render(); }
  else if (act === 'clear-yes'){ invoices = invoices.filter(function(i){ return i.status === 'recognizing'; }); ui.confirmClear = false; save(); render(); toast('台账已清空'); }
  else if (act === 'del'){ ui.confirmDel = true; render(); }
  else if (act === 'del-no'){ ui.confirmDel = false; render(); }
  else if (act === 'del-yes'){ var id = t.getAttribute('data-id'); invoices = invoices.filter(function(i){ return i.id !== id; }); queue = queue.filter(function(i){ return i.id !== id; }); ui.confirmDel = false; save(); location.hash = 'ledger'; toast('已删除'); }
  else if (act === 'retry' || act === 'retry-ai'){
    var iv = findInv(t.getAttribute('data-id'));
    if (iv && fileMap[iv.id]){ iv.status = 'recognizing'; iv.stage = '排队中'; queue.push({inv:iv, opts: act === 'retry-ai' ? {forceImage:true} : {}}); render(); pump(); }
  }
  else if (act === 'co-add'){ cfg.companies.push({name:'', taxId:''}); save(); render(); var ins = $$('[data-co][data-key="name"]'); if (ins.length) ins[ins.length-1].focus(); }
  else if (act === 'co-del'){ cfg.companies.splice(Number(t.getAttribute('data-i')), 1); save(); render(); }
  else if (act === 'reset-cfg'){ cfg = defaultCfg(); save(); render(); toast('已恢复默认规则'); }
});
document.addEventListener('keydown', function(e){
  var tr = e.target.closest && e.target.closest('tr[data-open]');
  if (tr && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); location.hash = 'review-' + tr.getAttribute('data-open'); }
});
document.addEventListener('input', function(e){
  if (e.target.id === 'mail-senders'){ mailUi.senders = e.target.value; return; }
  if (e.target.id === 'q'){ ui.q = e.target.value; var pos = e.target.selectionStart; render(); var q = $('#q'); if (q){ q.focus(); try{ q.setSelectionRange(pos,pos); }catch(_){} } }
});
document.addEventListener('change', function(e){
  var t = e.target;
  if (t.hasAttribute('data-f')){
    var inv = findInv(ui.curId); if (!inv) return;
    var k = t.getAttribute('data-f'), v = t.value.trim();
    if (['amount','tax','total'].indexOf(k) >= 0) v = num(v);
    else if (k === 'rate') v = parseRate(v);
    else if (k === 'date') v = normDate(v) || v;
    else if (k === 'buyerTax' || k === 'sellerTax') v = normTax(v);
    inv.f[k] = v;
    if (inv.status === 'error'){ inv.status = 'ready'; inv.err = ''; }
    if (inv.conf != null) inv.conf = Math.max(inv.conf, 0.8);
    save(); refreshReview(inv);
    return;
  }
  if (t.id === 'sender-filter'){ ui.sender = t.value; render(); return; }
  if (t.id === 'mail-preset'){ var mf = mailForm(); mailUi.draft = {preset:mf.preset, user:mf.user, host:mf.host, port:mf.port, secure:mf.secure}; mailUi.passDraft = mf.pass; render(); return; }
  if (t.classList && t.classList.contains('mail-file')){ var fid = t.getAttribute('data-fid'); if (t.checked) mailUi.sel[fid] = true; else delete mailUi.sel[fid]; render(); return; }
  if (t.id === 'mail-days'){ mailUi.days = t.value; return; }
  if (t.id === 'ai-provider'){
    var P = (aiInfo && aiInfo.providers) || {}, v = t.value;
    ui.aiKeyDraft = $('#ai-key').value; aiTest = null;
    ui.aiDraft = {provider:v, model:(aiInfo && v === aiInfo.provider) ? aiInfo.model : (P[v] ? P[v].model : ''), baseUrl:(aiInfo && v === aiInfo.provider) ? aiInfo.baseUrl : (P[v] ? P[v].baseUrl : '')};
    render(); return;
  }
  if (t.id === 'memo'){ var iv = findInv(t.getAttribute('data-id')); if (iv){ iv.memo = t.value; save(); } return; }
  if (t.hasAttribute('data-co')){ cfg.companies[Number(t.getAttribute('data-co'))][t.getAttribute('data-key')] = t.getAttribute('data-key') === 'taxId' ? normTax(t.value) : t.value.trim(); save(); toast('已保存'); return; }
  if (t.hasAttribute('data-lim')){ cfg.limits[t.getAttribute('data-lim')].v = num(t.value); save(); toast('已保存'); return; }
  if (t.hasAttribute('data-limlv')){ cfg.limits[t.getAttribute('data-limlv')].lv = t.value; save(); render(); return; }
  if (t.hasAttribute('data-num')){ var key = t.getAttribute('data-num'), n = num(t.value); if (key === 'days' && (n == null || n < 1)){ t.value = cfg.days; toast('报销期限至少 1 天'); return; } cfg[key] = n; save(); toast('已保存'); return; }
  if (t.hasAttribute('data-ron')){ cfg.rules[t.getAttribute('data-ron')].on = t.checked; save(); render(); return; }
  if (t.hasAttribute('data-rlv')){ cfg.rules[t.getAttribute('data-rlv')].lv = t.value; save(); render(); return; }
});
window.addEventListener('hashchange', function(){ ui.confirmDel = false; ui.confirmClear = false; ui.aiDraft = null; ui.aiKeyDraft = ''; aiTest = null; render(); window.scrollTo(0,0); });
$('#fileInput').addEventListener('change', function(e){ enqueue(e.target.files); e.target.value = ''; });
['dragenter','dragover'].forEach(function(ev){ document.addEventListener(ev, function(e){ var d = e.target.closest && e.target.closest('#drop'); if (!d) return; e.preventDefault(); d.classList.add('over'); }); });
document.addEventListener('dragleave', function(e){ var d = e.target.closest && e.target.closest('#drop'); if (d && !d.contains(e.relatedTarget)) d.classList.remove('over'); });
document.addEventListener('drop', function(e){
  var d = e.target.closest && e.target.closest('#drop');
  if (!d) return; e.preventDefault(); d.classList.remove('over');
  enqueue(e.dataTransfer && e.dataTransfer.files);
});

/* ---------- 导出 ---------- */
/* 导出：先选提交人，生成 Excel（发票汇总 + 发票明细两张表） */
function exportGroups(){
  var ready = invoices.filter(function(i){ return i.status === 'ready'; });
  var g = {}, manual = 0;
  ready.forEach(function(i){ if (i.sender){ g[i.sender] = g[i.sender] || {label:senderLabel(i), n:0}; g[i.sender].n++; } else manual++; });
  return {ready:ready, g:g, manual:manual};
}
function openExport(){
  var G = exportGroups();
  if (!G.ready.length){ toast('台账里还没有发票'); return; }
  var def = ui.sender || '';
  var opts = '<option value="">全部（' + G.ready.length + ' 张）</option>' +
    Object.keys(G.g).sort().map(function(k){ return '<option value="' + esc(k) + '"' + (def === k ? ' selected' : '') + '>' + esc(G.g[k].label + '（' + k + '）') + ' · ' + G.g[k].n + ' 张</option>'; }).join('') +
    (G.manual ? '<option value="__none"' + (def === '__none' ? ' selected' : '') + '>手动上传的 · ' + G.manual + ' 张</option>' : '');
  var bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'export-modal';
  bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ex-title"><h2 id="ex-title">导出台账</h2>' +
    '<label class="fld" for="ex-sender">导出谁的发票<select id="ex-sender">' + opts + '</select></label>' +
    '<label class="fld" for="ex-scope">范围<select id="ex-scope"><option value="all">全部发票</option><option value="todo">只导出待处理的（拦截、复核且未处理）</option><option value="ok">只导出已通过的（自动通过和人工通过）</option></select></label>' +
    '<p class="note">导出为 Excel 文件，包含两张表：「发票汇总」每张发票一行，「发票明细」每行明细一行。</p>' +
    '<div class="actions"><button class="btn lg" type="button" data-act="ex-cancel">取消</button><button class="btn lg primary grow" type="button" data-act="ex-go">导出 Excel</button></div></div>';
  document.body.appendChild(bg);
  $('#ex-sender').focus();
}
function closeExport(){ var m = $('#export-modal'); if (m) m.remove(); }
function doExport(){
  if (!window.XLSX){ toast('导出组件没有加载，请重启软件后再试'); return; }
  var who = $('#ex-sender').value, scope = $('#ex-scope').value;
  closeExport();
  var A = auditAll();
  var list = sortedList(A).filter(function(i){
    if (i.status !== 'ready') return false;
    if (who === '__none' ? !!i.sender : (who && i.sender !== who)) return false;
    var lv = A[i.id].level;
    if (scope === 'todo') return lv !== 'pass' && !i.decision;
    if (scope === 'ok') return lv === 'pass' || i.decision === 'approved';
    return true;
  });
  if (!list.length){ toast('没有符合条件的发票'); return; }
  var res = function(i){ var lv = A[i.id].level; return LV[lv].t; };
  var dec = function(i){ return i.decision ? DEC[i.decision] : (A[i.id].level === 'pass' ? '自动通过' : '待处理'); };
  var issues = function(i){ return A[i.id].checks.filter(function(c){ return c.k === 'fail' || c.k === 'warn'; }).map(function(c){ return c.title + '：' + c.detail; }).join('；'); };
  var how = function(i){ return i.source === 'sample' ? '示例' : i.source === 'manual' ? '手动录入' : METHOD[i.method] || ''; };
  var H1 = ['提交人','提交人邮箱','审核结果','处理结果','发票类型','发票代码','发票号码','开票日期','购买方','购买方税号','销售方','销售方税号','金额','税额','价税合计','税率','费用类别','项目','明细行数','审核发现','复核意见','邮件主题','邮件时间','来源文件','识别方式'];
  var S1 = [H1].concat(list.map(function(i){
    var f = i.f;
    return [senderLabel(i), i.sender || '', res(i), dec(i), f.type, f.code || '', f.no || '', f.date || '', f.buyer, f.buyerTax, f.seller, f.sellerTax,
      num(f.amount), num(f.tax), num(f.total), f.rate == null || f.rate === '' ? '' : f.rate + '%', f.cat, f.items, (f.lines || []).length,
      issues(i), i.memo || '', i.mail ? i.mail.subject : '', i.mail ? fmtDateTime(i.mail.date) : '', i.file || '', how(i)];
  }));
  var H2 = ['提交人','提交人邮箱','发票号码','开票日期','销售方','销售方税号','行号','项目名称','规格型号','单位','数量','单价','金额','税率','税额','审核结果','来源文件'];
  var S2 = [H2];
  list.forEach(function(i){
    var f = i.f, L = (f.lines && f.lines.length) ? f.lines : [{name:f.items, amount:f.amount, rate:f.rate, tax:f.tax}];
    L.forEach(function(l, n){
      S2.push([senderLabel(i), i.sender || '', f.no || '', f.date || '', f.seller, f.sellerTax, n + 1, l.name || '', l.spec || '', l.unit || '',
        num(l.qty), num(l.price), num(l.amount), l.rate == null || l.rate === '' ? '' : l.rate + '%', num(l.tax), res(i), i.file || '']);
    });
  });
  var XL = window.XLSX, wb = XL.utils.book_new();
  function sheet(rows, widths, moneyCols){
    var ws = XL.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map(function(w){ return {wch:w}; });
    ws['!autofilter'] = {ref: XL.utils.encode_range({s:{r:0, c:0}, e:{r:rows.length - 1, c:rows[0].length - 1}})};
    for (var r = 1; r < rows.length; r++) moneyCols.forEach(function(c){ var cell = ws[XL.utils.encode_cell({r:r, c:c})]; if (cell && cell.t === 'n') cell.z = '#,##0.00'; });
    return ws;
  }
  XL.utils.book_append_sheet(wb, sheet(S1, [10,24,8,12,18,14,24,12,26,22,26,22,12,10,12,8,10,26,8,50,24,24,16,24,16], [12,13,14]), '发票汇总');
  XL.utils.book_append_sheet(wb, sheet(S2, [10,24,24,12,26,22,6,30,14,8,10,14,12,8,10,8,24], [12,14]), '发票明细');
  var data = XL.write(wb, {type:'array', bookType:'xlsx'});
  var d = new Date(), label = who === '__none' ? '手动上传' : who ? (exportGroups().g[who] || {}).label || who : '全部';
  var name = '发票台账_' + String(label).replace(/[\\/:*?"<>|]/g, '_') + '_' + d.getFullYear() + ('0'+(d.getMonth()+1)).slice(-2) + ('0'+d.getDate()).slice(-2) + '.xlsx';
  window.api.saveFile(name, new Uint8Array(data)).then(function(r){
    if (!r || !r.ok) toast('导出失败：' + (r && r.message || '无法写入文件'));
    else if (r.data && r.data.saved) toast('已导出 ' + list.length + ' 张发票、' + (S2.length - 1) + ' 行明细');
  });
}
$('#uploadBtn').addEventListener('click', function(){ $('#fileInput').click(); });
$('#exportBtn').addEventListener('click', openExport);
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeExport(); });

/* ---------- 自动更新 ---------- */
var appVer = '', isPortable = false, upd = null;
function renderUpdate(){
  var bar = $('#updateBar'), box = $('#updateBarIn');
  if (!bar || !box) return;
  if (!upd || !upd.state || upd.state === 'none'){ bar.hidden = true; return; }
  var v = esc(upd.version || ''), h = '';
  if (upd.state === 'downloading') h = '<span class="spin"></span><span>正在后台下载新版本 v' + v + (upd.percent ? '（' + upd.percent + '%）' : '') + '，不影响使用</span>';
  else if (upd.state === 'ready') h = '<span>新版本 v' + v + ' 已经下载好。</span><button class="btn primary" type="button" data-act="upd-install">立即重启并更新</button><span class="muted">也可以下次关闭软件时自动更新</span>';
  else if (upd.state === 'portable') h = '<span>有新版本 v' + v + '。免安装版不能自动替换，请下载新版后用它替换旧的 exe。</span><button class="btn primary" type="button" data-act="upd-open">下载新版</button><span class="muted">改用安装版，以后可以自动更新</span>';
  else if (upd.state === 'failed') h = '<span>新版本 v' + v + ' 下载失败，下次启动会再试。</span>';
  box.innerHTML = h; bar.hidden = !h;
}
if (window.api.onUpdate) window.api.onUpdate(function(d){ upd = d; renderUpdate(); });

/* ---------- 启动 ---------- */
Promise.all([
  window.api.loadData().then(function(r){ return r && r.ok ? applyLoaded(r.data) : false; }),
  window.api.info().then(function(r){ if (r && r.ok) dataDir = r.data.dataDir; }),
  window.api.getUpdate().then(function(r){ if (r && r.ok){ appVer = r.data.version; isPortable = r.data.portable; if (r.data.update){ upd = r.data.update; renderUpdate(); } } }),
  initAI(),
  loadMailInfo()
]).then(function(res){
  if (!res[0]){ invoices = makeSamples(); save(); }
  render();
}).catch(function(){ render(); });
})();
