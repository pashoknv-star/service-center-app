/**
 * Tasks matrix overlay (T1-3): иконка «есть открытая задача» + рамка срока в матрице отпусков.
 *
 *  - Вариант B из макета: круг #0088CC со счётчиком ОТКРЫТЫХ задач, СТАРТУЮЩИХ в этот день;
 *    красный круг (#F44336), если у любой из них conflict. Только на ПЕРВОМ дне срока.
 *  - Весь срок открытой задачи (все ячейки периода, включая выходные/отпуск) — тонкая рамка
 *    1.5px solid var(--rt-blue), radius 8, лёгкое свечение (как .photo), без заливки.
 *    Рамка — псевдоэлемент ::before ячейки (pointer-events:none): цвета статусов матрицы,
 *    клики, выбор ячеек, Ctrl-мультивыбор и пик-режим командировок не затрагиваются.
 *  - Клик по иконке → openTasksPanel({employeeId, date, view:'calendar'}). Всем ролям
 *    (supervisor/viewer — чтение; запись закрыта на API). С Ctrl/Meta/Shift и во время
 *    пик-режима командировок клик НЕ перехватывается — идёт в ячейку как раньше.
 *  - Данные: ОДИН запрос GET api/tasks.php?from=YYYY-01-01&to=YYYY-12-31 на показанный год,
 *    кеш по году. Обновление: событие document 'tasks:changed' (шлёт js/tasks.js после
 *    записи) — кеш сбрасывается и матрица перерисовывается, как только видна.
 *  - Не трогает автосохранение/guard-логику save.php: модуль только читает api/tasks.php и
 *    красит DOM после renderVacationMatrix() (тот же приём, что overlay в js/trips.js).
 *
 * Публичный интерфейс: window.TasksMatrix.{overlay, refresh, invalidate, init}.
 * ES5-IIFE, без inline-обработчиков.
 */
