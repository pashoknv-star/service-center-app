#!/usr/bin/env node
// V8-T4 (вне gate): скриншоты форм «Новая задача» и «Новая командировка» при одной ширине (1440 и 375 px).
// Реальный headless Chromium по CDP + php -S на КОПИИ data/app.db. Пароли не вводятся (cookie от api/login.php).
// Запуск: node scripts/v8_t4_shots.js <фаза: before|after> [каталог (по умолчанию reports/V8/screens)]
//   пишет <каталог>/T4_raw_<фаза>_{task|trip}_{1440|375}.png (панель целиком; окно высотой, достаточной для формы)
//   и печатает измеренные стили (шрифт/цвета/отступы подписей, полей, кнопок) — JSON в stdout для отчёта.
'use strict';
const fs = require('fs'), path = require('path');
const L = require('./v6_accept_lib.js');
const sleep = L.sleep;
const phase = process.argv[2] || 'before';
const outDir = process.argv[3] || path.join(L.ROOT, 'reports/V8/screens');

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const env = await L.startEnv();
  try {
    const admin = (await L.login(env.base, 'admin')).join('; ');
    const { cdp } = await env.openBrowser();
    const k = L.pageKit(cdp, env.base, outDir);
    const ev = (x) => cdp.ev(x);
    const q = JSON.stringify;
    const measure = {};
    for (const [W, H] of [[1440, 1500], [375, 2300]]) {
      await k.size(W, H, W < 600);
      await k.setCookies(admin.split('; '));
      await cdp.send('Page.navigate', { url: env.base + '/index.html' });
      if (!await k.waitFor('!!(window.Trips && window.Tasks && document.querySelectorAll(".day-cell-data").length > 0 && document.getElementById("tabTrips"))', 40000)) throw new Error('страница не загрузилась');
      await k.waitFor('!!Trips.getCurrentUser()', 8000);
      await sleep(600);
      // ---- форма новой задачи
      await ev('document.getElementById("vacationPanel").classList.add("open")');
      await ev('document.getElementById("tabTasks").click()');
      await sleep(500);
      await ev('document.querySelector("[data-tk-act=newTask]").click()');
      await sleep(400);
      await ev('(() => { const t = document.querySelector("[data-tk-field=title]"); t.value = "Подготовить отчёт по объекту"; t.dispatchEvent(new Event("input", {bubbles:true})); })()');
      await sleep(200);
      measure['task_' + W] = await ev(`(() => {
        const cs = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return { font: s.fontSize + ' ' + s.fontWeight + ' ' + s.fontFamily.split(',')[0], color: s.color, bg: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderTopColor, radius: s.borderTopLeftRadius, pad: s.padding, margin: s.margin, tt: s.textTransform, x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
        const f = document.querySelector('.tk-form');
        const lab = f.querySelector('.tk-f > label'), inp = f.querySelector('[data-tk-field=title]'), ta = f.querySelector('textarea');
        const btns = [...f.querySelectorAll('.tk-actions button')];
        return { form: cs(f), h: cs(f.querySelector('h4')), label: cs(lab), input: cs(inp), textarea: cs(ta), btns: btns.map(b => Object.assign({ text: b.textContent.trim() }, cs(b))), actions: cs(f.querySelector('.tk-actions')) };
      })()`);
      await k.shotEl('#vacationPanel', 'T4_raw_' + phase + '_task_' + W);
      // ---- форма новой командировки
      await ev('document.getElementById("tabTrips").click()');
      await sleep(300);
      await ev('(document.getElementById("newTripBtn")||{click(){}}).click()');
      if (!await k.waitFor('!!document.getElementById("tripTitle")', 8000)) throw new Error('форма командировки не открылась');
      await ev('(() => { const t = document.getElementById("tripTitle"); t.value = "Командировка на объект"; document.getElementById("tripLocation").value = "Казань"; })()');
      await ev('Trips.addParticipantRow && Trips.addParticipantRow()');
      await sleep(400);
      measure['trip_' + W] = await ev(`(() => {
        const cs = (e) => { if (!e) return null; const s = getComputedStyle(e), r = e.getBoundingClientRect(); return { font: s.fontSize + ' ' + s.fontWeight + ' ' + s.fontFamily.split(',')[0], color: s.color, bg: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderTopColor, radius: s.borderTopLeftRadius, pad: s.padding, margin: s.margin, tt: s.textTransform, x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
        const f = document.getElementById('tripFormPanel');
        const btns = [...f.querySelectorAll('.trip-panel-actions button')].filter(b => b.offsetParent !== null);
        return { form: cs(f), h: cs(f.querySelector('h2, h4')), label: cs(f.querySelector('.trip-form-label')), input: cs(document.getElementById('tripTitle')), textarea: cs(document.getElementById('tripComment')), btns: btns.map(b => Object.assign({ text: b.textContent.trim() }, cs(b))), actions: cs(f.querySelector('.trip-panel-actions')), cols: f.querySelectorAll(".trip-form-columns").length };
      })()`);
      await k.shotEl('#vacationPanel', 'T4_raw_' + phase + '_trip_' + W);
      await ev('Trips.closeTripForm()');
    }
    console.log(JSON.stringify(measure, null, 1));
    fs.writeFileSync(path.join(process.env.TMPDIR || '/tmp', 'v8_t4_measure_' + phase + '.json'), JSON.stringify(measure, null, 1));
  } finally { env.cleanup(); }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
