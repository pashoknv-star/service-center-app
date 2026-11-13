// V6-6 (вне gate): реальный Chromium 1280 — зона 3 называется «Управление СЦ»: плитка (плашка), строка группы в матрице,
// <select id="editDept">, золото/бриллианты/строка директора вверху без изменений.
// Запуск: node scripts/v6_accept_v66.js  → reports/V6/V6-6_screens/*.png, V66_results.json
// Каркас — v6_accept_lib.js / v6_accept_seed.js (php -S на КОПИИ data/app.db; пароли в браузер не вводятся).
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const { seed } = require('./v6_accept_seed.js');
const OUT = path.join(L.ROOT, 'reports/V6/V6-6_screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'V66_results.json'));
  try {
    const s = await seed(env);
    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const NEW = 'Управление СЦ', OLD = 'Директор' + ' СЦ', OLD0 = 'В' + '2С';
    for (const [w, h, mob, tag] of [[1280, 800, false, '1280']]) {
      console.log('=== viewport ' + tag);
      await k.size(w, h, mob);
      await k.load(s.adminCookies);
      // ---------- плитка
      await cdp.ev(`(() => { const z=document.querySelector('.zone[data-zone="3"]'); z.scrollIntoView({block:'center'}); document.querySelectorAll('.zone *').forEach(e=>{ if(e.scrollLeft>0) e.scrollLeft=0;}); })()`);
      await sleep(500);
      await cdp.ev('(() => { const t=document.getElementById("vacationTrigger"); if(t) t.style.visibility="hidden"; })()');
      await k.shot('V66_01_main_zone3_context_' + tag);
      await k.shotEl('.zone[data-zone="3"]', 'V66_02_zone3_closeup_' + tag, { scale: 2 });
      const zi = await cdp.ev(`(() => {
        const z = document.querySelector('.zone[data-zone="3"]'), zt = z.querySelector('.zt'), ti = z.querySelector('.zt-title');
        const zr = zt.getBoundingClientRect(), tr = ti.getBoundingClientRect();
        const b = getComputedStyle(zt, '::before');
        const all = [...document.querySelectorAll('.zone .zt-title')].map(e => e.textContent.trim());
        return { title: ti.textContent.trim(), allTitles: all, wm: getComputedStyle(ti).writingMode, ztRect: [Math.round(zr.left), Math.round(zr.top), Math.round(zr.width), Math.round(zr.height)], titleRect: [Math.round(tr.left), Math.round(tr.top), Math.round(tr.width), Math.round(tr.height)],
          titleInsidePlaque: tr.left >= zr.left - 1 && tr.right <= zr.right + 1 && tr.top >= zr.top - 1 && tr.bottom <= zr.bottom + 1,
          scrollOverflow: ti.scrollHeight > ti.clientHeight + 1 || ti.scrollWidth > ti.clientWidth + 1,
          gemLayers: (b.backgroundImage.match(/url\\(/g) || []).length, beforeAnim: b.animationName,
          zBg: getComputedStyle(z).backgroundImage.slice(0, 120), emp: z.querySelectorAll('article.employee').length };
      })()`);
      console.log(JSON.stringify(zi));
      C.note('zone3_' + tag, zi);
      C.check(tag + ' плитка (боковая плашка) называется «' + NEW + '»', zi.title === NEW, zi.title);
      C.check(tag + ' в DOM нет прежних имён зоны («' + OLD + '», «' + OLD0 + '») среди плашек', !zi.allTitles.some((t) => t === OLD || t === OLD0) && zi.allTitles.length === 7, JSON.stringify(zi.allTitles));
      C.check(tag + ' название целиком внутри боковой плашки, без переполнения/обрезки', zi.titleInsidePlaque && !zi.scrollOverflow, JSON.stringify([zi.ztRect, zi.titleRect, zi.scrollOverflow]));
      C.check(tag + ' золото и бриллианты без изменений: градиент зоны, 5–9 бриллиантов, без анимации', /gradient/.test(zi.zBg) && zi.gemLayers >= 5 && zi.gemLayers <= 9 && (zi.beforeAnim === 'none' || !zi.beforeAnim), JSON.stringify([zi.zBg, zi.gemLayers, zi.beforeAnim]));
      // ---------- форма правки: <select id="editDept">
      const sel = await cdp.ev(`[...document.querySelectorAll('#editDept option')].map(o => o.value + ':' + o.textContent.trim())`);
      C.note('editDept', sel);
      C.check(tag + ' <select id="editDept">: option 3 = «' + NEW + '», 7 опций', sel.length === 7 && sel[3] === '3:' + NEW && !sel.some((o) => o.includes(OLD) || o.includes(OLD0)), JSON.stringify(sel));
      // ---------- матрица
      await cdp.ev('document.getElementById("vacationTrigger").style.visibility=""');
      await k.click('#vacationTrigger'); await sleep(700);
      await cdp.ev('document.getElementById("tabMatrix").click()'); await sleep(500);
      await cdp.ev('window.openMatrixAt({employeeId:"emp_101", date:"2026-11-18"})'); await sleep(2800);
      const mi = await cdp.ev(`(() => {
        const rows = [...document.querySelectorAll('#matrixBody tr')];
        const groups = rows.filter(r => r.classList.contains('matrix-group-row')).map(r => (r.querySelector('.matrix-group-label')||r).textContent.trim());
        const firstEmpRow = rows.find(r => r.querySelector('.name-col[data-emp-id]'));
        const g0 = rows.find(r => r.classList.contains('matrix-group-row'));
        const lab = g0.querySelector('.matrix-group-label');
        return { groups, firstEmp: firstEmpRow.querySelector('.name-col').textContent.trim().slice(0, 40), firstIsDirectorRow: firstEmpRow.classList.contains('matrix-row-director'),
                 firstGroupIsDirectorClass: g0.classList.contains('matrix-group-director'), labelOverflow: lab.scrollWidth > lab.clientWidth + 1, dirRows: rows.filter(r => r.classList.contains('matrix-row-director')).length };
      })()`);
      console.log(JSON.stringify(mi));
      C.note('matrix_' + tag, mi);
      C.check(tag + ' матрица: верхняя группа называется «' + NEW + '», первая строка — директор (золотой класс), одна строка зоны 3', mi.groups[0] === NEW && mi.firstIsDirectorRow && mi.firstGroupIsDirectorClass && mi.dirRows === 1 && /Директор Тестов/.test(mi.firstEmp), JSON.stringify(mi));
      C.check(tag + ' подпись группы в матрице читается целиком (без обрезки)', mi.labelOverflow === false, JSON.stringify(mi));
      C.check(tag + ' в матрице нет прежних имён зоны', !mi.groups.some((g) => g === OLD || g === OLD0), JSON.stringify(mi.groups));
      await cdp.ev('document.querySelector("#matrixBody").scrollIntoView({block:"start"})');
      await k.shot('V66_03_matrix_group_row_' + tag);
      await k.shotEl('#matrixBody tr.matrix-group-director', 'V66_04_matrix_group_label_closeup_' + tag, { scale: 2 });
    }
    C.check('в консоли страницы нет исключений', cdp.exceptions.length === 0, cdp.exceptions.join('|'));
  } catch (e) {
    console.log('ОШИБКА', e && e.stack || e); C.check('скрипт дошёл до конца без исключения', false, e && e.message);
  } finally {
    C.save(); env.cleanup();
    console.log('RESULT: ' + C.passed + ' passed, ' + C.failed + ' failed');
    process.exit(C.failed ? 1 : 0);
  }
})();
