/**
 * transport.js — вкладка «Транспорт» (V10-T8): доска «День / Неделя», очередь нераспределённых заявок,
 * перенос ТС между базами. Модуль самодостаточный: рисует в контейнер #transportView, в index.html — только
 * вкладка #tabTransport, контейнер и подключение скрипта.
 *
 * Данные — только GET api/transport_board.php?from=&to= (формат: reports/V10/T6_REPORT.md §2). Единственная запись —
 * перенос ТС: POST api/transport_vehicles.php?action=move&id= {base_id, version} (admin и viewer, can_move_vehicle).
 * Время — локальное +05 (строки YYYY-MM-DDTHH:MM без пояса), «сегодня» считается по +05 независимо от пояса браузера.
 *
 * Весь вывод строится через createElement + textContent (названия заявок, абоненты, адреса, места — пользовательские
 * строки): innerHTML с данными не используется нигде.
 *
 * Точки расширения:
 *   Transport.openForm(ctx)  — форма заявки/распределения (T9). Здесь — заглушка «форма — в следующем этапе»;
 *                              T9 заменяет функцию присвоением window.Transport.openForm = fn. Контексты:
 *                              {mode:'new', date, view} | {mode:'assign', requestId} | {mode:'edit', requestId, assignmentId?}.
 *   Transport.reload()       — перечитать доску (после сохранения формы).
 *   Transport.open({view:'day'|'week', date:'YYYY-MM-DD'}) — открыть вкладку (T11 — переход из реестра/журнала).
 *   Transport.isActive()     — вкладка открыта.
 */
