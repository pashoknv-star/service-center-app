// V6-4 (приёмка, вне gate): A — «Директор СЦ» (R-2): золотая плитка, матрица, openMatrixAt, иконки задач.
// Запуск: node scripts/v6_accept_a_director.js  → reports/V6/V6-4_screens/A_*.png, A_results.json
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const { seed, D } = require('./v6_accept_seed.js');
const OUT = path.join(L.ROOT, 'reports/V6/V6-4_screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'A_results.json'));
  try {
    const s = await seed(env);
    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const tz = (sel) => cdp.ev(sel);

    for (const vp of [[1280, 800, false, '1280'], [375, 740, true, '375']]) {
      const [w, h, mob, tag] = vp;
      console.log('=== viewport ' + tag);
      await k.size(w, h, mob);
      await k.load(s.adminCookies);
      // ---------- плитка
      await cdp.ev(`(() => { const z=document.querySelector('.zone[data-zone="3"]'); z.scrollIntoView({block:'center'}); document.querySelectorAll('.zone *').forEach(e=>{ if(e.scrollLeft>0) e.scrollLeft=0;}); })()`);
      await sleep(500);
      const vacTab = await cdp.ev('(() => { const t=document.getElementById("vacationTrigger"); if(t) t.style.visibility="hidden"; return !!t; })()');
      await k.shot('A01_main_zone3_context_' + tag);
      await k.shotEl('.zone[data-zone="3"]', 'A02_zone3_closeup_' + tag, { scale: tag === '375' ? 2 : 2 });
      const zi = await cdp.ev(`(() => {
        const z = document.querySelector('.zone[data-zone="3"]'), zt = z.querySelector('.zt'), cs = getComputedStyle(zt), b = getComputedStyle(zt, '::before');
        const t = getComputedStyle(z.querySelector('.zt-title')), cnt = getComputedStyle(z.querySelector('.count'));
        const zr = z.getBoundingClientRect(), ztr = zt.getBoundingClientRect();
        const other = document.querySelector('.zone[data-zone="1"] .zt'); const oc = getComputedStyle(other);
        return { title: z.querySelector('.zt-title').textContent.trim(), titleColor: t.color, countColor: cnt.color, ztBg: cs.backgroundImage.slice(0,200), ztW: ztr.width, zBg: getComputedStyle(z).backgroundImage.slice(0,160), zBorder: getComputedStyle(z).borderColor,
          gemLayers: (b.backgroundImage.match(/url\\(/g) || []).length, gemSizes: b.backgroundSize, beforeAnim: b.animationName, beforePE: b.pointerEvents, beforeW: b.width,
          otherBg: oc.backgroundImage.slice(0,120), otherTitle: getComputedStyle(other.querySelector('.zt-title')).color,
          emp: z.querySelectorAll('article.employee').length, empName: (z.querySelector('.employee .name, .employee h3, .employee strong')||{}).textContent,
          imgSrcPrefix: (z.querySelector('.photo img')||{}).src ? z.querySelector('.photo img').src.slice(0,30) : null };
      })()`);
      console.log(JSON.stringify(zi));
      C.note('zone3_' + tag, zi);
      C.check(tag + ' плитка называется «Директор СЦ» (в DOM, а не старое имя зоны)', zi.title === 'Директор СЦ', zi.title);
      C.check(tag + ' на боковой плашке бриллианты: 5–9 слоёв (inline-SVG), без анимации, pointer-events:none', zi.gemLayers >= 5 && zi.gemLayers <= 9 && (zi.beforeAnim === 'none' || !zi.beforeAnim) && zi.beforePE === 'none', JSON.stringify([zi.gemLayers, zi.beforeAnim, zi.beforePE]));
      C.check(tag + ' в зоне 3 один сотрудник с фото (img)', zi.emp === 1 && /^data:image\/jpeg/.test(zi.imgSrcPrefix || ''), JSON.stringify([zi.emp, zi.imgSrcPrefix]));
      C.check(tag + ' остальные зоны не золотые (у соседней зоны нет золотого градиента)', !/rgb\(2[0-4]\d, 2[0-4]\d, 1\d\d\)|#e2c677/i.test(zi.otherBg), zi.otherBg);

      // ---------- матрица
      await cdp.ev('document.getElementById("vacationTrigger").style.visibility=""');
      await k.click('#vacationTrigger'); await sleep(700);
      await cdp.ev('document.getElementById("tabMatrix").click()'); await sleep(500);
      const mi = await cdp.ev(`(() => {
        const rows = [...document.querySelectorAll('#matrixBody tr')];
        const groups = rows.filter(r => r.classList.contains('matrix-group-row')).map(r => (r.querySelector('.matrix-group-label')||r).textContent.trim());
        const firstEmpRow = rows.find(r => r.querySelector('.name-col[data-emp-id]'));
        const dirRows = rows.filter(r => r.classList.contains('matrix-row-director')).map(r => r.querySelector('.name-col').textContent.trim().slice(0,40));
        const dirGroupRows = rows.filter(r => r.classList.contains('matrix-group-director')).length;
        return { groups, firstEmp: firstEmpRow.querySelector('.name-col').textContent.trim().slice(0,40), firstEmpId: firstEmpRow.querySelector('.name-col').dataset.empId, dirRows, dirGroupRows, totalEmpRows: rows.filter(r=>r.querySelector('.name-col[data-emp-id]')).length };
      })()`);
      console.log(JSON.stringify(mi));
      C.note('matrix_' + tag, mi);
      C.check(tag + ' матрица: группа «Директор СЦ» — первая, строка директора — первая', mi.groups[0] === 'Директор СЦ' && /Директор Тестов/.test(mi.firstEmp) && mi.dirRows.length === 1 && mi.dirGroupRows === 1, JSON.stringify(mi));
      // перейти к ноябрю директорa и снять
      await cdp.ev('window.openMatrixAt({employeeId:"emp_101", date:"2026-11-18"})');
      await sleep(250);
      const fl = await cdp.ev(`(() => { const r = document.querySelector('#matrixBody tr.mx-flash'); if(!r) return null; const nc = r.querySelector('.name-col'); const dc = r.querySelector('.day-cell-data'); return { cls: r.className, nameShadow: getComputedStyle(nc).boxShadow, nameBg: getComputedStyle(nc).backgroundColor, empId: nc.dataset.empId }; })()`);
      console.log('flash(dir)', JSON.stringify(fl));
      C.check(tag + ' openMatrixAt(директор): строка подсвечена (mx-flash) и это строка директора', fl && /matrix-row-director/.test(fl.cls) && /mx-flash/.test(fl.cls), JSON.stringify(fl));
      await k.shot('A03_matrix_openAt_director_flash_' + tag);
      await sleep(2400);
      const fl2 = await cdp.ev('!!document.querySelector("#matrixBody tr.mx-flash")');
      C.check(tag + ' подсветка снимается через ~2 с, золотая строка остаётся', fl2 === false && await cdp.ev('!!document.querySelector("#matrixBody tr.matrix-row-director")'));
      await k.shot('A04_matrix_after_flash_' + tag);
      // регулярный сотрудник
      await cdp.ev('window.openMatrixAt({employeeId:"emp_2", date:"2026-11-18"})'); await sleep(250);
      const fl3 = await cdp.ev(`(() => { const r = document.querySelector('#matrixBody tr.mx-flash'); return r ? r.querySelector('.name-col').textContent.trim().slice(0,30) + '|' + r.className : null; })()`);
      C.check(tag + ' openMatrixAt(обычный сотрудник Ivanov): подсвечена его строка, без золотого класса', fl3 && /Ivanov/.test(fl3) && !/matrix-row-director/.test(fl3), fl3);
      await k.shot('A05_matrix_openAt_regular_flash_' + tag);
      // цвета ячеек: отпуск директора = отпуск Ivanov; фон обычных дней директора слегка золотой
      const cs = await cdp.ev(`(() => {
        const cell = (emp, doy) => { const n = document.querySelector('#matrixBody .name-col[data-emp-id="'+emp+'"]'); return n.closest('tr').querySelector('.day-cell-data[data-day="'+doy+'"]'); };
        const doy = Math.round((Date.UTC(2026,10,18)-Date.UTC(2026,0,1))/86400000)+1;
        const dv = cell('101', doy), iv = cell('2', doy), dn = cell('101', doy-5), inn = cell('2', doy-5);
        const g = (e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, bgi: c.backgroundImage.slice(0,100), cls: e.className }; };
        return { dirVac: g(dv), ivVac: g(iv), dirNorm: g(dn), ivNorm: g(inn), dirName: getComputedStyle(document.querySelector('#matrixBody .name-col[data-emp-id="101"]')).backgroundColor, ivName: getComputedStyle(document.querySelector('#matrixBody .name-col[data-emp-id="2"]')).backgroundColor,
          dirIcon: !!cell('101', doy).querySelector('.tk-mx-ic') || !!cell('101', Math.round((Date.UTC(2026,10,18)-Date.UTC(2026,0,1))/86400000)+1).querySelector('.tk-mx-ic'), dirFrames: document.querySelector('#matrixBody .name-col[data-emp-id="101"]').closest('tr').querySelectorAll('.tk-fr').length, dirIcons: document.querySelector('#matrixBody .name-col[data-emp-id="101"]').closest('tr').querySelectorAll('.tk-mx-ic').length };
      })()`);
      console.log(JSON.stringify(cs));
      C.note('cells_' + tag, cs);
      C.check(tag + ' ячейка отпуска директора того же цвета, что у обычного сотрудника', cs.dirVac.bg === cs.ivVac.bg && /vacation/.test(cs.dirVac.cls), JSON.stringify([cs.dirVac, cs.ivVac]));
      C.check(tag + ' обычная ячейка директора слегка золотая (фон-градиент), обычного — без', /rgba\(184, 146, 58, 0\.08\)/.test(cs.dirNorm.bgi) && !/rgba\(184/.test(cs.ivNorm.bgi), JSON.stringify([cs.dirNorm, cs.ivNorm]));
      C.check(tag + ' иконки задач (tasks_matrix) на строке директора есть, рамки срока есть', cs.dirIcons >= 1 && cs.dirFrames >= 1, JSON.stringify([cs.dirIcons, cs.dirFrames]));
      // для скрина: матрица в ноябре (сегодня) и директор + иконки
      await cdp.ev('window.openMatrixAt({employeeId:"emp_101", date:"2026-11-18"})'); await sleep(2600);
      await k.shot('A06_matrix_director_row_icons_' + tag);
      // hover по ячейке директора (перекрестие не должно ломаться)
      const hr = await k.rect('#matrixBody .name-col[data-emp-id="101"]');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hr.x + 200, y: hr.y });
      await sleep(300);
      await k.shot('A07_matrix_hover_director_' + tag);
      // клик по иконке задачи на строке директора → панель Задач (календарь)
      if (tag === '1280') {
        const ic = await k.rect('#matrixBody .name-col[data-emp-id="101"]');
        const icr = await cdp.ev(`(() => { const r = document.querySelector('#matrixBody .name-col[data-emp-id="101"]').closest('tr').querySelector('.tk-mx-ic'); r.scrollIntoView({block:'center',inline:'center'}); const b = r.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })()`);
        await sleep(200);
        await k.clickXY(icr.x, icr.y); await sleep(1200);
        const st = await cdp.ev(`({ view: window.Tasks.__t.S.view, tasksVisible: getComputedStyle(document.getElementById('tasksView')).display !== 'none', emp: window.Tasks.__t.S.filters && window.Tasks.__t.S.filters.emp })`);
        C.check('1280 клик по иконке задачи на золотой строке → «Задачи» (календарь) на сотрудника-директора', st.tasksVisible && st.view === 'calendar', JSON.stringify(st));
        await k.shot('A08_icon_click_opens_tasks_1280');
      }
    }
    C.note('exceptions', cdp.exceptions);
    C.check('нет необработанных исключений на странице', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
  } catch (e) { console.log('FATAL', e); C.check('прогон без аварии', false, e.stack); }
  finally { C.save(); env.cleanup(); console.log('PASSED ' + C.passed + ' FAILED ' + C.failed); process.exit(C.failed ? 1 : 0); }
})();