(function () {
  'use strict';

  var LOG = '[TASKS-MATRIX]';
  var API = 'api/tasks.php';
  var STYLE_ID = 'tasksMatrixStyles';
  var CLS_FRAME = 'tk-fr', CLS_L = 'tk-fr-l', CLS_R = 'tk-fr-r';
  var CLS_ICON = 'tk-mx-ic', CLS_CONF = 'tk-mx-conf';

  var cache = {};          // year -> tasks[]
  var inflight = {};       // year -> { gen, p }
  var gen = 0;             // растёт при invalidate(): устаревшие ответы не попадают в кеш
  var dirty = false;       // был 'tasks:changed', пока матрица скрыта
  var painted = { cells: [], icons: [] };
  var inited = false, patched = false, authWatched = false;

  // ------------------------------------------------------------ даты
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function ymdOf(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  /** Номер дня в году `year` для даты (может быть <1 или >365/366 для других лет). */
  function doyIn(p, year) {
    return Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(year, 0, 1)) / 86400000) + 1;
  }
  function ymdStr(year, doy) {
    var d = new Date(Date.UTC(year, 0, doy));
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  }
  function readYear() {
    var yd = document.getElementById('yearDisplay');
    var y = yd ? parseInt(yd.textContent, 10) : NaN;
    return isNaN(y) ? new Date().getFullYear() : y;
  }
  function domEmp(id) { return String(id == null ? '' : id).replace(/^emp_/, ''); }

  // ------------------------------------------------------------ данные
  function load(year, force) {
    if (!force && cache[year]) return Promise.resolve(cache[year]);
    var cur = inflight[year];
    if (cur && cur.gen === gen) return cur.p;
    var myGen = gen;
    var url = API + '?from=' + year + '-01-01&to=' + year + '-12-31';
    var p = fetch(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (d) {
        if (inflight[year] && inflight[year].p === p) delete inflight[year];
        if (!d || !d.success || !Array.isArray(d.tasks)) return null;
        if (myGen !== gen) return null;                 // за время запроса данные устарели
        cache[year] = d.tasks;
        return d.tasks;
      });
    inflight[year] = { gen: myGen, p: p };
    return p;
  }

  function invalidate() {
    gen++;
    cache = {};
    inflight = {};
  }

  // ------------------------------------------------------------ план отрисовки (чистая функция)
  /**
   * tasks → { empId: { api, frames:[{s,e,l,r}], icons:{doy:{count,conflict,titles[]}} } }
   * Только status==='open' и не архив. Рамка — union периодов задач сотрудника (пересекающиеся
   * сливаются, смежные — нет). Иконка — только если первый день срока попал в показанный год.
   * V6.3-2 (Д-1): у задачи с повторами «срок» = основной период + период каждого повтора
   * (t.occurrences[{start_at,end_at}]): рамка и иконка (первый день каждого периода) — на днях всех повторов;
   * иконка считает ЗАДАЧИ, а не выполнения (основной срок и повтор в один день — одна задача).
   */
  function taskSegments(t) {
    var segs = [], f = ymdOf(t.first_day || t.start_at);
    if (!f) return segs;
    segs.push({ f: f, l: ymdOf(t.last_day || t.end_at) || f });
    (Array.isArray(t.occurrences) ? t.occurrences : []).forEach(function (o) {
      var of = ymdOf(o && o.start_at);
      if (!of) return;
      segs.push({ f: of, l: ymdOf(o.end_at) || of });
    });
    return segs;
  }
  function buildPlan(tasks, year) {
    var total = isLeap(year) ? 366 : 365, byEmp = {};
    (tasks || []).forEach(function (t) {
      if (!t || t.status !== 'open' || Number(t.archived) === 1) return;
      var segs = taskSegments(t).map(function (s) {
        var ts = doyIn(s.f, year), te = doyIn(s.l, year);
        if (te < ts) te = ts;
        return { ts: ts, te: te };
      }).filter(function (s) { return !(s.te < 1 || s.ts > total); });          // срок вне показанного года
      if (!segs.length) return;
      (t.assignees || []).forEach(function (a) {
        var e = domEmp(a && a.employee_id);
        if (!e) return;
        var rec = byEmp[e] || (byEmp[e] = { api: String(a.employee_id), iv: [], icons: {} }), iconDays = {};
        segs.forEach(function (s) {
          rec.iv.push({ ts: s.ts, te: s.te });
          if (s.ts >= 1 && s.ts <= total && !iconDays[s.ts]) {
            iconDays[s.ts] = true;
            var ic = rec.icons[s.ts] || (rec.icons[s.ts] = { count: 0, conflict: false, titles: [] });
            ic.count++;
            if (t.conflict) ic.conflict = true;
            ic.titles.push(String(t.title || ''));
          }
        });
      });
    });
    Object.keys(byEmp).forEach(function (e) {
      var iv = byEmp[e].iv.sort(function (a, b) { return a.ts - b.ts || a.te - b.te; }), out = [];
      iv.forEach(function (x) {
        var last = out[out.length - 1];
        if (last && x.ts <= last.te) { if (x.te > last.te) last.te = x.te; } else { out.push({ ts: x.ts, te: x.te }); }
      });
      byEmp[e].frames = out.map(function (f) {
        return { s: Math.max(f.ts, 1), e: Math.min(f.te, total), l: f.ts >= 1, r: f.te <= total };
      });
      delete byEmp[e].iv;
    });
    return byEmp;
  }

  // ------------------------------------------------------------ DOM
  function clearPaint() {
    painted.cells.forEach(function (c) {
      if (c.classList) { c.classList.remove(CLS_FRAME); c.classList.remove(CLS_L); c.classList.remove(CLS_R); }
    });
    painted.icons.forEach(function (ic) {
      if (ic.parentNode) ic.parentNode.removeChild(ic);
    });
    painted = { cells: [], icons: [] };
  }

  function cellAt(row, doy) {
    var c = row.cells && row.cells[doy];
    if (c && String(c.dataset && c.dataset.day) === String(doy)) return c;
    return row.querySelector ? row.querySelector('.day-cell-data[data-day="' + doy + '"]') : null;
  }

  function paint(year, tasks) {
    var body = document.getElementById('matrixBody');
    if (!body) return;
    clearPaint();
    var plan = buildPlan(tasks, year), rows = {};
    if (!Object.keys(plan).length) return;
    var names = body.querySelectorAll('td.name-col[data-emp-id]');
    for (var i = 0; i < names.length; i++) rows[String(names[i].dataset.empId)] = names[i].parentNode;

    Object.keys(plan).forEach(function (emp) {
      var row = rows[emp], rec = plan[emp];
      if (!row) return;
      rec.frames.forEach(function (f) {
        for (var d = f.s; d <= f.e; d++) {
          var cell = cellAt(row, d);
          if (!cell) continue;
          cell.classList.add(CLS_FRAME);
          if (d === f.s && f.l) cell.classList.add(CLS_L);
          if (d === f.e && f.r) cell.classList.add(CLS_R);
          painted.cells.push(cell);
        }
      });
      Object.keys(rec.icons).forEach(function (k) {
        var doy = +k, info = rec.icons[k], cell = cellAt(row, doy);
        if (!cell) return;
        var ic = document.createElement('span');
        ic.className = CLS_ICON + (info.conflict ? ' ' + CLS_CONF : '');
        ic.dataset.tkEmp = emp;
        ic.dataset.tkApi = rec.api;
        ic.dataset.tkDate = ymdStr(year, doy);
        ic.dataset.tkCount = String(info.count);
        ic.setAttribute('role', 'button');
        ic.setAttribute('title', (info.conflict ? 'Конфликт с больничным/командировкой. ' : '') +
          'Открытых задач: ' + info.count + (info.titles.length ? ' — ' + info.titles.slice(0, 3).join('; ') : ''));
        ic.textContent = info.count > 9 ? '9+' : String(info.count);
        cell.appendChild(ic);
        painted.icons.push(ic);
      });
    });
  }

  // ------------------------------------------------------------ оркестрация
  /** Вызывается после renderVacationMatrix(): DOM новый — красим из кеша или грузим год. */
  function overlay(year) {
    year = year || readYear();
    if (cache[year]) { paint(year, cache[year]); return Promise.resolve(); }
    clearPaint();
    return load(year).then(function (tasks) {
      if (tasks && readYear() === year) paint(year, tasks);
    });
  }

  /** Перезагрузить данные показанного года и перекрасить (после мутаций в панели). */
  function refresh() {
    invalidate();
    dirty = false;
    var year = readYear();
    return load(year, true).then(function (tasks) {
      if (tasks && readYear() === year) paint(year, tasks);
    });
  }

  function matrixVisible() {
    var mw = document.getElementById('matrixWrapper');
    return !!mw && mw.style.display !== 'none';
  }
  function onTasksChanged() {
    invalidate();
    if (matrixVisible()) refresh(); else dirty = true;
  }

  // ------------------------------------------------------------ клики
  function pickActive() {
    if (window._employeePickActive === true) return true;
    var T = window.Trips;
    return !!(T && typeof T.suppressInfoPanel === 'function' && T.suppressInfoPanel());
  }
  function onMatrixPointer(ev) {
    var t = ev.target;
    var ic = t && typeof t.closest === 'function' ? t.closest('.' + CLS_ICON) : null;
    if (!ic) return;
    // Ctrl/Meta/Shift-мультивыбор и пик-режим командировок — как раньше, событие идёт в ячейку.
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || pickActive()) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.stopPropagation();                               // не стартует выбор диапазона / popup ячейки
    if (ev.type !== 'click') return;
    if (typeof window.openTasksPanel !== 'function') { console.warn(LOG, 'openTasksPanel недоступен'); return; }
    window.openTasksPanel({ employeeId: ic.dataset.tkApi || ic.dataset.tkEmp, date: ic.dataset.tkDate, view: 'calendar' });
  }

  // ------------------------------------------------------------ стили
  function css() {
    return '' +
      '.matrix-table .day-cell-data.tk-fr::before{content:"";position:absolute;top:0;bottom:0;left:0;right:0;pointer-events:none;z-index:2;' +
      'box-sizing:border-box;border-top:1.5px solid var(--rt-blue);border-bottom:1.5px solid var(--rt-blue);' +
      'box-shadow:0 0 6px rgba(0,136,204,.2);clip-path:inset(-6px 0 -6px 0)}' +
      '.matrix-table .day-cell-data.tk-fr.tk-fr-l::before{border-left:1.5px solid var(--rt-blue);border-radius:8px 0 0 8px;clip-path:inset(-6px 0 -6px -6px)}' +
      '.matrix-table .day-cell-data.tk-fr.tk-fr-r::before{border-right:1.5px solid var(--rt-blue);border-radius:0 8px 8px 0;clip-path:inset(-6px -6px -6px 0)}' +
      '.matrix-table .day-cell-data.tk-fr.tk-fr-l.tk-fr-r::before{border-radius:8px;clip-path:inset(-6px)}' +
      '.matrix-table .day-cell-data .tk-mx-ic{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;box-sizing:border-box;' +
      'min-width:16px;height:16px;padding:0 2px;border-radius:8px;background:#0088CC;color:#fff;' +
      'font:600 10px/16px sans-serif;text-align:center;cursor:pointer;pointer-events:auto;user-select:none}' +
      '.matrix-table .day-cell-data .tk-mx-ic.tk-mx-conf{background:#F44336}' +
      '@media (max-width:760px){.matrix-table .day-cell-data .tk-mx-ic{min-width:12px;height:12px;padding:0;border-radius:6px;font-size:8px;line-height:12px}}';
  }
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css();
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------ init
  function watchAuth() {
    if (authWatched || typeof MutationObserver === 'undefined') return;
    var authEl = document.getElementById('authOverlay');
    if (!authEl) return;
    authWatched = true;
    // запрос до входа получил 401 → после входа (класс 'hidden') загружаем заново
    new MutationObserver(function () {
      if (String(authEl.className).indexOf('hidden') >= 0) { invalidate(); overlay(readYear()); }
    }).observe(authEl, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    if (inited) return;
    var body = document.getElementById('matrixBody');
    if (!body) return;                                   // разметки матрицы нет — модуль не активируется
    inited = true;
    injectStyles();

    if (!patched && typeof window.renderVacationMatrix === 'function') {
      patched = true;
      var orig = window.renderVacationMatrix;
      window.renderVacationMatrix = function () {
        var r = orig.apply(this, arguments);
        try { overlay(readYear()); } catch (e) { console.warn(LOG, 'overlay error:', e); }
        return r;
      };
    }

    // Capture на tbody: срабатывает раньше обработчиков ячеек (click/mousedown на самих td).
    body.addEventListener('click', onMatrixPointer, true);
    body.addEventListener('mousedown', onMatrixPointer, true);

    document.addEventListener('tasks:changed', onTasksChanged);
    var mw = document.getElementById('matrixWrapper');
    if (mw && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { if (dirty && matrixVisible()) refresh(); })
        .observe(mw, { attributes: true, attributeFilter: ['style'] });
    }
    watchAuth();
    try { overlay(readYear()); } catch (e) { console.warn(LOG, 'overlay error:', e); }
  }

  function autoInit() {
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
  }

  window.TasksMatrix = {
    init: init,
    overlay: overlay,
    refresh: refresh,
    invalidate: invalidate,
    // для тестов (scripts/test_tasks_matrix.js); в UI не используется
    __t: { buildPlan: buildPlan, doyIn: doyIn, ymdStr: ymdStr, onMatrixPointer: onMatrixPointer, onTasksChanged: onTasksChanged, css: css,
      state: function () { return { cache: cache, inflight: inflight, dirty: dirty, painted: painted, gen: gen }; } }
  };

  autoInit();
})();
