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
  {id:'unclear',   name:'识别不清',       how:'AI 识别置信度低于 80%，或关键字段缺失', lv:'review'}
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
    companies:[{name:'上海示例科技有限公司', taxId:'91310115MA1K4A2B3C'},{name:'示例科技（杭州）有限公司', taxId:'91330106MA2H7C4D5E'}],
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
  if (inv.conf != null && inv.conf < 0.8) add('unclear', true, '识别置信度低', 'AI 置信度 ' + Math.round(inv.conf*100) + '%，建议对照原件核对' + (inv.aiNotes ? '。' + inv.aiNotes : ''), []);

  if (f.buyer){
    var comp = cfg.companies.filter(function(c){ return normName(c.name) === normName(f.buyer); })[0];
    if (!comp) add('buyerName', true, '购买方抬头不符', '「' + f.buyer + '」不在公司抬头列表里', ['buyer']);
    else {
      add('buyerName', false, '购买方抬头一致', comp.name);
      if (!f.buyerTax) add('buyerTax', true, '未识别到购买方税号', '公司报销的发票需要有购买方税号', ['buyerTax'], 'review');
      else if (normTax(f.buyerTax) !== normTax(comp.taxId)) add('buyerTax', true, '购买方税号与公司不一致', '票面 ' + f.buyerTax + '，' + comp.name + ' 应为 ' + comp.taxId, ['buyerTax']);
      else add('buyerTax', false, '购买方税号一致', comp.taxId);
    }
  }

  if (a != null && t != null && T != null){
    var diff = r2(a + t - T);
    if (Math.abs(diff) > 0.01) add('sum', true, '金额不平', fmtN(a) + ' + ' + fmtN(t) + ' = ' + fmtN(r2(a+t)) + '，票面价税合计 ' + fmtN(T) + '，差 ' + fmtN(Math.abs(diff)), ['amount','tax','total']);
    else add('sum', false, '金额平衡', fmtN(a) + ' + ' + fmtN(t) + ' = ' + fmtN(T));
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
  if (inv.status === 'recognizing') return '<span class="chip idle"><span class="spin"></span>识别中</span>';
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
  var base = Date.now() - 60000, buyer = '上海示例科技有限公司', bt = '91310115MA1K4A2B3C';
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
function emptyFields(){ return {type:'', cat:'其他', no:'', code:'', date:'', buyer:'', buyerTax:'', seller:'', sellerTax:'', amount:null, tax:null, total:null, rate:null, items:''}; }

/* ---------- AI 识别 ---------- */
var aiState = 'loading', aiInfo = null, aiTest = null;
var fileMap = {}; // 本次会话的原始文件，用于重新识别
var queue = [], busy = false;
var PROMPT = '你是中国发票信息抽取助手。附件是一张发票（可能是数电票、增值税专用/普通发票、铁路电子客票、出租车票、定额发票等）。\n' +
  '请只输出一个 JSON 对象，不要任何其他文字，字段如下：\n' +
  '{"invoice_type":"发票类型，如 数电票（普通发票）","invoice_code":"发票代码，没有则空字符串","invoice_number":"发票号码","issue_date":"YYYY-MM-DD","buyer_name":"购买方名称","buyer_tax_id":"购买方纳税人识别号/统一社会信用代码","seller_name":"销售方名称","seller_tax_id":"销售方纳税人识别号","amount":不含税金额合计(数字),"tax_amount":税额合计(数字),"total":价税合计(数字),"tax_rate":"主要税率，如 6%，免税写 免税","items":"主要项目名称，30字以内","category":"餐饮|住宿|交通|办公用品|其他 之一","confidence":0到1之间的数字，表示整体识别把握,"notes":"看不清、被遮挡或可疑之处，没有则空字符串"}\n' +
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
    not_granted:'没有允许本页面调用 Claude，可以手动补录字段', sampling_disabled:'当前账号无法使用 AI 识别，可以手动补录',
    rate_limited:'调用太频繁或用量已达上限，请稍后重新识别', session_expired:'登录已过期，刷新页面后再试',
    image_rejected:'图片无法识别，请换一张清晰的 JPG 或 PNG', images_unavailable:'当前环境不能把图片发给 AI，可以手动补录',
    invalid_json:'AI 返回的格式不对，可以点「重新识别」', refused:'AI 未能处理这张图片，请手动补录', empty_completion:'AI 没有返回结果，可以重新识别',
    prompt_too_large:'文件内容太长，请上传 PDF 或图片版', ofd:'暂不支持 OFD 格式，请上传同一张发票的 PDF 版', no_ai:'还没设置 AI 识别服务。可以对照左边的原件手动补录下面的字段，或到「AI 设置」填好 API Key 后点「重新识别」',
    decode:'读不出这个文件，请换成 JPG、PNG、PDF 或 XML', pdf:'PDF 渲染失败，请截图后上传图片'
  };
  if (/^(auth|rate|network|server|http|config|parse|empty|no_key)$/.test(code) && e.message) return e.message + (code === 'parse' || code === 'empty' ? '，可以点「重新识别」' : '');
  return M[code] || (e && e.message) || '识别出错，可以点「重新识别」';
}
function toJpeg(blob, maxW, q){
  return new Promise(function(res, rej){
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function(){
      var s = Math.min(1, maxW / img.naturalWidth), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth*s)); c.height = Math.max(1, Math.round(img.naturalHeight*s));
      var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,c.width,c.height); x.drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function(b){ b ? res(b) : rej({code:'decode'}); }, 'image/jpeg', q);
    };
    img.onerror = function(){ URL.revokeObjectURL(url); rej({code:'decode'}); };
    img.src = url;
  });
}
function blobToDataURL(b){ return new Promise(function(res){ var r = new FileReader(); r.onload = function(){ res(r.result); }; r.onerror = function(){ res(null); }; r.readAsDataURL(b); }); }
var pdfLib = null;
function loadPdf(){
  if (!window.pdfjsLib) return Promise.reject({code:'pdf'});
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  return Promise.resolve(window.pdfjsLib);
}
function pdfToJpeg(file){
  return loadPdf().then(function(lib){ return file.arrayBuffer().then(function(buf){ return lib.getDocument({data:buf, isEvalSupported:false}).promise; }); })
  .then(function(doc){ return doc.getPage(1); })
  .then(function(page){
    var vp = page.getViewport({scale:1}), sc = Math.min(3, 1700 / vp.width), v = page.getViewport({scale:sc});
    var c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,c.width,c.height);
    return page.render({canvasContext:x, viewport:v}).promise.then(function(){ return new Promise(function(res, rej){ c.toBlob(function(b){ b ? res(b) : rej({code:'pdf'}); }, 'image/jpeg', 0.9); }); });
  }).catch(function(e){ throw (e && e.code) ? e : {code:'pdf'}; });
}
function applyAI(inv, r){
  r = r || {};
  var cat = CATS.indexOf(r.category) >= 0 ? r.category : '其他';
  inv.f = {
    type: String(r.invoice_type || ''), cat: cat, no: String(r.invoice_number || '').replace(/\s/g,''), code: String(r.invoice_code || '').replace(/\s/g,''),
    date: normDate(r.issue_date), buyer: String(r.buyer_name || '').trim(), buyerTax: normTax(r.buyer_tax_id), seller: String(r.seller_name || '').trim(), sellerTax: normTax(r.seller_tax_id),
    amount: num(r.amount), tax: num(r.tax_amount), total: num(r.total), rate: parseRate(r.tax_rate), items: String(r.items || '')
  };
  var c = Number(r.confidence); inv.conf = isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
  inv.aiNotes = String(r.notes || '');
  inv.status = 'ready'; inv.err = '';
}
function recognize(inv, file){
  var name = file.name.toLowerCase();
  if (/\.ofd$/.test(name)) return Promise.reject({code:'ofd'});
  if (/\.xml$/.test(name) || file.type === 'text/xml' || file.type === 'application/xml'){
    if (aiState !== 'on') return Promise.reject({code:'no_ai'});
    return file.text().then(function(txt){ return callAI({prompt:PROMPT_XML, text:txt.slice(0, 80000)}); }).then(function(r){ applyAI(inv, r); if (inv.conf == null) inv.conf = 0.99; });
  }
  var getImg = (/\.pdf$/.test(name) || file.type === 'application/pdf') ? pdfToJpeg(file) : toJpeg(file, 1800, 0.9);
  return getImg.then(function(big){
    return toJpeg(big, 1100, 0.72).then(blobToDataURL).then(function(d){ inv.img = d; })
      .then(function(){ if (aiState !== 'on') throw {code:'no_ai'}; return toJpeg(big, 1600, 0.88); }).then(blobToDataURL)
      .then(function(d){ return callAI({prompt:PROMPT, imageB64:String(d).split(',')[1]}); });
  }).then(function(r){ applyAI(inv, r); });
}
function enqueue(files){
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  list.forEach(function(file, i){
    var inv = {id:uid() + i, createdAt:Date.now() + i, source:'ai', file:file.name, status:'recognizing', conf:null, aiNotes:'', decision:null, memo:'', f:emptyFields()};
    invoices.unshift(inv); fileMap[inv.id] = file; queue.push(inv);
  });
  save();
  if (route().v !== 'ledger') location.hash = 'ledger';
  render(); pump();
  if (aiState !== 'on') toast('已上传 ' + list.length + ' 张。还没设置 AI，点开发票可对照原件手动补录');
}
function pump(){
  if (busy) return;
  var inv = queue.shift();
  if (!inv){ render(); return; }
  busy = true; inv.status = 'recognizing'; render();
  recognize(inv, fileMap[inv.id]).catch(function(e){
    inv.status = 'error'; inv.err = aiErr(e); inv.errCode = (e && e.code) || '';
    if (e && e.code === 'no_ai' && !inv.f.buyer && cfg.companies[0]){ inv.f.buyer = cfg.companies[0].name; inv.f.buyerTax = cfg.companies[0].taxId; }
  })
  .then(function(){ busy = false; save(); render(); pump(); });
}

