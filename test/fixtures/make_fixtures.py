"""生成测试用的模拟发票（开发用）。

用法：python3 test/fixtures/make_fixtures.py
需要：playwright（Python 版，含 Chromium）、opencv-python、numpy、Pillow，以及系统里的中文字体。

所有公司名称、税号、发票号码均为虚构，仅用于测试识别效果。
生成的文件和 expected.json 会提交到仓库，云端测试直接使用，不需要重新生成。
"""
import base64
import io
import json
import math
import os
import random
import zipfile

import cv2
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
random.seed(7)
np.random.seed(7)


def qr_data_uri(text):
    enc = cv2.QRCodeEncoder.create()
    img = enc.encode(text)
    img = cv2.resize(img, (img.shape[1] * 8, img.shape[0] * 8), interpolation=cv2.INTER_NEAREST)
    img = cv2.copyMakeBorder(img, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=255)
    ok, buf = cv2.imencode('.png', img)
    return 'data:image/png;base64,' + base64.b64encode(buf.tobytes()).decode()


def upper_rmb(n):
    fen = round(n * 100)
    D = '零壹贰叁肆伍陆柒捌玖'
    U = ['', '拾', '佰', '仟', '万', '拾', '佰', '仟', '亿']
    s = str(fen // 100)
    out = ''
    for i, ch in enumerate(s):
        out += D[int(ch)] + U[len(s) - 1 - i]
    import re
    out = re.sub('零[拾佰仟]', '零', out)
    out = re.sub('零+', '零', out)
    out = re.sub('零(万|亿)', r'\1', out)
    out = re.sub('零$', '', out) or '零'
    out += '圆'
    j, f = fen % 100 // 10, fen % 10
    if not j and not f:
        out += '整'
    else:
        out += (D[j] + '角') if j else '零'
        if f:
            out += D[f] + '分'
    return out


CSS = """
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Noto Sans CJK SC', 'Noto Sans CJK JP', sans-serif; color: #2b2b2b; background: #fff; }
.page { width: 1000px; padding: 26px 34px 30px; position: relative; background: #fff; }
.brown { color: #8a5a2b; }
.v { color: #111; }
.title { text-align: center; font-size: 30px; letter-spacing: 4px; color: #a52a1f; font-weight: 700; }
.title u { text-decoration: none; border-bottom: 5px double #a52a1f; padding-bottom: 4px; }
.meta { position: absolute; right: 40px; top: 30px; font-size: 15px; line-height: 1.9; color: #8a5a2b; }
.qr { position: absolute; left: 34px; top: 18px; width: 104px; height: 104px; }
.grid { margin-top: 64px; border: 1.5px solid #8a5a2b; font-size: 15px; }
.row { display: flex; border-top: 1.5px solid #8a5a2b; }
.row:first-child { border-top: none; }
.vlab { width: 30px; border-right: 1.5px solid #8a5a2b; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #8a5a2b; font-size: 15px; line-height: 1.25; padding: 6px 0; }
.cell { padding: 8px 12px; line-height: 2; }
.half { flex: 1; display: flex; }
.half + .half { border-left: 1.5px solid #8a5a2b; }
table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
th { color: #8a5a2b; font-weight: 400; padding: 6px 8px; text-align: center; }
td { padding: 6px 8px; text-align: right; color: #111; }
td.l { text-align: left; }
.items { min-height: 150px; }
.sum td { color: #8a5a2b; }
.sum td.v { color: #111; }
.pwd { font-family: 'DejaVu Sans Mono', monospace; font-size: 13px; line-height: 1.55; color: #111; letter-spacing: 1px; }
.foot { display: flex; gap: 120px; margin-top: 10px; font-size: 15px; color: #8a5a2b; }
"""


def doc(body):
    return '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>' + body + '</body></html>'


def vertical(text):
    return '<div class="vlab">' + ''.join('<span>' + c + '</span>' for c in text) + '</div>'


def sdp(inv):
    """数电票（普通发票 / 专用发票 / 个人抬头）。"""
    items = ''.join(
        '<tr><td class="l">{n}</td><td></td><td>{u}</td><td>{q}</td><td>{p}</td><td>{a}</td><td>{r}</td><td>{t}</td></tr>'.format(**it)
        for it in inv['rows'])
    qr = '<img class="qr" src="' + qr_data_uri(inv['qr']) + '">' if inv.get('qr') else ''
    body = f"""
<div class="page">
  {qr}
  <div class="title"><u>{inv['title']}</u></div>
  <div class="meta">发票号码：<span class="v">{inv['no']}</span><br>开票日期：<span class="v">{inv['date_cn']}</span></div>
  <div class="grid">
    <div class="row">
      <div class="half">{vertical('购买方信息')}<div class="cell brown">名称：<span class="v">{inv['buyer']}</span><br>统一社会信用代码/纳税人识别号：<span class="v">{inv['buyerTax']}</span></div></div>
      <div class="half">{vertical('销售方信息')}<div class="cell brown">名称：<span class="v">{inv['seller']}</span><br>统一社会信用代码/纳税人识别号：<span class="v">{inv['sellerTax']}</span></div></div>
    </div>
    <div class="row items"><table>
      <tr><th style="text-align:left">项目名称</th><th>规格型号</th><th>单 位</th><th>数 量</th><th>单 价</th><th>金 额</th><th>税率/征收率</th><th>税 额</th></tr>
      {items}
      <tr class="sum"><td class="l">合 计</td><td></td><td></td><td></td><td></td><td class="v">¥{inv['amount']:.2f}</td><td></td><td class="v">¥{inv['tax']:.2f}</td></tr>
    </table></div>
    <div class="row"><div class="cell brown" style="flex:1">价税合计（大写）<span class="v">⊗{upper_rmb(inv['total'])}</span></div><div class="cell brown" style="width:260px">（小写）<span class="v">¥{inv['total']:.2f}</span></div></div>
    <div class="row" style="min-height:70px">{vertical('备注')}<div class="cell"></div></div>
  </div>
  <div class="foot"><span>开票人：<span class="v">{inv['drawer']}</span></span></div>
</div>"""
    return doc(body)


def old_dzpp(inv):
    """旧版增值税电子普通发票（有发票代码、8 位号码、密码区）。"""
    pwd = '<br>'.join(inv['pwd'])
    items = ''.join(
        '<tr><td class="l">{n}</td><td></td><td>{u}</td><td>{q}</td><td>{p}</td><td>{a}</td><td>{r}</td><td>{t}</td></tr>'.format(**it)
        for it in inv['rows'])
    body = f"""
<div class="page">
  <img class="qr" src="{qr_data_uri(inv['qr'])}">
  <div class="brown" style="position:absolute;left:150px;top:40px;font-size:14px">机器编号：<span class="v">499099605544</span></div>
  <div class="title" style="margin-top:6px"><u>{inv['title']}</u></div>
  <div class="meta">发票代码：<span class="v">{inv['code']}</span><br>发票号码：<span class="v">{inv['no']}</span><br>开票日期：<span class="v">{inv['date_cn']}</span><br>校 验 码：<span class="v">{inv['check']}</span></div>
  <div class="grid" style="margin-top:96px">
    <div class="row">
      {vertical('购买方')}
      <div class="cell brown" style="flex:1">名　　称：<span class="v">{inv['buyer']}</span><br>纳税人识别号：<span class="v">{inv['buyerTax']}</span><br>地 址、电 话：<br>开户行及账号：</div>
      {vertical('密码区')}
      <div class="cell pwd" style="width:330px">{pwd}</div>
    </div>
    <div class="row items"><table>
      <tr><th style="text-align:left">货物或应税劳务、服务名称</th><th>规格型号</th><th>单位</th><th>数 量</th><th>单 价</th><th>金 额</th><th>税率</th><th>税 额</th></tr>
      {items}
      <tr class="sum"><td class="l">合　　计</td><td></td><td></td><td></td><td></td><td class="v">¥{inv['amount']:.2f}</td><td></td><td class="v">¥{inv['tax']:.2f}</td></tr>
    </table></div>
    <div class="row"><div class="cell brown" style="flex:1">价税合计（大写）<span class="v">⊗{upper_rmb(inv['total'])}</span></div><div class="cell brown" style="width:260px">（小写）<span class="v">¥{inv['total']:.2f}</span></div></div>
    <div class="row">
      {vertical('销售方')}
      <div class="cell brown" style="flex:1">名　　称：<span class="v">{inv['seller']}</span><br>纳税人识别号：<span class="v">{inv['sellerTax']}</span><br>地 址、电 话：<span class="v">杭州市西湖区杨公堤18号 0571-87979889</span><br>开户行及账号：<span class="v">中国工商银行杭州西湖支行 1202020809900012345</span></div>
      {vertical('备注')}
      <div class="cell" style="width:330px"></div>
    </div>
  </div>
  <div class="foot"><span>收款人：</span><span>复核：</span><span>开票人：<span class="v">{inv['drawer']}</span></span><span>销售方：（章）</span></div>
</div>"""
    return doc(body)


def rail(inv):
    body = f"""
<div class="page" style="width:900px">
  <div class="title" style="font-size:26px"><u>{inv['title']}</u></div>
  <div class="brown" style="display:flex;justify-content:space-between;margin-top:18px;font-size:15px">
    <span>发票号码：<span class="v">{inv['no']}</span></span><span>开票日期：<span class="v">{inv['date_cn']}</span></span>
  </div>
  <div class="grid" style="margin-top:14px;padding:18px 26px;font-size:17px">
    <div style="display:flex;justify-content:space-between;align-items:center;font-size:24px" class="v">
      <span>上海虹桥 站</span><span style="font-size:18px">G7365</span><span>杭州东 站</span>
    </div>
    <div style="display:flex;justify-content:space-between;color:#555;font-size:14px"><span>Shanghaihongqiao</span><span>Hangzhoudong</span></div>
    <div class="v" style="margin-top:12px;display:flex;gap:40px"><span>2026年10月19日 14:05开</span><span>06车12F号</span><span>二等座</span></div>
    <div class="v" style="margin-top:8px;font-size:22px">￥{inv['total']:.2f}</div>
    <div class="v" style="margin-top:8px;font-size:15px">3101011990****1234 王磊</div>
    <div class="brown" style="margin-top:14px;font-size:15px">电子客票号：<span class="v">6510261019073651200123</span></div>
    <div class="brown" style="margin-top:6px;font-size:15px">购买方名称：<span class="v">{inv['buyer']}</span>　　统一社会信用代码：<span class="v">{inv['buyerTax']}</span></div>
  </div>
</div>"""
    return doc(body)


BUYER = '上海示例科技有限公司'
BUYER_TAX = '91310115MA1K4A2B3A'

INVOICES = [
    dict(kind='sdp', id='sdp-canyin', title='电子发票（普通发票）', type='数电票（普通发票）', cat='餐饮',
         no='26312000000207718804', date='2026-10-22', buyer=BUYER, buyerTax=BUYER_TAX,
         seller='上海小南国餐饮有限公司', sellerTax='913101016074123858',
         amount=1754.72, tax=105.28, total=1860.00, rate=6, items='*餐饮服务*餐费', drawer='张敏',
         rows=[dict(n='*餐饮服务*餐费', u='', q='1', p='1754.72', a='1754.72', r='6%', t='105.28')],
         qr='01,32,,26312000000207718804,1754.72,20261022,,8A3F'),
    dict(kind='sdp', id='sdp-zhuanpiao', title='电子发票（增值税专用发票）', type='数电票（专用发票）', cat='办公用品',
         no='26112000000310087642', date='2026-10-08', buyer=BUYER, buyerTax=BUYER_TAX,
         seller='北京京东世纪贸易有限公司', sellerTax='91110302MA01B2C3DK',
         amount=1592.92, tax=207.08, total=1800.00, rate=13, items='*计算机外部设备*显示器', drawer='李华',
         rows=[dict(n='*计算机外部设备*显示器', u='台', q='2', p='796.46', a='1592.92', r='13%', t='207.08')],
         qr='01,31,,26112000000310087642,1592.92,20261008,,C41E'),
    dict(kind='sdp', id='sdp-geren', title='电子发票（普通发票）', type='数电票（普通发票）', cat='交通',
         no='26442000000091273518', date='2026-10-20', buyer='王磊', buyerTax='',
         seller='滴滴出行科技有限公司', sellerTax='91120116MA05M8XX10',
         amount=83.98, tax=2.52, total=86.50, rate=3, items='*运输服务*客运服务费', drawer='系统',
         rows=[dict(n='*运输服务*客运服务费', u='次', q='1', p='83.98', a='83.98', r='3%', t='2.52')],
         qr='01,32,,26442000000091273518,83.98,20261020,,77D0'),
    dict(kind='old', id='old-zhusu', title='浙江增值税电子普通发票', type='增值税电子普通发票', cat='住宿',
         code='033002000111', no='38291746', date='2026-09-30', buyer=BUYER, buyerTax=BUYER_TAX,
         seller='杭州西湖国宾馆有限公司', sellerTax='91330100143059876E',
         amount=528.30, tax=31.70, total=560.00, rate=6, items='*住宿服务*住宿费', drawer='陈晓',
         check='12345 67890 12345 67890',
         pwd=['03<*+2-/>9<6/>1*54+3<<0+8-/23', '/9>6-*1<+05>>7/2*35-6<0+71>49', '1<*7/0>-+2<8/96>-3*+15<0/>63', '+-2>*07/<69-1+>3<4/*8-05+7>12'],
         rows=[dict(n='*住宿服务*住宿费', u='间夜', q='1', p='528.30', a='528.30', r='6%', t='31.70')],
         qr='01,10,033002000111,38291746,528.30,20260930,12345678901234567890,ABCD'),
    dict(kind='sdp', id='sdp-mingxi', title='电子发票（普通发票）', type='数电票（普通发票）', cat='其他',
         no='26612000000425517093', date='2026-10-16', buyer=BUYER, buyerTax=BUYER_TAX,
         seller='子洲县示例建材经销部', sellerTax='91610827MA6YC3K2EY',
         amount=154381.19, tax=1543.81, total=155925.00, rate=1, items='*非金属矿物制品*红砖等', drawer='马建东',
         rows=[dict(n='*非金属矿物制品*红砖', u='块', q='83500', p='0.6237623762376', a='52084.16', r='1%', t='520.84'),
               dict(n='*非金属矿物制品*沙子', u='m³', q='280', p='193.0693069307', a='54059.41', r='1%', t='540.59'),
               dict(n='*非金属矿物制品*水泥', u='吨', q='105', p='459.4059405941', a='48237.62', r='1%', t='482.38')],
         qr='01,32,,26612000000425517093,154381.19,20261016,,5E21'),
    dict(kind='rail', id='rail', title='电子发票（铁路电子客票）', type='电子发票（铁路电子客票）', cat='交通',
         no='26319166000003651200', date='2026-10-19', buyer=BUYER, buyerTax=BUYER_TAX,
         seller='铁路电子客票（票面无销售方）', sellerTax='', amount=66.97, tax=6.03, total=73.00, rate=9, items=''),
]

for inv in INVOICES:
    y, m, d = inv['date'].split('-')
    inv['date_cn'] = f'{y}年{m}月{d}日'


def html_for(inv):
    return {'sdp': sdp, 'old': old_dzpp, 'rail': rail}[inv['kind']](inv)


def degrade_photo(png_bytes, angle=1.6):
    """模拟手机拍照：轻微旋转、透视、阴影、模糊、噪点、JPEG 压缩。"""
    img = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_COLOR)
    h, w = img.shape[:2]
    pad = 60
    img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(214, 222, 228))
    h2, w2 = img.shape[:2]
    src = np.float32([[0, 0], [w2, 0], [w2, h2], [0, h2]])
    dst = np.float32([[18, 10], [w2 - 6, 26], [w2 - 22, h2 - 8], [4, h2 - 20]])
    M = cv2.getPerspectiveTransform(src, dst)
    img = cv2.warpPerspective(img, M, (w2, h2), borderValue=(214, 222, 228))
    R = cv2.getRotationMatrix2D((w2 / 2, h2 / 2), angle, 1.0)
    img = cv2.warpAffine(img, R, (w2, h2), borderValue=(214, 222, 228))
    yy, xx = np.mgrid[0:h2, 0:w2]
    shade = 0.80 + 0.20 * (xx / w2) * (0.6 + 0.4 * (yy / h2))
    img = np.clip(img.astype(np.float32) * shade[..., None], 0, 255)
    img = cv2.GaussianBlur(img, (3, 3), 0.9)
    img = np.clip(img + np.random.normal(0, 6, img.shape), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 72])
    return buf.tobytes()