(function () {
  'use strict';

  var API_BOARD = 'api/transport_board.php';
  var API_VEH = 'api/transport_vehicles.php';
  var SESSION_API = 'api/session.php';
  var POLL_MS = 30000;
  var TZ_OFFSET_MS = 5 * 3600 * 1000;                      // +05 (Екатеринбург)
  var NARROW_PX = 720;                                     // уже — «повестка» вместо шкалы времени

  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  var DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var STATUS = {
    new: 'новая', assigned: 'распределена', in_progress: 'в работе', done: 'выполнена', cancelled: 'отменена'
  };
  var ABS = {
    vacation: 'отпуск', sick: 'больничный', day_off: 'отгул', trip: 'командировка', trip_forecast: 'командировка (прогноз)'
  };
  var KIND = { departure: 'Выезд', intermediate: 'Остановка', arrival: 'Приезд' };
  var ERR_TEXT = {
    network: 'Нет связи с сервером. Повторите позже.',
    unauthorized: 'Сессия истекла — войдите заново.',
    forbidden: 'Недостаточно прав для этого действия.',
    not_found: 'Не найдено (возможно, удалено).',
    same_base: 'ТС уже находится в этой базе.',
    unknown_base: 'Такой базы нет — данные обновлены.',
    invalid_range: 'Неверный период.',
    range_too_long: 'Период слишком длинный.'
  };

  var S = {
    inited: false, active: false, user: null,
    view: 'day', date: null, from: null, to: null,
    board: null, loading: false, loadSeq: 0, msg: null, sel: null,
    timer: null, drag: null, dlg: null, menu: null, narrow: false, fresh: false
  };
  var DOM = { root: null, tab: null };
  var _leaving = false;

  // ------------------------------------------------------------------------------------------ утилиты
  function el(tag, cls, text, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function btn(act, text, cls, attrs) {
    var a = { type: 'button', 'data-tp-act': act };
    if (attrs) for (var k in attrs) a[k] = attrs[k];
    return el('button', cls || 'tp-btn', text, a);
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return { y: y, m: mo, d: d, t: t };
  }
  function ymdOf(t) { return t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate()); }
  function addDays(ymd, n) { var p = parseYmd(ymd); return ymdOf(new Date(p.t.getTime() + n * 86400000)); }
  function dowOf(ymd) { return parseYmd(ymd).t.getUTCDay(); }
  function weekStart(ymd) { var d = dowOf(ymd); return addDays(ymd, -((d + 6) % 7)); }
  function todayYmd() { return ymdOf(new Date(Date.now() + TZ_OFFSET_MS)); }
  function nowMinutesLocal() { var t = new Date(Date.now() + TZ_OFFSET_MS); return t.getUTCHours() * 60 + t.getUTCMinutes(); }
  /** 'YYYY-MM-DDTHH:MM' → минуты от эпохи (локальное время как есть) */
  function absMin(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
  }
  function dayMin(ymd) { var p = parseYmd(ymd); return p.t.getTime() / 60000; }
  function fmtDm(ymd) { return ymd.slice(8, 10) + '.' + ymd.slice(5, 7); }
  /** время назначения: в рамках дня day — «HH:MM», иначе «дд.мм HH:MM» */
  function fmtT(s, day) { var d = String(s).slice(0, 10), t = String(s).slice(11, 16); return d === day ? t : fmtDm(d) + ' ' + t; }
  function fmtDur(m) {
    m = Math.round(m);
    if (m < 60) return m + ' мин';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' ч ' + r + ' мин' : h + ' ч';
  }
  function fmtHours(min) {
    var h = Math.round(min / 6) / 10;
    return String(h).replace('.', ',') + ' ч';
  }
  function fmtDayTitle(ymd) {
    var p = parseYmd(ymd);
    return DOW[p.t.getUTCDay()] + ', ' + p.d + ' ' + MONTHS[p.m - 1] + ' ' + p.y;
  }
  function fmtWeekTitle(from, to) {
    var a = parseYmd(from), b = parseYmd(to);
    if (a.y === b.y && a.m === b.m) return a.d + '–' + b.d + ' ' + MONTHS[b.m - 1] + ' ' + b.y;
    if (a.y === b.y) return a.d + ' ' + MONTHS_SHORT[a.m - 1] + ' – ' + b.d + ' ' + MONTHS_SHORT[b.m - 1] + ' ' + b.y;
    return a.d + ' ' + MONTHS_SHORT[a.m - 1] + ' ' + a.y + ' – ' + b.d + ' ' + MONTHS_SHORT[b.m - 1] + ' ' + b.y;
  }
  function setRange() {
    if (S.view === 'week') { S.from = weekStart(S.date); S.to = addDays(S.from, 6); }
    else { S.from = S.date; S.to = S.date; }
  }
  function toast(text, type) {
    if (typeof window.showToast === 'function') { try { window.showToast(text, type); } catch (e) { /* ignore */ } }
  }

  // ------------------------------------------------------------------------------------------ api
  function api(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined && body !== null) opt.body = JSON.stringify(body);
    return fetch(url, opt).then(function (resp) {
      return resp.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        return { ok: resp.ok, status: resp.status, data: data || {} };
      });
    }).catch(function () { return { ok: false, status: 0, data: { error: 'network' } }; });
  }
  function errText(r) {
    var code = r && r.data && r.data.error;
    if (!code && r && r.status === 0) code = 'network';
    if (r && r.status === 401) code = 'unauthorized';
    if (r && r.status === 403) code = 'forbidden';
    return ERR_TEXT[code] || ('Ошибка сервера' + (code ? ' (' + code + ')' : '') + '.');
  }
  function refreshUser() {
    return api('GET', SESSION_API).then(function (r) {
      S.user = (r.ok && r.data && r.data.authenticated) ? r.data.user : null;
    });
  }

  // ------------------------------------------------------------------------------------------ данные
  function boardIndex() {
    var b = S.board, ix = { veh: {}, vehBase: {}, base: {}, byVeh: {}, byId: {}, reqs: {}, abs: {}, names: {} };
    if (!b) return ix;
    (b.bases || []).forEach(function (bs) {
      ix.base[bs.id] = bs;
      (bs.vehicles || []).forEach(function (v) { ix.veh[v.id] = v; ix.vehBase[v.id] = bs; });
    });
    (b.assignments || []).forEach(function (a) {
      ix.byId[a.id] = a;
      (ix.byVeh[a.vehicle_id] = ix.byVeh[a.vehicle_id] || []).push(a);
      if (a.request) ix.reqs[a.request.id] = a.request;
      if (a.driver_id) ix.names[a.driver_id] = a.driver_name;
      (a.crew || []).forEach(function (c) { ix.names[c.employee_id] = c.name; });
    });
    (b.queue || []).forEach(function (r) { ix.reqs[r.id] = r; });
    (b.absences || []).forEach(function (x) { ix.abs[x.employee_id + '|' + x.date] = x.type; });
    return ix;
  }
  /** отсутствия водителя и бригады назначения в указанные дни: [{name, type, date, who}] */
  function absencesOf(a, dates, ix) {
    var out = [];
    var people = [];
    if (a.driver_id) people.push({ id: a.driver_id, name: a.driver_name, who: 'водитель' });
    (a.crew || []).forEach(function (c) { people.push({ id: c.employee_id, name: c.name, who: 'бригада' }); });
    people.forEach(function (p) {
      for (var i = 0; i < dates.length; i++) {
        var t = ix.abs[p.id + '|' + dates[i]];
        if (t) { out.push({ id: p.id, name: p.name, type: t, date: dates[i], who: p.who }); break; }
      }
    });
    return out;
  }
  function absLabel(t) { return ABS[t] || t; }
  function segOf(a, day) {
    var ds = dayMin(day), s = Math.max(absMin(a.start_at), ds), e = Math.min(absMin(a.end_at), ds + 1440);
    if (!(e > s)) return null;
    return { s: s - ds, e: e - ds, contL: absMin(a.start_at) < ds, contR: absMin(a.end_at) > ds + 1440 };
  }
  function canMove() { return !!(S.board && S.board.can_move_vehicle); }
  function canCreate() { return !!(S.user && (S.user.role === 'admin' || S.user.role === 'supervisor')); }

  // ------------------------------------------------------------------------------------------ загрузка
  function load(silent) {
    var seq = ++S.loadSeq;
    S.loading = true;
    if (!silent) render();
    return api('GET', API_BOARD + '?from=' + encodeURIComponent(S.from) + '&to=' + encodeURIComponent(S.to)).then(function (r) {
      if (seq !== S.loadSeq) return;                      // устарел: пришёл ответ на более поздний запрос
      S.loading = false;
      if (r.ok && r.data && r.data.success) {
        S.board = r.data;
        if (S.msg && S.msg.src === 'load') S.msg = null;
        if (S.sel) {
          var ix = boardIndex();
          if (S.sel.kind === 'asg' && !ix.byId[S.sel.id]) S.sel = null;
          else if (S.sel.kind === 'req' && !ix.reqs[S.sel.id]) S.sel = null;
        }
      } else {
        S.msg = { type: 'error', src: 'load', text: errText(r) };
      }
      render();
    });
  }
  function reload() { return S.active ? load(true) : Promise.resolve(); }
  function tick() {
    if (!S.active || S.loading || S.dlg || S.menu || S.drag) return Promise.resolve();
    if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
    var p = document.getElementById('vacationPanel');
    if (p && !p.classList.contains('open')) return Promise.resolve();
    return load(true);
  }
  function startTimer() { if (!S.timer) S.timer = setInterval(tick, POLL_MS); }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  // ------------------------------------------------------------------------------------------ вкладка
  function panelEl() { return document.getElementById('vacationPanel'); }
  function ensurePanelOpen() {
    var p = panelEl();
    if (p && !p.classList.contains('open')) {
      var trg = document.getElementById('vacationTrigger');
      if (trg && trg.click) trg.click();
    }
  }
  function deactivate() {
    if (!S.active) return;
    S.active = false;
    closeMenu(); closeDlg();
    stopTimer();
    if (DOM.root) DOM.root.style.display = 'none';
    if (DOM.tab) DOM.tab.classList.remove('active');
    var p = panelEl();
    if (p) p.classList.remove('transport-tab-active');
  }
  function activate() {
    if (!DOM.root) return Promise.resolve();
    var was = S.active;
    S.active = true;
    if (!S.date) S.date = todayYmd();
    setRange();
    var mw = document.getElementById('matrixWrapper'), tv = document.getElementById('tripsListView');
    _leaving = true;
    if (mw) mw.style.display = 'none';
    if (tv) tv.style.display = 'none';
    _leaving = false;
    if (window.Tasks && typeof window.Tasks.deactivate === 'function') { try { window.Tasks.deactivate(); } catch (e) { /* ignore */ } }
    ['tabMatrix', 'tabTrips', 'tabTasks'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.classList.remove('active');
    });
    if (DOM.tab) DOM.tab.classList.add('active');
    var p = panelEl();
    if (p) p.classList.add('transport-tab-active');
    DOM.root.style.display = 'block';
    startTimer();
    return refreshUser().then(function () { return load(was); });
  }
  /**
   * Точка входа для других модулей. opts: { view: 'day'|'week', date: 'YYYY-MM-DD' }
   */
  function open(opts) {
    opts = opts || {};
    ensurePanelOpen();
    if (opts.view === 'day' || opts.view === 'week') S.view = opts.view;
    if (parseYmd(opts.date)) S.date = opts.date;
    S.msg = null;
    S.sel = null;
    return activate();
  }

  // ------------------------------------------------------------------------------------------ точки расширения (T9)
  function openForm(ctx) {
    // заглушка: форму заявки реализует T9 (подмена window.Transport.openForm)
    S.msg = { type: 'info', src: 'form', text: 'Форма заявки — в следующем этапе.' };
    toast('Форма заявки — в следующем этапе.', 'info');
    render();
    return ctx;
  }
  function callForm(ctx) {
    if (window.Transport && typeof window.Transport.openForm === 'function') return window.Transport.openForm(ctx);
    return openForm(ctx);
  }

  // ------------------------------------------------------------------------------------------ рендер
  function saveScroll() {
    var o = { top: DOM.root ? DOM.root.scrollTop : 0, left: 0 };
    var sc = DOM.root && DOM.root.querySelector('.tp-scroll');
    if (sc) o.left = sc.scrollLeft;
    return o;
  }
  function restoreScroll(o) {
    if (!DOM.root) return;
    DOM.root.scrollTop = o.top;
    var sc = DOM.root.querySelector('.tp-scroll');
    if (sc) sc.scrollLeft = o.left;
  }
  function render() {
    if (!DOM.root || !S.active) return;
    var sc = saveScroll();
    S.narrow = DOM.root.clientWidth > 0 && DOM.root.clientWidth < NARROW_PX;
    var root = DOM.root;
    while (root.firstChild) root.removeChild(root.firstChild);
    var wrap = el('div', 'tp-wrap' + (S.loading ? ' tp-loading' : '') + (S.narrow ? ' tp-narrow' : ''));
    add(wrap, renderBar(), renderLegend());
    if (S.msg) {
      var m = el('div', 'tp-msg tp-msg-' + S.msg.type, S.msg.text, { role: 'status' });
      add(wrap, m);
    }
    if (!S.board) {
      add(wrap, el('div', 'tp-empty', S.loading ? 'Загрузка…' : 'Данные недоступны.'));
    } else {
      var ix = boardIndex();
      add(wrap, renderAbsenceNote(ix));
      add(wrap, S.view === 'week' ? renderWeek(ix) : (S.narrow ? renderAgenda(ix) : renderDay(ix)));
      add(wrap, renderBottom(ix));
    }
    root.appendChild(wrap);
    restoreScroll(sc);
    if (S.fresh) {
      S.fresh = false;
      var det = root.querySelector('.tp-detail');
      if (det && det.scrollIntoView) det.scrollIntoView({ block: 'nearest' });
    }
  }
  function renderBar() {
    var bar = el('div', 'tp-bar');
    var nav = el('div', 'tp-nav');
    add(nav, btn('prev', '◀', 'tp-btn tp-ico', { 'aria-label': 'Назад', title: S.view === 'week' ? 'Предыдущая неделя' : 'Предыдущий день' }));
    add(nav, el('b', 'tp-title', S.view === 'week' ? fmtWeekTitle(S.from, S.to) : fmtDayTitle(S.date)));
    add(nav, btn('next', '▶', 'tp-btn tp-ico', { 'aria-label': 'Вперёд', title: S.view === 'week' ? 'Следующая неделя' : 'Следующий день' }));
    add(nav, btn('today', 'Сегодня'));
    var di = el('input', 'tp-date', null, { type: 'date', 'data-tp-field': 'date', value: S.date, 'aria-label': 'Перейти к дате' });
    di.value = S.date;
    add(nav, di);
    add(bar, nav);
    var seg = el('div', 'tp-seg', null, { role: 'group', 'aria-label': 'Режим' });
    add(seg, btn('viewDay', 'День', 'tp-btn' + (S.view === 'day' ? ' on' : ''), { 'aria-pressed': S.view === 'day' ? 'true' : 'false' }));
    add(seg, btn('viewWeek', 'Неделя', 'tp-btn' + (S.view === 'week' ? ' on' : ''), { 'aria-pressed': S.view === 'week' ? 'true' : 'false' }));
    add(bar, seg);
    add(bar, btn('refresh', '⟳', 'tp-btn tp-ico', { title: 'Обновить', 'aria-label': 'Обновить' }));
    if (canCreate()) add(bar, btn('newReq', '+ Новая заявка', 'tp-btn tp-primary'));
    return bar;
  }
  function renderLegend() {
    var lg = el('div', 'tp-legend');
    ['new', 'assigned', 'in_progress', 'done', 'cancelled'].forEach(function (s) {
      var i = el('span', 'tp-lg');
      add(i, el('i', 'tp-dot st-' + s), el('span', null, STATUS[s]));
      add(lg, i);
    });
    var w = el('span', 'tp-lg');
    add(w, el('span', 'tp-abs', '⚠'), el('span', null, 'отсутствие водителя / бригады'));
    add(lg, w);
    return lg;
  }
  function renderAbsenceNote(ix) {
    var list = (S.board.absences || []);
    if (!list.length) return null;
    var groups = {}, order = [], unknown = {};
    list.forEach(function (x) {
      if (!ix.names[x.employee_id]) { unknown[x.employee_id] = true; return; }
      var k = x.employee_id + '|' + x.type;
      if (!groups[k]) { groups[k] = { name: ix.names[x.employee_id], type: x.type, dates: [] }; order.push(k); }
      groups[k].dates.push(fmtDm(x.date));
    });
    var parts = order.map(function (k) { var g = groups[k]; return g.name + ' — ' + absLabel(g.type) + ' (' + g.dates.join(', ') + ')'; });
    var nUnknown = Object.keys(unknown).length;
    if (nUnknown) parts.push('ещё ' + nUnknown + ' чел. без назначений в периоде');
    if (!parts.length) return null;
    var n = el('div', 'tp-absn');
    add(n, el('span', 'tp-abs', '⚠'), el('span', null, ' Отсутствуют: ' + parts.join('; ')));
    return n;
  }

  // --- группы баз / строки ТС
  function baseHeader(bs) {
    var h = el('div', 'tp-base-h');
    var inner = el('div', 'tp-base-hi');
    add(inner, el('b', null, bs.name), el('span', 'tp-muted', ' · ' + (bs.vehicles || []).length + ' ТС'));
    if (canMove()) add(inner, el('span', 'tp-muted tp-hint', ' — перетащите строку ТС в другую базу или нажмите ⇄'));
    add(h, inner);
    return h;
  }
  function vehicleLabel(v) {
    var mv = canMove();
    var lab = el('div', 'tp-veh tp-lab' + (v.status === 'repair' ? ' tp-repair' : ''), null, { 'data-vehicle-id': v.id });
    if (mv) { lab.setAttribute('draggable', 'true'); lab.setAttribute('title', 'Перетащите в другую базу'); }
    if (mv) add(lab, el('span', 'tp-hnd', '⠿', { 'aria-hidden': 'true' }));
    var txt = el('span', 'tp-vtxt');
    add(txt, el('b', 'tp-vn', v.name), el('small', 'tp-vp', v.plate));
    if (v.status === 'repair') add(txt, el('span', 'tp-badge', 'ремонт'));
    add(lab, txt);
    if (mv) add(lab, btn('moveMenu', '⇄', 'tp-btn tp-ico tp-mv', { 'data-vehicle-id': v.id, title: 'Переместить в базу…', 'aria-label': 'Переместить в базу…', 'aria-haspopup': 'menu' }));
    return lab;
  }
  function emptyBase() { return el('div', 'tp-empty tp-empty-base', 'нет ТС'); }
  function stClass(a) { return 'st-' + ((a.request && a.request.status) || 'assigned'); }
  function asgTitleAttr(a, day) {
    var r = a.request || {};
    var s = '№' + r.display_no + ' ' + (r.title || '') + '\n' + fmtT(a.start_at, day) + '–' + fmtT(a.end_at, day) + '\nВодитель: ' + (a.driver_name || '—');
    if ((a.crew || []).length) s += '\nБригада: ' + a.crew.map(function (c) { return c.name; }).join(', ');
    return s;
  }

  // --- «День», шкала времени
  function renderDay(ix) {
    var day = S.date, today = todayYmd();
    var scroll = el('div', 'tp-scroll');
    var tl = el('div', 'tp-tl');
    var axis = el('div', 'tp-axis');
    var hrs = el('div', 'tp-hrs');
    for (var h = 0; h < 24; h += 2) {
      var i = el('i', null, p2(h), null);
      i.style.left = (h / 24 * 100).toFixed(3) + '%';
      hrs.appendChild(i);
    }
    add(axis, el('div', 'tp-lab tp-axis-lab', 'ТС'), hrs);
    tl.appendChild(axis);
    var bases = S.board.bases || [];
    if (!bases.length) tl.appendChild(el('div', 'tp-empty', 'Баз пока нет — справочник баз ведёт администратор.'));
    bases.forEach(function (bs) {
      var g = el('div', 'tp-base', null, { 'data-base-id': bs.id });
      g.appendChild(baseHeader(bs));
      if (!(bs.vehicles || []).length) g.appendChild(emptyBase());
      (bs.vehicles || []).forEach(function (v) {
        var row = el('div', 'tp-row' + (v.status === 'repair' ? ' tp-repair' : ''), null, { 'data-vehicle-id': v.id });
        var segs = [];
        (ix.byVeh[v.id] || []).forEach(function (a) {
          var sg = segOf(a, day);
          if (sg) segs.push({ a: a, sg: sg });
        });
        segs.sort(function (x, y) { return x.sg.s - y.sg.s || x.sg.e - y.sg.e; });
        var laneEnd = [];
        segs.forEach(function (x) {
          var l = 0;
          while (l < laneEnd.length && laneEnd[l] > x.sg.s) l++;
          laneEnd[l] = x.sg.e;
          x.lane = l;
        });
        var lanes = Math.max(1, laneEnd.length);
        var lane = el('div', 'tp-lane');
        lane.style.height = (lanes * 40 + 6) + 'px';
        if (v.status === 'repair') lane.appendChild(el('span', 'tp-repair-cap', 'РЕМОНТ — назначение потребует подтверждения'));
        if (day === today) {
          var now = el('i', 'tp-now');
          now.style.left = (nowMinutesLocal() / 1440 * 100).toFixed(3) + '%';
          lane.appendChild(now);
        }
        segs.forEach(function (x) { lane.appendChild(dayBlock(x, day, ix)); });
        add(row, vehicleLabel(v), lane);
        g.appendChild(row);
      });
      tl.appendChild(g);
    });
    scroll.appendChild(tl);
    return scroll;
  }
  function dayBlock(x, day, ix) {
    var a = x.a, r = a.request || {}, sg = x.sg;
    var abs = absencesOf(a, [day], ix);
    var b = el('button', 'tp-blk ' + stClass(a) + (x.sg.contL ? ' tp-cont-l' : '') + (x.sg.contR ? ' tp-cont-r' : '') + (abs.length ? ' tp-has-abs' : '') + (S.sel && S.sel.kind === 'asg' && S.sel.id === a.id ? ' tp-sel' : ''),
      null, { type: 'button', 'data-tp-act': 'selAsg', 'data-assign-id': a.id, title: asgTitleAttr(a, day) });
    b.style.left = (sg.s / 1440 * 100).toFixed(3) + '%';
    b.style.width = ((sg.e - sg.s) / 1440 * 100).toFixed(3) + '%';
    b.style.top = (3 + x.lane * 40) + 'px';
    var l1 = el('span', 'tp-b1');
    add(l1, el('b', null, '№' + r.display_no + ' · ' + fmtDur(a.duration_min)));
    if (abs.length) add(l1, absMark(abs));
    var l2 = el('span', 'tp-b2', fmtT(a.start_at, day) + '–' + fmtT(a.end_at, day) + ' · ' + (a.driver_name || '—') + ((a.crew || []).length ? ' · бр. ' + a.crew.length : ''));
    add(b, l1, l2);
    return b;
  }
  function absMark(abs) {
    return el('span', 'tp-abs', '⚠', { title: abs.map(function (x) { return x.name + ' — ' + absLabel(x.type) + ' (' + fmtDm(x.date) + ')'; }).join('\n') });
  }

  // --- «День», повестка (узкий экран)
  function renderAgenda(ix) {
    var day = S.date;
    var box = el('div', 'tp-ag');
    var bases = S.board.bases || [];
    if (!bases.length) box.appendChild(el('div', 'tp-empty', 'Баз пока нет — справочник баз ведёт администратор.'));
    bases.forEach(function (bs) {
      var g = el('div', 'tp-base', null, { 'data-base-id': bs.id });
      g.appendChild(baseHeader(bs));
      if (!(bs.vehicles || []).length) g.appendChild(emptyBase());
      (bs.vehicles || []).forEach(function (v) {
        var row = el('div', 'tp-row tp-ag-row' + (v.status === 'repair' ? ' tp-repair' : ''), null, { 'data-vehicle-id': v.id });
        row.appendChild(vehicleLabel(v));
        var list = [];
        (ix.byVeh[v.id] || []).forEach(function (a) { var sg = segOf(a, day); if (sg) list.push({ a: a, sg: sg }); });
        list.sort(function (p, q) { return p.sg.s - q.sg.s; });
        var cards = el('div', 'tp-ag-list');
        if (!list.length) cards.appendChild(el('div', 'tp-free', v.status === 'repair' ? 'ремонт' : 'свободно'));
        list.forEach(function (x) {
          var a = x.a, r = a.request || {}, abs = absencesOf(a, [day], ix);
          var c = el('button', 'tp-card ' + stClass(a) + (S.sel && S.sel.kind === 'asg' && S.sel.id === a.id ? ' tp-sel' : ''), null, { type: 'button', 'data-tp-act': 'selAsg', 'data-assign-id': a.id, title: asgTitleAttr(a, day) });
          var l1 = el('span', 'tp-c1');
          add(l1, el('b', null, fmtT(a.start_at, day) + '–' + fmtT(a.end_at, day)), el('span', null, ' №' + r.display_no + ' · ' + fmtDur(a.duration_min)));
          if (abs.length) add(l1, absMark(abs));
          add(c, l1, el('span', 'tp-c2', (a.driver_name || '—') + ((a.crew || []).length ? ' · бр. ' + a.crew.length : '')));
          cards.appendChild(c);
        });
        row.appendChild(cards);
        g.appendChild(row);
      });
      box.appendChild(g);
    });
    return box;
  }

  // --- «Неделя»
  function renderWeek(ix) {
    var days = [];
    for (var i = 0; i < 7; i++) days.push(addDays(S.from, i));
    var today = todayYmd();
    var scroll = el('div', 'tp-scroll');
    var wk = el('div', 'tp-wk');
    var hd = el('div', 'tp-wk-h');
    add(hd, el('div', 'tp-lab tp-axis-lab', 'ТС'));
    days.forEach(function (d) {
      var dw = dowOf(d);
      var c = el('div', 'tp-wk-day' + (dw === 0 || dw === 6 ? ' tp-we' : '') + (d === today ? ' tp-today' : ''), DOW[dw] + ' ' + parseYmd(d).d, { 'data-date': d });
      hd.appendChild(c);
    });
    wk.appendChild(hd);
    var bases = S.board.bases || [];
    if (!bases.length) wk.appendChild(el('div', 'tp-empty', 'Баз пока нет — справочник баз ведёт администратор.'));
    bases.forEach(function (bs) {
      var g = el('div', 'tp-base', null, { 'data-base-id': bs.id });
      g.appendChild(baseHeader(bs));
      if (!(bs.vehicles || []).length) g.appendChild(emptyBase());
      (bs.vehicles || []).forEach(function (v) {
        var row = el('div', 'tp-row' + (v.status === 'repair' ? ' tp-repair' : ''), null, { 'data-vehicle-id': v.id });
        row.appendChild(vehicleLabel(v));
        days.forEach(function (d) {
          var dw = dowOf(d);
          var items = [], total = 0;
          (ix.byVeh[v.id] || []).forEach(function (a) {
            var sg = segOf(a, d);
            if (sg) { items.push({ a: a, sg: sg }); total += sg.e - sg.s; }
          });
          items.sort(function (p, q) { return p.sg.s - q.sg.s; });
          var anyAbs = false;
          items.forEach(function (x) { if (absencesOf(x.a, [d], ix).length) anyAbs = true; });
          var cell = el('div', 'tp-wk-cell' + (dw === 0 || dw === 6 ? ' tp-we' : '') + (d === today ? ' tp-today' : '') + (total > 540 ? ' tp-over' : '') + (anyAbs ? ' tp-has-abs' : ''), null,
            { 'data-vehicle-id': v.id, 'data-date': d, 'data-tp-act': 'gotoDay', tabindex: '0', role: 'button', 'aria-label': 'Открыть день ' + fmtDm(d) });
          var load = el('div', 'tp-load');
          if (items.length) load.appendChild(el('span', null, fmtHours(total) + ' · ' + items.length + ' зад.'));
          else load.appendChild(el('span', 'tp-free', v.status === 'repair' ? 'ремонт' : 'свободно'));
          if (anyAbs) load.appendChild(el('span', 'tp-abs', '⚠', { title: 'Водитель или бригада отсутствуют' }));
          cell.appendChild(load);
          var mini = el('div', 'tp-mini');
          items.forEach(function (x) {
            var s = el('i', stClass(x.a));
            s.style.left = (x.sg.s / 1440 * 100).toFixed(2) + '%';
            s.style.width = ((x.sg.e - x.sg.s) / 1440 * 100).toFixed(2) + '%';
            mini.appendChild(s);
          });
          cell.appendChild(mini);
          items.slice(0, 3).forEach(function (x) {
            var a = x.a, r = a.request || {};
            var chip = el('button', 'tp-chip ' + stClass(a) + (S.sel && S.sel.kind === 'asg' && S.sel.id === a.id ? ' tp-sel' : ''), null,
              { type: 'button', 'data-tp-act': 'selAsg', 'data-assign-id': a.id, title: asgTitleAttr(a, d) });
            add(chip, el('b', null, fmtT(a.start_at, d)), el('span', null, ' №' + r.display_no + ' ' + (a.driver_name || '')));
            cell.appendChild(chip);
          });
          if (items.length > 3) cell.appendChild(el('div', 'tp-more', 'ещё ' + (items.length - 3)));
          row.appendChild(cell);
        });
        g.appendChild(row);
      });
      wk.appendChild(g);
    });
    scroll.appendChild(wk);
    return scroll;
  }

  // --- очередь и карточка
  function pill(status) { return el('span', 'tp-pill st-' + status, STATUS[status] || status); }
  function renderBottom(ix) {
    var bt = el('div', 'tp-bottom');
    var q = el('div', 'tp-queue');
    var queue = S.board.queue || [];
    q.appendChild(el('div', 'tp-qh', 'Не распределены (' + queue.length + ')'));
    if (!queue.length) q.appendChild(el('div', 'tp-free', 'Нераспределённых заявок нет'));
    queue.forEach(function (r) {
      var c = el('div', 'tp-q st-' + r.status + (S.sel && S.sel.kind === 'req' && S.sel.id === r.id ? ' tp-sel' : ''), null, { 'data-request-id': r.id, 'data-tp-act': 'selReq', tabindex: '0', role: 'button' });
      var l1 = el('div', 'tp-q1');
      add(l1, el('b', null, '№' + r.display_no), el('span', 'tp-q-title', r.title || ''));
      add(c, l1);
      var meta = [];
      if (r.subscriber) meta.push(r.subscriber);
      if (r.address) meta.push(r.address);
      if (meta.length) c.appendChild(el('div', 'tp-q2', meta.join(' · ')));
      c.appendChild(el('div', 'tp-q3', 'создал: ' + (r.created_by_name || r.created_by || '—')));
      if (r.can_edit) c.appendChild(btn('assign', 'Назначить', 'tp-btn tp-small', { 'data-request-id': r.id }));
      q.appendChild(c);
    });
    if (S.board.queue_truncated) q.appendChild(el('div', 'tp-muted', 'Показаны первые заявки очереди — остальные скрыты.'));
    if (canCreate()) q.appendChild(btn('newReq', '+ Новая заявка', 'tp-btn tp-primary'));
    bt.appendChild(q);
    var det = renderDetail(ix);
    if (det) bt.appendChild(det);
    return bt;
  }
  function row2(label, valueNode) {
    var r = el('div', 'tp-dr');
    add(r, el('span', 'tp-dl', label), valueNode);
    return r;
  }
  function renderDetail(ix) {
    if (!S.sel) return null;
    var a = null, r = null;
    if (S.sel.kind === 'asg') { a = ix.byId[S.sel.id]; r = a && a.request; }
    else r = ix.reqs[S.sel.id];
    if (!r) return null;
    var d = el('div', 'tp-detail');
    var h = el('div', 'tp-dh');
    add(h, el('b', null, 'Заявка №' + r.display_no), pill(r.status), btn('closeDetail', '×', 'tp-btn tp-ico', { 'aria-label': 'Закрыть', title: 'Закрыть' }));
    d.appendChild(h);
    d.appendChild(el('div', 'tp-dtitle', r.title || ''));
    if (r.subscriber) d.appendChild(row2('Абонент: ', el('span', 'tp-dv', r.subscriber)));
    if (r.address) d.appendChild(row2('Адрес: ', el('span', 'tp-dv', r.address)));
    d.appendChild(row2('Создал: ', el('span', 'tp-dv', r.created_by_name || r.created_by || '—')));
    if (a) {
      var v = ix.veh[a.vehicle_id], bs = ix.vehBase[a.vehicle_id];
      d.appendChild(row2('ТС: ', el('span', 'tp-dv', v ? v.name + ' ' + v.plate + (bs ? ' · ' + bs.name : '') : '—')));
      var abs = absencesOf(a, a.days || [], ix);
      var absBy = {};
      abs.forEach(function (x) { absBy[x.id] = x; });
      var dv = el('span', 'tp-dv');
      dv.appendChild(document.createTextNode(a.driver_name || '—'));
      if (absBy[a.driver_id]) dv.appendChild(absNote(absBy[a.driver_id]));
      d.appendChild(row2('Водитель: ', dv));
      var cv = el('span', 'tp-dv');
      if (!(a.crew || []).length) cv.appendChild(document.createTextNode('—'));
      (a.crew || []).forEach(function (c) {
        var chip = el('span', 'tp-crew', c.name);
        if (absBy[c.employee_id]) chip.appendChild(absNote(absBy[c.employee_id]));
        cv.appendChild(chip);
      });
      d.appendChild(row2('Бригада: ', cv));
      d.appendChild(row2('Время: ', el('span', 'tp-dv', fmtDm(a.start_at.slice(0, 10)) + ' ' + a.start_at.slice(11, 16) + '–' + (a.end_at.slice(0, 10) === a.start_at.slice(0, 10) ? '' : fmtDm(a.end_at.slice(0, 10)) + ' ') + a.end_at.slice(11, 16) + ' (' + fmtDur(a.duration_min) + ')')));
      var st = (a.stops || []).slice().sort(function (p, q) { return p.ord - q.ord; });
      if (st.length) {
        var rt = el('div', 'tp-route');
        st.forEach(function (s, i) {
          if (i > 0 && (s.leg_min || s.leg_km)) rt.appendChild(el('span', 'tp-leg', '→ ' + (s.leg_min ? fmtDur(s.leg_min) : '') + (s.leg_km ? (s.leg_min ? ', ' : '') + s.leg_km + ' км' : '')));
          var sp = el('span', 'tp-stop tp-stop-' + s.kind);
          add(sp, el('b', null, (KIND[s.kind] || s.kind) + ': '), el('span', null, s.place || ''));
          if (s.stay_min) sp.appendChild(el('small', null, ' · стоянка ' + fmtDur(s.stay_min)));
          rt.appendChild(sp);
        });
        d.appendChild(row2('Маршрут: ', rt));
      }
    }
    var bar = el('div', 'tp-dbar');
    if (r.can_edit) bar.appendChild(a ? btn('editReq', 'Изменить', 'tp-btn', { 'data-request-id': r.id, 'data-assign-id': a.id }) : btn('assign', 'Назначить', 'tp-btn', { 'data-request-id': r.id }));
    if (bar.firstChild) d.appendChild(bar);
    return d;
  }
  function absNote(x) {
    return el('span', 'tp-abs tp-abs-note', ' ⚠ ' + absLabel(x.type) + ' (' + fmtDm(x.date) + ')', { title: x.name + ' — ' + absLabel(x.type) });
  }

  // ------------------------------------------------------------------------------------------ перенос ТС
  function findVehicle(id) {
    if (!S.board) return null;
    var bases = S.board.bases || [];
    for (var i = 0; i < bases.length; i++) {
      var vs = bases[i].vehicles || [];
      for (var j = 0; j < vs.length; j++) if (vs[j].id === id) return { v: vs[j], base: bases[i] };
    }
    return null;
  }
  function closeMenu() {
    if (S.menu) { if (S.menu.parentNode) S.menu.parentNode.removeChild(S.menu); S.menu = null; }
  }
  function closeDlg() {
    if (S.dlg) { if (S.dlg.parentNode) S.dlg.parentNode.removeChild(S.dlg); S.dlg = null; }
  }
  /** Меню «Переместить в базу…» (для сенсорных экранов и клавиатуры) */
  function openMenu(vid, anchor) {
    if (!canMove()) return;
    var f = findVehicle(vid);
    if (!f) return;
    closeMenu();
    var m = el('div', 'tp-menu', null, { id: 'transportMenu', role: 'menu' });
    add(m, el('div', 'tp-menu-h', 'Переместить «' + f.v.name + '» в базу…'), el('div', 'tp-menu-n', 'Перенос постоянный: ТС останется в новой базе.'));
    var any = false;
    (S.board.bases || []).forEach(function (bs) {
      if (bs.id === f.base.id) return;
      any = true;
      m.appendChild(btn('menuPick', bs.name + ' (' + (bs.vehicles || []).length + ' ТС)', 'tp-menu-it', { 'data-base-id': bs.id, 'data-vehicle-id': vid, role: 'menuitem' }));
    });
    if (!any) m.appendChild(el('div', 'tp-menu-n', 'Других баз нет.'));
    m.addEventListener('click', onOverlayClick);
    document.body.appendChild(m);
    S.menu = m;
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 8, bottom: 40 };
    var mw = m.offsetWidth, mh = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - mw - 8)), top = r.bottom + 4;
    if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 4);
    m.style.left = left + 'px';
    m.style.top = top + 'px';
    var first = m.querySelector('.tp-menu-it');
    if (first && first.focus) first.focus();
  }
  /** Диалог подтверждения переноса; до подтверждения ничего не отправляется */
  function askMove(vid, baseId) {
    if (!canMove() || S.dlg) return;
    var f = findVehicle(vid);
    var to = S.board && (S.board.bases || []).filter(function (b) { return b.id === baseId; })[0];
    if (!f || !to || f.base.id === to.id) return;
    closeMenu();
    var ov = el('div', 'tp-ov', null, { id: 'transportDlg' });
    var d = el('div', 'tp-dlg', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'transportDlgH' });
    add(d, el('h3', null, 'Переместить ТС в другую базу?', { id: 'transportDlgH' }));
    var p1 = el('p');
    add(p1, el('b', null, '«' + f.v.name + '»'), document.createTextNode(' (' + f.v.plate + '): «' + f.base.name + '» → «' + to.name + '»'));
    add(d, p1);
    add(d, el('p', 'tp-dlg-n', 'Перенос постоянный: ТС останется в новой базе, пока его снова не перенесут. Уже созданные назначения не меняются.'));
    var bar = el('div', 'tp-dlg-bar');
    add(bar, btn('dlgCancel', 'Отмена'), btn('dlgOk', 'Переместить', 'tp-btn tp-primary', { 'data-vehicle-id': vid, 'data-base-id': baseId }));
    add(d, bar);
    ov.appendChild(d);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) { ev.stopPropagation(); closeDlg(); } else onOverlayClick(ev); });
    document.body.appendChild(ov);
    S.dlg = ov;
    var ok = ov.querySelector('[data-tp-act="dlgOk"]');
    if (ok && ok.focus) ok.focus();
  }
  function doMove(vid, baseId) {
    var f = findVehicle(vid);
    if (!f) { closeDlg(); return Promise.resolve(); }
    var name = f.v.name, to = (S.board.bases || []).filter(function (b) { return b.id === baseId; })[0];
    if (S.dlg) S.dlg.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    return api('POST', API_VEH + '?action=move&id=' + encodeURIComponent(vid), { base_id: baseId, version: f.v.version }).then(function (r) {
      closeDlg();
      if (r.ok && r.data && r.data.success) {
        S.msg = { type: 'ok', src: 'move', text: 'ТС «' + name + '» перенесён в базу «' + (to ? to.name : '') + '». Перенос постоянный.' };
        toast('ТС перенесён', 'success');
      } else if (r.status === 409) {
        S.msg = { type: 'error', src: 'move', text: 'ТС «' + name + '» уже изменён другим пользователем — данные обновлены. Проверьте базу и повторите перенос.' };
      } else if (r.status === 0) {
        S.msg = { type: 'error', src: 'move', text: ERR_TEXT.network };
        render();
        return;
      } else {
        S.msg = { type: 'error', src: 'move', text: errText(r) };
      }
      return load(true);
    });
  }

  // ------------------------------------------------------------------------------------------ события
  function gotoDate(d) {
    if (!parseYmd(d)) return Promise.resolve();
    S.date = d; S.sel = null; S.msg = null;
    setRange();
    return load();
  }
  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-tp-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-tp-act'), step = S.view === 'week' ? 7 : 1;
    switch (act) {
      case 'prev': gotoDate(addDays(S.date, -step)); break;
      case 'next': gotoDate(addDays(S.date, step)); break;
      case 'today': gotoDate(todayYmd()); break;
      case 'refresh': S.msg = null; load(); break;
      case 'viewDay': case 'viewWeek':
        S.view = act === 'viewWeek' ? 'week' : 'day'; S.msg = null; setRange(); load(); break;
      case 'gotoDay': {
        var d = t.getAttribute('data-date');
        S.view = 'day'; S.date = d; S.sel = null; S.msg = null; setRange(); load(); break;
      }
      case 'selAsg': S.sel = { kind: 'asg', id: t.getAttribute('data-assign-id') }; S.fresh = true; render(); break;
      case 'selReq': S.sel = { kind: 'req', id: t.getAttribute('data-request-id') }; S.fresh = true; render(); break;
      case 'closeDetail': S.sel = null; render(); break;
      case 'newReq': callForm({ mode: 'new', date: S.date, view: S.view }); break;
      case 'assign': callForm({ mode: 'assign', requestId: t.getAttribute('data-request-id') }); break;
      case 'editReq': {
        var ctx = { mode: 'edit', requestId: t.getAttribute('data-request-id') };
        if (t.getAttribute('data-assign-id')) ctx.assignmentId = t.getAttribute('data-assign-id');
        callForm(ctx); break;
      }
      case 'moveMenu': openMenu(t.getAttribute('data-vehicle-id'), t); break;
      case 'menuPick': askMove(t.getAttribute('data-vehicle-id'), t.getAttribute('data-base-id')); break;
      case 'dlgCancel': closeDlg(); break;
      case 'dlgOk': doMove(t.getAttribute('data-vehicle-id'), t.getAttribute('data-base-id')); break;
      default: break;
    }
  }
  /** Клики внутри окон переноса (они в body, вне панели) не должны доходить до глобального «клик вне панели → закрыть» в index.html */
  function onOverlayClick(ev) {
    ev.stopPropagation();
    onClick(ev);
  }
  function onChange(ev) {
    var t = ev.target;
    if (t && t.getAttribute && t.getAttribute('data-tp-field') === 'date') gotoDate(t.value);
  }
  function onKeyDownRoot(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var t = ev.target;
    if (t && t.getAttribute && (t.getAttribute('data-tp-act') === 'gotoDay' || t.getAttribute('data-tp-act') === 'selReq') && t === ev.target) {
      ev.preventDefault();
      onClick(ev);
    }
  }
  function onDocKeyDown(ev) {
    if (ev.key !== 'Escape') return;
    if (S.menu) { closeMenu(); return; }
    if (S.dlg) closeDlg();
  }
  function onDocClick(ev) {
    if (!S.menu) return;
    var t = ev.target;
    if (t && t.closest && (t.closest('#transportMenu') || t.closest('[data-tp-act="moveMenu"]'))) return;
    closeMenu();
  }
  // HTML5 drag & drop: строка ТС → группа базы
  function clearDrop() {
    if (!DOM.root) return;
    DOM.root.querySelectorAll('.tp-drop').forEach(function (e) { e.classList.remove('tp-drop'); });
    DOM.root.querySelectorAll('.tp-dragging').forEach(function (e) { e.classList.remove('tp-dragging'); });
  }
  function onDragStart(ev) {
    var lab = ev.target && ev.target.closest ? ev.target.closest('.tp-veh[draggable="true"]') : null;
    if (!lab || !canMove()) return;
    S.drag = { vid: lab.getAttribute('data-vehicle-id') };
    lab.classList.add('tp-dragging');
    if (ev.dataTransfer) {
      try { ev.dataTransfer.setData('text/plain', S.drag.vid); ev.dataTransfer.effectAllowed = 'move'; } catch (e) { /* ignore */ }
    }
  }
  function onDragOver(ev) {
    if (!S.drag) return;
    var g = ev.target && ev.target.closest ? ev.target.closest('.tp-base') : null;
    var f = findVehicle(S.drag.vid);
    clearDropOnly();
    if (!g || !f || g.getAttribute('data-base-id') === f.base.id) return;
    ev.preventDefault();
    if (ev.dataTransfer) { try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* ignore */ } }
    g.classList.add('tp-drop');
  }
  function clearDropOnly() {
    if (!DOM.root) return;
    DOM.root.querySelectorAll('.tp-drop').forEach(function (e) { e.classList.remove('tp-drop'); });
  }
  function onDrop(ev) {
    if (!S.drag) return;
    var g = ev.target && ev.target.closest ? ev.target.closest('.tp-base') : null;
    var vid = S.drag.vid;
    if (ev.preventDefault) ev.preventDefault();
    S.drag = null;
    clearDrop();
    if (g) askMove(vid, g.getAttribute('data-base-id'));
  }
  function onDragEnd() { S.drag = null; clearDrop(); }

  // ------------------------------------------------------------------------------------------ стили
  function css() {
    return '' +
      '#transportView{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px;box-sizing:border-box;color:var(--text);font-size:13px}' +
      '.vacation-panel.transport-tab-active .vacation-legend{display:none}' +
      '.tp-wrap{min-width:0;max-width:100%}.tp-wrap.tp-loading .tp-scroll,.tp-wrap.tp-loading .tp-ag{opacity:.6}' +
      '.tp-wrap button{font:inherit}' +
      '.tp-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}' +
      '.tp-nav{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}' +
      '.tp-title{font-size:15px;min-width:150px;text-align:center}' +
      '.tp-btn{border:1px solid #cfd6e4;background:#fff;color:var(--text);border-radius:8px;padding:6px 12px;cursor:pointer;line-height:1.2}' +
      '.tp-btn:hover{background:#f3f0ff}.tp-btn:disabled{opacity:.5;cursor:default}' +
      '.tp-btn.on{background:#7700ff;border-color:#7700ff;color:#fff}.tp-ico{padding:6px 9px}' +
      '.tp-primary{background:#7700ff;border-color:#7700ff;color:#fff}.tp-primary:hover{background:#6200d6}' +
      '.tp-small{padding:3px 8px;margin-top:6px;font-size:12px}' +
      '.tp-seg{display:inline-flex;gap:0}.tp-seg .tp-btn{border-radius:0}.tp-seg .tp-btn:first-child{border-radius:8px 0 0 8px}.tp-seg .tp-btn:last-child{border-radius:0 8px 8px 0;border-left:0}' +
      '.tp-date{border:1px solid #cfd6e4;border-radius:8px;padding:5px 8px;font:inherit;max-width:100%}' +
      '.tp-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:#5b6678;margin-bottom:8px}' +
      '.tp-lg{display:inline-flex;align-items:center;gap:5px}.tp-dot{display:inline-block;width:10px;height:10px;border-radius:50%}' +
      '.st-new{--stc:#e8a000}.st-assigned{--stc:#0088cc}.st-in_progress{--stc:#7700ff}.st-done{--stc:#2e9f5b}.st-cancelled{--stc:#8a94a6}' +
      '.tp-dot{background:var(--stc)}' +
      '.tp-msg{padding:8px 12px;border-radius:8px;margin-bottom:8px;overflow-wrap:anywhere}' +
      '.tp-msg-info{background:#eef6ff;border:1px solid #b9d8f5}.tp-msg-ok{background:#eafaf0;border:1px solid #a6dcb9}.tp-msg-error{background:#fff1f0;border:1px solid #f5b5b0;color:#8a1f17}' +
      '.tp-absn{padding:6px 10px;border-radius:8px;background:#fff6e5;border:1px solid #f1d49b;margin-bottom:8px;overflow-wrap:anywhere}' +
      '.tp-abs{color:#d9730d;font-weight:700}.tp-abs-note{font-weight:600}' +
      '.tp-muted{color:#6b778c;font-weight:400}.tp-empty{padding:12px;color:#6b778c}.tp-empty-base{padding:6px 12px;font-size:12px}' +
      '.tp-free{color:#a0a9b8}' +
      '.tp-scroll{overflow-x:auto;max-width:100%;border:1px solid var(--divider);border-radius:10px;background:#fff}' +
      '.tp-base{border-top:1px solid #e4e8f0}.tp-base:first-child{border-top:0}' +
      '.tp-base.tp-drop{outline:2px dashed #7700ff;outline-offset:-2px;background:#faf6ff}' +
      '.tp-base-h{padding:5px 0;background:#eef0fb;border-left:4px solid #7700ff;font-size:12px}.tp-base-hi{position:sticky;left:8px;display:inline-block;max-width:calc(100vw - 80px);padding-left:8px;box-sizing:border-box;overflow-wrap:anywhere}' +
      '.tp-tl{min-width:1000px}.tp-wk{min-width:1000px}' +
      '.tp-axis,.tp-row,.tp-wk-h{display:flex}' +
      '.tp-lab{flex:0 0 150px;box-sizing:border-box;position:sticky;left:0;z-index:3;background:#fff;border-right:1px solid #e4e8f0;padding:6px 8px}' +
      '.tp-axis-lab{font-weight:600;color:#6b778c}' +
      '.tp-hrs{position:relative;flex:1 1 850px;height:22px}.tp-hrs i{position:absolute;top:4px;font-style:normal;font-size:11px;color:#6b778c;transform:translateX(-50%)}' +
      '.tp-row{border-top:1px solid #eef0f5}' +
      '.tp-veh{display:flex;align-items:flex-start;gap:5px;overflow-wrap:break-word}.tp-veh[draggable="true"]{cursor:grab}.tp-veh.tp-dragging{opacity:.5}' +
      '.tp-hnd{color:#8a94a6;cursor:grab}.tp-vtxt{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}.tp-vp{color:#6b778c}' +
      '.tp-badge{display:inline-block;margin-top:2px;padding:0 6px;border-radius:8px;background:#e4e8f0;color:#5b6678;font-size:11px;align-self:flex-start}' +
      '.tp-mv{flex:none;padding:2px 7px}' +
      '.tp-lane{position:relative;flex:1 1 850px;background-image:repeating-linear-gradient(90deg,#e8ebf2 0,#e8ebf2 1px,transparent 1px,transparent 4.16667%)}' +
      '.tp-repair .tp-lane,.tp-repair.tp-ag-row .tp-ag-list{background-color:#f3f5fa;background-image:repeating-linear-gradient(45deg,#e4e8f0 0,#e4e8f0 6px,#f3f5fa 6px,#f3f5fa 12px)}' +
      '.tp-repair-cap{position:absolute;left:6px;top:4px;font-size:11px;color:#6b778c}' +
      '.tp-now{position:absolute;top:0;bottom:0;width:2px;background:#ff5722;z-index:1}' +
      '.tp-blk{position:absolute;height:36px;box-sizing:border-box;min-width:14px;padding:2px 6px;border:0;border-radius:6px;background:var(--stc,#0088cc);color:#fff;text-align:left;cursor:pointer;overflow:hidden;white-space:nowrap;display:flex;flex-direction:column;justify-content:center;z-index:2}' +
      '.tp-blk.tp-sel,.tp-card.tp-sel,.tp-chip.tp-sel{box-shadow:0 0 0 2px #1a2b49}' +
      '.tp-blk.tp-has-abs{outline:2px solid #ff9800;outline-offset:-2px}' +
      '.tp-blk .tp-abs{color:#ffe0b2;margin-left:4px}' +
      '.tp-cont-l{border-top-left-radius:0;border-bottom-left-radius:0}.tp-cont-r{border-top-right-radius:0;border-bottom-right-radius:0}' +
      '.tp-b1,.tp-b2{display:block;overflow:hidden;text-overflow:ellipsis;font-size:12px}.tp-b2{font-size:11px;opacity:.95}' +
      '.tp-wk-day{flex:1 1 120px;min-width:0;text-align:center;padding:6px 2px;font-weight:600;color:#6b778c}.tp-we{background:#fafbfe}.tp-today{background:#fff4e5}' +
      '.tp-wk-cell{flex:1 1 120px;min-width:0;box-sizing:border-box;padding:4px;border-left:1px solid #eef0f5;cursor:pointer;overflow:hidden}.tp-wk-cell:hover{background:#f7f4ff}' +
      '.tp-wk-cell.tp-has-abs{box-shadow:inset 0 0 0 2px #ff9800}.tp-over .tp-load{color:#d9730d;font-weight:600}' +
      '.tp-load{font-size:12px;display:flex;justify-content:space-between;gap:4px}' +
      '.tp-mini{position:relative;height:6px;background:#eef0f5;border-radius:3px;margin:3px 0 4px}.tp-mini i{position:absolute;top:0;bottom:0;border-radius:3px;background:var(--stc,#0088cc);min-width:2px}' +
      '.tp-chip{display:block;width:100%;box-sizing:border-box;margin-top:2px;padding:1px 5px;border:0;border-left:3px solid var(--stc,#0088cc);border-radius:4px;background:#f3f6fb;color:var(--text);text-align:left;font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.tp-more{font-size:11px;color:#6b778c}' +
      '.tp-ag-row{flex-direction:column}.tp-ag-row .tp-lab{position:static;flex:none;border-right:0;background:#fafbfe}' +
      '.tp-ag-list{padding:4px 8px 8px;display:flex;flex-direction:column;gap:6px}' +
      '.tp-card{display:block;width:100%;box-sizing:border-box;padding:6px 8px;border:0;border-left:4px solid var(--stc,#0088cc);border-radius:6px;background:#f3f6fb;color:var(--text);text-align:left;cursor:pointer;overflow-wrap:anywhere}' +
      '.tp-c1,.tp-c2{display:block}.tp-c2{font-size:12px;color:#5b6678}' +
      '.tp-bottom{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;align-items:flex-start}' +
      '.tp-queue,.tp-detail{box-sizing:border-box;min-width:0;border:1px solid var(--divider);border-radius:10px;padding:10px;background:#fff}' +
      '.tp-queue{flex:1 1 260px;max-width:100%}.tp-detail{flex:2 1 320px;max-width:100%;overflow-wrap:anywhere}' +
      '.tp-qh{font-weight:700;margin-bottom:8px}' +
      '.tp-q{border-left:4px solid var(--stc,#e8a000);border:1px solid #e4e8f0;border-left:4px solid var(--stc,#e8a000);border-radius:8px;padding:6px 8px;margin-bottom:6px;cursor:pointer;overflow-wrap:anywhere}.tp-q.tp-sel{box-shadow:0 0 0 2px #1a2b49}' +
      '.tp-q1{display:flex;gap:6px}.tp-q-title{min-width:0}.tp-q2{font-size:12px;color:#5b6678}.tp-q3{font-size:11px;color:#8a94a6}' +
      '.tp-dh{display:flex;gap:8px;align-items:center;margin-bottom:6px}.tp-dh .tp-ico{margin-left:auto}' +
      '.tp-pill{display:inline-block;padding:1px 8px;border-radius:10px;background:var(--stc,#0088cc);color:#fff;font-size:11px}' +
      '.tp-dtitle{font-weight:700;margin-bottom:6px}.tp-dr{margin:3px 0}.tp-dl{color:#6b778c}' +
      '.tp-crew{display:inline-block;margin:0 4px 2px 0;padding:0 8px;border:1px solid #d6dbe6;border-radius:10px}' +
      '.tp-route{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;margin-top:2px}.tp-stop{padding:2px 8px;border-radius:8px;background:#eef6ff}.tp-stop-departure{background:#eafaf0}.tp-stop-arrival{background:#fff1ee}.tp-leg{color:#6b778c;font-size:12px}' +
      '.tp-dbar{margin-top:8px;display:flex;gap:8px}' +
      '.tp-ov{position:fixed;left:0;top:0;right:0;bottom:0;z-index:4000;background:rgba(26,43,73,.45);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}' +
      '.tp-dlg{width:440px;max-width:100%;box-sizing:border-box;background:#fff;border-radius:12px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.35);color:var(--text);overflow-wrap:anywhere}' +
      '.tp-dlg h3{margin:0 0 8px}.tp-dlg p{margin:6px 0}.tp-dlg-n{color:#5b6678;font-size:12px}.tp-dlg-bar{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}' +
      '.tp-menu{position:fixed;z-index:4100;width:300px;max-width:calc(100vw - 16px);box-sizing:border-box;background:#fff;border:1px solid #cfd6e4;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:6px;max-height:70vh;overflow:auto;color:var(--text)}' +
      '.tp-menu-h{font-weight:700;padding:4px 8px;overflow-wrap:anywhere}.tp-menu-n{padding:0 8px 6px;font-size:12px;color:#5b6678}' +
      '.tp-menu-it{display:block;width:100%;box-sizing:border-box;text-align:left;border:0;background:#fff;padding:9px 10px;border-radius:6px;cursor:pointer;color:var(--text);overflow-wrap:anywhere}.tp-menu-it:hover,.tp-menu-it:focus{background:#f3f0ff;outline:0}' +
      '@media (max-width:760px){#transportView{padding:8px}.tp-title{min-width:0;flex:1 1 auto}.tp-btn{padding:8px 12px}.tp-ico{padding:8px 11px}.tp-lab{flex-basis:120px}.tp-queue,.tp-detail{flex-basis:100%}}' +
      /* четвёртая вкладка в шапке панели: на узком экране вкладки переносятся, а не расширяют панель (375 px без горизонтального скролла) */
      '.vacation-panel-header .panel-tabs{flex-wrap:wrap;max-width:100%;gap:6px}' +
      '@media (max-width:480px){.vacation-panel-header .panel-tab{padding:6px 10px;font-size:13px}}';
  }
  function injectStyles() {
    if (document.getElementById('transportModuleStyles')) return;
    var st = document.createElement('style');
    st.id = 'transportModuleStyles';
    st.textContent = css();
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------------------------------ init
  function init() {
    if (S.inited) return;
    DOM.root = document.getElementById('transportView');
    DOM.tab = document.getElementById('tabTransport');
    if (!DOM.root || !DOM.tab) return;                    // разметка не вставлена — модуль не активируется
    S.inited = true;
    injectStyles();
    DOM.tab.addEventListener('click', function () { activate(); });
    ['tabMatrix', 'tabTrips', 'tabTasks'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', deactivate);
    });
    // Trips.switchTab / Tasks.activate вызываются и программно — тогда тоже уходим с вкладки «Транспорт»
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function () {
        if (_leaving || !S.active) return;
        var mw = document.getElementById('matrixWrapper'), tv = document.getElementById('tripsListView'), tk = document.getElementById('tasksView');
        if ((mw && mw.style.display === 'block') || (tv && tv.style.display === 'block') || (tk && tk.style.display === 'block')) deactivate();
      });
      ['matrixWrapper', 'tripsListView', 'tasksView'].forEach(function (id) {
        var e = document.getElementById(id);
        if (e) mo.observe(e, { attributes: true, attributeFilter: ['style'] });
      });
    }
    DOM.root.addEventListener('click', onClick);
    DOM.root.addEventListener('change', onChange);
    DOM.root.addEventListener('keydown', onKeyDownRoot);
    DOM.root.addEventListener('dragstart', onDragStart);
    DOM.root.addEventListener('dragover', onDragOver);
    DOM.root.addEventListener('dragenter', onDragOver);
    DOM.root.addEventListener('drop', onDrop);
    DOM.root.addEventListener('dragend', onDragEnd);
    document.addEventListener('keydown', onDocKeyDown);
    document.addEventListener('click', onDocClick);
    document.addEventListener('visibilitychange', function () { if (S.active && !document.hidden) tick(); });
    var rz = null;
    window.addEventListener('resize', function () {
      if (!S.active) return;
      clearTimeout(rz);
      rz = setTimeout(function () {
        var narrow = DOM.root.clientWidth > 0 && DOM.root.clientWidth < NARROW_PX;
        if (narrow !== S.narrow && S.board) render();
      }, 150);
    });
  }
  function autoInit() {
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
  }

  window.Transport = {
    init: init,
    open: open,
    activate: activate,
    deactivate: deactivate,
    reload: reload,
    openForm: openForm,                    // точка расширения T9 (см. шапку файла)
    isActive: function () { return S.active; },
    // для тестов (scripts/test_transport_board_ui.js); в UI не используется
    __t: {
      S: S, tick: tick, render: render, askMove: askMove, doMove: doMove, openMenu: openMenu, load: load,
      fmtDur: fmtDur, fmtWeekTitle: fmtWeekTitle, weekStart: weekStart, addDays: addDays, todayYmd: todayYmd,
      get POLL_MS() { return POLL_MS; }
    }
  };

  autoInit();
})();