/* ---------- 路由与渲染 ---------- */
var ui = {filter:'all', q:'', confirmClear:false, confirmDel:false};
function route(){
  var h = (location.hash || '').replace(/^#/, '');
  if (h === 'rules') return {v:'rules'};
  if (h === 'ai') return {v:'ai'};
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

  var aiNote = '';
  if (aiState === 'nokey') aiNote = '<span class="warnline">还没设置 AI 识别：上传后可以对照原件手动补录；<a href="#ai">到 AI 设置填写 API Key</a> 后会自动识别。</span>';

  h += '<div class="cols"><div class="col-main">' +
    '<section class="drop" id="drop" aria-label="上传发票">' +
      '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);flex:none"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/></svg>' +
      '<div class="drop-text"><strong>把发票拖到这里，或点击选择文件</strong><span class="muted" style="font-size:13px">支持 PDF、JPG、PNG、数电票 XML，可一次选多张。AI 识别字段后按规则自动审核。</span>' + aiNote + '</div>' +
      '<div class="drop-actions"><button class="btn lg primary" type="button" data-act="pick">上传发票</button><button class="btn lg" type="button" data-act="manual">手动录入</button></div>' +
    '</section>';

  if (processing.length || queue.length){
    var total = processing.length + queue.length;
    h += '<div class="progress" role="status"><span class="spin"></span><span class="names">正在识别 ' + total + ' 张：' + esc(processing.concat(queue).map(function(i){ return i.file; }).slice(0,3).join('、')) + (total > 3 ? ' 等' : '') + '</span><span>每张约 10–40 秒</span></div>';
  }

  var list = sortedList(A).filter(function(i){
    if (ui.filter !== 'all'){ if (i.status !== 'ready' || A[i.id].level !== ui.filter) return false; }
    if (ui.q){ var q = ui.q.toLowerCase(); return [i.f.no, i.f.seller, i.f.buyer, i.file, i.f.items].join(' ').toLowerCase().indexOf(q) >= 0; }
    return true;
  });

  h += '<section class="card" aria-label="发票台账"><div class="filters">' +
    pill('all','全部', invoices.length) + pill('block','拦截', cnt.block) + pill('review','复核', cnt.review) + pill('pass','通过', cnt.pass) +
    '<label class="search" for="q"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q" placeholder="搜索发票号、销售方、文件名" value="' + esc(ui.q) + '"></label></div>';

  if (!invoices.length){
    h += '<div class="empty"><strong style="color:var(--ink)">台账是空的</strong><span>上传几张发票试试，或者先加载示例数据看看审核效果。</span><button class="btn" type="button" data-act="samples">加载示例发票</button></div>';
  } else if (!list.length){
    h += '<div class="empty">没有符合条件的发票</div>';
  } else {
    h += '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>风险</th><th>发票号码</th><th>开票日期</th><th>销售方</th><th>类别</th><th class="num">价税合计</th><th>审核发现</th></tr></thead><tbody>';
    list.forEach(function(i){
      var au = A[i.id], issue;
      if (i.status === 'recognizing') issue = '<span class="muted">' + esc(i.file) + '</span>';
      else if (i.status === 'error') issue = (i.errCode === 'no_ai' ? '未设置 AI 识别，点开对照原件补录，或设置 AI 后重新识别' : esc(i.err)) + ' <span class="muted">· ' + esc(i.file) + '</span>';
      else { var bad = au.checks.filter(function(c){ return c.k === 'fail' || c.k === 'warn'; }); issue = bad.length ? esc(bad.map(function(c){ return c.title; }).join('；')) : '<span class="muted">—</span>'; }
      h += '<tr data-open="' + i.id + '" tabindex="0" aria-label="查看 ' + esc(i.f.seller || i.file) + '">' +
        '<td>' + chip(i, au) + (i.decision ? '<span class="decision">' + DEC[i.decision] + '</span>' : '') + '</td>' +
        '<td class="mono nowrap" style="font-size:12px">' + esc(i.f.no || '—') + (i.source === 'sample' ? ' <span class="chip sample">示例</span>' : '') + '</td>' +
        '<td class="mono nowrap" style="font-size:12px">' + esc(i.f.date || '—') + '</td>' +
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
  h += '<p class="note">' + (inv.source === 'sample' ? '这是示例数据。' : inv.source === 'manual' ? '手动录入。' : '来源文件：' + esc(inv.file) + '。') + (inv.conf != null ? ' AI 识别置信度 ' + Math.round(inv.conf*100) + '%。' : '') + (inv.aiNotes ? ' 识别备注：' + esc(inv.aiNotes) : '') + '</p></section>';

  h += '<div class="rv-right">';
  if (inv.status === 'error') h += '<div class="errbox" role="alert">' + esc(inv.err) + '</div>';
  if (inv.status === 'recognizing') h += '<div class="progress"><span class="spin"></span>正在识别 ' + esc(inv.file) + '…</div>';
  h += '<section class="card pad stack" aria-label="审核结果" id="rv-checks">' + checksHtml(inv, au) + '</section>';
  h += '<section class="card pad stack" aria-label="识别字段"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap"><h2 class="h">识别字段</h2><span class="sub">改错后自动重新审核</span></div><div class="fgrid" id="rv-fields">' + fieldsHtml(inv, au) + '</div>' +
    (fileMap[inv.id] ? '<div class="actions">' + (aiState === 'on' ? '<button class="btn sm" type="button" data-act="retry" data-id="' + inv.id + '"' + (inv.status === 'recognizing' ? ' disabled' : '') + '>重新识别</button>' : '<a class="btn sm" href="#ai">设置 AI 后可自动识别</a>') + '</div>' : '') + '</section>';
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
function paper(inv, au){
  var f = inv.f, hs = hlSet(au);
  function m(k, txt){ var t = esc(txt == null || txt === '' ? '—' : txt); return hs[k] ? '<mark>' + t + '</mark>' : '<span class="v">' + t + '</span>'; }
  var T = num(f.total);
  return '<div class="paper"><div class="ph"><div class="qr" aria-hidden="true">二维码</div><div class="pt">' + esc(/专用/.test(f.type) ? '电子发票（增值税专用发票）' : /铁路/.test(f.type) ? '电子发票（铁路电子客票）' : '电子发票（普通发票）') + '</div>' +
    '<div class="meta">' + (f.code ? '发票代码：' + m('code', f.code) + '<br>' : '') + '发票号码：' + m('no', f.no) + '<br>开票日期：' + m('date', dateCN(f.date)) + '</div></div>' +
    '<div class="parties"><div><b>购买方信息</b><div>名称：' + m('buyer', f.buyer) + '</div><div>统一社会信用代码：<span class="mono">' + m('buyerTax', f.buyerTax) + '</span></div></div>' +
    '<div><b>销售方信息</b><div>名称：' + m('seller', f.seller) + '</div><div>统一社会信用代码：<span class="mono">' + m('sellerTax', f.sellerTax) + '</span></div></div></div>' +
    '<table><thead><tr><th>项目名称</th><th class="r">金额</th><th class="r">税率</th><th class="r">税额</th></tr></thead><tbody class="mono">' +
    '<tr><td style="font-family:var(--f-sans)">' + m('items', f.items) + '</td><td class="r">' + m('amount', num(f.amount) == null ? '' : fmtN(num(f.amount))) + '</td><td class="r">' + m('rate', f.rate == null || f.rate === '' ? '' : f.rate + '%') + '</td><td class="r">' + m('tax', num(f.tax) == null ? '' : fmtN(num(f.tax))) + '</td></tr>' +
    '<tr><td style="padding:16px"></td><td></td><td></td><td></td></tr></tbody></table>' +
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
  var h = '<div class="rl-head"><div class="stack" style="gap:4px"><h1>AI 设置</h1><span class="muted" style="font-size:13px">选择用来识别发票的 AI 服务。发票图片会发送给所选服务商识别，API Key 加密保存在这台电脑上。</span></div></div>';
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

/* ---------- 事件 ---------- */
function findInv(id){ return invoices.filter(function(i){ return i.id === id; })[0]; }
document.addEventListener('click', function(e){
  var t = e.target.closest('[data-act],[data-filter],[data-dec],[data-open],[data-rate]');
  if (!t) return;
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
  else if (act === 'retry'){ var iv = findInv(t.getAttribute('data-id')); if (iv && fileMap[iv.id]){ iv.status = 'recognizing'; queue.push(iv); render(); pump(); } }
  else if (act === 'co-add'){ cfg.companies.push({name:'', taxId:''}); save(); render(); var ins = $$('[data-co][data-key="name"]'); if (ins.length) ins[ins.length-1].focus(); }
  else if (act === 'co-del'){ cfg.companies.splice(Number(t.getAttribute('data-i')), 1); save(); render(); }
  else if (act === 'reset-cfg'){ cfg = defaultCfg(); save(); render(); toast('已恢复默认规则'); }
});
document.addEventListener('keydown', function(e){
  var tr = e.target.closest && e.target.closest('tr[data-open]');
  if (tr && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); location.hash = 'review-' + tr.getAttribute('data-open'); }
});
document.addEventListener('input', function(e){
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
    if (inv.source === 'ai') inv.conf = inv.conf == null ? null : Math.max(inv.conf, 0.8);
    save(); refreshReview(inv);
    return;
  }
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
function csvCell(v){ var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
function longNum(v){ return v ? '="' + v + '"' : ''; }
function buildCsv(){
  var A = auditAll();
  var head = ['审核结果','处理结果','发票类型','发票代码','发票号码','开票日期','购买方','购买方税号','销售方','销售方税号','金额','税额','价税合计','税率','费用类别','项目','审核发现','复核意见','来源文件','录入方式'];
  var rows = sortedList(A).filter(function(i){ return i.status === 'ready'; }).map(function(i){
    var au = A[i.id], f = i.f;
    return [LV[au.level].t, i.decision ? DEC[i.decision] : (au.level === 'pass' ? '自动通过' : '待处理'), f.type, longNum(f.code), longNum(f.no), f.date, f.buyer, f.buyerTax, f.seller, f.sellerTax,
      num(f.amount), num(f.tax), num(f.total), f.rate == null ? '' : f.rate + '%', f.cat, f.items,
      au.checks.filter(function(c){ return c.k === 'fail' || c.k === 'warn'; }).map(function(c){ return c.title + '：' + c.detail; }).join('；'),
      i.memo, i.file, {sample:'示例', ai:'AI 识别', manual:'手动录入'}[i.source] || ''];
  });
  return '﻿' + [head].concat(rows).map(function(r){ return r.map(function(c, idx){ return (idx === 3 || idx === 4) ? c : csvCell(c); }).join(','); }).join('\r\n');
}
$('#uploadBtn').addEventListener('click', function(){ $('#fileInput').click(); });
$('#exportBtn').addEventListener('click', function(){
  var ready = invoices.filter(function(i){ return i.status === 'ready'; });
  if (!ready.length){ toast('台账里还没有发票'); return; }
  var csv = buildCsv(), d = new Date(), name = '发票台账_' + d.getFullYear() + ('0'+(d.getMonth()+1)).slice(-2) + ('0'+d.getDate()).slice(-2) + '.csv';
  window.api.saveCsv(name, csv).then(function(r){
    if (!r || !r.ok) toast('导出失败：' + (r && r.message || '无法写入文件'));
    else if (r.data && r.data.saved) toast('已导出 ' + ready.length + ' 张，可用 Excel 打开');
  });
});

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
  initAI()
]).then(function(res){
  if (!res[0]){ invoices = makeSamples(); save(); }
  render();
}).catch(function(){ render(); });
})();