def xml_items(inv):
    out = []
    for r in inv['rows']:
        out.append(f"""    <IssuItemInformation>
      <ItemName>{r['n']}</ItemName>
      <SpecMod></SpecMod>
      <MeaUnits>{r['u']}</MeaUnits>
      <Quantity>{r['q']}</Quantity>
      <UnPrice>{r['p']}</UnPrice>
      <Amount>{r['a']}</Amount>
      <TaxRate>{int(r['r'].rstrip('%')) / 100:.2f}</TaxRate>
      <ComTaxAm>{r['t']}</ComTaxAm>
    </IssuItemInformation>""")
    return '\n'.join(out)


def xml_for(inv):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<EInvoice>
  <Header>
    <EIid>{inv['no']}</EIid>
    <EInvoiceTag>SWEI3100</EInvoiceTag>
    <Version>0.1</Version>
    <InherentLabel>
      <EInvoiceType><LabelCode>02</LabelCode><LabelName>普通发票</LabelName></EInvoiceType>
    </InherentLabel>
  </Header>
  <EInvoiceData>
    <SellerInformation>
      <SellerIdNum>{inv['sellerTax']}</SellerIdNum>
      <SellerName>{inv['seller']}</SellerName>
    </SellerInformation>
    <BuyerInformation>
      <BuyerIdNum>{inv['buyerTax']}</BuyerIdNum>
      <BuyerName>{inv['buyer']}</BuyerName>
    </BuyerInformation>
    <BasicInformation>
      <TotalAmWithoutTax>{inv['amount']:.2f}</TotalAmWithoutTax>
      <TotalTaxAm>{inv['tax']:.2f}</TotalTaxAm>
      <TotalTax-includedAmount>{inv['total']:.2f}</TotalTax-includedAmount>
      <TotalTax-includedAmountInChinese>{upper_rmb(inv['total'])}</TotalTax-includedAmountInChinese>
      <Drawer>{inv['drawer']}</Drawer>
      <RequestTime>{inv['date']} 12:31:05</RequestTime>
    </BasicInformation>
{xml_items(inv)}
  </EInvoiceData>
  <TaxSupervisionInfo>
    <InvoiceNumber>{inv['no']}</InvoiceNumber>
    <IssueTime>{inv['date']} 12:31:05</IssueTime>
    <TaxBureauCode>13100000000</TaxBureauCode>
  </TaxSupervisionInfo>
