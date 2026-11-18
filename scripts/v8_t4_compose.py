#!/usr/bin/env python3
# V8-T4 (вне gate): склеивает «Новая задача | Новая командировка» рядом из T4_raw_<фаза>_{task|trip}_{1440|375}.png
# и печатает измеренные различия стилей (из $TMPDIR/v8_t4_measure_<фаза>.json). Запуск: python3 scripts/v8_t4_compose.py
import json, os, sys
from PIL import Image, ImageDraw
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'reports', 'V8', 'screens')
T = os.environ.get('TMPDIR', '/tmp')

def trim_h(im, pad=16):
    # обрезать нижнее пустое место: последняя строка с «чернилами» (не белая/не фон) + отступ
    g = im.convert('L'); w, h = g.size
    last = 0
    px = g.load()
    for y in range(h - 1, 0, -1):
        if any(px[x, y] < 200 for x in range(2, w - 2, 2)):
            last = y; break
    return min(h, last + pad)

for W in (1440, 375):
    for ph in ('before', 'after'):
        a = Image.open(os.path.join(D, 'T4_raw_%s_task_%d.png' % (ph, W))).convert('RGB')
        b = Image.open(os.path.join(D, 'T4_raw_%s_trip_%d.png' % (ph, W))).convert('RGB')
        # у 1440 панель 1203/1073 px шириной; оставляем как снято
        h = max(trim_h(a), trim_h(b)) if W == 375 else max(trim_h(a), trim_h(b))
        # правая часть кадра 1440 — фон страницы; режем до ширины панели + поля
        cw = 1210 if W == 1440 else 375
        a = a.crop((0, 0, min(cw, a.width), h)); b = b.crop((0, 0, min(cw, b.width), h))
        gap = 24; top = 28
        out = Image.new('RGB', (a.width + b.width + gap, h + top), (230, 230, 235))
        dr = ImageDraw.Draw(out)
        try:
            from PIL import ImageFont
            fnt = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 13)
        except Exception:
            fnt = None
        dr.text((6, 7), 'ЗАДАЧА (эталон) — %s, %d px' % (ph, W), fill=(0, 0, 0), font=fnt)
        dr.text((a.width + gap + 6, 7), 'КОМАНДИРОВКА — %s, %d px' % (ph, W), fill=(0, 0, 0), font=fnt)
        out.paste(a, (0, top)); out.paste(b, (a.width + gap, top))
        name = os.path.join(D, 'T4_%s_%d.png' % (ph, W))
        out.save(name); print('saved', name, out.size)

for ph in ('before', 'after'):
    f = os.path.join(T, 'v8_t4_measure_%s.json' % ph)
    if not os.path.exists(f): continue
    m = json.load(open(f))
    for W in (1440, 375):
        t, r = m['task_%d' % W], m['trip_%d' % W]
        diffs = []
        for k in ('h', 'label', 'input', 'textarea', 'actions'):
            for fld in ('font', 'color', 'bg', 'border', 'radius', 'pad', 'margin', 'tt', 'x', 'w'):
                if t[k][fld] != r[k][fld]:
                    diffs.append('%s.%s: задача=%s | командировка=%s' % (k, fld, t[k][fld], r[k][fld]))
        print('== %s %d: различий стилей %d' % (ph, W, len(diffs)))
        for d in diffs: print('  ', d)
        print('  кнопки задачи:', [(x['text'], x['bg'], x['pad'], x['radius']) for x in t['btns']])
        print('  кнопки поездки:', [(x['text'], x['bg'], x['pad'], x['radius']) for x in r['btns']])
