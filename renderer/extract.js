/* 发票字段提取（不依赖 AI，可离线运行）
 *
 * 输入来源：
 *   - PDF 文字层 / OFD 文字 / OCR 识别出的文字（带坐标的文字块 → 按行整理 → 按标签提取）
 *   - 数电票 XML（按标签名读取）
 *   - 发票二维码（发票号码、开票日期、金额）
 *
 * 浏览器里挂在 window.InvoiceExtract 上，Node 里用 require 加载（便于测试）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvoiceExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATS = ['餐饮', '住宿', '交通', '办公用品', '其他'];
  var STD_RATES = [0, 1, 1.5, 3, 5, 6, 9, 10, 11, 13, 16, 17];
  var CJK = '\\u3400-\\u9fff';
  var RAIL_SELLER = '铁路电子客票（票面无销售方）';

  function r2(n) { return Math.round(n * 100) / 100; }

  /* ---------- 文字规范化 ---------- */
  // 很多发票 PDF 里的“示、日、子”等字实际存的是外形相同的部首字符（如 ⽰ ⽇ ⼦），
  // NFKC 能把康熙部首、全角字母数字标点统一成普通字符；部首补充区的常见字单独映射。
  var RADICALS = { '⻋': '车', '⻓': '长', '⻔': '门', '⻢': '马', '⻜': '飞', '⻛': '风', '⻚': '页', '⻅': '见', '⻆': '角', '⻉': '贝', '⻘': '青', '⻝': '食', '⻥': '鱼', '⻦': '鸟', '⻨': '麦', '⻩': '黄', '⻰': '龙', '⻮': '齿', '⻄': '西', '⻊': '足', '⻏': '阝', '⻖': '阝' };
  function norm(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFKC'); } catch (e) { /* 老环境没有 normalize */ }
    return s
      .replace(/[⺀-⻿]/g, function (c) { return RADICALS[c] || c; })
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[￥]/g, '¥')
      .replace(/[　  - ]/g, ' ')
      .replace(/[：﹕]/g, ':');
  }
  // 去掉汉字之间、汉字与标点之间的空格（OCR 常在每个汉字之间插空格），保留数字之间的空格。
  // 制表符表示版面上的大间隔（不同栏），保留下来用于切分。
  var compactRe = new RegExp('(?<=[' + CJK + ':()*/¥%⊗\\t]) +| +(?=[' + CJK + ':()*/¥%⊗\\t])', 'g');
  function compact(s) {
    return norm(s).replace(/[ \r\n\f\v]+/g, ' ').replace(compactRe, '').replace(/\t+/g, '\t').replace(/^[\t ]+|[\t ]+$/g, '');
  }
  function fullParens(s) { return String(s || '').replace(/\(/g, '（').replace(/\)/g, '）'); }

  /* ---------- 文字块 → 行 ---------- */
  // items: [{str, x, y, w, h}]，坐标原点在左上角
  function buildRows(items) {
    var list = (items || []).filter(function (it) { return it && String(it.str || '').trim(); }).map(function (it) {
      var h = Math.max(1, +it.h || 0);
      return { str: String(it.str), x: +it.x || 0, y: +it.y || 0, w: Math.max(0, +it.w || 0), h: h, yc: (+it.y || 0) + h / 2 };
    });
    list.sort(function (a, b) { return a.yc - b.yc || a.x - b.x; });
    var rows = [];
    list.forEach(function (it) {
      var row = null;
      for (var i = rows.length - 1; i >= 0 && i >= rows.length - 3; i--) {
        var r = rows[i];
        if (Math.abs(r.yc - it.yc) <= Math.min(r.h, it.h) * 0.55) { row = r; break; }
      }
      if (!row) { row = { yc: it.yc, h: it.h, items: [] }; rows.push(row); }
      row.items.push(it);
      row.yc = (row.yc * (row.items.length - 1) + it.yc) / row.items.length;
      row.h = Math.max(row.h, it.h);
    });
    rows.sort(function (a, b) { return a.yc - b.yc; });
    return rows.map(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
      var out = '', prev = null;
      r.items.forEach(function (it) {
        if (prev) {
          var gap = it.x - (prev.x + prev.w), h = Math.min(it.h, prev.h);
          out += gap > h * 1.2 ? '\t' : gap > h * 0.25 ? ' ' : '';
        }
        out += it.str;
        prev = it;
      });
      return out;
    });
  }

  // pdf.js 的 getTextContent().items → 行（pdf 坐标原点在左下角）
  function rowsFromPdfItems(items, pageHeight) {
    return buildRows((items || []).map(function (it) {
      var t = it.transform || [1, 0, 0, 1, 0, 0];
      var h = Math.abs(it.height || t[3] || Math.hypot(t[2], t[3]) || 10);
      return { str: it.str, x: t[4], y: pageHeight - t[5] - h, w: it.width || 0, h: h };
    }));
  }

  // 纯文本（每行一行，连续 3 个以上空格视为分栏）→ 行
  function rowsFromText(text) {
    return String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/ {3,}/g, '\t'); }).filter(function (l) { return l.trim(); });
  }

  // tesseract 的 TSV 输出 → 行
  function rowsFromTsv(tsv) {
    var items = [];
    String(tsv || '').split('\n').forEach(function (line, i) {
      var c = line.split('\t');
      if (i === 0 && c[0] === 'level') return;
      if (c.length < 12 || c[0] !== '5') return;
      var text = c.slice(11).join('\t');
      if (!text.trim()) return;
      items.push({ str: text, x: +c[6], y: +c[7], w: +c[8], h: +c[9] });
    });
    return buildRows(items);
  }

  /* ---------- 金额 ---------- */
  var MONEY = '(\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d+[.,]\\d{2})(?![\\d])';
  function money(s) {
    if (s == null) return null;
    var t = String(s).replace(/\s/g, '');
    if (/^\d+,\d{2}$/.test(t)) t = t.replace(',', '.');
    t = t.replace(/,/g, '');
    var n = Number(t);
    return isFinite(n) ? n : null;
  }
  function allMoney(text) {
    var re = new RegExp('(?<![\\d.,])' + MONEY, 'g'), out = [], m;
    while ((m = re.exec(text))) { var v = money(m[1]); if (v != null) out.push(v); }
    return out;
  }

  /* ---------- 类别 ---------- */
  function inferCategory(items, seller, type) {
    var rules = [
      ['住宿', /住宿|房费|间夜|宾馆|酒店|旅馆|客栈|民宿/],
      ['交通', /运输|客运|出租|铁路|客票|航空|机票|行程单|滴滴|出行|网约车|打车|通行费|高速|公交|地铁|停车|旅客|燃油附加/],
      ['餐饮', /餐饮|餐费|餐厅|饮食|食品|饮品|咖啡|茶饮|外卖|酒楼|食堂|小吃|火锅|烧烤|面馆|饭店/],
      ['办公用品', /办公|文具|纸张|打印|复印|墨盒|硒鼓|计算机|电脑|显示器|键盘|鼠标|U盘|移动硬盘|笔记本|签字笔|文件夹|白板/]
    ];
    var srcs = [items || '', type || '', seller || ''];
    for (var s = 0; s < srcs.length; s++) {
      for (var i = 0; i < rules.length; i++) if (rules[i][1].test(srcs[s])) return rules[i][0];
    }
    return '其他';
  }

  function snapRate(v) {
    if (v == null || !isFinite(v)) return null;
    for (var i = 0; i < STD_RATES.length; i++) if (Math.abs(STD_RATES[i] - v) < 0.05) return STD_RATES[i];
    return null;
  }

  function normDate(y, m, d) {
    y = +y; m = +m; d = +d;
    if (!(y > 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
  }

  function invoiceType(T) {
    if (/铁路电子客票/.test(T)) return '电子发票（铁路电子客票）';
    if (/航空运输电子客票行程单/.test(T)) return '电子发票（航空运输电子客票行程单）';
    if (/电子发票\((?:增值税)?专用发票\)/.test(T)) return '数电票（专用发票）';
    if (/电子发票\(普通发票\)/.test(T)) return '数电票（普通发票）';
    if (/增值税电子专用发票/.test(T)) return '增值税电子专用发票';
    if (/增值税电子普通发票/.test(T)) return '增值税电子普通发票';
    if (/增值税专用发票/.test(T)) return '增值税专用发票';
    if (/增值税普通发票/.test(T)) return '增值税普通发票';
    if (/通行费/.test(T)) return '通行费电子发票';
    return '';
  }

  var TAX_ID_RE = /^([0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}|[0-9A-Z]{15}|[0-9A-Z]{20})$/;

  /* ---------- 统一社会信用代码（GB 32100）校验位 ---------- */
  var USCC_CH = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  var USCC_W = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  function usccValid(id) {
    // 第 1 位登记管理部门、第 2 位机构类别、第 3-8 位行政区划（数字）
    if (!/^[1-9ANY][0-9A-HJ-NPQRTUWXY]\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(id)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += USCC_CH.indexOf(id[i]) * USCC_W[i];
    var c = 31 - sum % 31;
    return USCC_CH[c === 31 ? 0 : c] === id[17];
  }
  // OCR 常把 0/O、1/I、2/Z、5/S、8/B 认混。只在文字识别结果上使用：先换掉代码里不允许出现的字母，
  // 再用校验位尝试修正一个字符；唯一能通过校验的结果才采用。
  var CONFUSE = { '0': 'ODQ', 'O': '0', 'D': '0', 'Q': '0', '1': 'IL7T', 'I': '1', 'L': '1', '7': '1', 'T': '1', '2': 'Z', 'Z': '2', '5': 'S', 'S': '5', '8': 'B3', 'B': '8', '3': '8', '6': 'G', 'G': '6', 'U': 'V', 'V': 'U' };
  function fixTaxId(id) {
    id = String(id || '').toUpperCase().replace(/\s/g, '');
    if (id.length === 19) {
      // 多认出了一个字符：逐个删掉试校验位
      var mapc = function (x) { return x.replace(/O/g, '0').replace(/I/g, '1').replace(/Z/g, '2').replace(/S/g, '5'); };
      var mid = mapc(id), del = [], dup = [];
      for (var d = 0; d < 19; d++) {
        var c18 = mid.slice(0, d) + mid.slice(d + 1);
        if (!usccValid(c18)) continue;
        if (del.indexOf(c18) < 0) del.push(c18);
        // 和相邻字符相同（如 0O、1I 被认成两个字），最可能是重复识别
        if ((mid[d] === mid[d - 1] || mid[d] === mid[d + 1]) && dup.indexOf(c18) < 0) dup.push(c18);
      }
      var pick = dup.length === 1 ? dup[0] : del.length === 1 ? del[0] : '';
      return pick ? { id: pick, fixed: true } : { id: id, fixed: false, invalid: true };
    }
    if (id.length !== 18) return { id: id, fixed: false };
    var base = id.replace(/O/g, '0').replace(/I/g, '1').replace(/Z/g, '2').replace(/S/g, '5');
    if (usccValid(base)) return { id: base, fixed: base !== id };
    var hits = [];
    for (var i = 0; i < 18; i++) {
      var alts = CONFUSE[base[i]] || '';
      for (var j = 0; j < alts.length; j++) {
        var cand = base.slice(0, i) + alts[j] + base.slice(i + 1);
        if (usccValid(cand) && hits.indexOf(cand) < 0) hits.push(cand);
      }
    }
    return hits.length === 1 ? { id: hits[0], fixed: true } : { id: base, fixed: base !== id, invalid: true };
  }

  /* ---------- 项目名称 ---------- */
  var TAX_CLASSES = ['餐饮服务', '住宿服务', '运输服务', '旅客运输服务', '物流辅助服务', '经纪代理服务', '现代服务', '生活服务', '信息技术服务',
    '电信服务', '邮政服务', '建筑服务', '租赁服务', '研发和技术服务', '广告服务', '会议展览服务', '鉴证咨询服务', '文化创意服务', '商务辅助服务',
    '计算机外部设备', '计算机配套产品', '计算机', '办公设备', '纸制品', '文具', '日用杂品', '食品', '酒', '非酒精饮料', '汽油', '柴油', '家具',
    '通信设备', '电子元件', '劳保用品', '印刷品', '图书', '体育用品', '医疗仪器器械', '药品', '服装', '五金'].sort(function (a, b) { return b.length - a.length; });
  function itemFromCell(cell) {
    var c = String(cell || '').replace(new RegExp('^[^' + CJK + ']+'), '').replace(/[\d.%¥\s]+$/, '');
    var m = c.match(new RegExp('^([' + CJK + ']{2,12})[^' + CJK + ']{1,2}([' + CJK + '、]{1,30})'));
    if (m) return '*' + m[1] + '*' + m[2];
    c = c.replace(new RegExp('[^' + CJK + '、]', 'g'), '');
    for (var i = 0; i < TAX_CLASSES.length; i++) {
      if (c.indexOf(TAX_CLASSES[i]) === 0 && c.length > TAX_CLASSES[i].length) return '*' + TAX_CLASSES[i] + '*' + c.slice(TAX_CLASSES[i].length);
    }
    return c.length >= 2 ? c : '';
  }

  /* ---------- 名称 ---------- */
  var NAME_STOP = /\t|\s{2,}|(?:[购销买售]{1,2}方?)?(?:名称|统一社会|纳税人|识别号|地址|电话|开户行|密码区|项目名称|货物或应税|规格型号)|$/;
  var NAME_SUFFIX = /(有限责任公司|股份有限公司|有限公司|分公司|公司|集团|厂|店|中心|医院|学校|研究院|研究所|事务所|局|馆|社|部|处|站|行|所)/;
  function cleanName(v) {
    v = String(v || '').replace(/^[\s:]+/, '');
    var m = v.match(NAME_STOP);
    if (m && m.index != null) v = v.slice(0, m.index);
    v = v.replace(/[\s]+/g, '').replace(/[|丨_]+$/, '');
    // 文字识别带进来的标点和杂字：去掉开头的符号、公司名结尾后多出的一个字
    v = v.replace(new RegExp('^[^' + CJK + '(（A-Za-z0-9]+'), '').replace(/[,.;:，。；、:'"“”‘’]/g, '');
    var over = v.match(/^(.*(?:有限责任公司|股份有限公司|有限公司))[^（(]$/);
    if (over) v = over[1];
    // 去掉粘在末尾的竖排标签字（购买方信息 / 销售方信息）
    var tail = v.match(new RegExp('^(.*' + NAME_SUFFIX.source + ')[购销买售方信息]{1,3}$'));
    if (tail) v = tail[1];
    // 公司名后面粘上了密码区之类的乱码：截到公司名结尾
    var junk = v.match(new RegExp('^(.*?' + NAME_SUFFIX.source + '(?:[(（][^)）]{1,10}[)）])?)[0-9<>*+\\-/=]{3,}'));
    if (junk) v = junk[1];
    return fullParens(v);
  }

  // 在整页文字里找到所有“名称”标签，按上下文判断是购买方还是销售方
  function findParties(rows) {
    var names = [], taxes = [];
    var T = rows.join('\n');
    var nameRe = /名\s*称\s*:?/g, m;
    while ((m = nameRe.exec(T))) {
      var before = T.slice(Math.max(0, m.index - 6), m.index);
      if (/项目|货物|服务|应税劳务/.test(before)) continue;
      var lineEnd = T.indexOf('\n', m.index);
      var after = T.slice(m.index + m[0].length, lineEnd < 0 ? undefined : lineEnd);
      var role = /销|售/.test(before) ? 'seller' : /购|买/.test(before) ? 'buyer' : '';
      names.push({ idx: m.index, role: role, value: cleanName(after) });
    }
    var taxRe = /(?:纳税人识别号|识别号|信用代码)[^:\n0-9A-Z]{0,14}:?\s*((?:[0-9A-Z] ?){15,20})?/g;
    while ((m = taxRe.exec(T))) {
      var b = T.slice(Math.max(0, m.index - 22), m.index);
      var rl = /销售方|销|售/.test(b.slice(-6)) ? 'seller' : /购买方|购|买/.test(b.slice(-6)) ? 'buyer' : '';
      taxes.push({ idx: m.index, role: rl, value: (m[1] || '').replace(/\s/g, '').slice(0, 20) });
    }
    function assign(list, other) {
      var out = { buyer: null, seller: null };
      list.forEach(function (n) { if (n.role && !out[n.role]) out[n.role] = n; });
      list.forEach(function (n) {
        if (n.role) return;
        if (!out.buyer && (!out.seller || n.idx < out.seller.idx)) { out.buyer = n; n.role = 'buyer'; }
        else if (!out.seller) { out.seller = n; n.role = 'seller'; }
      });
      return out;
    }
    var N = assign(names), X = assign(taxes);
    return {
      buyer: N.buyer ? N.buyer.value : '', seller: N.seller ? N.seller.value : '',
      buyerTax: X.buyer ? X.buyer.value : '', sellerTax: X.seller ? X.seller.value : ''
    };
  }

  // 没有“名称”标签时，按公司名的样子在文字里找
  function companyNames(T) {
    var re = new RegExp('[' + CJK + '()]{2,40}(?:有限责任公司|股份有限公司|有限公司|分公司|集团|酒店|宾馆|饭店|餐厅|中心|医院)', 'g');
    var out = [], m;
    while ((m = re.exec(T))) out.push(fullParens(m[0]));
    return out;
  }

  /* ---------- 文字 → 字段 ---------- */
  function parseText(rawRows, opts) {
    opts = opts || {};
    var rows = (rawRows || []).map(compact).filter(Boolean);
    var T = rows.join('\n');
    var flat = rows.join(' ');
    var f = { type: '', cat: '其他', no: '', code: '', date: '', buyer: '', buyerTax: '', seller: '', sellerTax: '', amount: null, tax: null, total: null, rate: null, items: '' };
    var notes = [];

    f.type = invoiceType(T);

    var m = T.match(/发票号码:?((?:\d\s?){8,20})/);
    if (m) f.no = m[1].replace(/\s/g, '').slice(0, 20);
    if (!f.no) { m = flat.match(/(?<!\d)(2\d{19})(?!\d)/); if (m) f.no = m[1]; }
    m = T.match(/发票代码:?((?:\d\s?){10,12})/);
    if (m) f.code = m[1].replace(/\s/g, '');

    m = T.match(/开票日期:?\s*(\d{4})\s*[年.\-\/]\s*(\d{1,2})\s*[月.\-\/]\s*(\d{1,2})/);
    if (!m) m = T.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) f.date = normDate(m[1], m[2], m[3]);

    var p = findParties(rows);
    f.buyer = p.buyer; f.seller = p.seller; f.buyerTax = p.buyerTax; f.sellerTax = p.sellerTax;
    var isRail = /铁路电子客票/.test(T);
    if (!f.buyer || (!f.seller && !isRail)) {
      var cs = companyNames(T).filter(function (c) { return c !== f.buyer && c !== f.seller; });
      if (!f.buyer && cs.length && f.seller !== cs[0]) f.buyer = cs.shift();
      if (!f.seller && cs.length) f.seller = cs.shift();
    }

    // 金额：先找“价税合计（小写）”和“合计”行，再用 金额 + 税额 = 价税合计 互相印证
    m = T.match(new RegExp('小写\\)?:?\\s*[¥Y]?\\s*' + MONEY));
    if (m) f.total = money(m[1]);
    if (f.total == null && isRail) {
      m = T.match(new RegExp('(?:票价:?\\s*)?[¥Y]\\s*' + MONEY));
      if (m) f.total = money(m[1]);
    }
    m = T.match(new RegExp('合\\s*计\\s*[¥Y]?\\s*' + MONEY + '\\s*[¥Y]?\\s*(?:' + MONEY + '|(\\*{2,}))'));
    if (m) {
      f.amount = money(m[1]);
      f.tax = m[2] != null ? money(m[2]) : (m[3] ? 0 : null);
    }
    var cands = allMoney(flat);
    if (f.total == null && f.amount != null && f.tax != null) f.total = r2(f.amount + f.tax);
    if (f.total != null && (f.amount == null || f.tax == null || Math.abs(f.amount + f.tax - f.total) > 0.011)) {
      // 在所有金额里找一对 a + t = 价税合计
      var best = null;
      for (var i = 0; i < cands.length; i++) for (var j = 0; j < cands.length; j++) {
        if (i === j) continue;
        var a = cands[i], t = cands[j];
        if (a >= t && Math.abs(a + t - f.total) <= 0.011 && (!best || a > best[0])) best = [a, t];
      }
      if (best && (f.amount == null || f.tax == null)) { f.amount = best[0]; f.tax = best[1]; }
    }
    if (f.total == null && cands.length) {
      // 找不到价税合计标签：取能被拆成 a + t 的最大金额
      var sorted = cands.slice().sort(function (a, b) { return b - a; });
      for (var k = 0; k < sorted.length && f.total == null; k++) {
        for (var x = 0; x < cands.length; x++) for (var y = 0; y < cands.length; y++) {
          if (x !== y && cands[x] < sorted[k] && Math.abs(cands[x] + cands[y] - sorted[k]) <= 0.011) {
            f.total = sorted[k]; f.amount = Math.max(cands[x], cands[y]); f.tax = Math.min(cands[x], cands[y]);
          }
        }
      }
    }

    // 税率
    var rates = [], rr = /(?<![\d.])(\d{1,2}(?:\.\d)?)\s*%/g;
    while ((m = rr.exec(flat))) { var sv = snapRate(+m[1]); if (sv != null) rates.push(sv); }
    if (rates.length) f.rate = rates[0];
    else if (/免税/.test(T)) f.rate = 0;
    else if (f.amount && f.tax != null) {
      var calc = snapRate(Math.round(f.tax / f.amount * 1000) / 10);
      if (calc != null) f.rate = calc;
    }

    // 项目名称
    var items = [], ir = /\*[^*\s\d¥]{1,20}\*[^\s*¥\d%]{0,30}/g;
    while ((m = ir.exec(flat))) if (items.indexOf(m[0]) < 0) items.push(m[0]);
    if (items.length) f.items = items[0] + (items.length > 1 ? '等' : '');
    if (!f.items) {
      // 文字识别常把 * 认成别的符号：取表头下一行的第一栏，并还原成 *类别*名称 的格式
      for (var ri = 0; ri < rows.length - 1 && !f.items; ri++) {
        if (!/项目名称|货物或应税|服务名称/.test(rows[ri])) continue;
        for (var rj = ri + 1; rj <= ri + 3 && rj < rows.length && !f.items; rj++) {
          if (/^合\s*计/.test(rows[rj])) break;
          f.items = itemFromCell(rows[rj].split('\t')[0]);
        }
      }
    }

    if (isRail) {
      f.type = f.type || '电子发票（铁路电子客票）';
      if (!f.seller) f.seller = RAIL_SELLER;
      if (f.rate == null) f.rate = 9;
      if (f.total != null && f.amount == null) {
        f.amount = r2(f.total / (1 + f.rate / 100)); f.tax = r2(f.total - f.amount);
        notes.push('金额和税额按 ' + f.rate + '% 由票价换算');
      }
    }

    // 版面里所有通过校验位的统一社会信用代码（文字识别结果先修正常见误认）
    var valid = [], tr = opts.ocr ? /(?<![0-9A-Z])((?:[0-9A-Z] ?){18,19})(?![0-9A-Z])/g : /(?<![0-9A-Z])([0-9A-Z]{18})(?![0-9A-Z])/g;
    while ((m = tr.exec(flat))) {
      var cand = m[1].replace(/ /g, '');
      if (opts.ocr) cand = fixTaxId(cand).id;
      if (usccValid(cand) && valid.indexOf(cand) < 0) valid.push(cand);
    }
    if (opts.ocr) {
      ['buyerTax', 'sellerTax'].forEach(function (k) {
        if (f[k]) { var fx = fixTaxId(f[k]); if (fx.fixed && usccValid(fx.id)) f[k] = fx.id; }
      });
    }
    var bOk = usccValid(f.buyerTax), sOk = usccValid(f.sellerTax);
    if (valid.length >= 2 && !(bOk && sOk && f.buyerTax !== f.sellerTax)) {
      // 购买方在前（数电票在左、旧版在上），销售方在后
      f.buyerTax = valid[0]; f.sellerTax = valid[1];
    } else if (valid.length === 1 && !bOk && !sOk && f.buyerTax === '' && f.sellerTax === '') {
      if (!NAME_SUFFIX.test(f.buyer)) f.sellerTax = valid[0];
    }
    if (opts.ocr) {
      ['buyerTax', 'sellerTax'].forEach(function (k) {
        if (!f[k]) return;
        var r = fixTaxId(f[k]);
        if (r.fixed) notes.push((k === 'buyerTax' ? '购买方' : '销售方') + '税号按校验位修正了识别误差');
        f[k] = r.id;
      });
    }

    f.cat = inferCategory(f.items, f.seller, f.type);
    return { f: f, notes: notes, text: T };
  }

  /* ---------- 二维码 ---------- */
  var QR_TYPES = { '01': '增值税专用发票', '04': '增值税普通发票', '08': '增值税电子专用发票', '10': '增值税电子普通发票', '11': '增值税普通发票（卷式）', '14': '通行费电子发票', '31': '数电票（专用发票）', '32': '数电票（普通发票）', '51': '电子发票（铁路电子客票）', '61': '电子发票（航空运输电子客票行程单）' };
  function parseQr(s) {
    if (!s) return null;
    var c = String(s).trim().split(/[,，]/);
    if (c.length < 6) return null;
    var no = (c[3] || '').trim(), date = (c[5] || '').trim();
    if (!/^\d{8,20}$/.test(no) || !/^\d{8}$/.test(date)) return null;
    return {
      typeCode: (c[1] || '').trim(), type: QR_TYPES[(c[1] || '').trim()] || '',
      code: (c[2] || '').trim(), no: no, amount: money(c[4]),
      date: normDate(date.slice(0, 4), date.slice(4, 6), date.slice(6, 8)), raw: String(s)
    };
  }

  // 用二维码核对 / 补全识别结果；二维码内容由开票系统生成，比文字识别可靠
  function applyQr(res, qr) {
    if (!qr) return res;
    var f = res.f, notes = res.notes;
    res.qr = { ok: true, mismatch: [] };
    if (qr.no && f.no !== qr.no) { if (f.no) res.qr.mismatch.push('发票号码'); f.no = qr.no; }
    if (qr.code && f.code !== qr.code) { if (f.code) res.qr.mismatch.push('发票代码'); f.code = qr.code; }
    if (qr.date && f.date !== qr.date) { if (f.date) res.qr.mismatch.push('开票日期'); f.date = qr.date; }
    if (!f.type && qr.type) f.type = qr.type;
    if (qr.amount != null) {
      var hit = [f.amount, f.total].some(function (v) { return v != null && Math.abs(v - qr.amount) < 0.011; });
      if (!hit) {
        if (f.amount == null && f.total == null) { f.amount = qr.amount; notes.push('不含税金额取自二维码'); }
        else res.qr.mismatch.push('金额');
      } else res.qr.amountOk = true;
    }
    if (res.qr.mismatch.length) notes.push(res.qr.mismatch.join('、') + '与二维码不一致，已按二维码修正，请核对');
    return res;
  }

  /* ---------- 公司抬头校正（只用于文字识别结果） ---------- */
  function editDistance(a, b) {
    a = String(a || ''); b = String(b || '');
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
  }
  function snapBuyer(res, companies) {
    var f = res.f;
    if (!companies || !companies.length) return res;
    var nm = function (s) { return String(s || '').replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')'); };
    var best = null;
    companies.forEach(function (c) {
      if (!c || !c.name) return;
      var dn = f.buyer ? editDistance(nm(f.buyer), nm(c.name)) : 99;
      var taxOk = c.taxId && f.buyerTax && f.buyerTax.toUpperCase() === String(c.taxId).toUpperCase();
      var score = taxOk ? 0 : dn;
      if (!best || score < best.score) best = { c: c, dn: dn, taxOk: taxOk, score: score };
    });
    if (!best) return res;
    var c = best.c;
    // 税号完全一致而名称只差一两个字：名称按公司抬头修正（多半是识别误差）
    if (best.taxOk && f.buyer !== c.name && best.dn <= Math.max(2, Math.floor(c.name.length / 5))) {
      f.buyer = c.name; res.notes.push('购买方名称已按公司抬头校正');
    }
    // 名称完全一致、税号没识别出来：不替换税号，交给审核规则提示
    return res;
  }

  /* ---------- 完整度和置信度 ---------- */
  var BASE = { 'xml': 0.99, 'pdf-text': 0.97, 'ofd': 0.95, 'ocr': 0.86 };
  function score(res, method) {
    var f = res.f, c = BASE[method] || 0.8;
    var miss = ['no', 'date', 'total', 'seller', 'buyer'].filter(function (k) { return f[k] === '' || f[k] == null; });
    c -= miss.length * 0.15;
    var sumOk = f.amount != null && f.tax != null && f.total != null && Math.abs(f.amount + f.tax - f.total) <= 0.011;
    if (method === 'ocr') {
      if (!sumOk) c -= 0.12;
      if (res.qr && res.qr.ok) c += res.qr.mismatch.length ? -0.05 : 0.06;
      ['sellerTax', 'buyerTax'].forEach(function (k) {
        if (!f[k]) return;
        if (f[k].length === 18 ? !usccValid(f[k]) : !TAX_ID_RE.test(f[k])) c -= 0.08;
      });
      c = Math.min(c, 0.92);
    }
    res.missing = miss;
    res.complete = miss.length === 0;
    res.conf = Math.max(0.05, Math.min(0.99, Math.round(c * 100) / 100));
    return res;
  }

  // 一页文字是否像一张能读的发票（用于判断 PDF 文字层是否可用）
  function looksReadable(res) {
    var f = res.f;
    return !!(f.no && (f.total != null || f.amount != null) && (f.seller || f.buyer));
  }

  /* ---------- XML（数电票） ---------- */
  function xmlTag(xml, names) {
    for (var i = 0; i < names.length; i++) {
      var n = names[i].replace(/[-]/g, '\\-');
      var re = new RegExp('<(?:[\\w.-]+:)?' + n + '(?:\\s[^>]*)?>\\s*(?:<!\\[CDATA\\[)?([^<]*?)(?:\\]\\]>)?\\s*</(?:[\\w.-]+:)?' + n + '>', 'i');
      var m = xml.match(re);
      if (m && m[1].trim()) return decodeEntities(m[1].trim());
    }
    return '';
  }
  function decodeEntities(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); }).replace(/&amp;/g, '&');
  }
  function parseXml(xml) {
    xml = String(xml || '');
    var g = function () { return xmlTag(xml, Array.prototype.slice.call(arguments)); };
    var f = { type: '', cat: '其他', no: '', code: '', date: '', buyer: '', buyerTax: '', seller: '', sellerTax: '', amount: null, tax: null, total: null, rate: null, items: '' };
    f.no = g('InvoiceNumber', 'InvoiceNo', 'EIid', 'FPHM', 'Fphm').replace(/\s/g, '');
    f.code = g('InvoiceCode', 'FPDM', 'Fpdm').replace(/\s/g, '');
    var d = g('IssueTime', 'IssuTime', 'RequestTime', 'IssueDate', 'InvoiceDate', 'KPRQ', 'Kprq');
    var dm = d.match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
    if (dm) f.date = normDate(dm[1], dm[2], dm[3]);
    f.buyer = fullParens(g('BuyerName', 'PurchaserName', 'GMFMC', 'Gmfmc'));
    f.buyerTax = g('BuyerIdNum', 'BuyerTaxID', 'BuyerTaxNo', 'PurchaserTaxNo', 'GMFNSRSBH', 'Gmfnsrsbh').toUpperCase();
    f.seller = fullParens(g('SellerName', 'XSFMC', 'Xsfmc', 'XHFMC'));
    f.sellerTax = g('SellerIdNum', 'SellerTaxID', 'SellerTaxNo', 'XSFNSRSBH', 'Xsfnsrsbh', 'XHFNSRSBH').toUpperCase();
    f.amount = money(g('TotalAmWithoutTax', 'TotalAmountWithoutTax', 'HJJE', 'Hjje', 'TotalAmount'));
    f.tax = money(g('TotalTaxAm', 'TotalTaxAmount', 'HJSE', 'Hjse'));
    f.total = money(g('TotalTax-includedAmount', 'TotalAmountWithTax', 'AmountWithTax', 'JSHJ', 'Jshj'));
    if (f.total == null && f.amount != null && f.tax != null) f.total = r2(f.amount + f.tax);
    var rate = g('TaxRate', 'SL', 'Sl');
    if (rate) {
      if (/免税/.test(rate)) f.rate = 0;
      else { var rv = Number(rate.replace('%', '')); if (isFinite(rv)) f.rate = snapRate(/%/.test(rate) || rv >= 1 ? rv : rv * 100); }
    }
    f.items = g('ItemName', 'XMMC', 'Xmmc', 'GoodsName', 'SPMC');
    var tb = xml.match(/<(?:[\w.-]+:)?EInvoiceType[\s\S]*?<(?:[\w.-]+:)?LabelName>([^<]+)</);
    if (tb) {
      var tn = tb[1].trim();
      f.type = /专用/.test(tn) ? '数电票（专用发票）' : /普通/.test(tn) ? '数电票（普通发票）' : '数电票（' + tn + '）';
    }
    f.cat = inferCategory(f.items, f.seller, f.type);
    return { f: f, notes: [], text: '' };
  }

  /* ---------- OFD ---------- */
  // OFD 是一个 zip 包。inflateRaw(Uint8Array) → Promise<Uint8Array>
  function readZip(buf, inflateRaw) {
    var u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error('不是有效的 OFD 文件'));
    var count = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true);
    var entries = [];
    var dec = new TextDecoder('utf-8'), gbk = null;
    try { gbk = new TextDecoder('gbk'); } catch (e) { /* 不支持 GBK 时按 UTF-8 */ }
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var flag = dv.getUint16(off + 8, true), method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
      var nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      var loc = dv.getUint32(off + 42, true);
      // Windows 里打的压缩包，中文文件名通常是 GBK 编码（没有 UTF-8 标记）
      var raw = u8.subarray(off + 46, off + 46 + nlen);
      var name = (flag & 0x800) || !gbk ? dec.decode(raw) : (/[^\x00-\x7f]/.test(String.fromCharCode.apply(null, raw)) ? gbk.decode(raw) : dec.decode(raw));
      entries.push({ name: name, method: method, csize: csize, loc: loc });
      off += 46 + nlen + elen + clen;
    }
    return Promise.resolve(entries.map(function (e) {
      var readBytes = function () {
        var lnlen = dv.getUint16(e.loc + 26, true), lelen = dv.getUint16(e.loc + 28, true);
        var start = e.loc + 30 + lnlen + lelen, data = u8.subarray(start, start + e.csize);
        return e.method === 0 ? Promise.resolve(data.slice()) : e.method === 8 ? inflateRaw(data) : Promise.reject(new Error('不支持的压缩方式'));
      };
      return {
        name: e.name,
        readBytes: readBytes,
        read: function () { return readBytes().then(function (b) { return dec.decode(b); }); }
      };
    }));
  }
  function ofdTextItems(xml) {
    var items = [], re = /<(?:ofd:)?TextObject\b([^>]*)>([\s\S]*?)<\/(?:ofd:)?TextObject>/g, m;
    while ((m = re.exec(xml))) {
      var b = (m[1].match(/Boundary="([^"]+)"/) || [])[1];
      if (!b) continue;
      var bb = b.trim().split(/\s+/).map(Number);
      var size = Number((m[1].match(/Size="([^"]+)"/) || [])[1]) || bb[3] || 3;
      var codes = m[2].match(/<(?:ofd:)?TextCode\b[^>]*>([\s\S]*?)<\/(?:ofd:)?TextCode>/g) || [];
      codes.forEach(function (tc) {
        var x = Number((tc.match(/\sX="([^"]+)"/) || [])[1]) || 0;
        var y = Number((tc.match(/\sY="([^"]+)"/) || [])[1]) || size;
        var s = decodeEntities(tc.replace(/<[^>]+>/g, ''));
        items.push({ str: s, x: bb[0] + x, y: bb[1] + y - size, w: s.length * size * 0.95, h: size });
      });
    }
    return items;
  }
  function parseOfd(buf, inflateRaw) {
    return readZip(buf, inflateRaw).then(function (entries) {
      var xmls = entries.filter(function (e) { return /\.xml$/i.test(e.name); });
      return Promise.all(xmls.map(function (e) { return e.read().then(function (t) { return { name: e.name, text: t }; }); }));
    }).then(function (files) {
      // 先找随附的发票数据 XML
      for (var i = 0; i < files.length; i++) {
        if (/<(?:[\w.-]+:)?(?:InvoiceNumber|InvoiceNo|EIid|FPHM)\b/i.test(files[i].text)) {
          var x = parseXml(files[i].text);
          if (x.f.no && x.f.total != null) return { res: x, method: 'xml' };
        }
      }
      var pages = files.filter(function (f) { return /Content\.xml$/i.test(f.name); });
      pages.sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (!pages.length) throw new Error('OFD 里没有找到页面内容');
      var res = parseText(buildRows(ofdTextItems(pages[0].text)));
      return { res: res, method: 'ofd' };
    });
  }

  return {
    CATS: CATS, norm: norm, compact: compact, buildRows: buildRows, rowsFromText: rowsFromText, rowsFromPdfItems: rowsFromPdfItems, rowsFromTsv: rowsFromTsv,
    parseText: parseText, parseQr: parseQr, applyQr: applyQr, snapBuyer: snapBuyer, score: score, looksReadable: looksReadable,
    parseXml: parseXml, parseOfd: parseOfd, usccValid: usccValid, fixTaxId: fixTaxId, readZip: readZip, inferCategory: inferCategory, editDistance: editDistance, TAX_ID_RE: TAX_ID_RE
  };
});