</EInvoice>
"""


def ofd_for(inv):
    """最简 OFD：一个页面的 TextObject（单位毫米）。只用来测试 OFD 文字读取。"""
    objs = []
    oid = [1]

    def t(x, y, s, size=3.2):
        oid[0] += 1
        w = max(1.0, len(s) * size)
        objs.append(f'<ofd:TextObject ID="{oid[0]}" Boundary="{x:.2f} {y:.2f} {w:.2f} {size * 1.4:.2f}" Font="3" Size="{size}">'
                    f'<ofd:TextCode X="0" Y="{size:.2f}">{s}</ofd:TextCode></ofd:TextObject>')

    t(70, 8, inv['title'], 5)
    t(140, 14, '发票号码：'), t(158, 14, inv['no'])
    t(140, 20, '开票日期：'), t(158, 20, inv['date_cn'])
    t(8, 34, '购'), t(14, 34, '名称：'), t(26, 34, inv['buyer'])
    t(108, 34, '销'), t(114, 34, '名称：'), t(126, 34, inv['seller'])
    t(14, 41, '统一社会信用代码/纳税人识别号：'), t(64, 41, inv['buyerTax'])
    t(114, 41, '统一社会信用代码/纳税人识别号：'), t(164, 41, inv['sellerTax'])
    t(14, 55, '项目名称'), t(120, 55, '金额'), t(150, 55, '税率/征收率'), t(180, 55, '税额')
    t(14, 62, inv['items']), t(118, 62, f"{inv['amount']:.2f}"), t(152, 62, f"{inv['rate']}%"), t(178, 62, f"{inv['tax']:.2f}")
    t(14, 90, '合计'), t(116, 90, f"¥{inv['amount']:.2f}"), t(176, 90, f"¥{inv['tax']:.2f}")
    t(14, 98, '价税合计（大写）'), t(44, 98, '⊗' + upper_rmb(inv['total'])), t(140, 98, '（小写）'), t(156, 98, f"¥{inv['total']:.2f}")
    t(14, 120, '开票人：'), t(28, 120, inv['drawer'])
    content = ('<?xml version="1.0" encoding="UTF-8"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:Layer ID="1">'
               + ''.join(objs) + '</ofd:Layer></ofd:Content></ofd:Page>')
    ofd_xml = ('<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.1" DocType="OFD">'
               '<ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>')
    document = ('<?xml version="1.0" encoding="UTF-8"?><ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Pages>'
                '<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages></ofd:Document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('OFD.xml', ofd_xml)
        z.writestr('Doc_0/Document.xml', document)
        z.writestr('Doc_0/Pages/Page_0/Content.xml', content)
    return buf.getvalue()


def cid_pdf(inv, path):
    """用不内嵌的 STSong-Light 字体（UniGB-UCS2-H 编码）生成 PDF，很多开票系统都这样出 PDF，读取时需要 CMap。"""
    from reportlab.pdfgen import canvas as rl
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    W, H = 600, 380
    c = rl.Canvas(path, pagesize=(W, H))
    def t(x, y, s, size=9):
        c.setFont('STSong-Light', size); c.drawString(x, H - y, s)
    t(200, 34, inv['title'], 15)
    t(420, 30, '发票代码：' + inv['code']); t(420, 44, '发票号码：' + inv['no'])
    t(420, 58, '开票日期：' + inv['date_cn']); t(420, 72, '校 验 码：' + inv['check'])
    c.rect(20, H - 170, 560, 80)
    t(26, 112, '购'); t(26, 124, '买'); t(26, 136, '方')
    t(44, 106, '名    称：' + inv['buyer']); t(44, 122, '纳税人识别号：' + inv['buyerTax'])
    t(44, 138, '地 址、电 话：'); t(44, 154, '开户行及账号：')
    t(330, 112, '密'); t(330, 124, '码'); t(330, 136, '区')
    for i, l in enumerate(inv['pwd']):
        t(348, 106 + i * 14, l, 8)
    t(26, 186, '货物或应税劳务、服务名称'); t(330, 186, '金 额'); t(420, 186, '税率'); t(500, 186, '税 额')
    r = inv['rows'][0]
    t(26, 204, r['n']); t(330, 204, r['a']); t(420, 204, r['r']); t(500, 204, r['t'])
    t(26, 240, '合    计'); t(326, 240, '¥%.2f' % inv['amount']); t(496, 240, '¥%.2f' % inv['tax'])
    t(26, 262, '价税合计（大写）  ⊗' + upper_rmb(inv['total'])); t(400, 262, '（小写）¥%.2f' % inv['total'])
    t(26, 290, '销'); t(26, 302, '售'); t(26, 314, '方')
    t(44, 288, '名    称：' + inv['seller']); t(44, 304, '纳税人识别号：' + inv['sellerTax'])
    t(44, 320, '地 址、电 话：杭州市西湖区杨公堤18号 0571-87979889')
    t(26, 356, '收款人：'); t(160, 356, '复核：'); t(300, 356, '开票人：' + inv['drawer']); t(440, 356, '销售方：（章）')
    c.save()


def lines_of(inv, keys=None):
    out = []
    for r in inv.get('rows', []):
        l = dict(name=r['n'], unit=r['u'], qty=float(r['q']), price=float(r['p']), amount=float(r['a']), rate=float(r['r'].rstrip('%')), tax=float(r['t']))
        out.append({k: v for k, v in l.items() if not keys or k in keys})
    return out


def expected(inv, method, line_keys=None):
    e = {k: inv[k] for k in ('no', 'date', 'buyer', 'buyerTax', 'seller', 'sellerTax', 'total', 'rate', 'cat')}
    if inv['amount'] is not None:
        e['amount'] = inv['amount']
        e['tax'] = inv['tax']
    if inv.get('code'):
        e['code'] = inv['code']
    if inv.get('items'):
        e['items'] = inv['items']
    e['type'] = inv['type']
    e['method'] = method
    if inv.get('rows'):
        e['lines'] = lines_of(inv, line_keys)
    return e


def main():
    exp = {}
    byid = {i['id']: i for i in INVOICES}
    with sync_playwright() as p:
        b = p.chromium.launch()
        for inv in INVOICES:
            html = html_for(inv)
            pg = b.new_page(viewport={'width': 1060, 'height': 760}, device_scale_factor=1)
            pg.set_content(html)
            pg.wait_for_timeout(200)
            box = pg.locator('.page').bounding_box()
            pdf_path = os.path.join(HERE, inv['id'] + '.pdf')
            pg.pdf(path=pdf_path, width=f"{math.ceil(box['width']) + 2}px", height=f"{math.ceil(box['height']) + 2}px",
                   print_background=True, margin={'top': '0', 'right': '0', 'bottom': '0', 'left': '0'})
            exp[inv['id'] + '.pdf'] = expected(inv, 'pdf-text')
            pg.close()

        # 截图类：微信截图大小（1 倍）、高清截图（2 倍）
        for iid, scale, name in [('sdp-canyin', 1, 'sdp-canyin-screenshot.png'), ('old-zhusu', 2, 'old-zhusu-hd.png'),
                                 ('sdp-geren', 1.25, 'sdp-geren-screenshot.png'), ('sdp-mingxi', 1.5, 'sdp-mingxi-screenshot.png')]:
            inv = byid[iid]
            pg = b.new_page(viewport={'width': 1060, 'height': 760}, device_scale_factor=scale)
            pg.set_content(html_for(inv))
            pg.wait_for_timeout(200)
            pg.locator('.page').screenshot(path=os.path.join(HERE, name))
            exp[name] = expected(inv, 'ocr')
            pg.close()

        # 拍照效果
        inv = byid['sdp-zhuanpiao']
        pg = b.new_page(viewport={'width': 1060, 'height': 760}, device_scale_factor=1.6)
        pg.set_content(html_for(inv))
        pg.wait_for_timeout(200)
        png = pg.locator('.page').screenshot()
        with open(os.path.join(HERE, 'sdp-zhuanpiao-photo.jpg'), 'wb') as f:
            f.write(degrade_photo(png))
        exp['sdp-zhuanpiao-photo.jpg'] = expected(inv, 'ocr')
        pg.close()
        b.close()

    inv = byid['old-zhusu']
    cid_pdf(inv, os.path.join(HERE, 'old-zhusu-stsong.pdf'))
    exp['old-zhusu-stsong.pdf'] = expected(inv, 'pdf-text', ['name', 'amount', 'rate', 'tax'])

    inv = byid['sdp-canyin']
    with open(os.path.join(HERE, 'sdp-canyin.xml'), 'w', encoding='utf-8') as f:
        f.write(xml_for(inv))
    e = expected(inv, 'xml')
    e['type'] = '数电票（普通发票）'
    exp['sdp-canyin.xml'] = e

    inv = byid['sdp-zhuanpiao']
    with open(os.path.join(HERE, 'sdp-zhuanpiao.ofd'), 'wb') as f:
        f.write(ofd_for(inv))
    exp['sdp-zhuanpiao.ofd'] = expected(inv, 'ofd', ['name', 'amount', 'rate', 'tax'])

    # 二维码内容（用于二维码解码测试）
    exp['_qr'] = {i['id']: i['qr'] for i in INVOICES if i.get('qr')}
    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(exp, f, ensure_ascii=False, indent=2)
    print('生成完成：', ', '.join(sorted(k for k in exp if not k.startswith('_'))))


if __name__ == '__main__':
    main()
