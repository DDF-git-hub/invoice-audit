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
  {id:'crossYear', name:'跨年度发票',     how:'上一年开具、今年报销：注意费用所属期间和企业所得税汇算清缴', lv:'review'},
  {id:'splitNo',   name:'连号拆票',       how:'同一销售方、同一天开具、发票号码连续，可能为避开单张限额拆开开票', lv:'review'},
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
    companies:[{name:'上海示例科技有限公司', taxId:'91310115MA1K4A2B3A'}],
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
  vouchers = Array.isArray(p.vouchers) ? p.vouchers : [];
  invoices.forEach(function(i){
    if (i.status === 'recognizing'){ i.status = 'error'; i.err = '上次识别被中断，可重新上传或手动补录'; }
    if (i.status === 'error' && !i.errCode && /^还没设置 AI/.test(i.err || '')) i.errCode = 'no_ai';
  });
  return true;
}
function save(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    var payload = {v:1, savedAt:new Date().toISOString(), cfg:cfg, vouchers:vouchers, invoices:invoices.map(function(i){ var o = Object.assign({}, i); if (o.status === 'recognizing'){ o.status = 'error'; o.err = '识别被中断，可重新上传或手动补录'; } return o; })};
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

  // 进项税：专票里的餐饮、娱乐、居民日常服务不得抵扣；旅客运输票据按规定计算抵扣
  if (/专用/.test(f.type || '') && noDedReason(inv)) checks.push({id:'deduct', k:'info', title:'进项税不得抵扣', detail: noDedReason(inv) + '的进项税额不得抵扣（财税〔2016〕36 号），生成凭证时全额计入费用', fields:[]});
  else if (isTravel(inv) && acct().dedTravel && T != null){ var tx = dedTax(inv); if (tx > 0) checks.push({id:'deduct', k:'info', title:'旅客运输可抵扣进项', detail: (num(f.tax) > 0 ? '按票面税额 ' + fmtN(tx) : '票面未列税额，按 价税合计 ÷ (1+9%) × 9% 计算 ' + fmtN(tx)) + '；须为本单位员工本人乘坐', fields:[]}); }

  if (f.date && inv.createdAt){
    var fy = Number(String(f.date).slice(0, 4)), sy = new Date(inv.createdAt).getFullYear();
    if (fy && fy < sy){
      add('crossYear', true, '跨年度发票', '发票 ' + String(fy).slice(2) + ' 年开具，' + String(sy).slice(2) + ' 年报销', ['date']);
    }
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

  // 连号拆票：同一销售方、同一天、号码相差不超过 3
  if (no && f.seller && f.date){
    var sibs = all.filter(function(o){ var n = normNo(o.f.no); return o.id !== inv.id && o.status === 'ready' && n && n !== no && n.length === no.length && normName(o.f.seller) === normName(f.seller) && o.f.date === f.date && consecutive(n, no); });
    if (sibs.length){
      var sum = r2(sibs.reduce(function(x, o){ return x + (num(o.f.total) || 0); }, T || 0)), lim0 = cfg.limits[f.cat];
      add('splitNo', true, '连号拆票', '与 ' + sibs.map(function(o){ return o.f.no; }).join('、') + ' 号码连续，同一销售方同一天开具，合计 ' + fmt(sum) + (lim0 && lim0.v != null && sum > lim0.v && (T || 0) <= lim0.v ? '，合计超过' + f.cat + '单张上限 ' + fmt(lim0.v) + '，可能为避开限额拆开开票' : ''), ['no']);
    }
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
  var order = {fail:0, warn:1, info:2, ok:3, skip:4};
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
  // 示例：每种情况一张，发票类型尽量不同
  var S = [
    // 重复报销：同一张住宿票报了两次
    ['数电票（普通发票）','住宿','26312000000184620371',-14,buyer,bt,'上海锦江之星酒店管理有限公司','91310000132205678K',528.30,31.70,560.00,6,'*住宿服务*住宿费',0.97,'锦江之星_1013.pdf'],
    ['数电票（普通发票）','住宿','26312000000184620371',-14,buyer,bt,'上海锦江之星酒店管理有限公司','91310000132205678K',528.30,31.70,560.00,6,'*住宿服务*住宿费',0.96,'IMG_4790.jpg'],
    // 购买方税号不符
    ['数电票（普通发票）','其他','26442000000091273518',-7,buyer,'91310115MA1K4A2B3D','深圳顺丰速运有限公司','91440300279467123Q',345.63,10.37,356.00,3,'*物流辅助服务*收派服务费',0.95,'顺丰_1020.pdf'],
    // 金额不平（纸质专票）
    ['增值税专用发票','办公用品','04918736',-6,buyer,bt,'上海宏达五金有限公司','91310112MA1GB7HK2N',884.96,115.04,990.00,13,'*五金制品*工具套装',0.94,'宏达五金_专票.jpg'],
    // 超出餐饮上限 + 专票进项不得抵扣
    ['数电票（专用发票）','餐饮','26312000000207719120',-4,buyer,bt,'上海老正兴菜馆有限公司','91310101132251234X',943.40,56.60,1000.00,6,'*餐饮服务*餐费',0.97,'老正兴_专票.pdf'],
    // 疑似重复：同一销售方、同一天、同金额，号码不同
    ['数电票（普通发票）','餐饮','26312000000207718804',-5,buyer,bt,'上海小南国餐饮有限公司','91310101607412385X',358.49,21.51,380.00,6,'*餐饮服务*餐费',0.96,'小南国_1.pdf'],
    ['数电票（普通发票）','餐饮','26312000000207718911',-5,buyer,bt,'上海小南国餐饮有限公司','91310101607412385X',358.49,21.51,380.00,6,'*餐饮服务*餐费',0.94,'小南国_2.pdf'],
    // 连号拆票：单张都没超上限，合计超了
    ['数电票（普通发票）','餐饮','26312000000215530417',-2,buyer,bt,'上海鼎泰丰餐饮有限公司','91310104MA1FR2K91E',452.83,27.17,480.00,6,'*餐饮服务*餐费',0.96,'鼎泰丰_1.pdf'],
    ['数电票（普通发票）','餐饮','26312000000215530418',-2,buyer,bt,'上海鼎泰丰餐饮有限公司','91310104MA1FR2K91E',471.70,28.30,500.00,6,'*餐饮服务*餐费',0.96,'鼎泰丰_2.pdf'],
    // 识别不清：照片折痕，号码没认出来
    ['增值税电子普通发票','住宿','',-12,buyer,bt,'杭州西湖国宾馆','91330100143059876R',528.30,31.70,560.00,6,'*住宿服务*住宿费',0.62,'IMG_3302.jpg'],
    // 跨年度（同时超过报销期限）
    ['数电票（普通发票）','住宿','25312000000198812046',(new Date().getFullYear() - 1) + '-12-26',buyer,bt,'上海和平饭店有限公司','91310000132203456N',528.30,31.70,560.00,6,'*住宿服务*住宿费',0.97,'和平饭店_去年.pdf']
  ];
  return S.map(function(s, i){
    return {id:uid() + i, createdAt: base + i*1000, source:'sample', file:s[14], status:'ready', conf:s[13], aiNotes: s[13] < 0.8 ? '发票号码区域被折痕遮挡' : '', decision:null, memo:'',
      f:{type:s[0], cat:s[1], no:s[2], code:'', date: typeof s[3] === 'string' ? s[3] : isoOffset(s[3]), buyer:s[4], buyerTax:s[5], seller:s[6], sellerTax:s[7], amount:s[8], tax:s[9], total:s[10], rate:s[11], items:s[12]}};
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
    if (meta){ inv.source = 'mail'; inv.sender = meta.sender || ''; inv.senderName = meta.senderName || ''; inv.employeeId = meta.employeeId || null; inv.mail = meta.mail || null; }
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
var ui = {filter:'all', q:'', person:'', confirmClear:false, confirmDel:false};
function route(){
  var h = (location.hash || '').replace(/^#/, '');
  if (h === 'rules') return {v:'rules'};
  if (h === 'ai') return {v:'ai'};
  if (h === 'mail') return {v:'mail'};
  if (h === 'staff') return {v:'staff'};
  if (/^voucher(-done|-rules|-u8)?$/.test(h)) return {v:'voucher', tab:h};
  if (h === 'history') return {v:'history'};
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
  else if (r.v === 'staff') el.innerHTML = viewStaff();
  else if (r.v === 'voucher') el.innerHTML = viewVoucher(r.tab);
  else if (r.v === 'history') el.innerHTML = viewHistory();
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
    if (ui.person && personKey(i) !== ui.person) return false;
    if (ui.q){ var q = ui.q.toLowerCase(); return [i.f.no, i.f.seller, i.f.buyer, i.file, i.f.items, i.sender, i.senderName, personLabel(i)].join(' ').toLowerCase().indexOf(q) >= 0; }
    return true;
  });

  h += '<section class="card" aria-label="发票台账"><div class="filters">' +
    pill('all','全部', invoices.length) + pill('block','拦截', cnt.block) + pill('review','复核', cnt.review) + pill('pass','通过', cnt.pass) +
    (function(){
      var G = personGroups(invoices.filter(function(i){ return i.status !== 'recognizing'; }));
      if (!G.length || (G.length === 1 && G[0].kind === 2 && !emps().length)) return '';
      return '<label class="sr" for="person-filter">报销人</label><select id="person-filter" class="inp" style="width:auto;height:34px;border-radius:17px"><option value="">全部报销人</option>' +
        G.map(function(g){ return '<option value="' + esc(g.key) + '"' + (ui.person === g.key ? ' selected' : '') + '>' + esc(g.label + (g.kind === 1 ? '（未登记）' : '')) + ' · ' + g.n + '</option>'; }).join('') + '</select>';
    })() +
    '<label class="search" for="q"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q" placeholder="搜索发票号、销售方、文件名" value="' + esc(ui.q) + '"></label></div>';

  if (!invoices.length){
    h += '<div class="empty"><strong style="color:var(--ink)">台账是空的</strong><span>上传几张发票试试，或者先加载示例数据看看审核效果。</span><button class="btn" type="button" data-act="samples">加载示例发票</button></div>';
  } else if (!list.length){
    h += '<div class="empty">没有符合条件的发票</div>';
  } else {
    h += '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>风险</th><th>发票号码</th><th>开票日期</th><th>报销人</th><th>销售方</th><th>类别</th><th class="num">价税合计</th><th>审核发现</th></tr></thead><tbody>';
    list.forEach(function(i){
      var au = A[i.id], issue;
      if (i.status === 'recognizing') issue = '<span class="muted">' + esc(i.file) + (i.stage ? ' · ' + esc(i.stage) : '') + '</span>';
      else if (i.status === 'error') issue = (i.errCode === 'no_ai' ? '未设置 AI 识别，点开对照原件补录，或设置 AI 后重新识别' : esc(i.err)) + ' <span class="muted">· ' + esc(i.file) + '</span>';
      else { var bad = au.checks.filter(function(c){ return c.k === 'fail' || c.k === 'warn'; }); issue = bad.length ? esc(bad.map(function(c){ return c.title; }).join('；')) : '<span class="muted">—</span>'; }
      h += '<tr data-open="' + i.id + '" tabindex="0" aria-label="查看 ' + esc(i.f.seller || i.file) + '">' +
        '<td>' + chip(i, au) + (i.decision ? '<span class="decision">' + DEC[i.decision] + '</span>' : '') + '</td>' +
        '<td class="mono nowrap" style="font-size:12px">' + esc(i.f.no || '—') + (i.source === 'sample' ? ' <span class="chip sample">示例</span>' : '') + '</td>' +
        '<td class="mono nowrap" style="font-size:12px">' + esc(i.f.date || '—') + '</td>' +
        '<td class="nowrap"' + (i.sender ? ' title="' + esc(i.sender) + '"' : '') + '>' + (personLabel(i) ? esc(personLabel(i)) + (i.sender && !employeeOf(i) ? ' <span class="muted" style="font-size:11px">未登记</span>' : '') : '<span class="muted">—</span>') + '</td>' +
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
  h += '<p class="note">' + (inv.source === 'sample' ? '这是示例数据。' : inv.source === 'manual' ? '手动录入。' : '来源文件：' + esc(inv.file) + '。') + (inv.voucher ? ' 已生成凭证 ' + esc(inv.voucher.display) + '。' : '') + (inv.sender ? ' 来自邮件：' + esc(inv.senderName ? inv.senderName + ' <' + inv.sender + '>' : inv.sender) + (inv.mail && inv.mail.subject ? '「' + esc(inv.mail.subject) + '」' : '') + (inv.mail && inv.mail.date ? ' ' + esc(fmtDateTime(inv.mail.date)) : '') + '。' : '') + (inv.method && METHOD[inv.method] ? ' 识别方式：' + METHOD[inv.method] + '。' : '') + (inv.conf != null ? ' 置信度 ' + Math.round(inv.conf*100) + '%。' : '') + (inv.qr ? ' 二维码：已读取' + (inv.qr.mismatch && inv.qr.mismatch.length ? '，' + esc(inv.qr.mismatch.join('、')) + '已按二维码修正' : '，号码和日期一致') + '。' : '') + (inv.aiNotes ? ' 识别备注：' + esc(inv.aiNotes) : '') + '</p></section>';

  h += '<div class="rv-right">';
  if (inv.status === 'error') h += '<div class="errbox" role="alert">' + esc(inv.err) + '</div>';
  if (inv.status === 'recognizing') h += '<div class="progress"><span class="spin"></span>正在识别 ' + esc(inv.file) + '…</div>';
  h += '<section class="card pad stack" aria-label="审核结果" id="rv-checks">' + checksHtml(inv, au) + '</section>';
  h += '<section class="card pad stack" aria-label="识别字段"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap"><h2 class="h">识别字段</h2><span class="sub">改错后自动重新审核</span></div><div class="fgrid" id="rv-fields">' + fieldsHtml(inv, au) + '</div>' +
    (fileMap[inv.id] ? '<div class="actions"><button class="btn sm" type="button" data-act="retry" data-id="' + inv.id + '"' + (inv.status === 'recognizing' ? ' disabled' : '') + '>重新识别</button>' +
      (aiState === 'on' && inv.method !== 'ai' ? '<button class="btn sm" type="button" data-act="retry-ai" data-id="' + inv.id + '"' + (inv.status === 'recognizing' ? ' disabled' : '') + '>用 AI 重新识别</button>' : '') +
      (aiState !== 'on' && inv.method === 'ocr' ? '<a class="btn sm" href="#ai">开启 AI 识别更准</a>' : '') + '</div>' : '') + '</section>';
  var curEmp = employeeOf(inv);
  h += '<section class="card pad stack" aria-label="复核处理">' +
    '<label class="fld" for="rv-emp">报销人<select id="rv-emp" data-id="' + inv.id + '"><option value="">' + (inv.sender ? '未登记（' + esc(inv.sender) + '）' : '未指定') + '</option>' +
      emps().slice().sort(function(a, b){ return byName(a.name, b.name); }).map(function(e){ return '<option value="' + e.id + '"' + (curEmp && curEmp.id === e.id ? ' selected' : '') + '>' + esc(e.name + (e.dept ? '（' + e.dept + '）' : '')) + '</option>'; }).join('') + '</select></label>' +
    (inv.sender && !curEmp ? '<span class="sub">这个邮箱还没登记，可以在上面直接选员工，或者到 <a href="#staff">员工</a> 页把邮箱登记到员工名下。</span>' : '') +
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
  var I = {ok:'✓', warn:'▲', fail:'✕', skip:'–', info:'i'};
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

/* ---------- 员工（一个人可以有多个邮箱） ---------- */
function emps(){ if (!cfg.employees) cfg.employees = []; return cfg.employees; }
function empById(id){ return emps().filter(function(e){ return e.id === id; })[0] || null; }
function empByEmail(addr){ addr = String(addr || '').toLowerCase(); return addr ? emps().filter(function(e){ return (e.emails || []).indexOf(addr) >= 0; })[0] || null : null; }
function employeeOf(inv){ return (inv.employeeId && empById(inv.employeeId)) || (inv.sender ? empByEmail(inv.sender) : null); }
function personKey(inv){ var e = employeeOf(inv); return e ? 'emp:' + e.id : inv.sender ? 'mail:' + inv.sender : 'none'; }
function personLabel(inv){ var e = employeeOf(inv); return e ? e.name : (inv.sender ? senderLabel(inv) : ''); }
function byName(a, b){ return String(a).localeCompare(String(b), 'zh-CN'); }
// 按报销人分组：已登记员工 → 未登记的发件邮箱 → 手动上传未指定
function personGroups(list){
  var g = {};
  list.forEach(function(i){
    var k = personKey(i);
    if (!g[k]){
      var e = employeeOf(i);
      g[k] = {key:k, n:0, kind: e ? 0 : i.sender ? 1 : 2,
        label: e ? e.name : i.sender ? senderLabel(i) : '手动上传（未指定报销人）',
        sub: e ? (e.dept || '') : i.sender || ''};
    }
    g[k].n++;
  });
  return Object.keys(g).map(function(k){ return g[k]; }).sort(function(a, b){ return a.kind - b.kind || byName(a.label, b.label); });
}
function subDate(inv){ var d = inv.mail && inv.mail.date ? new Date(inv.mail.date) : new Date(inv.createdAt); return isNaN(d) ? new Date(inv.createdAt) : d; }
function dayOf(d){ return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2); }

var staffUi = {editId:null, draft:null, error:'', confirmDel:null};
function staffDraft(){ return staffUi.draft || {name:'', dept:'', emails:''}; }
function viewStaff(){
  var list = emps().slice().sort(function(a, b){ return byName(a.name, b.name); });
  var d = staffDraft(), editing = staffUi.editId ? empById(staffUi.editId) : null;
  var counts = {};
  invoices.forEach(function(i){ var e = employeeOf(i); if (e) counts[e.id] = (counts[e.id] || 0) + 1; });
  var h = '<div class="rl-head"><div class="stack" style="gap:4px"><h1>员工与邮箱</h1><span class="muted" style="font-size:13px">登记每个员工报销时会用的邮箱，一个人可以登记多个。收票时选员工，就会读取他所有邮箱发来的发票；台账、查询、导出也都按员工归类。</span></div></div>';
  h += '<div class="cols"><section class="card pad stack" style="flex:1 1 360px;min-width:0" aria-label="登记员工"><h2 class="h">' + (editing ? '修改：' + esc(editing.name) : '登记员工') + '</h2>' +
    '<label class="fld" for="st-name">姓名<input id="st-name" value="' + esc(d.name) + '" placeholder="例如 张三"></label>' +
    '<label class="fld" for="st-dept">部门（可不填）<input id="st-dept" value="' + esc(d.dept) + '" placeholder="例如 市场部"></label>' +
    '<label class="fld" for="st-emails">邮箱（可以填多个，每行一个或用逗号隔开）<textarea id="st-emails" rows="4" class="mono" placeholder="zhangsan@company.com&#10;12345678@qq.com">' + esc(d.emails) + '</textarea></label>' +
    (staffUi.error ? '<div class="errbox" role="alert">' + esc(staffUi.error) + '</div>' : '') +
    '<div class="actions"><button class="btn lg primary" type="button" data-act="st-save">' + (editing ? '保存修改' : '添加员工') + '</button>' + (editing || d.name || d.emails ? '<button class="btn lg" type="button" data-act="st-cancel">取消</button>' : '') + '</div></section>';
  h += '<section class="card" style="flex:999 1 560px;min-width:0" aria-label="员工列表"><div class="filters"><b>已登记 ' + list.length + ' 人</b></div>';
  if (!list.length) h += '<div class="empty">还没有登记员工。在左边填姓名和邮箱，点「添加员工」。</div>';
  else {
    h += '<div class="tbl-wrap"><table class="tbl" style="min-width:560px"><thead><tr><th>姓名</th><th>部门</th><th>邮箱</th><th class="num">发票</th><th></th></tr></thead><tbody>';
    list.forEach(function(e){
      h += '<tr><td class="nowrap"><b>' + esc(e.name) + '</b></td><td class="muted nowrap">' + esc(e.dept || '—') + '</td><td><div style="display:flex;gap:4px;flex-wrap:wrap">' +
        (e.emails || []).map(function(m){ return '<span class="chip idle mono" style="font-weight:400">' + esc(m) + '</span>'; }).join('') + '</div></td>' +
        '<td class="num mono">' + (counts[e.id] ? '<a href="#history" data-act="st-hist" data-id="' + e.id + '">' + counts[e.id] + ' 张</a>' : '0') + '</td><td class="nowrap" style="text-align:right">' +
        (staffUi.confirmDel === e.id ? '<button class="linkbtn" style="color:var(--block)" type="button" data-act="st-del-yes" data-id="' + e.id + '">确认删除</button> <button class="linkbtn muted" type="button" data-act="st-del-no">取消</button>'
          : '<button class="linkbtn" type="button" data-act="st-edit" data-id="' + e.id + '">修改</button> <button class="linkbtn muted" type="button" data-act="st-del" data-id="' + e.id + '">删除</button>') + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }
  h += '</section></div>';
  // 收到过、但还没登记的发件邮箱
  var unknown = {};
  invoices.forEach(function(i){ if (i.sender && !employeeOf(i)){ unknown[i.sender] = unknown[i.sender] || {name:i.senderName || '', n:0}; unknown[i.sender].n++; } });
  var uk = Object.keys(unknown).sort();
  if (uk.length){
    h += '<section class="card" aria-label="未登记的发件人"><div class="filters"><b>还没登记的发件人</b><span class="muted" style="font-size:12px">这些邮箱发来过发票，登记到员工名下后，发票会自动归到这个员工</span></div><div class="tbl-wrap"><table class="tbl" style="min-width:560px"><tbody>';
    uk.forEach(function(m){
      h += '<tr><td class="mono">' + esc(m) + '</td><td class="muted">' + esc(unknown[m].name) + '</td><td class="num mono">' + unknown[m].n + ' 张</td><td class="nowrap" style="text-align:right">' +
        '<button class="linkbtn" type="button" data-act="st-new-from" data-email="' + esc(m) + '" data-name="' + esc(unknown[m].name) + '">新建员工</button>' +
        (list.length ? ' <select class="inp" style="width:auto;height:30px;display:inline-block" aria-label="加到员工" data-addto="' + esc(m) + '"><option value="">加到已有员工…</option>' + list.map(function(e){ return '<option value="' + e.id + '">' + esc(e.name) + '</option>'; }).join('') + '</select>' : '') + '</td></tr>';
    });
    h += '</tbody></table></div></section>';
  }
  return h;
}
function staffSave(){
  var name = $('#st-name').value.trim(), dept = $('#st-dept').value.trim(), raw = $('#st-emails').value;
  var emails = parseSenders(raw);
  staffUi.draft = {name:name, dept:dept, emails:raw};
  if (!name){ staffUi.error = '请填写姓名'; render(); return; }
  var bad = String(raw).split(/[\s,，;；、]+/).filter(function(x){ return x.trim() && parseSenders(x).length === 0; });
  if (bad.length){ staffUi.error = '这些不是有效的邮箱：' + bad.join('、'); render(); return; }
  if (!emails.length){ staffUi.error = '请至少填一个邮箱'; render(); return; }
  var me = staffUi.editId;
  var dupName = emps().filter(function(e){ return e.id !== me && e.name === name; })[0];
  if (dupName){ staffUi.error = '已经有一个叫「' + name + '」的员工，同名的请加上部门或编号区分，比如「' + name + '（' + (dept || '市场部') + '）」'; render(); return; }
  for (var i = 0; i < emails.length; i++){
    var o = empByEmail(emails[i]);
    if (o && o.id !== me){ staffUi.error = emails[i] + ' 已经登记给「' + o.name + '」了，一个邮箱只能属于一个人'; render(); return; }
  }
  if (me){ var e = empById(me); e.name = name; e.dept = dept; e.emails = emails; toast('已保存「' + name + '」'); }
  else { emps().push({id:'e' + uid(), name:name, dept:dept, emails:emails, createdAt:Date.now()}); toast('已添加「' + name + '」，' + emails.length + ' 个邮箱'); }
  staffUi = {editId:null, draft:null, error:'', confirmDel:null};
  save(); render();
}
function staffAction(act, t){
  var id = t.getAttribute('data-id');
  if (act === 'st-save'){ staffSave(); return; }
  if (act === 'st-cancel'){ staffUi = {editId:null, draft:null, error:'', confirmDel:null}; render(); return; }
  if (act === 'st-edit'){ var e = empById(id); staffUi = {editId:id, draft:{name:e.name, dept:e.dept || '', emails:(e.emails || []).join('\n')}, error:'', confirmDel:null}; render(); window.scrollTo(0, 0); $('#st-name').focus(); return; }
  if (act === 'st-del'){ staffUi.confirmDel = id; render(); return; }
  if (act === 'st-del-no'){ staffUi.confirmDel = null; render(); return; }
  if (act === 'st-del-yes'){
    var ex = empById(id);
    cfg.employees = emps().filter(function(e){ return e.id !== id; });
    invoices.forEach(function(i){ if (i.employeeId === id) i.employeeId = null; });
    staffUi.confirmDel = null; save(); render(); toast('已删除「' + (ex ? ex.name : '') + '」，他的发票还在台账里');
    return;
  }
  if (act === 'st-new-from'){
    staffUi = {editId:null, draft:{name:t.getAttribute('data-name') || '', dept:'', emails:t.getAttribute('data-email')}, error:'', confirmDel:null};
    render(); window.scrollTo(0, 0); $('#st-name').focus(); return;
  }
  if (act === 'st-hist'){ var em = empById(id); histUi.who = em ? em.name : ''; return; }
}

/* ---------- 报销查询 ---------- */
var histUi = {who:'', from:'', to:'', dateType:'submit', status:'all'};
var HIST_STATUS = [['all','全部'],['ok','已通过（自动通过、人工通过）'],['todo','待处理'],['rejected','已驳回'],['returned','已退回补充说明']];
function histMatches(){
  var A = auditAll(), q = histUi.who.trim().toLowerCase();
  var list = invoices.filter(function(i){
    if (i.status === 'recognizing') return false;
    if (q){
      var e = employeeOf(i), hay = [personLabel(i), i.sender, e ? (e.emails || []).join(' ') : '', e ? e.dept : ''].join(' ').toLowerCase();
      if (personLabel(i).toLowerCase() !== q && hay.indexOf(q) < 0) return false;
    }
    var day = histUi.dateType === 'invoice' ? (i.f.date || '') : dayOf(subDate(i));
    if (histUi.from && (!day || day < histUi.from)) return false;
    if (histUi.to && (!day || day > histUi.to)) return false;
    if (histUi.status !== 'all'){
      var lv = i.status === 'ready' ? A[i.id].level : 'review';
      if (histUi.status === 'ok' && !(lv === 'pass' && !i.decision || i.decision === 'approved')) return false;
      if (histUi.status === 'todo' && !(lv !== 'pass' && !i.decision)) return false;
      if ((histUi.status === 'rejected' || histUi.status === 'returned') && i.decision !== histUi.status) return false;
    }
    return true;
  });
  list.sort(function(a, b){ return (histUi.dateType === 'invoice' ? String(b.f.date).localeCompare(String(a.f.date)) : 0) || subDate(b) - subDate(a); });
  return {A:A, list:list};
}
function statusChip(i, A){
  if (i.status !== 'ready') return '<span class="chip block">识别失败</span>';
  if (i.decision === 'approved') return '<span class="chip pass">人工通过</span>';
  if (i.decision === 'rejected') return '<span class="chip block">已驳回</span>';
  if (i.decision === 'returned') return '<span class="chip review">已退回</span>';
  var lv = A[i.id].level;
  return lv === 'pass' ? '<span class="chip pass">● 自动通过</span>' : '<span class="chip ' + lv + '">' + LV[lv].i + ' 待处理（' + LV[lv].t + '）</span>';
}
function histResults(){
  var R = histMatches(), A = R.A, list = R.list;
  if (!invoices.length) return '<div class="card"><div class="empty">台账里还没有发票</div></div>';
  var sum = 0, cnt = {ok:0, todo:0, no:0};
  list.forEach(function(i){
    sum += num(i.f.total) || 0;
    if (i.decision === 'approved' || i.status === 'ready' && A[i.id].level === 'pass' && !i.decision) cnt.ok++;
    else if (i.decision === 'rejected' || i.decision === 'returned') cnt.no++;
    else cnt.todo++;
  });
  var who = histUi.who.trim();
  var h = '<section class="card" aria-label="查询结果"><div class="filters" style="justify-content:space-between"><div><b>' + esc(who || '全部报销人') + '</b> <span class="muted">' + list.length + ' 张，价税合计 <span class="mono">' + fmt(r2(sum)) + '</span>' +
    (list.length ? '（通过 ' + cnt.ok + '，待处理 ' + cnt.todo + '，驳回或退回 ' + cnt.no + '）' : '') + '</span></div>' +
    (list.length ? '<button class="btn sm" type="button" data-act="hist-export">导出查询结果</button>' : '') + '</div>';
  if (!list.length) return h + '<div class="empty">没有符合条件的报销记录。可以放宽日期范围，或者检查姓名有没有写错。</div></section>';
  var groups = [], cur = null;
  list.forEach(function(i){
    var day = histUi.dateType === 'invoice' ? (i.f.date || '日期未识别') : dayOf(subDate(i));
    if (!cur || cur.day !== day){ cur = {day:day, items:[], sum:0}; groups.push(cur); }
    cur.items.push(i); cur.sum += num(i.f.total) || 0;
  });
  h += '<div class="tbl-wrap"><table class="tbl" style="min-width:900px"><thead><tr><th>' + (histUi.dateType === 'invoice' ? '开票日期' : '提交时间') + '</th><th>报销人</th><th>发票号码</th><th>销售方</th><th>项目</th><th class="num">价税合计</th><th>状态</th><th>来源</th></tr></thead><tbody>';
  groups.forEach(function(g){
    h += '<tr class="dayrow"><td colspan="8"><b class="mono">' + esc(g.day) + '</b> <span class="muted">' + g.items.length + ' 张 · ' + fmt(r2(g.sum)) + '</span></td></tr>';
    g.items.forEach(function(i){
      var d = subDate(i);
      h += '<tr data-open="' + i.id + '" tabindex="0"><td class="mono nowrap" style="font-size:12px">' + (histUi.dateType === 'invoice' ? esc(dayOf(d)) + ' 提交' : ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2)) + '</td>' +
        '<td class="nowrap">' + esc(personLabel(i) || '—') + '</td><td class="mono nowrap" style="font-size:12px">' + esc(i.f.no || '—') + '</td><td>' + esc(i.f.seller || '—') + '</td><td class="muted">' + esc(i.f.items || '') + '</td>' +
        '<td class="num mono">' + fmt(num(i.f.total)) + '</td><td>' + statusChip(i, A) + (i.memo ? '<span class="decision" style="white-space:normal">' + esc(i.memo) + '</span>' : '') + '</td>' +
        '<td class="muted" style="font-size:12px">' + esc(i.mail && i.mail.subject ? '邮件：' + i.mail.subject : i.file || (i.source === 'manual' ? '手动录入' : '')) + '</td></tr>';
    });
  });
  return h + '</tbody></table></div><div class="tbl-foot"><span>点一行查看发票和审核结果</span></div></section>';
}
function viewHistory(){
  var names = {};
  emps().forEach(function(e){ names[e.name] = e.dept || ''; });
  invoices.forEach(function(i){ var l = personLabel(i); if (l && !(l in names)) names[l] = i.sender || ''; });
  var h = '<div class="rl-head"><div class="stack" style="gap:4px"><h1>报销查询</h1><span class="muted" style="font-size:13px">输入或选择报销人，选日期范围，查看他在这段时间的全部报销记录。</span></div></div>';
  h += '<section class="card pad stack" aria-label="查询条件"><div class="hist-grid">' +
    '<label class="fld" for="hist-who">报销人<input id="hist-who" list="hist-names" autocomplete="off" value="' + esc(histUi.who) + '" placeholder="输入姓名或邮箱，留空查全部"><datalist id="hist-names">' +
      Object.keys(names).sort(byName).map(function(n){ return '<option value="' + esc(n) + '">' + esc(names[n]) + '</option>'; }).join('') + '</datalist></label>' +
    '<label class="fld" for="hist-type">按哪个日期<select id="hist-type"><option value="submit"' + (histUi.dateType === 'submit' ? ' selected' : '') + '>提交日期（收到邮件或上传的日期）</option><option value="invoice"' + (histUi.dateType === 'invoice' ? ' selected' : '') + '>开票日期</option></select></label>' +
    '<label class="fld" for="hist-from">从<input id="hist-from" type="date" value="' + esc(histUi.from) + '"></label>' +
    '<label class="fld" for="hist-to">到<input id="hist-to" type="date" value="' + esc(histUi.to) + '"></label>' +
    '<label class="fld" for="hist-status">状态<select id="hist-status">' + HIST_STATUS.map(function(o){ return '<option value="' + o[0] + '"' + (histUi.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    '</div><div class="actions" style="gap:6px"><span class="sub">快速选择：</span>' + [['today','今天'],['week','最近 7 天'],['month','本月'],['lastmonth','上个月'],['year','今年'],['any','不限日期']].map(function(o){ return '<button class="pill" type="button" data-act="hist-range" data-r="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></section>';
  return h + '<div id="hist-results">' + histResults() + '</div>';
}
function histRange(r){
  var t = new Date(); t.setHours(0,0,0,0);
  var from = new Date(t), to = new Date(t);
  if (r === 'week') from.setDate(t.getDate() - 6);
  else if (r === 'month') from.setDate(1);
  else if (r === 'lastmonth'){ from = new Date(t.getFullYear(), t.getMonth() - 1, 1); to = new Date(t.getFullYear(), t.getMonth(), 0); }
  else if (r === 'year') from = new Date(t.getFullYear(), 0, 1);
  histUi.from = r === 'any' ? '' : dayOf(from); histUi.to = r === 'any' ? '' : dayOf(to);
  render();
}
function histRefresh(){ var el = $('#hist-results'); if (el) el.innerHTML = histResults(); }

/* ---------- 邮箱收票 ---------- */
var mailInfo = null;
var mailUi = {empSel:{}, scanLabel:'', editing:false, draft:null, passDraft:'', status:null, testing:false, senders:'', days:'30', scanning:false, progress:'', result:null, sel:{}, error:'', importing:false};
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
  var recent = (cfg.recentSenders || []).filter(function(m){ return !empByEmail(m); }).slice(0, 12);
  h += '<section class="card pad stack" aria-label="检查邮件"><div class="fgrid">' +
    (function(){
      var E = emps().slice().sort(function(a, b){ return byName(a.name, b.name); });
      var allOn = E.length && E.every(function(e){ return mailUi.empSel[e.id]; });
      return '<div class="wide stack" style="gap:8px"><span class="sub">选择员工（会读取他登记的所有邮箱）</span>' +
        (E.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="pill emp' + (allOn ? ' on' : '') + '" data-act="mail-allemps" aria-pressed="' + !!allOn + '">全部员工</button>' +
          E.map(function(e){ return '<button type="button" class="pill emp' + (mailUi.empSel[e.id] ? ' on' : '') + '" data-act="mail-emp" data-id="' + e.id + '" aria-pressed="' + !!mailUi.empSel[e.id] + '">' + esc(e.name) + ' <span class="muted" style="font-size:12px">' + (e.emails || []).length + ' 个邮箱</span></button>'; }).join('') + '</div>'
          : '<span class="muted" style="font-size:13px">还没有登记员工。<a href="#staff">到员工页登记</a>后，这里点名字就能收他所有邮箱的发票；也可以直接在下面填邮箱。</span>') + '</div>';
    })() +
    '<label class="fld wide" for="mail-senders">' + (emps().length ? '其他邮箱（可不填）' : '发件人邮箱') + '<input id="mail-senders" class="mono" autocomplete="off" value="' + esc(mailUi.senders) + '" placeholder="例如 zhangsan@company.com，可以填几个，用逗号隔开"></label>' +
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
    h += '<section class="card" aria-label="邮件清单"><div class="filters" style="justify-content:space-between"><div><b>' + esc(mailUi.scanLabel || R.senders.join('、')) + '</b> <span class="muted">最近 ' + R.days + ' 天：' + R.messages.length + ' 封邮件，' + nFiles + ' 个发票文件' + (nSeen ? '（' + nSeen + ' 个已导入过）' : '') + '</span></div>' +
      (nFiles ? '<div class="actions"><button class="linkbtn" type="button" data-act="mail-all">全选</button><button class="linkbtn muted" type="button" data-act="mail-none">全不选</button></div>' : '') + '</div>';
    if (!R.messages.length) h += '<div class="empty">没有找到这些发件人在最近 ' + R.days + ' 天发来的邮件。可以换个时间范围，或者确认发件人邮箱有没有写错。</div>';
    R.messages.forEach(function(m){
      var me = empByEmail(m.from);
      h += '<div class="mailmsg"><div class="mailhead"><span><b>' + esc(me ? me.name : (m.fromName || m.from)) + '</b> <span class="muted mono" style="font-size:12px">' + esc(m.from) + '</span></span><span class="muted mono" style="font-size:12px">' + esc(fmtDateTime(m.date)) + '</span></div>' +
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
    var manual = parseSenders(mailUi.senders), senders = [], names = [];
    emps().forEach(function(e){ if (mailUi.empSel[e.id]){ names.push(e.name); (e.emails || []).forEach(function(m){ if (senders.indexOf(m) < 0) senders.push(m); }); } });
    manual.forEach(function(m){ if (senders.indexOf(m) < 0) senders.push(m); });
    if (!senders.length){ mailUi.error = emps().length ? '请选择员工，或者填写发件人邮箱' : '请填写发件人邮箱，例如 zhangsan@company.com'; render(); return true; }
    mailUi.scanLabel = names.concat(manual.filter(function(m){ return !empByEmail(m); })).join('、');
    mailUi.days = ($('#mail-days') || {}).value || mailUi.days;
    mailUi.scanning = true; mailUi.error = ''; mailUi.progress = '正在连接邮箱'; mailUi.result = null; mailUi.sel = {}; render();
    window.api.mailScan({senders:senders, days:Number(mailUi.days)}).then(function(r){
      if (!r || !r.ok){ mailUi.error = (r && r.message) || '检查邮件失败'; return; }
      mailUi.result = r.data;
      r.data.messages.forEach(function(m){ m.files.forEach(function(f){ if (!f.seen) mailUi.sel[f.id] = true; }); });
      cfg.recentSenders = manual.concat((cfg.recentSenders || []).filter(function(s){ return manual.indexOf(s) < 0; })).slice(0, 12);
      save();
    }).then(function(){ mailUi.scanning = false; render(); });
    return true;
  }
  if (act === 'mail-emp'){ var eid = t.getAttribute('data-id'); if (mailUi.empSel[eid]) delete mailUi.empSel[eid]; else mailUi.empSel[eid] = true; render(); return true; }
  if (act === 'mail-allemps'){ var E = emps(), on = E.length && E.every(function(e){ return mailUi.empSel[e.id]; }); mailUi.empSel = {}; if (!on) E.forEach(function(e){ mailUi.empSel[e.id] = true; }); render(); return true; }
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
        var xe = empByEmail(x.from);
        metas.push({sender:x.from, senderName:x.fromName, employeeId: xe ? xe.id : null, mail:{subject:x.subject, date:x.date}});
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

/* ---------- 凭证：科目、分录规则、生成与审核 ---------- */
// 科目编码按新会计准则常用编码（4-2-2），演示用，可在「科目与规则」里改或从 Excel 导入
var DEFAULT_ACCOUNTS = [
  ['1001','库存现金',''],['1002','银行存款',''],
  ['2221','应交税费',''],['222101','应交增值税',''],['22210101','进项税额',''],
  ['2241','其他应付款',''],['224101','员工往来','person'],
  ['6601','销售费用',''],['660101','办公费','dept'],['660102','差旅费','dept'],['660103','交通费','dept'],['660104','业务招待费','dept'],['660199','其他','dept'],
  ['6602','管理费用',''],['660201','办公费','dept'],['660202','差旅费','dept'],['660203','交通费','dept'],['660204','业务招待费','dept'],['660299','其他','dept']
];
function defaultAcct(){
  return {
    accounts: DEFAULT_ACCOUNTS.map(function(a){ return {code:a[0], name:a[1], aux:a[2]}; }),
    rules: [{id:'r1', cat:'餐饮', code:'660204'}, {id:'r2', cat:'住宿', code:'660202'}, {id:'r3', cat:'交通', code:'660203'}, {id:'r4', cat:'办公用品', code:'660201'}, {id:'r5', cat:'其他', code:'660299'},
      {id:'r6', dept:'市场部', cat:'餐饮', code:'660104'}, {id:'r7', dept:'市场部', cat:'交通', code:'660103'}, {id:'r8', dept:'市场部', cat:'住宿', code:'660102'}],
    creditCode:'224101', taxCode:'22210101', dedSpecial:true, dedTravel:true
  };
}
function acct(){ if (!cfg.acct || !cfg.acct.accounts) cfg.acct = defaultAcct(); return cfg.acct; }
var vouchers = [];
function accByCode(code){ code = String(code || '').trim(); return acct().accounts.filter(function(a){ return a.code === code; })[0] || null; }
function isLeaf(code){ return !acct().accounts.some(function(a){ return a.code !== code && a.code.indexOf(code) === 0; }); }
function fullName(code){
  var a = accByCode(code); if (!a) return '';
  var parts = acct().accounts.filter(function(x){ return code.indexOf(x.code) === 0 && x.code !== code; }).sort(function(x, y){ return x.code.length - y.code.length; }).map(function(x){ return x.name; });
  return parts.concat([a.name]).join('-');
}
function matchRule(inv){
  var e = employeeOf(inv), dept = e && e.dept || '', cat = inv.f.cat, seller = normName(inv.f.seller), best = null, bs = -1;
  acct().rules.forEach(function(r){
    if (!r.seller && !r.dept && !r.cat) return;
    if (r.seller && normName(r.seller) !== seller) return;
    if (r.dept && r.dept !== dept) return;
    if (r.cat && r.cat !== cat) return;
    var sc = (r.seller ? 4 : 0) + (r.dept ? 2 : 0) + (r.cat ? 1 : 0);
    if (sc >= bs){ bs = sc; best = r; }
  });
  return best;
}
function ruleText(r){ return r ? [r.seller ? '销售方「' + r.seller + '」' : '', r.dept ? '部门「' + r.dept + '」' : '', r.cat ? '类别「' + r.cat + '」' : ''].filter(Boolean).join(' + ') : '没有匹配的规则'; }
var NO_DED_RE = /餐饮服务|娱乐服务|居民日常服务/;
// 专票里不得抵扣的项目（财税〔2016〕36 号：餐饮、娱乐、居民日常服务）
function noDedReason(inv){ var f = inv.f, s = (f.items || '') + ' ' + (f.lines || []).map(function(l){ return (l && l.name) || ''; }).join(' '), m = s.match(NO_DED_RE); return m ? m[0] : f.cat === '餐饮' ? '餐饮服务' : ''; }
function isTravel(inv){ return /铁路|航空|客票|行程单/.test(inv.f.type || ''); }
function isDeductible(inv){ var t = inv.f.type || '', A = acct(); if (A.dedSpecial && /专用/.test(t)) return !noDedReason(inv); return !!(A.dedTravel && isTravel(inv)); }
// 可抵扣税额：票面有税额用票面；旅客运输票据没列税额的按 价税合计 ÷ (1+9%) × 9% 计算
function dedTax(inv){ var f = inv.f, t = num(f.tax), T = num(f.total); if (t > 0) return r2(t); if (isTravel(inv) && T > 0) return r2(T / 1.09 * 0.09); return 0; }
function consecutive(a, b){ try { var d = BigInt(a) - BigInt(b); return d !== 0n && d <= 3n && d >= -3n; } catch (e) { return false; } }
function eligibleFor(inv, A){ return inv.status === 'ready' && ((A[inv.id] && A[inv.id].level === 'pass' && !inv.decision) || inv.decision === 'approved'); }
function genLines(invs){
  var lines = [], total = 0, e0 = employeeOf(invs[0]);
  invs.forEach(function(inv){
    var f = inv.f, T = num(f.total) || 0, A = num(f.amount), t = num(f.tax) || 0, e = employeeOf(inv), r = matchRule(inv);
    var tx = isDeductible(inv) ? dedTax(inv) : 0, ded = tx > 0, nd = /专用/.test(f.type || '') && noDedReason(inv);
    var tail = f.no ? ' 发票' + String(f.no).slice(-8) : '';
    lines.push({dc:'D', code: r ? r.code : '', summary: (personLabel(inv) || '') + '报销' + (f.cat === '其他' ? '' : f.cat) + '费 ' + (f.seller || '') + tail, amount: r2(ded ? T - tx : T), dept: e && e.dept || '', person: '', invId: inv.id, kind: 'exp', rule: (r ? '规则：' + ruleText(r) : '没有匹配的规则') + (nd ? '；' + nd + '专票进项不得抵扣，全额计入费用' : '')});
    if (ded) lines.push({dc:'D', code: acct().taxCode, summary: '进项税额' + tail, amount: tx, dept: '', person: '', invId: inv.id, kind: 'tax', rule: '可抵扣：' + (/专用/.test(f.type) ? '专用发票' : '旅客运输票据' + (num(f.tax) > 0 ? '' : '，按 9% 计算'))});
    total += T;
  });
  var name = personLabel(invs[0]) || '未指定报销人';
  lines.push({dc:'C', code: acct().creditCode, summary: '应付' + name + '报销款（' + invs.length + ' 张发票）', amount: r2(total), dept: '', person: e0 ? e0.id : '', kind: 'credit', rule: '员工报销款'});
  return lines;
}
// 待确认的凭证：符合条件的发票按「报销人 + 提交日期」合并；手动改过的草稿会保留
function voucherState(){
  var A = auditAll(), used = {};
  vouchers.forEach(function(v){ if (v.status !== 'draft') v.invIds.forEach(function(id){ used[id] = v; }); });
  var groups = {}, order = [];
  invoices.forEach(function(i){
    if (used[i.id] || !eligibleFor(i, A)) return;
    var k = personKey(i) + '|' + dayOf(subDate(i));
    if (!groups[k]){ groups[k] = []; order.push(k); }
    groups[k].push(i);
  });
  var drafts = order.map(function(k){
    var invs = groups[k].sort(function(a, b){ return a.createdAt - b.createdAt; }), ids = invs.map(function(i){ return i.id; });
    var stored = vouchers.filter(function(v){ return v.status === 'draft' && v.key === k; })[0];
    var e = employeeOf(invs[0]);
    var base = {key:k, day:k.split('|')[1], invIds:ids, personLabel: personLabel(invs[0]) || '未指定报销人', dept: e && e.dept || '', empId: e ? e.id : ''};
    if (stored){ stored.stale = stored.invIds.slice().sort().join() !== ids.slice().sort().join(); return Object.assign(stored, {personLabel:base.personLabel, dept:base.dept, empId:base.empId}); }
    return Object.assign(base, {id:'v' + uid(), status:'draft', date:base.day, lines:genLines(invs), edited:false, log:[]});
  });
  // 发票已经不符合条件（被驳回、删除）的旧草稿清掉
  vouchers = vouchers.filter(function(v){ return v.status !== 'draft' || groups[v.key]; });
  return {drafts:drafts, confirmed:vouchers.filter(function(v){ return v.status === 'confirmed'; }), posted:vouchers.filter(function(v){ return v.status === 'posted'; })};
}
function validateV(v){
  var errs = [], d = 0, c = 0;
  v.lines.forEach(function(l, i){
    var a = accByCode(l.code), n = '第 ' + (i + 1) + ' 行';
    if (!l.code) errs.push(n + '没有科目');
    else if (!a) errs.push(n + '科目 ' + l.code + ' 不在科目表里');
    else if (!isLeaf(l.code)) errs.push(n + '「' + fullName(l.code) + '」不是末级科目');
    if (a && a.aux === 'dept' && !l.dept) errs.push(n + '「' + fullName(l.code) + '」需要部门（可以在「员工」页给报销人填部门）');
    if (a && a.aux === 'person' && !(l.person && empById(l.person))) errs.push(n + '「' + fullName(l.code) + '」需要个人（请先给发票指定报销人）');
    if (!(num(l.amount) > 0)) errs.push(n + '金额要大于 0');
    if (l.dc === 'D') d += num(l.amount) || 0; else c += num(l.amount) || 0;
  });
  if (!v.lines.length) errs.push('没有分录');
  if (Math.abs(r2(d) - r2(c)) > 0.001) errs.push('借贷不平衡：借方 ' + fmtN(r2(d)) + '，贷方 ' + fmtN(r2(c)) + '，相差 ' + fmtN(Math.abs(r2(d - c))));
  var invTotal = r2(v.invIds.reduce(function(s, id){ var i = findInv(id); return s + (i ? num(i.f.total) || 0 : 0); }, 0));
  var warns = [];
  if (Math.abs(r2(c) - invTotal) > 0.001) warns.push('贷方合计 ' + fmtN(r2(c)) + ' 和发票价税合计 ' + fmtN(invTotal) + ' 不一样，请确认是有意调整');
  if (v.stale) warns.push('这张凭证改过以后，发票有了变化（新增或撤下了发票），建议点「按规则重新生成」');
  return {errs:errs, warns:warns, d:r2(d), c:r2(c)};
}
function storeDraft(v){
  if (vouchers.indexOf(v) < 0) vouchers.push(v);
  v.edited = true;
  return v;
}
function vlog(v, text){ (v.log = v.log || []).push({at:new Date().toISOString(), text:text}); }

/* ---------- 凭证页 ---------- */
var vUi = {u8:null, u8Status:null, u8Testing:false, posting:{}, viewer:null, learn:null, acctMsg:''};
function loadU8(){ return window.api.u8Get().then(function(r){ if (r && r.ok) vUi.u8 = r.data; }); }
function u8Badge(){
  var c = vUi.u8 || {mode:'demo'};
  return c.mode === 'openapi' ? '<span class="chip review">正式环境：用友 U8 开放平台 · 账套 ' + esc(c.account || '') + '</span>' : '<span class="chip idle">演示环境（模拟用友 U8）· 账套 ' + esc(c.account || '001') + '</span>';
}
function vTab(cur){
  var S = voucherState();
  var tabs = [['voucher','待确认', S.drafts.length], ['voucher-done','已确认 / 已生成', S.confirmed.length + S.posted.length], ['voucher-rules','科目与规则', ''], ['voucher-u8','U8 连接', '']];
  return '<div class="rl-head"><div class="stack" style="gap:4px"><h1>凭证</h1><span class="muted" style="font-size:13px">审核通过的发票按「报销人 + 提交日期」合并成一张凭证，软件按规则做好分录，人工确认后生成到用友 U8。</span></div><div class="grow" style="margin-left:auto">' + u8Badge() + '</div></div>' +
    '<nav class="nav" aria-label="凭证" style="margin-bottom:4px">' + tabs.map(function(t){ return '<a href="#' + t[0] + '" class="' + (cur === t[0] ? 'on' : '') + '">' + t[1] + (t[2] !== '' ? ' <span class="mono">' + t[2] + '</span>' : '') + '</a>'; }).join('') + '</nav>';
}
function lineRow(v, l, i, editable){
  var a = accByCode(l.code), E = emps();
  if (!editable){
    return '<tr><td>' + (l.dc === 'D' ? '借' : '贷') + '</td><td><span class="mono">' + esc(l.code) + '</span> ' + esc(fullName(l.code)) + '</td><td>' + esc(l.summary) + '</td><td>' + esc(l.dept || '') + '</td><td>' + esc(l.person && empById(l.person) ? empById(l.person).name : '') + '</td><td class="num mono">' + (l.dc === 'D' ? fmtN(num(l.amount)) : '') + '</td><td class="num mono">' + (l.dc === 'C' ? fmtN(num(l.amount)) : '') + '</td></tr>';
  }
  var k = ' data-v="' + v.key + '" data-i="' + i + '"';
  return '<tr class="vline">' +
    '<td><select class="inp vl" data-vf="dc"' + k + ' aria-label="借贷" style="width:56px"><option value="D"' + (l.dc === 'D' ? ' selected' : '') + '>借</option><option value="C"' + (l.dc === 'C' ? ' selected' : '') + '>贷</option></select></td>' +
    '<td style="min-width:220px"><input class="inp mono vl" data-vf="code"' + k + ' list="acct-list" value="' + esc(l.code) + '" aria-label="科目编码"><div class="sub" style="margin-top:2px">' + (a ? esc(fullName(l.code)) : '<span style="color:var(--block)">请选择科目</span>') + '</div></td>' +
    '<td style="min-width:220px"><input class="inp vl" data-vf="summary"' + k + ' value="' + esc(l.summary) + '" aria-label="摘要"></td>' +
    '<td><input class="inp vl" data-vf="dept"' + k + ' list="dept-list" value="' + esc(l.dept || '') + '" aria-label="部门" style="width:96px"' + (a && a.aux === 'dept' ? '' : ' placeholder="—"') + '></td>' +
    '<td><select class="inp vl" data-vf="person"' + k + ' aria-label="个人" style="width:96px"><option value="">—</option>' + E.map(function(e){ return '<option value="' + e.id + '"' + (l.person === e.id ? ' selected' : '') + '>' + esc(e.name) + '</option>'; }).join('') + '</select></td>' +
    '<td><input class="inp mono vl" data-vf="amount"' + k + ' inputmode="decimal" value="' + (num(l.amount) == null ? '' : num(l.amount).toFixed(2)) + '" aria-label="金额" style="width:110px;text-align:right"></td>' +
    '<td class="muted" style="font-size:12px;min-width:120px">' + esc(l.rule || '手动添加') + '</td>' +
    '<td><button class="linkbtn muted" type="button" data-act="vl-del"' + k + ' aria-label="删除这一行">删除</button></td></tr>';
}
function voucherCard(v, editable){
  var chk = validateV(v), invs = v.invIds.map(findInv).filter(Boolean);
  var h = '<section class="card" aria-label="凭证 ' + esc(v.personLabel || '') + '"><div class="filters" style="justify-content:space-between">' +
    '<div><b>' + esc(v.personLabel || '') + '</b>' + (v.dept ? ' <span class="muted">' + esc(v.dept) + '</span>' : '') + ' <span class="muted">· 提交日期 ' + esc(v.day || v.date) + ' · ' + invs.length + ' 张发票 · 合计 <span class="mono">' + fmt(chk.c) + '</span></span>' +
    (v.edited && v.status === 'draft' ? ' <span class="chip review">已手动修改</span>' : '') + (v.status === 'posted' ? ' <span class="chip pass">已生成 ' + esc(v.u8 && v.u8.display || '') + '</span>' : v.status === 'confirmed' ? ' <span class="chip idle">已确认，待生成</span>' : '') + '</div>' +
    '<label class="fld" for="vd-' + v.key + '" style="flex-direction:row;align-items:center;gap:6px">凭证日期<input type="date" class="inp vdate" id="vd-' + v.key + '" data-v="' + v.key + '" value="' + esc(v.date) + '"' + (editable ? '' : ' disabled') + ' style="width:auto"></label></div>';
  h += '<div class="tbl-wrap"><table class="tbl vtbl" style="min-width:' + (editable ? 1100 : 820) + 'px"><thead><tr><th>借/贷</th><th>科目</th><th>摘要</th><th>部门</th><th>个人</th>' + (editable ? '<th>金额</th><th>依据</th><th></th>' : '<th class="num">借方</th><th class="num">贷方</th>') + '</tr></thead><tbody>' +
    v.lines.map(function(l, i){ return lineRow(v, l, i, editable); }).join('') + '</tbody></table></div>';
  h += '<div class="pad stack" style="padding-top:10px"><div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:13px"><span>借方合计 <b class="mono">' + fmtN(chk.d) + '</b></span><span>贷方合计 <b class="mono">' + fmtN(chk.c) + '</b></span>' +
    (chk.errs.length ? '<span class="status-bad">✕ 有 ' + chk.errs.length + ' 个问题，改好才能确认</span>' : '<span class="status-ok">✓ 借贷平衡、科目和辅助核算齐全</span>') + '</div>';
  if (chk.errs.length) h += '<ul class="errlist">' + chk.errs.map(function(e){ return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
  if (chk.warns.length) h += '<ul class="warnlist">' + chk.warns.map(function(e){ return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
  h += '<div class="sub">发票：' + invs.map(function(i){ return '<a href="#review-' + i.id + '">' + esc((i.f.no || i.file || '').slice(-8)) + ' ' + esc(i.f.seller || '') + ' ' + fmt(num(i.f.total)) + '</a>'; }).join('，') + '</div>';
  if (v.status === 'posted' && v.u8) h += '<div class="sub">已传入 U8：' + esc(v.u8.display) + '（' + esc(v.u8.period || '') + '，状态 ' + esc(v.u8.status || '') + '）· ' + esc(fmtDateTime(v.postedAt)) + '</div>';
  if (v.lastError) h += '<div class="errbox">' + esc(v.lastError) + '</div>';
  h += '<div class="actions">';
  if (editable){
    h += '<button class="btn sm" type="button" data-act="vl-add" data-v="' + v.key + '">加一行</button>';
    if (v.edited) h += '<button class="btn sm" type="button" data-act="v-reset" data-v="' + v.key + '">按规则重新生成</button>';
    h += '<button class="btn lg primary grow" type="button" data-act="v-confirm" data-v="' + v.key + '"' + (chk.errs.length ? ' disabled' : '') + '>确认分录</button>';
  } else if (v.status === 'confirmed'){
    h += '<button class="btn sm" type="button" data-act="v-unconfirm" data-v="' + v.key + '">撤回确认</button>' +
      '<button class="btn lg primary grow" type="button" data-act="v-post" data-v="' + v.key + '"' + (vUi.posting[v.key] ? ' disabled' : '') + '>' + (vUi.posting[v.key] ? '<span class="spin"></span>正在生成…' : '生成凭证到 U8') + '</button>';
  } else if (v.status === 'posted'){
    h += '<button class="btn sm grow" type="button" data-act="v-view" data-v="' + v.key + '">查看凭证</button>';
  }
  return h + '</div></div></section>';
}
function datalists(){
  var depts = {};
  emps().forEach(function(e){ if (e.dept) depts[e.dept] = 1; });
  acct().rules.forEach(function(r){ if (r.dept) depts[r.dept] = 1; });
  return '<datalist id="acct-list">' + acct().accounts.filter(function(a){ return isLeaf(a.code); }).map(function(a){ return '<option value="' + esc(a.code) + '">' + esc(fullName(a.code)) + '</option>'; }).join('') + '</datalist>' +
    '<datalist id="dept-list">' + Object.keys(depts).map(function(d){ return '<option value="' + esc(d) + '"></option>'; }).join('') + '</datalist>';
}
function viewVoucher(tab){
  var S = voucherState(), h = vTab(tab) + datalists();
  if (tab === 'voucher-rules') return h + viewAcctRules();
  if (tab === 'voucher-u8') return h + viewU8();
  if (tab === 'voucher-done'){
    if (!S.confirmed.length && !S.posted.length) return h + '<div class="card"><div class="empty">还没有确认的凭证。在「待确认」里核对分录后点「确认分录」。</div></div>';
    if (S.confirmed.length) h += '<div class="actions"><b>已确认、待生成 ' + S.confirmed.length + ' 张</b><button class="btn primary grow" type="button" data-act="v-post-all">全部生成到 U8</button></div>' + S.confirmed.map(function(v){ return voucherCard(v, false); }).join('');
    if (S.posted.length) h += '<div class="actions" style="margin-top:8px"><b>已生成 ' + S.posted.length + ' 张</b><button class="btn sm grow" type="button" data-act="v-export">导出凭证清单（Excel）</button></div>' + S.posted.slice().reverse().map(function(v){ return voucherCard(v, false); }).join('');
    return h;
  }
  if (!S.drafts.length) return h + '<div class="card"><div class="empty"><strong style="color:var(--ink)">没有待确认的分录</strong><span>只有审核通过（自动通过或人工通过）的发票才会生成分录。拦截和待复核的发票处理完以后会出现在这里。</span></div></div>';
  return h + '<p class="note">分录按「科目与规则」自动生成。改科目、金额、部门都可以，改完确认时可以选择把改法存成规则。</p>' + S.drafts.map(function(v){ return voucherCard(v, true); }).join('');
}

/* 科目与规则 */
function viewAcctRules(){
  var A = acct();
  var h = '<div class="cols"><section class="card pad stack" style="flex:1 1 520px;min-width:0" aria-label="分录规则"><div><h2 class="h">分录规则</h2><span class="sub">每张发票的费用记到哪个科目。条件越具体越优先：销售方 &gt; 部门 + 类别 &gt; 只按类别。</span></div>' +
    '<div class="tbl-wrap"><table class="rtbl" style="min-width:520px"><thead><tr><th>销售方</th><th>部门</th><th>类别</th><th>记到科目</th><th></th></tr></thead><tbody>' +
    A.rules.slice().sort(function(a, b){ return ((b.seller ? 4 : 0) + (b.dept ? 2 : 0) + (b.cat ? 1 : 0)) - ((a.seller ? 4 : 0) + (a.dept ? 2 : 0) + (a.cat ? 1 : 0)); }).map(function(r){
      return '<tr><td>' + esc(r.seller || '任意') + '</td><td>' + esc(r.dept || '任意') + '</td><td>' + esc(r.cat || '任意') + '</td><td><span class="mono">' + esc(r.code) + '</span> ' + esc(fullName(r.code) || '（科目表里没有）') + '</td><td style="text-align:right"><button class="linkbtn muted" type="button" data-act="ar-del" data-id="' + r.id + '">删除</button></td></tr>';
    }).join('') + '</tbody></table></div>' +
    '<div class="fgrid"><label class="fld" for="ar-seller">销售方（可不填）<input id="ar-seller" placeholder="例如 上海小南国餐饮有限公司"></label><label class="fld" for="ar-dept">部门（可不填）<input id="ar-dept" list="dept-list" placeholder="例如 市场部"></label>' +
    '<label class="fld" for="ar-cat">类别（可不填）<select id="ar-cat"><option value="">任意</option>' + CATS.map(function(c){ return '<option>' + c + '</option>'; }).join('') + '</select></label>' +
    '<label class="fld" for="ar-code">记到科目<input id="ar-code" class="mono" list="acct-list" placeholder="科目编码"></label></div>' +
    '<div class="actions"><button class="btn sm" type="button" data-act="ar-add">添加规则</button></div>' +
    '<h2 class="h" style="margin-top:8px">其他设置</h2><div class="fgrid">' +
    '<label class="fld" for="ar-credit">贷方（应付员工）科目<input id="ar-credit" class="mono acs" data-k="creditCode" list="acct-list" value="' + esc(A.creditCode) + '"></label>' +
    '<label class="fld" for="ar-tax">进项税科目<input id="ar-tax" class="mono acs" data-k="taxCode" list="acct-list" value="' + esc(A.taxCode) + '"></label>' +
    '<label class="fld wide" for="ar-ded1" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="ar-ded1" class="acs" data-k="dedSpecial"' + (A.dedSpecial ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:var(--accent)">专用发票的税额单独记进项税</label>' +
    '<label class="fld wide" for="ar-ded2" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="ar-ded2" class="acs" data-k="dedTravel"' + (A.dedTravel ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:var(--accent)">火车票、飞机行程单等旅客运输票据的税额记进项税</label>' +
    '</div><p class="note">其他发票（普通发票等）按价税合计全额记费用。具体科目和税务处理请以公司财务和税务口径为准。</p></section>';
  h += '<section class="card pad stack" style="flex:1 1 480px;min-width:0" aria-label="科目表"><div><h2 class="h">科目表</h2><span class="sub">只有末级科目能用在分录里。「辅助核算」决定这个科目要不要填部门或个人。</span></div>' +
    '<div class="actions"><button class="btn sm" type="button" data-act="ac-import">从 Excel 导入科目表</button><span class="sub">第一行是表头，需要有「科目编码」和「科目名称」两列，可选「辅助核算」列（填 部门 或 个人）</span></div>' +
    (vUi.acctMsg ? '<div class="status-ok">' + esc(vUi.acctMsg) + '</div>' : '') +
    '<div class="tbl-wrap" style="max-height:520px;overflow:auto"><table class="rtbl" style="min-width:440px"><thead><tr><th>编码</th><th>名称</th><th>辅助核算</th><th></th></tr></thead><tbody>' +
    A.accounts.slice().sort(function(a, b){ return a.code.localeCompare(b.code); }).map(function(a){
      var lv = (a.code.length - 4) / 2;
      return '<tr><td class="mono">' + esc(a.code) + '</td><td style="padding-left:' + (8 + Math.max(0, lv) * 16) + 'px">' + esc(a.name) + (isLeaf(a.code) ? '' : ' <span class="sub">（上级）</span>') + '</td>' +
        '<td><select class="inp acx" data-code="' + esc(a.code) + '" aria-label="辅助核算" style="width:auto;height:30px"><option value="">无</option><option value="dept"' + (a.aux === 'dept' ? ' selected' : '') + '>部门</option><option value="person"' + (a.aux === 'person' ? ' selected' : '') + '>个人</option></select></td>' +
        '<td style="text-align:right"><button class="linkbtn muted" type="button" data-act="ac-del" data-code="' + esc(a.code) + '">删除</button></td></tr>';
    }).join('') + '</tbody></table></div>' +
    '<div class="fgrid"><label class="fld" for="ac-code">科目编码<input id="ac-code" class="mono" placeholder="例如 660205"></label><label class="fld" for="ac-name">科目名称<input id="ac-name" placeholder="例如 会议费"></label>' +
    '<label class="fld" for="ac-aux">辅助核算<select id="ac-aux"><option value="">无</option><option value="dept">部门</option><option value="person">个人</option></select></label></div>' +
    '<div class="actions"><button class="btn sm" type="button" data-act="ac-add">添加科目</button><button class="linkbtn muted grow" type="button" data-act="ac-reset">恢复演示科目和规则</button></div></section></div>';
  return h;
}
/* U8 连接 */
function viewU8(){
  var c = vUi.u8 || {mode:'demo'};
  var f = function(id, label, val, ph, cls){ return '<label class="fld' + (cls || '') + '" for="u8-' + id + '">' + label + '<input id="u8-' + id + '" class="mono" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"></label>'; };
  var h = '<div class="cols"><section class="card pad stack" style="flex:999 1 520px;min-width:0" aria-label="U8 连接"><h2 class="h">连接用友 U8</h2>' +
    '<div class="fgrid"><label class="fld wide" for="u8-mode">连接方式<select id="u8-mode"><option value="demo"' + (c.mode !== 'openapi' ? ' selected' : '') + '>演示环境（软件内置模拟 U8，不连接真实 U8）</option><option value="openapi"' + (c.mode === 'openapi' ? ' selected' : '') + '>正式环境：用友 U8 开放平台（OpenAPI）</option></select></label>' +
    f('server', c.mode === 'openapi' ? '开放平台地址' : '服务器地址', c.server, c.mode === 'openapi' ? 'https://api.yonyouup.com' : 'http://u8-demo.local', ' wide') +
    f('account', '账套号', c.account, '001') + f('year', '会计年度', c.year, '2026') + f('operator', '制单人（操作员）', c.operator, '例如 demo') + f('word', '凭证类别', c.word, '记');
  if (c.mode === 'openapi'){
    h += f('fromAccount', '企业账号（from_account）', c.fromAccount, '') + f('toAccount', '目标账号（to_account）', c.toAccount, '') + f('appKey', 'AppKey', c.appKey, '') +
      '<label class="fld" for="u8-appSecret">AppSecret<input id="u8-appSecret" type="password" class="mono" placeholder="' + (c.hasSecret ? '已保存，不修改就留空' : '') + '"></label>';
  }
  h += '</div><div class="actions"><button class="btn lg primary" type="button" data-act="u8-test"' + (vUi.u8Testing ? ' disabled' : '') + '>' + (vUi.u8Testing ? '<span class="spin"></span>正在连接…' : '保存并测试连接') + '</button></div>';
  if (vUi.u8Status) h += '<div class="' + (vUi.u8Status.ok ? 'status-ok' : 'status-bad') + '" role="status">' + esc(vUi.u8Status.msg) + '</div>';
  h += '</section><aside class="col-side"><section class="card pad stack"><h2 class="h">说明</h2><div class="help">' +
    (c.mode === 'openapi' ? '<p>正式环境按用友 U8 开放平台的接口传凭证。需要客户的 IT 或用友服务商：</p><ol><li>开通 U8 开放平台（OpenAPI），提供 AppKey、AppSecret、企业账号</li><li>确认凭证类别、科目编码、部门和人员编码与这里一致</li><li>先在测试账套试传几张，核对无误再切到正式账套</li></ol><p>这部分没有在真实 U8 上联调过，第一次接入请预留联调时间。</p>'
      : '<p>演示环境：凭证传到软件内置的模拟 U8，保存在这台电脑上，会返回凭证号，也能打开查看。</p><p>演示时可以这样说明：「这是模拟用友 U8 的演示环境。接到真实 U8，需要开通 U8 开放平台接口，把地址和密钥填到这里，再用测试账套联调一次。」</p>') +
    '</div></section></aside></div>';
  return h;
}
function u8Form(){
  var g = function(k){ var e = $('#u8-' + k); return e ? e.value.trim() : undefined; };
  var o = {mode: g('mode')};
  ['server','account','year','operator','word','fromAccount','toAccount','appKey','appSecret'].forEach(function(k){ var v = g(k); if (v !== undefined) o[k] = v; });
  return o;
}

/* 凭证查看（模拟 U8 返回的凭证） */
function showVoucher(v){
  var d = 0, c = 0;
  v.lines.forEach(function(l){ if (l.dc === 'D') d += num(l.amount) || 0; else c += num(l.amount) || 0; });
  var bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'v-viewer';
  bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="vv-title" style="width:min(920px,100%)"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 id="vv-title">记账凭证</h2>' + u8Badge() + '</div>' +
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px"><span>' + esc(v.u8 ? v.u8.display.replace('-', ' 字 ') + ' 号' : '') + '</span><span>制单日期：' + esc(v.date) + '</span><span>附单据数：' + v.invIds.length + '</span></div>' +
    '<div class="tbl-wrap"><table class="tbl" style="min-width:760px"><thead><tr><th>摘要</th><th>科目名称</th><th>辅助项</th><th class="num">借方金额</th><th class="num">贷方金额</th></tr></thead><tbody>' +
    v.lines.map(function(l){ return '<tr style="cursor:default"><td>' + esc(l.summary) + '</td><td><span class="mono">' + esc(l.code) + '</span> ' + esc(fullName(l.code)) + '</td><td>' + esc([l.dept, l.person && empById(l.person) ? empById(l.person).name : ''].filter(Boolean).join(' / ')) + '</td><td class="num mono">' + (l.dc === 'D' ? fmtN(num(l.amount)) : '') + '</td><td class="num mono">' + (l.dc === 'C' ? fmtN(num(l.amount)) : '') + '</td></tr>'; }).join('') +
    '<tr style="cursor:default"><td colspan="3"><b>合计：' + rmbUpper(r2(d)) + '</b></td><td class="num mono"><b>' + fmtN(r2(d)) + '</b></td><td class="num mono"><b>' + fmtN(r2(c)) + '</b></td></tr></tbody></table></div>' +
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px" class="muted"><span>制单：' + esc((vUi.u8 && vUi.u8.operator) || '') + '</span><span>U8 状态：' + esc(v.u8 && v.u8.status || '') + '（需在 U8 里审核、记账）</span><span>传入时间：' + esc(fmtDateTime(v.postedAt)) + '</span></div>' +
    '<div class="actions"><button class="btn lg grow" type="button" data-act="vv-close">关闭</button></div></div>';
  document.body.appendChild(bg);
}

/* 确认时：把改过的科目存成规则 */
function learnCandidates(v){
  var out = [];
  v.lines.forEach(function(l, i){
    if (l.kind !== 'exp' || !l.invId) return;
    var inv = findInv(l.invId); if (!inv) return;
    var r = matchRule(inv), gen = r ? r.code : '';
    if (l.code && l.code !== gen) out.push({i:i, inv:inv, from:gen, to:l.code, dept:(employeeOf(inv) || {}).dept || ''});
  });
  return out;
}
function openLearn(v, cands){
  var bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'learn-modal';
  bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="lm-title" style="width:min(640px,100%)"><h2 id="lm-title">以后同类发票也这样记吗？</h2><p class="note">你改了下面这些发票的科目。可以把改法存成规则，以后同类发票自动这样记；只是这一张特殊的，选「只改这一张」。</p>' +
    cands.map(function(c, n){
      return '<div class="card pad stack" style="gap:6px"><div style="font-size:13px"><b>' + esc(c.inv.f.seller || '') + '</b> · ' + esc(c.inv.f.cat) + (c.dept ? ' · ' + esc(c.dept) : '') + '</div><div class="sub">' + esc(c.from ? c.from + ' ' + fullName(c.from) : '（原来没有科目）') + ' → <b>' + esc(c.to + ' ' + fullName(c.to)) + '</b></div>' +
        '<label class="fld" for="lm-' + n + '">存成规则<select id="lm-' + n + '"><option value="">只改这一张</option><option value="seller">以后销售方「' + esc(c.inv.f.seller || '') + '」的发票都这样记</option>' +
        (c.dept ? '<option value="dept">以后「' + esc(c.dept) + '」的「' + esc(c.inv.f.cat) + '」发票都这样记</option>' : '') + '<option value="cat">以后所有「' + esc(c.inv.f.cat) + '」发票都这样记</option></select></label></div>';
    }).join('') +
    '<div class="actions"><button class="btn lg" type="button" data-act="lm-cancel">取消</button><button class="btn lg primary grow" type="button" data-act="lm-ok" data-v="' + v.key + '">确认分录</button></div></div>';
  document.body.appendChild(bg);
  vUi.learn = {key:v.key, cands:cands};
}
function doConfirm(v){
  v.status = 'confirmed'; v.confirmedAt = new Date().toISOString(); v.stale = false;
  if (vouchers.indexOf(v) < 0) vouchers.push(v);
  vlog(v, '确认分录');
  save(); render(); toast('已确认「' + v.personLabel + '」的分录，可以生成凭证了');
}
function payload(v){
  return {
    externalId: v.id, date: v.date, word: (vUi.u8 && vUi.u8.word) || '记', maker: (vUi.u8 && vUi.u8.operator) || '', attachments: v.invIds.length,
    entries: v.lines.map(function(l){ var e = l.person ? empById(l.person) : null; return {summary:l.summary, code:l.code, name:fullName(l.code), debit: l.dc === 'D' ? r2(num(l.amount)) : 0, credit: l.dc === 'C' ? r2(num(l.amount)) : 0, dept:l.dept || '', person: e ? e.name : ''}; })
  };
}
function postVoucher(v){
  vUi.posting[v.key] = true; v.lastError = ''; render();
  return window.api.u8Post(payload(v)).then(function(r){
    delete vUi.posting[v.key];
    if (r && r.ok){
      v.status = 'posted'; v.u8 = r.data; v.postedAt = new Date().toISOString(); vlog(v, '生成凭证 ' + r.data.display);
      v.invIds.forEach(function(id){ var i = findInv(id); if (i) i.voucher = {key:v.key, display:r.data.display}; });
      toast('已生成凭证 ' + r.data.display);
    } else { v.lastError = '生成失败：' + ((r && r.message) || '未知错误'); }
    save(); render();
  });
}
function exportVouchers(){
  if (!window.XLSX) return;
  var S = voucherState(), rows = [['凭证日期','凭证字','凭证号','附单据数','摘要','科目编码','科目名称','借方金额','贷方金额','部门','个人','报销人','状态']];
  S.posted.forEach(function(v){ v.lines.forEach(function(l){ var e = l.person ? empById(l.person) : null; rows.push([v.date, v.u8 ? v.u8.word : '', v.u8 ? v.u8.no : '', v.invIds.length, l.summary, l.code, fullName(l.code), l.dc === 'D' ? r2(num(l.amount)) : '', l.dc === 'C' ? r2(num(l.amount)) : '', l.dept || '', e ? e.name : '', v.personLabel, '已生成']); }); });
  var XL = window.XLSX, wb = XL.utils.book_new(), ws = XL.utils.aoa_to_sheet(rows);
  ws['!cols'] = [12,6,8,8,40,12,28,12,12,10,10,10,8].map(function(w){ return {wch:w}; });
  XL.utils.book_append_sheet(wb, ws, '凭证清单');
  var d = new Date();
  window.api.saveFile('凭证清单_' + dayOf(d).replace(/-/g, '') + '.xlsx', new Uint8Array(XL.write(wb, {type:'array', bookType:'xlsx'}))).then(function(r){ if (r && r.ok && r.data.saved) toast('已导出 ' + (rows.length - 1) + ' 行分录'); });
}
function findDraft(key){ var S = voucherState(); return S.drafts.concat(S.confirmed, S.posted).filter(function(v){ return v.key === key; })[0]; }
function voucherAction(act, t){
  var key = t.getAttribute('data-v'), v = key ? findDraft(key) : null;
  if (act === 'vl-add' && v){ storeDraft(v).lines.push({dc:'D', code:'', summary:'', amount:null, dept:v.dept || '', person:'', kind:'manual', rule:'手动添加'}); vlog(v, '加一行'); save(); render(); return; }
  if (act === 'vl-del' && v){ var i = Number(t.getAttribute('data-i')); storeDraft(v); vlog(v, '删除第 ' + (i + 1) + ' 行：' + v.lines[i].code + ' ' + v.lines[i].amount); v.lines.splice(i, 1); save(); render(); return; }
  if (act === 'v-reset' && v){ vouchers = vouchers.filter(function(x){ return x !== v; }); save(); render(); toast('已按规则重新生成'); return; }
  if (act === 'v-confirm' && v){
    if (validateV(v).errs.length) return;
    var cands = learnCandidates(v);
    if (cands.length) openLearn(v, cands); else doConfirm(v);
    return;
  }
  if (act === 'lm-cancel'){ var m = $('#learn-modal'); if (m) m.remove(); vUi.learn = null; return; }
  if (act === 'lm-ok' && vUi.learn){
    var L = vUi.learn, vv = findDraft(L.key), saved = 0;
    L.cands.forEach(function(c, n){
      var how = ($('#lm-' + n) || {}).value;
      if (!how) return;
      var r = {id:'r' + uid(), code:c.to};
      if (how === 'seller') r.seller = c.inv.f.seller;
      if (how === 'dept'){ r.dept = c.dept; r.cat = c.inv.f.cat; }
      if (how === 'cat') r.cat = c.inv.f.cat;
      acct().rules = acct().rules.filter(function(x){ return !(x.seller === r.seller && x.dept === r.dept && x.cat === r.cat); });
      acct().rules.push(r); saved++;
    });
    var lm = $('#learn-modal'); if (lm) lm.remove(); vUi.learn = null;
    if (vv){ if (saved) vlog(vv, '存了 ' + saved + ' 条规则'); doConfirm(vv); }
    if (saved) toast('已保存 ' + saved + ' 条规则，以后同类发票会自动这样记');
    return;
  }
  if (act === 'v-unconfirm' && v){ v.status = 'draft'; v.edited = true; vlog(v, '撤回确认'); save(); render(); return; }
  if (act === 'v-post' && v){ postVoucher(v); return; }
  if (act === 'v-post-all'){
    var list = voucherState().confirmed;
    list.reduce(function(p, x){ return p.then(function(){ return postVoucher(x); }); }, Promise.resolve());
    return;
  }
  if (act === 'v-view' && v){ showVoucher(v); return; }
  if (act === 'vv-close'){ var vw = $('#v-viewer'); if (vw) vw.remove(); return; }
  if (act === 'v-export'){ exportVouchers(); return; }
  if (act === 'u8-test'){
    var form = u8Form();
    vUi.u8Testing = true; vUi.u8Status = null; render();
    window.api.u8Save(form).then(function(r){ if (r && r.ok) vUi.u8 = r.data; return window.api.u8Test(); }).then(function(r){
      vUi.u8Status = r && r.ok ? {ok:true, msg:r.data.msg} : {ok:false, msg:'连接失败：' + ((r && r.message) || '未知错误')};
    }).then(function(){ vUi.u8Testing = false; render(); });
    return;
  }
  var A = acct();
  if (act === 'ar-add'){
    var code = $('#ar-code').value.trim(), r = {id:'r' + uid(), seller:$('#ar-seller').value.trim(), dept:$('#ar-dept').value.trim(), cat:$('#ar-cat').value, code:code};
    if (!r.seller && !r.dept && !r.cat){ toast('至少填一个条件：销售方、部门或类别'); return; }
    if (!accByCode(code) || !isLeaf(code)){ toast('请选择科目表里的末级科目'); return; }
    ['seller','dept','cat'].forEach(function(k){ if (!r[k]) delete r[k]; });
    A.rules.push(r); save(); render(); toast('已添加规则'); return;
  }
  if (act === 'ar-del'){ A.rules = A.rules.filter(function(x){ return x.id !== t.getAttribute('data-id'); }); save(); render(); return; }
  if (act === 'ac-add'){
    var c2 = $('#ac-code').value.trim(), n2 = $('#ac-name').value.trim();
    if (!/^\d{4,}$/.test(c2) || !n2){ toast('请填写科目编码（数字）和名称'); return; }
    if (accByCode(c2)){ toast('科目 ' + c2 + ' 已经有了'); return; }
    A.accounts.push({code:c2, name:n2, aux:$('#ac-aux').value}); save(); render(); toast('已添加科目 ' + c2 + ' ' + n2); return;
  }
  if (act === 'ac-del'){ var dc = t.getAttribute('data-code'); A.accounts = A.accounts.filter(function(a){ return a.code !== dc; }); save(); render(); return; }
  if (act === 'ac-reset'){ cfg.acct = defaultAcct(); save(); render(); toast('已恢复演示科目和规则'); return; }
  if (act === 'ac-import'){ $('#acctFile').click(); return; }
}
function voucherChange(t){
  if (t.classList.contains('vl')){
    var v = findDraft(t.getAttribute('data-v')), i = Number(t.getAttribute('data-i')), f = t.getAttribute('data-vf');
    if (!v || !v.lines[i]) return true;
    storeDraft(v);
    var old = v.lines[i][f], val = t.value;
    if (f === 'amount') val = num(val);
    if (f === 'code') val = val.trim().split(/\s/)[0];
    v.lines[i][f] = val;
    vlog(v, '第 ' + (i + 1) + ' 行 ' + ({dc:'借贷', code:'科目', summary:'摘要', dept:'部门', person:'个人', amount:'金额'}[f]) + '：' + (old == null ? '' : old) + ' → ' + (val == null ? '' : val));
    save(); render(); return true;
  }
  if (t.classList.contains('vdate')){ var vd = findDraft(t.getAttribute('data-v')); if (vd && vd.status === 'draft'){ storeDraft(vd).date = t.value; vlog(vd, '凭证日期改为 ' + t.value); save(); } return true; }
  if (t.classList.contains('acx')){ var a = accByCode(t.getAttribute('data-code')); if (a){ a.aux = t.value; save(); render(); } return true; }
  if (t.classList.contains('acs')){ acct()[t.getAttribute('data-k')] = t.type === 'checkbox' ? t.checked : t.value.trim(); save(); render(); return true; }
  if (t.id === 'u8-mode'){ var form = u8Form(); window.api.u8Save(form).then(function(r){ if (r && r.ok) vUi.u8 = r.data; vUi.u8Status = null; render(); }); return true; }
  if (t.id === 'acctFile'){
    var file = t.files && t.files[0]; t.value = '';
    if (!file || !window.XLSX) return true;
    file.arrayBuffer().then(function(buf){
      var wb = window.XLSX.read(buf, {type:'array'}), rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:false});
      var head = (rows[0] || []).map(function(x){ return String(x || ''); });
      var ci = head.findIndex(function(x){ return /编码|代码/.test(x); }), ni = head.findIndex(function(x){ return /名称/.test(x); }), ai = head.findIndex(function(x){ return /辅助/.test(x); });
      if (ci < 0 || ni < 0){ toast('没找到「科目编码」和「科目名称」两列'); return; }
      var list = [];
      rows.slice(1).forEach(function(r){
        var c = String(r[ci] || '').trim(), n = String(r[ni] || '').trim().split(/[-－\\/]/).pop();
        if (!/^\d{4,}$/.test(c) || !n) return;
        var ax = ai >= 0 ? String(r[ai] || '') : '';
        list.push({code:c, name:n, aux: /部门/.test(ax) ? 'dept' : /个人|职员|人员/.test(ax) ? 'person' : ''});
      });
      if (!list.length){ toast('表里没有读到科目'); return; }
      acct().accounts = list; vUi.acctMsg = '已导入 ' + list.length + ' 个科目。请检查分录规则里的科目编码是否还存在。'; save(); render();
    });
    return true;
  }
  return false;
}

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
  else if (/^st-/.test(act)) staffAction(act, t);
  else if (/^(v|vl|vv|lm|ar|ac|u8)-/.test(act)) voucherAction(act, t);
  else if (act === 'hist-range') histRange(t.getAttribute('data-r'));
  else if (act === 'hist-export'){ var HR = histMatches(); exportList(HR.list, (histUi.who.trim() || '全部') + (histUi.from || histUi.to ? '_' + (histUi.from || '') + '至' + (histUi.to || '') : '')); }
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
  else if (act === 'reset-cfg'){ var keep = {employees:cfg.employees, acct:cfg.acct, recentSenders:cfg.recentSenders}; cfg = Object.assign(defaultCfg(), keep); save(); render(); toast('已恢复默认审核规则'); }
});
document.addEventListener('keydown', function(e){
  var tr = e.target.closest && e.target.closest('tr[data-open]');
  if (tr && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); location.hash = 'review-' + tr.getAttribute('data-open'); }
});
document.addEventListener('input', function(e){
  if (e.target.id === 'mail-senders'){ mailUi.senders = e.target.value; return; }
  if (e.target.id === 'hist-who'){ histUi.who = e.target.value; histRefresh(); return; }
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
  if (voucherChange(t)) return;
  if (t.id === 'person-filter'){ ui.person = t.value; render(); return; }
  if (t.id === 'rv-emp'){ var ri = findInv(t.getAttribute('data-id')); if (ri){ ri.employeeId = t.value || null; save(); render(); toast(t.value ? '报销人已改为「' + empById(t.value).name + '」' : '已取消指定报销人'); } return; }
  if (t.hasAttribute && t.hasAttribute('data-addto')){
    var em = empById(t.value), addr = t.getAttribute('data-addto');
    if (em && (em.emails || []).indexOf(addr) < 0){ em.emails = (em.emails || []).concat([addr]); save(); render(); toast('已把 ' + addr + ' 登记到「' + em.name + '」'); }
    return;
  }
  if (t.id === 'hist-type'){ histUi.dateType = t.value; histRefresh(); return; }
  if (t.id === 'hist-from'){ histUi.from = t.value; histRefresh(); return; }
  if (t.id === 'hist-to'){ histUi.to = t.value; histRefresh(); return; }
  if (t.id === 'hist-status'){ histUi.status = t.value; histRefresh(); return; }
  if (t.id === 'hist-who'){ histUi.who = t.value; histRefresh(); return; }
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
function openExport(){
  var ready = invoices.filter(function(i){ return i.status === 'ready'; });
  if (!ready.length){ toast('台账里还没有发票'); return; }
  var G = personGroups(ready), def = ui.person || '';
  var opts = '<option value="">全部（' + ready.length + ' 张）</option>' +
    G.map(function(g){ return '<option value="' + esc(g.key) + '"' + (def === g.key ? ' selected' : '') + '>' + esc(g.label + (g.kind === 1 ? '（未登记 ' + g.sub + '）' : g.sub ? '（' + g.sub + '）' : '')) + ' · ' + g.n + ' 张</option>'; }).join('');
  var bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'export-modal';
  bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ex-title"><h2 id="ex-title">导出台账</h2>' +
    '<label class="fld" for="ex-sender">导出谁的发票<select id="ex-sender">' + opts + '</select></label>' +
    '<label class="fld" for="ex-scope">范围<select id="ex-scope"><option value="all">全部发票</option><option value="todo">只导出待处理的（拦截、复核且未处理）</option><option value="ok">只导出已通过的（自动通过和人工通过）</option></select></label>' +
    '<p class="note">导出为 Excel 文件，包含两张表：「发票汇总」每张发票一行，「发票明细」每行明细一行。想按日期导出某个人的，可以用「报销查询」查出来再导出。</p>' +
    '<div class="actions"><button class="btn lg" type="button" data-act="ex-cancel">取消</button><button class="btn lg primary grow" type="button" data-act="ex-go">导出 Excel</button></div></div>';
  document.body.appendChild(bg);
  $('#ex-sender').focus();
}
function closeExport(){ var m = $('#export-modal'); if (m) m.remove(); }
function doExport(){
  var who = $('#ex-sender').value, scope = $('#ex-scope').value;
  closeExport();
  var A = auditAll();
  var list = sortedList(A).filter(function(i){
    if (i.status !== 'ready') return false;
    if (who && personKey(i) !== who) return false;
    var lv = A[i.id].level;
    if (scope === 'todo') return lv !== 'pass' && !i.decision;
    if (scope === 'ok') return lv === 'pass' || i.decision === 'approved';
    return true;
  });
  var g = who ? personGroups(list)[0] : null;
  exportList(list, g ? g.label : '全部');
}
function exportList(list, label){
  if (!window.XLSX){ toast('导出组件没有加载，请重启软件后再试'); return; }
  list = list.filter(function(i){ return i.status === 'ready'; });
  if (!list.length){ toast('没有符合条件的发票'); return; }
  var A = auditAll();
  var res = function(i){ var lv = A[i.id].level; return LV[lv].t; };
  var dec = function(i){ return i.decision ? DEC[i.decision] : (A[i.id].level === 'pass' ? '自动通过' : '待处理'); };
  var issues = function(i){ return A[i.id].checks.filter(function(c){ return c.k === 'fail' || c.k === 'warn'; }).map(function(c){ return c.title + '：' + c.detail; }).join('；'); };
  var how = function(i){ return i.source === 'sample' ? '示例' : i.source === 'manual' ? '手动录入' : METHOD[i.method] || ''; };
  var dept = function(i){ var e = employeeOf(i); return e ? e.dept || '' : ''; };
  var H1 = ['报销人','部门','提交邮箱','提交时间','审核结果','处理结果','发票类型','发票代码','发票号码','开票日期','购买方','购买方税号','销售方','销售方税号','金额','税额','价税合计','税率','费用类别','项目','明细行数','审核发现','复核意见','邮件主题','邮件时间','来源文件','识别方式'];
  var S1 = [H1].concat(list.map(function(i){
    var f = i.f;
    return [personLabel(i), dept(i), i.sender || '', fmtDateTime(subDate(i).toISOString()), res(i), dec(i), f.type, f.code || '', f.no || '', f.date || '', f.buyer, f.buyerTax, f.seller, f.sellerTax,
      num(f.amount), num(f.tax), num(f.total), f.rate == null || f.rate === '' ? '' : f.rate + '%', f.cat, f.items, (f.lines || []).length,
      issues(i), i.memo || '', i.mail ? i.mail.subject : '', i.mail ? fmtDateTime(i.mail.date) : '', i.file || '', how(i)];
  }));
  var H2 = ['报销人','部门','提交邮箱','发票号码','开票日期','销售方','销售方税号','行号','项目名称','规格型号','单位','数量','单价','金额','税率','税额','审核结果','来源文件'];
  var S2 = [H2];
  list.forEach(function(i){
    var f = i.f, L = (f.lines && f.lines.length) ? f.lines : [{name:f.items, amount:f.amount, rate:f.rate, tax:f.tax}];
    L.forEach(function(l, n){
      S2.push([personLabel(i), dept(i), i.sender || '', f.no || '', f.date || '', f.seller, f.sellerTax, n + 1, l.name || '', l.spec || '', l.unit || '',
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
  XL.utils.book_append_sheet(wb, sheet(S1, [10,10,24,16,8,12,18,14,24,12,26,22,26,22,12,10,12,8,10,26,8,50,24,24,16,24,16], [14,15,16]), '发票汇总');
  XL.utils.book_append_sheet(wb, sheet(S2, [10,10,24,24,12,26,22,6,30,14,8,10,14,12,8,10,8,24], [13,15]), '发票明细');
  var data = XL.write(wb, {type:'array', bookType:'xlsx'});
  var d = new Date();
  var name = '发票台账_' + String(label).replace(/[\\/:*?"<>|]/g, '_') + '_' + d.getFullYear() + ('0'+(d.getMonth()+1)).slice(-2) + ('0'+d.getDate()).slice(-2) + '.xlsx';
  window.api.saveFile(name, new Uint8Array(data)).then(function(r){
    if (!r || !r.ok) toast('导出失败：' + (r && r.message || '无法写入文件'));
    else if (r.data && r.data.saved) toast('已导出 ' + list.length + ' 张发票、' + (S2.length - 1) + ' 行明细');
  });
}
$('#uploadBtn').addEventListener('click', function(){ $('#fileInput').click(); });
$('#exportBtn').addEventListener('click', openExport);
document.addEventListener('keydown', function(e){ if (e.key === 'Escape'){ closeExport(); ['#v-viewer', '#learn-modal'].forEach(function(q){ var m = $(q); if (m) m.remove(); }); vUi.learn = null; } });

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
  loadMailInfo(),
  loadU8()
]).then(function(res){
  if (!res[0]){ invoices = makeSamples(); save(); }
  render();
}).catch(function(){ render(); });
})();
