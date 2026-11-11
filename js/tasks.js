/**
 * js/tasks.js — панель «Задачи» (T1-2): Список / Доска / Календарь.
 *
 * Модуль самодостаточный: стили инжектируются отсюда, разметка рисуется строкой
 * в контейнер #tasksView, в index.html — только точечные вставки (вкладка
 * #tabTasks, контейнер #tasksView, подключение скрипта).
 *
 * API: api/tasks.php (T1-1). Запись — только admin; supervisor/viewer получают
 * режим «только чтение» (элементы записи НЕ рендерятся), а сервер всё равно
 * отвечает 403 на любую запись.
 *
 * Обработчики: НИ ОДНОГО inline onclick. Все кнопки несут data-tk-act="<имя>",
 * имена разрешаются через таблицу ACTIONS (делегирование на #tasksView);
 * сьют scripts/test_tasks_frontend.js проверяет, что каждое data-tk-act в этом
 * файле имеет обработчик (урок «4× мёртвых кнопок»).
 * Публичный интерфейс — window.Tasks.* и window.openTasksPanel().
 *
 * T1-8 (D-1): «Исполнитель удалён» — счётчик ⚠ на вкладке, плашка/полоса в Списке,
 * секция Доски, плитка Календаря, карточка с «Назначить»; окно замены после удаления
 * сотрудника: window.Tasks.openTasksFor(empId) (до удаления) и
 * window.Tasks.offerReassign(empId, fullName, tasks) (после) — вызываются из #deleteEmp (index.html).
 */
(function () {
  'use strict';

  if (window.Tasks) return;

  var LOG = '[Tasks]';
  var API = 'api/tasks.php';
  var EMP_API = 'api/employees.php';
  var SESSION_API = 'api/session.php';

  var PRIORITY_TEXT = { 1: 'высокий', 2: 'обычный', 3: 'низкий' };
  var DOW_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var NOTE_TEXT = { weekend: 'выходной', holiday: 'праздник', vacation: 'отпуск', day_off: 'отгул' };
  var REASON_TEXT = { sick: 'больничный', trip: 'командировка' };
  var NONE = '__none__';                       // фильтр «Без исполнителя»
  var GONE_NAME = 'сотрудник удалён';          // ФИО удалённого, если snapshot пуст (старые данные)

  var ERR_TEXT = {
    network: 'Нет связи с сервером. Повторите позже.',
    unauthorized: 'Сессия истекла — войдите заново.',
    forbidden: 'Недостаточно прав: менять задачи может только администратор.',
    not_found: 'Задача не найдена (возможно, удалена или в архиве).',
    title_required: 'Укажите название задачи.',
    invalid_title: 'Название слишком длинное (максимум 200 символов).',
    invalid_description: 'Описание слишком длинное (максимум 5000 символов).',
    invalid_label: 'Метка слишком длинная (максимум 50 символов).',
    invalid_priority: 'Приоритет должен быть от 1 до 3.',
    invalid_start_at: 'Некорректная дата или время начала.',
    invalid_end_at: 'Некорректная дата или время окончания.',
    end_before_start: 'Окончание раньше начала.',
    period_too_long: 'Период слишком длинный (максимум 366 дней).',
    assignees_required: 'Выберите хотя бы одного исполнителя.',
    assignees_too_many: 'Слишком много исполнителей.',
    employee_not_found: 'Выбранный сотрудник не найден.',
    invalid_checklist: 'Пункты чек-листа не должны быть пустыми (максимум 300 символов).',
    checklist_too_many: 'Слишком много пунктов чек-листа (максимум 50).',
    task_archived: 'Задача в архиве и не может быть изменена.',
    version_required: 'Не передана версия задачи — перезагрузите карточку.'
  };

  // ---------------------------------------------------------------- state
  var S = {
    inited: false,
    active: false,
    user: null,
    employees: [],
    empById: {},
    tasks: [],
    view: 'list',                 // list | board | calendar
    filters: { emp: '', due: '', priority: '', label: '', status: '' },
    selectedId: null,
    cal: { mode: 'week', anchor: null, emp: '', only: false },
    form: null,                   // { id, version, draft, blocked, error } | null
    msg: null,                    // { type: 'error'|'ok'|'info', text }
    loading: false,
    loadError: null,
    busy: false,
    dragId: null,
    loadSeq: 0,
    orphanCount: 0,                // T1-8: открытые задачи без исполнителя (?orphans=1)
    modal: null                    // T1-8: окно замены { empId, fullName, items, target, error, busy }
  };
  var DOM = {};

  // ---------------------------------------------------------------- utils
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function utcOf(s) { var p = parseYmd(s); return Date.UTC(p.y, p.m - 1, p.d); }
  function addDays(s, n) {
    var t = new Date(utcOf(s) + n * 86400000);
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  function dowOf(s) { return new Date(utcOf(s)).getUTCDay(); }
  function weekStart(s) { var d = dowOf(s); return addDays(s, d === 0 ? -6 : 1 - d); }
  function todayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function timeOf(s) { var m = /T(\d{2}:\d{2})/.exec(String(s || '')); return m ? m[1] : ''; }
  function dateOf(s) { return String(s || '').slice(0, 10); }
  function fmtDm(s) { var p = parseYmd(s); return p ? pad(p.d) + '.' + pad(p.m) : ''; }
  function fmtDay(s) { return parseYmd(s) ? DOW_SHORT[dowOf(s)] + ' ' + fmtDm(s) : ''; }
  function truncate(text, n) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '…' : t;
  }
  function fmtPeriod(t) {
    var sd = dateOf(t.start_at), st = timeOf(t.start_at);
    if (!t.end_at) return fmtDay(sd) + (st ? ' ' + st : '');
    var ed = dateOf(t.end_at), et = timeOf(t.end_at);
    if (sd === ed) return fmtDay(sd) + (st ? ' ' + st : '') + (et ? ' — ' + et : '');
    return fmtDay(sd) + (st ? ' ' + st : '') + ' — ' + fmtDay(ed) + (et ? ' ' + et : '');
  }

  function isAdmin() { return !!(S.user && (S.user.isAdmin === true || S.user.role === 'admin')); }
  function canWrite() { return isAdmin(); }

  function normEmpId(v) {
    if (v == null || v === '') return '';
    var s = String(v);
    return /^\d+$/.test(s) ? 'emp_' + s : s;
  }
  function empName(id) {
    var e = S.empById[id];
    return e ? e.name : String(id);
  }
  function assigneesOf(t) { return (t && t.assignees) || []; }
  function personName(a) {
    return a.full_name || (a.removed ? GONE_NAME : empName(a.employee_id));
  }
  function assigneeNames(t) {
    return assigneesOf(t).map(personName);
  }
  function hasAssignee(t, empId) {
    return assigneesOf(t).some(function (a) { return !a.removed && a.employee_id === empId; });
  }
  // «без исполнителя»: открытая неархивная задача, у которой не осталось действующих исполнителей.
  // Закрытые задачи без пометок (ФИО остаётся из snapshot).
  function isOrphan(t) {
    return !!(t && t.orphan === true && t.status === 'open' && !t.archived);
  }
  function removedNames(t) {
    return assigneesOf(t).filter(function (a) { return a.removed && a.full_name; })
      .map(function (a) { return a.full_name; });
  }
  // плашка «Исполнитель удалён (<ФИО из snapshot>)»; без ФИО (старые данные) — без скобок.
  function plateText(t) {
    var n = removedNames(t);
    return 'Исполнитель удалён' + (n.length ? ' (' + n.join(', ') + ')' : '');
  }
  function plateHtml(t) {
    return '<span class="tk-plate" title="Сотрудник удалён из справочника — задача осталась без исполнителя">' + esc(plateText(t)) + '</span>';
  }
  // removed_at может быть null (audit_log хранится 7 дней) — тогда без даты, никогда «null»/«Invalid Date».
  function removedDate(t) {
    var best = null;
    assigneesOf(t).forEach(function (a) {
      if (a.removed && a.removed_at && (!best || String(a.removed_at) > String(best))) best = a.removed_at;
    });
    if (!best) return '';
    var d = new Date(best);
    if (isNaN(d.getTime())) return '';
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function findTask(id) {
    for (var i = 0; i < S.tasks.length; i++) if (S.tasks[i].id === id) return S.tasks[i];
    return null;
  }
  function mergeTask(task) {
    if (!task || !task.id) return;
    for (var i = 0; i < S.tasks.length; i++) {
      if (S.tasks[i].id === task.id) { S.tasks[i] = task; return; }
    }
    S.tasks.push(task);
  }
  function toast(text, type) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(text, type); } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- api
  function api(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined && body !== null) opt.body = JSON.stringify(body);
    return fetch(url, opt).then(function (resp) {
      return resp.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        return { ok: resp.ok, status: resp.status, data: data || {} };
      });
    }).catch(function () {
      return { ok: false, status: 0, data: { error: 'network' } };
    });
  }
  function errText(r) {
    var code = r && r.data && r.data.error;
    if (!code && r && r.status === 0) code = 'network';
    if (r && r.status === 401) code = 'unauthorized';
    if (r && r.status === 403) code = 'forbidden';
    return ERR_TEXT[code] || ('Ошибка сервера' + (code ? ' (' + code + ')' : '') + '.');
  }

  // ---------------------------------------------------------------- data
  function refreshUser() {
    return api('GET', SESSION_API).then(function (r) {
      S.user = (r.ok && r.data && r.data.authenticated) ? r.data.user : null;
    });
  }
  function loadEmployees(force) {
    if (S.employees.length && !force) return Promise.resolve();
    return api('GET', EMP_API).then(function (r) {
      var arr = Array.isArray(r.data) ? r.data : (r.data.employees || []);
      if (!r.ok || !Array.isArray(arr)) return;
      S.employees = arr.map(function (e) {
        return { id: String(e.id), name: e.full_name || e.fullName || String(e.id) };
      });
      S.empById = {};
      S.employees.forEach(function (e) { S.empById[e.id] = e; });
    });
  }
  function calRange() {
    var a = S.cal.anchor || todayYmd();
    if (S.cal.mode === 'day') return { from: a, to: a };
    var ws = weekStart(a);
    return { from: ws, to: addDays(ws, 6) };
  }
  function load() {
    var seq = ++S.loadSeq;
    var q = '';
    if (S.view === 'calendar') {
      var r = calRange();
      q = '?from=' + r.from + '&to=' + r.to;
    }
    S.loading = true;
    render();
    return api('GET', API + q).then(function (res) {
      if (seq !== S.loadSeq) return;       // устаревший ответ
      S.loading = false;
      if (res.ok && res.data.success) {
        S.tasks = res.data.tasks || [];
        S.loadError = null;
      } else {
        S.loadError = errText(res);
      }
      // выбранной карточки нет в выборке (например, другая неделя) — дотянуть по id
      if (S.selectedId && !findTask(S.selectedId)) {
        return api('GET', API + '?id=' + encodeURIComponent(S.selectedId)).then(function (one) {
          if (seq !== S.loadSeq) return;
          if (one.ok && one.data.task && !one.data.task.archived) mergeTask(one.data.task); else S.selectedId = null;
          render();
        });
      }
      render();
    });
  }

  // ---------------------------------------------------------------- filters
  function labelsOf(tasks) {
    var seen = {}, out = [];
    tasks.forEach(function (t) { if (t.label && !seen[t.label]) { seen[t.label] = 1; out.push(t.label); } });
    return out.sort();
  }
  function matchDue(t, due) {
    if (!due) return true;
    var today = todayYmd();
    if (due === 'overdue') return t.status === 'open' && t.last_day < today;
    if (due === 'today') return t.first_day <= today && today <= t.last_day;
    if (due === 'week') {
      var ws = weekStart(today);
      return t.first_day <= addDays(ws, 6) && t.last_day >= ws;
    }
    return true;
  }
  function applyFilters(tasks, f, listOnly) {
    return tasks.filter(function (t) {
      if (f.emp === NONE) { if (!isOrphan(t)) return false; }
      else if (f.emp && !hasAssignee(t, f.emp)) return false;
      if (!listOnly) return true;
      if (f.status && t.status !== f.status) return false;
      if (f.priority && String(t.priority) !== String(f.priority)) return false;
      if (f.label && t.label !== f.label) return false;
      return matchDue(t, f.due);
    });
  }

  // ---------------------------------------------------------------- html bits
  function optionsHtml(items, selected, allLabel) {
    var h = allLabel != null ? '<option value="">' + esc(allLabel) + '</option>' : '';
    items.forEach(function (it) {
      h += '<option value="' + esc(it.value) + '"' + (String(it.value) === String(selected) ? ' selected' : '') + '>' + esc(it.label) + '</option>';
    });
    return h;
  }
  function empOptions(selected, allLabel, withNone) {
    var items = S.employees.map(function (e) { return { value: e.id, label: e.name }; });
    if (withNone) items.push({ value: NONE, label: 'Без исполнителя' });
    return optionsHtml(items, selected, allLabel);
  }
  function priorityTag(t) {
    var p = +t.priority;
    return '<span class="tk-tag' + (p === 1 ? ' tk-hi' : '') + '">' + esc(PRIORITY_TEXT[p] || p) + '</span>';
  }
  function conflictReasons(t) {
    var seen = {}, out = [];
    (t.conflict_days || []).forEach(function (c) {
      if (!seen[c.reason]) { seen[c.reason] = 1; out.push(REASON_TEXT[c.reason] || c.reason); }
    });
    return out;
  }
  function badgesHtml(t) {
    var h = '';
    if (t.label) h += '<span class="tk-tag">' + esc(t.label) + '</span>';
    if (t.checklist && t.checklist.length) {
      var done = t.checklist.filter(function (c) { return c.done; }).length;
      h += '<span class="tk-tag">☑ ' + done + '/' + t.checklist.length + '</span>';
    }
    if (t.conflict) {
      h += '<span class="tk-tag tk-warn" title="Задача легла на дни, когда у исполнителя больничный или командировка">конфликт: ' + esc(conflictReasons(t).join(', ') || 'больничный/командировка') + '</span>';
    }
    if (t.check_state === 'pending') {
      h += '<span class="tk-tag tk-pending" title="Проверка правил (n8n) ещё не выполнена — будет перепроверена автоматически">не проверено</span>';
    }
    if (t.status === 'closed') h += '<span class="tk-tag tk-closed">закрыта</span>';
    return h;
  }
  function nameLinks(t) {
    var a = assigneesOf(t);
    if (!a.length) return '<span class="tk-muted">—</span>';
    if (isOrphan(t)) return plateHtml(t);
    var open = t.status === 'open' && !t.archived;
    return a.map(function (p) {
      if (p.removed) {
        // удалённый: у открытой задачи с другими исполнителями — зачёркнут; у закрытой — без пометок
        return open ? '<s class="tk-gone" title="Сотрудник удалён">' + esc(personName(p)) + '</s>' : esc(personName(p));
      }
      return '<a href="#" class="tk-name" data-tk-act="filterEmp" data-emp="' + esc(p.employee_id) + '">' +
        esc(personName(p)) + '</a>';
    }).join(', ');
  }

  // ---------------------------------------------------------------- views
  function renderMsg() {
    if (!S.msg) return '';
    return '<div class="tk-msg tk-msg-' + esc(S.msg.type) + '" role="status">' + esc(S.msg.text) +
      ' <button type="button" class="tk-x" data-tk-act="dismissMsg" title="Скрыть">×</button></div>';
  }

  function renderBar() {
    var views = [['list', 'Список'], ['board', 'Доска'], ['calendar', 'Календарь']];
    var h = '<div class="tk-bar"><h3 class="tk-title">Задачи</h3><div class="tk-switch" role="tablist">';
    views.forEach(function (v) {
      h += '<button type="button" class="tk-sw' + (S.view === v[0] ? ' active' : '') + '" data-tk-act="setView" data-view="' + v[0] + '">' + v[1] + '</button>';
    });
    h += '</div>';
    if (canWrite()) h += '<button type="button" class="tk-btn tk-primary" data-tk-act="newTask">+ Новая задача</button>';
    if (!canWrite()) h += '<span class="tk-ro" title="Изменять задачи может только администратор">только просмотр</span>';
    h += '</div>';
    return h;
  }

  function renderList() {
    var f = S.filters;
    var rows = applyFilters(S.tasks, f, true);
    var h = '<div class="tk-filters">' +
      '<label>Сотрудник <select data-tk-filter="emp">' + empOptions(f.emp, 'Все', true) + '</select></label>' +
      '<label>Срок <select data-tk-filter="due">' + optionsHtml([
        { value: 'today', label: 'Сегодня' }, { value: 'week', label: 'На этой неделе' }, { value: 'overdue', label: 'Просрочено' }
      ], f.due, 'Любой') + '</select></label>' +
      '<label>Приоритет <select data-tk-filter="priority">' + optionsHtml([
        { value: 1, label: 'высокий' }, { value: 2, label: 'обычный' }, { value: 3, label: 'низкий' }
      ], f.priority, 'Любой') + '</select></label>' +
      '<label>Метка <select data-tk-filter="label">' + optionsHtml(labelsOf(S.tasks).map(function (l) { return { value: l, label: l }; }), f.label, 'Любая') + '</select></label>' +
      '<label>Статус <select data-tk-filter="status">' + optionsHtml([
        { value: 'open', label: 'Открыта' }, { value: 'closed', label: 'Закрыта' }
      ], f.status, 'Любой') + '</select></label>' +
      '<button type="button" class="tk-btn" data-tk-act="resetFilters">Сбросить</button></div>';
    if (!rows.length) {
      return h + '<p class="tk-empty">' + (S.loading ? 'Загрузка…' : 'Задач нет.') + '</p>';
    }
    h += '<div class="tk-tablewrap"><table class="tk-table"><thead><tr><th>Задача</th><th>Исполнитель</th><th>Срок</th><th>Приор.</th><th>Статус</th></tr></thead><tbody>';
    rows.forEach(function (t) {
      h += '<tr class="tk-row' + (t.status === 'closed' ? ' tk-dim' : '') + (isOrphan(t) ? ' tk-orph' : '') + '" data-tk-act="openTask" data-id="' + esc(t.id) + '" data-view="board">' +
        '<td><b>' + esc(t.title) + '</b><div class="tk-badges">' + badgesHtml(t).replace('<span class="tk-tag tk-closed">закрыта</span>', '') + '</div></td>' +
        '<td>' + nameLinks(t) + '</td>' +
        '<td class="tk-nowrap">' + esc(fmtPeriod(t)) + '</td>' +
        '<td class="' + (+t.priority === 1 ? 'tk-hi' : '') + '">' + esc(PRIORITY_TEXT[t.priority] || t.priority) + '</td>' +
        '<td>' + (t.status === 'closed' ? 'Закрыта' : 'Открыта') + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function cardHtml(t) {
    var admin = canWrite();
    return '<div class="tk-card' + (t.id === S.selectedId ? ' tk-sel' : '') + (t.status === 'closed' ? ' tk-dim' : '') + (isOrphan(t) ? ' tk-orph' : '') + '"' +
      ' data-tk-act="openTask" data-id="' + esc(t.id) + '" data-view="board"' + (admin ? ' draggable="true" data-tk-drag="' + esc(t.id) + '"' : '') + '>' +
      '<b>' + esc(t.title) + '</b>' +
      '<div class="tk-sub">' + (isOrphan(t) ? plateHtml(t) : esc(assigneeNames(t).join(', '))) + ' · ' + esc(fmtPeriod(t)) + '</div>' +
      '<div class="tk-badges">' + (+t.priority === 1 ? '<span class="tk-tag tk-hi">высокий</span>' : '<span class="tk-tag">' + esc(PRIORITY_TEXT[t.priority] || '') + '</span>') +
      badgesHtml(t).replace('<span class="tk-tag tk-closed">закрыта</span>', '') + '</div></div>';
  }

  function renderBoard() {
    var rows = applyFilters(S.tasks, { emp: S.filters.emp }, false);
    var orph = rows.filter(isOrphan);
    var open = rows.filter(function (t) { return t.status === 'open' && !isOrphan(t); });
    var closed = rows.filter(function (t) { return t.status === 'closed'; }).sort(function (a, b) {
      return String(b.closed_at || '').localeCompare(String(a.closed_at || ''));
    });
    var h = '<div class="tk-filters"><label>Сотрудник <select data-tk-filter="emp">' + empOptions(S.filters.emp, 'Все', true) + '</select></label>';
    if (S.filters.emp) h += '<button type="button" class="tk-btn" data-tk-act="clearEmp">× Все сотрудники</button>';
    if (canWrite()) h += '<span class="tk-muted">Перетащите карточку в другую колонку, чтобы закрыть или переоткрыть задачу.</span>';
    h += '</div><div class="tk-split"><div class="tk-boardmain">';
    if (orph.length) {
      h += '<div class="tk-sec tk-sec-orph" data-tk-sec="orphans"><b>⚠ Без исполнителя · ' + orph.length + '</b>' +
        '<span class="tk-muted"> — исполнитель удалён, задача ждёт назначения</span>' +
        '<div class="tk-sec-cards">' + orph.map(cardHtml).join('') + '</div></div>';
    }
    h += '<div class="tk-cols">';
    h += '<div class="tk-col" data-tk-col="open"><b>Открыта · ' + open.length + '</b>' +
      (open.map(cardHtml).join('') || '<p class="tk-empty">Нет открытых задач</p>') + '</div>';
    h += '<div class="tk-col" data-tk-col="closed"><b>Закрыта · ' + closed.length + '</b>' +
      (closed.map(cardHtml).join('') || '<p class="tk-empty">Нет закрытых задач</p>') + '</div>';
    h += '</div></div>' + renderDetail() + '</div>';
    return h;
  }

  // --- календарь
  function calDays() {
    var r = calRange(), days = [], d = r.from;
    while (d <= r.to) { days.push(d); d = addDays(d, 1); }
    return days;
  }
  function calTitle(days) {
    if (days.length === 1) return fmtDay(days[0]) + '.' + parseYmd(days[0]).y;
    return fmtDm(days[0]) + ' — ' + fmtDm(days[days.length - 1]) + '.' + parseYmd(days[days.length - 1]).y;
  }
  function holidayLabelFor(date) {
    for (var i = 0; i < S.tasks.length; i++) {
      var notes = S.tasks[i].notes || [];
      for (var j = 0; j < notes.length; j++) {
        if (notes[j].date === date && notes[j].kind === 'holiday') return notes[j].label || 'праздник';
      }
    }
    return '';
  }
  function tileHtml(t, date) {
    var first = t.first_day, last = t.last_day, st = timeOf(t.start_at), et = timeOf(t.end_at);
    var when;
    if (first === last) when = st ? st + (et ? '–' + et : '') : '';
    else if (date === first) when = (st ? st + ' ' : '') + '→';
    else if (date === last) when = '→' + (et ? ' ' + et : '');
    else when = '…продолжение';
    var orph = isOrphan(t);
    var names = assigneeNames(t).join(', ');
    var vac = (t.notes || []).filter(function (n) { return n.date === date && (n.kind === 'vacation' || n.kind === 'day_off'); });
    var hl = S.cal.emp && hasAssignee(t, S.cal.emp);
    var max = S.cal.mode === 'day' ? 140 : 48;
    return '<div class="tk-ev' + (t.id === S.selectedId ? ' tk-sel' : '') + (t.conflict ? ' tk-conf' : '') +
      (orph ? ' tk-orph' : '') + (t.status === 'closed' ? ' tk-dim' : '') + (hl ? ' tk-hl' : '') + '" data-tk-act="openTask" data-id="' + esc(t.id) + '" title="' + esc(t.title + (orph ? ' — ' + plateText(t) : '')) + '">' +
      (when ? '<span class="tk-ev-when">' + esc(when) + '</span> ' : '') +
      (orph ? '<b class="tk-orph-lbl">без исполнителя</b>' : '<b>' + esc(names) + '</b>') +
      '<div class="tk-ev-desc">' + esc(truncate(t.description || t.title, max)) + '</div>' +
      (vac.length ? '<span class="tk-tag tk-neutral">' + esc(NOTE_TEXT[vac[0].kind]) + '</span>' : '') +
      (t.conflict ? '<span class="tk-tag tk-warn">⚠ конфликт</span>' : '') +
      (t.check_state === 'pending' ? '<span class="tk-tag tk-pending">не проверено</span>' : '') + '</div>';
  }
  function renderCalendar() {
    var days = calDays();
    var today = todayYmd();
    var tasks = S.tasks.filter(function (t) { return !(S.cal.only && S.cal.emp) || hasAssignee(t, S.cal.emp); });
    var h = '<div class="tk-filters">' +
      '<button type="button" class="tk-btn" data-tk-act="calPrev">◀</button>' +
      '<button type="button" class="tk-btn" data-tk-act="calToday">Сегодня</button>' +
      '<button type="button" class="tk-btn" data-tk-act="calNext">▶</button>' +
      '<b class="tk-caltitle">' + esc(calTitle(days)) + '</b>' +
      '<span class="tk-switch">' +
      '<button type="button" class="tk-sw' + (S.cal.mode === 'week' ? ' active' : '') + '" data-tk-act="calMode" data-mode="week">Неделя</button>' +
      '<button type="button" class="tk-sw' + (S.cal.mode === 'day' ? ' active' : '') + '" data-tk-act="calMode" data-mode="day">День</button></span>' +
      '<label>Сотрудник <select data-tk-filter="calEmp">' + empOptions(S.cal.emp, 'Все сотрудники') + '</select></label>';
    if (S.cal.emp) {
      h += '<label class="tk-check"><input type="checkbox" data-tk-filter="calOnly"' + (S.cal.only ? ' checked' : '') + '> только выбранный</label>';
    }
    h += '</div><div class="tk-split"><div class="tk-wk" style="grid-template-columns:repeat(' + days.length + ',minmax(0,1fr))">';
    days.forEach(function (d) {
      var wd = dowOf(d), hol = holidayLabelFor(d);
      h += '<div class="tk-wk-h' + (wd === 0 || wd === 6 ? ' tk-we' : '') + (d === today ? ' tk-today' : '') + '"><b>' + esc(fmtDay(d)) + '</b>' +
        (hol ? '<span class="tk-tag tk-neutral">' + esc(hol) + '</span>' : '') + '</div>';
    });
    days.forEach(function (d) {
      var wd = dowOf(d);
      var dayTasks = tasks.filter(function (t) { return t.first_day <= d && d <= t.last_day; })
        .sort(function (a, b) {
          var ta = a.first_day === d ? timeOf(a.start_at) : '', tb = b.first_day === d ? timeOf(b.start_at) : '';
          return ta === tb ? String(a.title).localeCompare(String(b.title)) : (ta < tb ? -1 : 1);
        });
      h += '<div class="tk-wk-c' + (wd === 0 || wd === 6 ? ' tk-we' : '') + '">' +
        (dayTasks.map(function (t) { return tileHtml(t, d); }).join('') || '') + '</div>';
    });
    h += '</div>' + renderDetail() + '</div>';
    var anyTile = days.some(function (d) { return tasks.some(function (t) { return t.first_day <= d && d <= t.last_day; }); });
    if (!anyTile && !S.loading) h += '<p class="tk-empty">На этот период задач нет.</p>';
    return h;
  }

  // --- карточка (справа)
  function renderDetail() {
    var t = S.selectedId ? findTask(S.selectedId) : null;
    if (!t) return '<aside class="tk-detail"><p class="tk-empty">Выберите задачу, чтобы увидеть карточку.</p></aside>';
    var h = '<aside class="tk-detail"><div class="tk-dhead"><b class="tk-dtitle">' + esc(t.title) + '</b>' +
      '<span class="tk-tag' + (t.status === 'closed' ? ' tk-closed' : '') + '">' + (t.status === 'closed' ? 'Закрыта' : 'Открыта') + '</span></div>';
    h += '<div class="tk-badges">' + priorityTag(t) + badgesHtml(t).replace('<span class="tk-tag tk-closed">закрыта</span>', '') + '</div>';
    h += '<div class="tk-kv"><span>Срок</span><b>' + esc(fmtPeriod(t)) + '</b></div>';
    h += '<div class="tk-kv"><span>Исполнители</span><div>' + nameLinks(t) + '</div></div>';
    if (isOrphan(t)) {
      var rd = removedDate(t);
      h += '<div class="tk-box tk-box-orph" data-tk-box="orphan"><b>Исполнитель удалён' + (rd ? ' ' + esc(rd) : '') + '</b> — задача без исполнителя.' +
        (canWrite() && !t.archived
          ? ' <button type="button" class="tk-btn tk-primary" data-tk-act="assignOrphan" data-id="' + esc(t.id) + '">Назначить</button>'
          : '') +
        '<div class="tk-muted">Закрыть задачу можно и без исполнителя.</div></div>';
    }
    h += '<div class="tk-kv"><span>Описание</span><div class="tk-pre">' + (t.description ? esc(t.description) : '<span class="tk-muted">нет описания</span>') + '</div></div>';
    if (t.checklist && t.checklist.length) {
      h += '<div class="tk-kv"><span>Чек-лист</span><ul class="tk-ck">' + t.checklist.map(function (c) {
        return '<li class="' + (c.done ? 'tk-done' : '') + '">' + (c.done ? '☑' : '☐') + ' ' + esc(c.text) + '</li>';
      }).join('') + '</ul></div>';
    }
    if (t.conflict) {
      h += '<div class="tk-box tk-box-warn"><b>Конфликт.</b> Исполнитель в эти дни на больничном или в командировке: ' +
        esc((t.conflict_days || []).map(function (c) {
          return fmtDm(c.date) + ' ' + empName(c.employee_id) + ' (' + (REASON_TEXT[c.reason] || c.reason) + ')';
        }).join('; ')) + '. Задача не отменяется — решите, переназначить или сдвинуть срок.</div>';
    }
    if (t.check_state === 'pending') {
      h += '<div class="tk-box tk-box-pending"><b>Не проверено.</b> Автоматическая проверка правил ещё не выполнена; задача сохранена и будет перепроверена.</div>';
    }
    var notes = (t.notes || []);
    if (notes.length) {
      h += '<div class="tk-box"><b>Пометки</b> <span class="tk-muted">(справочно, без ограничений)</span><ul class="tk-notes">' + notes.map(function (n) {
        var who = n.employee_id ? empName(n.employee_id) + ': ' : '';
        return '<li>' + esc(fmtDay(n.date)) + ' — ' + esc(who + (NOTE_TEXT[n.kind] || n.kind) + (n.kind === 'holiday' && n.label ? ' (' + n.label + ')' : '')) + '</li>';
      }).join('') + '</ul></div>';
    }
    if (t.archived) h += '<div class="tk-box">Задача в архиве.</div>';
    if (canWrite() && !t.archived) {
      h += '<div class="tk-actions">' +
        '<button type="button" class="tk-btn tk-primary" data-tk-act="editTask" data-id="' + esc(t.id) + '">Править</button>' +
        '<button type="button" class="tk-btn" data-tk-act="reassignTask" data-id="' + esc(t.id) + '">Переназначить</button>' +
        (t.status === 'open'
          ? '<button type="button" class="tk-btn" data-tk-act="closeTask" data-id="' + esc(t.id) + '">Закрыть</button>'
          : '<button type="button" class="tk-btn" data-tk-act="reopenTask" data-id="' + esc(t.id) + '">Переоткрыть</button>') +
        '<button type="button" class="tk-btn tk-danger" data-tk-act="archiveTask" data-id="' + esc(t.id) + '">В архив</button></div>';
    }
    return h + '</aside>';
  }

  // --- форма (только admin)
  function emptyDraft() {
    var d = S.view === 'calendar' ? (S.cal.anchor || todayYmd()) : todayYmd();
    return {
      title: '', description: '', assignees: S.filters.emp ? [S.filters.emp] : [],
      watchers: [], kind: 'single', startDate: d, startTime: '', endDate: d, endTime: '',
      priority: 2, label: '', checklist: []
    };
  }
  function draftFromTask(t) {
    return {
      title: t.title || '', description: t.description || '',
      assignees: assigneesOf(t).filter(function (a) { return !a.removed; }).map(function (a) { return a.employee_id; }),
      hasRemoved: assigneesOf(t).some(function (a) { return a.removed; }),
      origActive: assigneesOf(t).filter(function (a) { return !a.removed; }).map(function (a) { return a.employee_id; }),
      watchers: (t.watchers || []).filter(function (a) { return !a.removed; }).map(function (a) { return a.employee_id; }),
      kind: t.end_at ? 'period' : 'single',
      startDate: dateOf(t.start_at), startTime: timeOf(t.start_at),
      endDate: t.end_at ? dateOf(t.end_at) : dateOf(t.start_at), endTime: timeOf(t.end_at),
      priority: +t.priority || 2, label: t.label || '',
      checklist: (t.checklist || []).map(function (c) { return { id: c.id, text: c.text, done: !!c.done }; })
    };
  }
  function fieldRow(label, inner, cls) {
    return '<div class="tk-f ' + (cls || '') + '"><label>' + esc(label) + '</label>' + inner + '</div>';
  }
  function renderBlocked(b) {
    var h = '<div class="tk-box tk-box-warn" id="tkBlocked"><b>Срок попадает на больничный или командировку</b> — такие задачи ставить нельзя. Заблокированные дни:<ul class="tk-notes">';
    (b.blocked_days || []).forEach(function (d) {
      h += '<li>' + esc(fmtDay(d.date)) + ' — ' + esc(empName(d.employee_id)) + ' (' + esc(REASON_TEXT[d.reason] || d.reason) + ')</li>';
    });
    h += '</ul>';
    if (b.suggested_start) {
      h += '<div>Ближайший свободный срок: <b>' + esc(fmtDay(dateOf(b.suggested_start)) + (timeOf(b.suggested_start) ? ' ' + timeOf(b.suggested_start) : '') +
        (b.suggested_end ? ' — ' + fmtDay(dateOf(b.suggested_end)) + (timeOf(b.suggested_end) ? ' ' + timeOf(b.suggested_end) : '') : '')) + '</b> ' +
        '<button type="button" class="tk-btn tk-primary" data-tk-act="acceptSuggested">Принять предложенную дату</button></div>';
    } else {
      h += '<div>Подходящую дату подобрать не удалось — измените срок или исполнителей вручную.</div>';
    }
    return h + '</div>';
  }
  function renderForm() {
    var F = S.form, d = F.draft, isNew = !F.id;
    var h = '<form class="tk-form" data-tk-form="1"><h4>' + (isNew ? 'Новая задача' : 'Редактирование задачи') + '</h4>';
    if (F.error) h += '<div class="tk-msg tk-msg-error" role="alert">' + esc(F.error) + '</div>';
    if (F.blocked) h += renderBlocked(F.blocked);
    h += fieldRow('Название *', '<input type="text" maxlength="200" data-tk-field="title" value="' + esc(d.title) + '">');
    h += fieldRow('Описание', '<textarea rows="3" maxlength="5000" data-tk-field="description">' + esc(d.description) + '</textarea>');
    var chips = d.assignees.map(function (id) {
      return '<span class="tk-chip">' + esc(empName(id)) + ' <button type="button" class="tk-x" data-tk-act="removeAssignee" data-emp="' + esc(id) + '" title="Убрать">×</button></span>';
    }).join('') || '<span class="tk-muted">никого не выбрано</span>';
    var rest = S.employees.filter(function (e) { return d.assignees.indexOf(e.id) < 0; })
      .map(function (e) { return { value: e.id, label: e.name }; });
    h += fieldRow('Исполнители (1..N) *', '<div class="tk-chips" id="tkAssignees">' + chips + '</div>' +
      '<select data-tk-field="assigneePick">' + optionsHtml(rest, '', '+ добавить исполнителя…') + '</select>');
    h += fieldRow('Срок', '<div class="tk-radio">' +
      '<label><input type="radio" name="tkKind" data-tk-field="kind" value="single"' + (d.kind === 'single' ? ' checked' : '') + '> Срок (один день)</label>' +
      '<label><input type="radio" name="tkKind" data-tk-field="kind" value="period"' + (d.kind === 'period' ? ' checked' : '') + '> Период</label></div>' +
      '<div class="tk-dt"><span>' + (d.kind === 'period' ? 'Начало' : 'Дата') + '</span>' +
      '<input type="date" data-tk-field="startDate" value="' + esc(d.startDate) + '"> <input type="time" data-tk-field="startTime" value="' + esc(d.startTime) + '"></div>' +
      (d.kind === 'period' ? '<div class="tk-dt"><span>Конец</span><input type="date" data-tk-field="endDate" value="' + esc(d.endDate) + '"> <input type="time" data-tk-field="endTime" value="' + esc(d.endTime) + '"></div>' : ''));
    h += fieldRow('Приоритет', '<select data-tk-field="priority">' + optionsHtml([
      { value: 1, label: '1 — высокий' }, { value: 2, label: '2 — обычный' }, { value: 3, label: '3 — низкий' }], d.priority) + '</select>');
    h += fieldRow('Метка', '<input type="text" maxlength="50" list="tkLabels" data-tk-field="label" value="' + esc(d.label) + '">' +
      '<datalist id="tkLabels">' + labelsOf(S.tasks).map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist>');
    h += fieldRow('Чек-лист', '<div class="tk-cklist">' + d.checklist.map(function (c, i) {
      return '<div class="tk-ckrow"><input type="checkbox" data-tk-ck-done="' + i + '"' + (c.done ? ' checked' : '') + '> ' +
        '<input type="text" maxlength="300" data-tk-ck-text="' + i + '" value="' + esc(c.text) + '"> ' +
        '<button type="button" class="tk-x" data-tk-act="removeCheck" data-idx="' + i + '" title="Удалить пункт">×</button></div>';
    }).join('') + '</div><button type="button" class="tk-btn" data-tk-act="addCheck">+ пункт</button>');
    var wnames = d.watchers.map(empName).join(', ');
    h += fieldRow('Наблюдатель', '<select disabled title="Поле хранится, но в MVP неактивно"><option>' + esc(wnames || 'не используется в MVP') + '</option></select>', 'tk-f-off');
    h += '<div class="tk-actions"><button type="button" class="tk-btn tk-primary" data-tk-act="saveForm"' + (S.busy ? ' disabled' : '') + '>Сохранить</button>' +
      '<button type="button" class="tk-btn" data-tk-act="cancelForm">Отмена</button></div></form>';
    return h;
  }

  function render() {
    if (!DOM.root) return;
    var h = '<div class="tk-wrap">' + renderBar() + renderMsg();
    if (S.loadError) h += '<div class="tk-msg tk-msg-error">' + esc(S.loadError) + '</div>';
    if (S.form && canWrite()) h += renderForm();
    else if (S.view === 'board') h += renderBoard();
    else if (S.view === 'calendar') h += renderCalendar();
    else h += renderList();
    h += '</div>';
    DOM.root.innerHTML = h;
    if (!S.form && typeof DOM.root.querySelector === 'function') {
      var sel = DOM.root.querySelector('.tk-sel');
      if (sel && sel.scrollIntoView) { try { sel.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
    }
  }

  // ---------------------------------------------------------------- form logic
  function draftError(d) {
    if (!String(d.title).trim()) return ERR_TEXT.title_required;
    if (!d.assignees.length && !(d.hasRemoved && d.origActive && !d.origActive.length)) return ERR_TEXT.assignees_required;
    if (!parseYmd(d.startDate)) return 'Укажите дату начала.';
    if (d.kind === 'period') {
      if (!parseYmd(d.endDate)) return 'Укажите дату окончания периода.';
      var s = d.startDate + 'T' + (d.startTime || '00:00'), e = d.endDate + 'T' + (d.endTime || '23:59');
      if (e < s) return ERR_TEXT.end_before_start;
    }
    return '';
  }
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    return a.every(function (x) { return b.indexOf(x) >= 0; });
  }
  function buildPayload(d, isNew) {
    var p = {
      title: String(d.title).trim(),
      description: String(d.description || '').trim(),
      assignees: d.assignees.slice(),
      start_at: d.startDate + (d.startTime ? 'T' + d.startTime : ''),
      end_at: d.kind === 'period' ? (d.endDate + (d.endTime ? 'T' + d.endTime : '')) : (isNew ? null : ''),
      priority: +d.priority || 2,
      label: String(d.label || '').trim(),
      checklist: d.checklist.filter(function (c) { return String(c.text).trim() !== ''; }).map(function (c) {
        var it = { text: String(c.text).trim(), done: !!c.done };
        if (c.id) it.id = c.id;
        return it;
      })
    };
    // T1-8: у задачи есть удалённые исполнители и состав действующих не менялся (в т.ч. «без исполнителя») —
    // assignees не отправляем: сервер оставляет всё как есть (snapshot удалённых сохраняется).
    if (!isNew && d.hasRemoved && d.origActive && sameSet(d.assignees, d.origActive)) delete p.assignees;
    // watchers намеренно не отправляются: поле хранится на сервере, UI его не меняет.
    return p;
  }

  // T1-3: сообщаем матрице (js/tasks_matrix.js), что данные задач изменились на сервере.
  function notifyChanged() {
    try {
      if (typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('tasks:changed'));
      }
    } catch (e) { /* матрица необязательна */ }
    refreshOrphanCount();
  }

  // ---------------------------------------------------------------- T1-8: счётчик ⚠ на вкладке
  var _orphSeq = 0;
  function renderBadge() {
    if (!DOM.tab) return;
    var n = S.orphanCount | 0;
    DOM.tab.innerHTML = 'Задачи' + (n > 0
      ? '<span class="tk-orph-cnt" data-tk-badge="orphans" title="Открытых задач без исполнителя: ' + n + '">⚠ ' + n + '</span>' : '');
  }
  function refreshOrphanCount() {
    var seq = ++_orphSeq;
    return api('GET', API + '?orphans=1').then(function (r) {
      if (seq !== _orphSeq) return;
      if (r.status === 0) return;                       // нет связи — оставляем прежнее значение
      S.orphanCount = (r.ok && r.data && r.data.success) ? (+r.data.count || 0) : 0;
      renderBadge();
    });
  }

  function handleWriteResult(r, id, okText) {
    S.busy = false;
    if (r.ok && r.data && r.data.success) {
      notifyChanged();
      S.form = null;
      var task = r.data.task;
      if (task && task.archived) {
        // архивная задача из панели исчезает (на сервере остаётся, читается по id)
        S.tasks = S.tasks.filter(function (x) { return x.id !== task.id; });
        if (S.selectedId === task.id) S.selectedId = null;
      } else if (task) {
        mergeTask(task);
        S.selectedId = task.id;
      }
      S.msg = { type: 'ok', text: okText };
      toast(okText, 'success');
      if (task && S.view === 'calendar') {
        var rg = calRange();
        if (task.first_day > rg.to || task.last_day < rg.from) S.cal.anchor = task.first_day;
      }
      return load();
    }
    var code = r.data && r.data.error;
    if (r.status === 409 && code === 'VERSION_CONFLICT') {
      notifyChanged();
      S.form = null;
      if (r.data.task) mergeTask(r.data.task);
      S.selectedId = id;
      if (S.view === 'list') S.view = 'board';
      S.msg = { type: 'error', text: 'Задача уже изменена другим пользователем (актуальная версия ' + (r.data.current_version || '?') +
        '). Показана свежая карточка, ваши правки не применены — повторите их при необходимости.' };
      toast('Конфликт версий: карточка обновлена', 'error');
      return load();
    }
    if (r.status === 422 && code === 'TASK_BLOCKED_BY_SICK_OR_TRIP') {
      if (S.form) {
        S.form.blocked = {
          blocked_days: r.data.blocked_days || [], suggested_start: r.data.suggested_start || null,
          suggested_end: r.data.suggested_end || null
        };
        S.form.error = '';
      } else {
        S.msg = { type: 'error', text: 'Действие заблокировано: дни на больничном/в командировке.' };
      }
      render();
      return Promise.resolve();
    }
    var text = errText(r);
    if (S.form) S.form.error = text; else S.msg = { type: 'error', text: text };
    render();
    return Promise.resolve();
  }

  function submitForm() {
    if (!canWrite() || !S.form || S.busy) return Promise.resolve();
    var F = S.form, err = draftError(F.draft);
    F.blocked = null;
    if (err) { F.error = err; render(); return Promise.resolve(); }
    F.error = '';
    S.busy = true;
    var isNew = !F.id, payload = buildPayload(F.draft, isNew), p;
    if (isNew) {
      p = api('POST', API, payload);
    } else {
      payload.version = F.version;
      p = api('PUT', API + '?id=' + encodeURIComponent(F.id), payload);
    }
    return p.then(function (r) { return handleWriteResult(r, F.id, isNew ? 'Задача создана' : 'Задача сохранена'); });
  }

  function statusAction(id, action) {
    if (!canWrite() || S.busy) return Promise.resolve();
    var t = findTask(id);
    if (!t) return Promise.resolve();
    S.busy = true;
    S.msg = null;
    return api('POST', API + '?id=' + encodeURIComponent(id) + '&action=' + action, { version: t.version }).then(function (r) {
      return handleWriteResult(r, id, action === 'close' ? 'Задача закрыта' : 'Задача переоткрыта');
    });
  }

  // ---------------------------------------------------------------- actions
  function openForm(id, focus) {
    if (!canWrite()) return;
    var t = id ? findTask(id) : null;
    S.form = { id: t ? t.id : null, version: t ? t.version : null, draft: t ? draftFromTask(t) : emptyDraft(), blocked: null, error: '', focus: focus || '' };
    S.msg = null;
    render();
    if (focus === 'assignees' && DOM.root.querySelector) {
      var el = DOM.root.querySelector('[data-tk-field="assigneePick"]');
      if (el && el.focus) el.focus();
    }
  }

  var ACTIONS = {
    dismissMsg: function () { S.msg = null; render(); },
    setView: function (el) {
      S.view = el.dataset.view || 'list';
      S.form = null; S.msg = null;
      load();
    },
    resetFilters: function () {
      S.filters = { emp: '', due: '', priority: '', label: '', status: '' };
      render();
    },
    openTask: function (el) {
      S.selectedId = el.dataset.id;
      S.msg = null;
      var to = el.dataset.view;
      if (to && to !== S.view) {
        if (to === 'board') S.filters.emp = '';
        S.view = to;
        load();
      } else {
        render();
      }
    },
    filterEmp: function (el, ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      S.filters.emp = el.dataset.emp || '';
      S.selectedId = null;
      S.msg = null;
      if (S.view !== 'board') { S.view = 'board'; load(); } else { render(); }
    },
    clearEmp: function () { S.filters.emp = ''; render(); },
    newTask: function () { openForm(null); },
    editTask: function (el) { openForm(el.dataset.id); },
    reassignTask: function (el) { openForm(el.dataset.id, 'assignees'); },
    assignOrphan: function (el) { openForm(el.dataset.id, 'assignees'); },        // T1-8: «Назначить» в карточке (admin)
    mAssign: function () { runAssign(null, false); },                              // T1-8: окно замены
    mAccept: function (el) {
      var it = modalItem(el.dataset.id);
      if (it) runAssign(it, true);
    },
    mLater: function () { closeModal(); },
    closeTask: function (el) { statusAction(el.dataset.id, 'close'); },
    reopenTask: function (el) { statusAction(el.dataset.id, 'reopen'); },
    archiveTask: function (el) {
      if (!canWrite() || S.busy) return;
      var t = findTask(el.dataset.id);
      if (!t) return;
      if (typeof window.confirm === 'function' && !window.confirm('Отправить задачу «' + t.title + '» в архив?')) return;
      S.busy = true;
      api('DELETE', API + '?id=' + encodeURIComponent(t.id), { version: t.version }).then(function (r) {
        return handleWriteResult(r, t.id, 'Задача отправлена в архив');
      });
    },
    saveForm: function () { submitForm(); },
    cancelForm: function () { S.form = null; render(); },
    removeAssignee: function (el) {
      if (!S.form) return;
      S.form.draft.assignees = S.form.draft.assignees.filter(function (x) { return x !== el.dataset.emp; });
      S.form.blocked = null;
      render();
    },
    addCheck: function () {
      if (!S.form) return;
      S.form.draft.checklist.push({ text: '', done: false });
      render();
      if (DOM.root.querySelectorAll) {
        var inputs = DOM.root.querySelectorAll('[data-tk-ck-text]');
        var last = inputs && inputs[inputs.length - 1];
        if (last && last.focus) last.focus();
      }
    },
    removeCheck: function (el) {
      if (!S.form) return;
      S.form.draft.checklist.splice(+el.dataset.idx, 1);
      render();
    },
    acceptSuggested: function () {
      if (!S.form || !S.form.blocked || !S.form.blocked.suggested_start) return;
      var b = S.form.blocked, d = S.form.draft;
      d.startDate = dateOf(b.suggested_start);
      d.startTime = timeOf(b.suggested_start);
      if (d.kind === 'period' && b.suggested_end) {
        d.endDate = dateOf(b.suggested_end);
        d.endTime = timeOf(b.suggested_end);
      }
      S.form.blocked = null;
      submitForm();       // нажатие кнопки = подтверждение admin
    },
    calPrev: function () { shiftCal(-1); },
    calNext: function () { shiftCal(1); },
    calToday: function () { S.cal.anchor = todayYmd(); load(); },
    calMode: function (el) { S.cal.mode = el.dataset.mode === 'day' ? 'day' : 'week'; load(); }
  };

  function shiftCal(dir) {
    S.cal.anchor = addDays(S.cal.anchor || todayYmd(), (S.cal.mode === 'day' ? 1 : 7) * dir);
    load();
  }

  // ---------------------------------------------------------------- events
  function onClick(ev) {
    var t = ev.target;
    var el = t && t.closest ? t.closest('[data-tk-act]') : null;
    if (!el) return;
    var fn = ACTIONS[el.dataset.tkAct];
    if (typeof fn !== 'function') { console.warn(LOG, 'нет обработчика для', el.dataset.tkAct); return; }
    fn(el, ev);
  }
  function onChange(ev) {
    var t = ev.target;
    if (!t || !t.dataset) return;
    if (t.dataset.tkFilter) {
      var k = t.dataset.tkFilter, v = t.type === 'checkbox' ? !!t.checked : t.value;
      if (k === 'calEmp') { S.cal.emp = v; if (!v) S.cal.only = false; }
      else if (k === 'calOnly') S.cal.only = v;
      else S.filters[k] = v;
      render();
      return;
    }
    if (!S.form) return;
    var d = S.form.draft;
    if (t.dataset.tkCkText !== undefined) { d.checklist[+t.dataset.tkCkText].text = t.value; return; }
    if (t.dataset.tkCkDone !== undefined) { d.checklist[+t.dataset.tkCkDone].done = !!t.checked; return; }
    var f = t.dataset.tkField;
    if (!f) return;
    if (f === 'assigneePick') {
      if (t.value && d.assignees.indexOf(t.value) < 0) { d.assignees.push(t.value); S.form.blocked = null; }
      render();
      return;
    }
    if (f === 'kind') { d.kind = t.value === 'period' ? 'period' : 'single'; render(); return; }
    if (f === 'priority') { d.priority = +t.value || 2; return; }
    if (['title', 'description', 'label', 'startDate', 'startTime', 'endDate', 'endTime'].indexOf(f) >= 0) {
      d[f] = t.value;
      if (f === 'startDate' && d.kind === 'period' && (!d.endDate || d.endDate < d.startDate)) {
        d.endDate = d.startDate;
        render();
      }
    }
  }
  function onInput(ev) {
    // черновик обновляется на каждый ввод (без перерисовки, чтобы не терять фокус)
    var t = ev.target;
    if (!t || !t.dataset || !S.form) return;
    var d = S.form.draft;
    if (t.dataset.tkCkText !== undefined) { d.checklist[+t.dataset.tkCkText].text = t.value; return; }
    var f = t.dataset.tkField;
    if (f === 'title' || f === 'description' || f === 'label') d[f] = t.value;
  }
  function onDragStart(ev) {
    var t = ev.target;
    var el = t && t.closest ? t.closest('[data-tk-drag]') : null;
    if (!el || !canWrite()) return;
    S.dragId = el.dataset.tkDrag;
    if (ev.dataTransfer) { try { ev.dataTransfer.setData('text/plain', S.dragId); ev.dataTransfer.effectAllowed = 'move'; } catch (e) { /* ignore */ } }
  }
  function onDragOver(ev) {
    var t = ev.target;
    var col = t && t.closest ? t.closest('[data-tk-col]') : null;
    if (col && S.dragId && canWrite() && ev.preventDefault) ev.preventDefault();
  }
  function onDrop(ev) {
    var t = ev.target;
    var col = t && t.closest ? t.closest('[data-tk-col]') : null;
    var id = S.dragId;
    S.dragId = null;
    if (!col || !id || !canWrite()) return;
    if (ev.preventDefault) ev.preventDefault();
    var task = findTask(id), target = col.dataset.tkCol;
    if (!task || task.status === target) return;
    statusAction(id, target === 'closed' ? 'close' : 'reopen');
  }

  // ---------------------------------------------------------------- panel / tab
  var _leaving = false;
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
    if (DOM.root) DOM.root.style.display = 'none';
    if (DOM.tab) DOM.tab.classList.remove('active');
    var p = panelEl();
    if (p) p.classList.remove('tasks-tab-active');
  }
  function activate() {
    if (!DOM.root) return Promise.resolve();
    S.active = true;
    var mw = document.getElementById('matrixWrapper'), tv = document.getElementById('tripsListView');
    _leaving = true;
    if (mw) mw.style.display = 'none';
    if (tv) tv.style.display = 'none';
    _leaving = false;
    ['tabMatrix', 'tabTrips'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.classList.remove('active');
    });
    if (DOM.tab) DOM.tab.classList.add('active');
    var p = panelEl();
    if (p) p.classList.add('tasks-tab-active');
    DOM.root.style.display = 'block';
    // справочник перечитываем при каждом открытии: сотрудника могли удалить/добавить после прошлого раза
    return Promise.all([refreshUser(), loadEmployees(true)]).then(function () {
      if (!S.user) { S.msg = { type: 'error', text: ERR_TEXT.unauthorized }; render(); return; }
      if (!canWrite()) S.form = null;
      refreshOrphanCount();
      return load();
    });
  }

  /**
   * Точка входа для других модулей (T1-3: клик по иконке в матрице).
   * opts: { employeeId, date: 'YYYY-MM-DD', view: 'list'|'board'|'calendar', taskId, mode: 'week'|'day' }
   */
  function openTasksPanel(opts) {
    opts = opts || {};
    ensurePanelOpen();
    var emp = normEmpId(opts.employeeId);
    S.form = null;
    S.msg = null;
    S.view = opts.view === 'list' || opts.view === 'board' ? opts.view : 'calendar';
    if (S.view === 'calendar') {
      S.cal.anchor = parseYmd(opts.date) ? dateOf(opts.date) : todayYmd();
      if (opts.mode === 'day' || opts.mode === 'week') S.cal.mode = opts.mode;
      S.cal.emp = emp;
      S.cal.only = false;
    } else {
      S.filters.emp = emp;
    }
    S.selectedId = opts.taskId || null;
    return activate();
  }

  // ---------------------------------------------------------------- T1-8: окно замены исполнителя
  var OPEN_FOR_TIMEOUT_MS = 5000;

  /** Открытые задачи сотрудника (до удаления): Promise<{ok, count, tasks}>; при сбое ok=false (удаление не блокируется). */
  function openTasksFor(empId) {
    var id = normEmpId(empId);
    var fail = { ok: false, count: 0, tasks: [] };
    if (!id) return Promise.resolve(fail);
    var timer = null;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve({ ok: false, status: 0, data: {} }); }, OPEN_FOR_TIMEOUT_MS);
    });
    return Promise.race([api('GET', API + '?open_for=' + encodeURIComponent(id)), timeout]).then(function (r) {
      if (timer) clearTimeout(timer);
      if (r.ok && r.data && r.data.success && Array.isArray(r.data.tasks)) {
        return { ok: true, count: r.data.tasks.length, tasks: r.data.tasks };
      }
      return fail;
    });
  }

  function modalItem(id) {
    var M = S.modal;
    if (!M) return null;
    for (var i = 0; i < M.items.length; i++) if (M.items[i].id === id) return M.items[i];
    return null;
  }
  function activeIds(task) {
    return assigneesOf(task).filter(function (a) { return !a.removed; }).map(function (a) { return a.employee_id; });
  }
  // свежая карточка задачи: версия, состав исполнителей, не закрыта ли
  function readItem(it) {
    return api('GET', API + '?id=' + encodeURIComponent(it.id)).then(function (r) {
      var t = r.ok && r.data && r.data.task;
      if (!t) {
        it.status = 'error';
        it.readFailed = true;
        it.error = r.status === 404 ? ERR_TEXT.not_found : errText(r);
        it.checked = false;
        return false;
      }
      it.task = t;
      it.version = t.version;
      it.others = activeIds(t);
      if (it.initialOthers === undefined) it.initialOthers = it.others.slice();
      if (t.status !== 'open' || t.archived) {
        it.status = 'skipped'; it.note = 'Задача уже закрыта или в архиве — не переназначается.'; it.checked = false;
      } else if (!it.initialOthers.length && it.others.length) {
        it.status = 'skipped';
        it.note = 'Исполнитель уже назначен: ' + it.others.map(empName).join(', ') + '.'; it.checked = false;
      } else if (it.readFailed) {
        it.readFailed = false; it.status = 'pending'; it.error = ''; it.checked = true;
      }
      return true;
    });
  }
  function itemSuggestion(it) {
    var b = it.blocked;
    if (!b || !b.suggested_start) return null;
    var p = { start_at: dateOf(b.suggested_start) + (timeOf(b.suggested_start) ? 'T' + timeOf(b.suggested_start) : '') };
    if (it.task && it.task.end_at && b.suggested_end) {
      p.end_at = dateOf(b.suggested_end) + (timeOf(b.suggested_end) ? 'T' + timeOf(b.suggested_end) : '');
    }
    return p;
  }
  // одна задача: PUT assignees (+ предложенная дата при accept) с version; 409 → перечитать и повторить один раз
  function putItem(it, target, accept, retried) {
    var ids = (it.others || []).filter(function (x) { return x !== target; });
    ids.push(target);
    var body = { version: it.version, assignees: ids };
    if (accept) {
      var sg = itemSuggestion(it);
      if (sg) { body.start_at = sg.start_at; if (sg.end_at) body.end_at = sg.end_at; }
    }
    return api('PUT', API + '?id=' + encodeURIComponent(it.id), body).then(function (r) {
      var code = r.data && r.data.error;
      if (r.ok && r.data && r.data.success) {
        it.status = 'done'; it.error = ''; it.blocked = null; it.checked = false;
        it.assignedTo = empName(target);
        if (r.data.task) { it.task = r.data.task; it.version = r.data.task.version; }
        return 'done';
      }
      if (r.status === 409 && code === 'VERSION_CONFLICT') {
        if (retried) {
          it.status = 'error'; it.error = 'Задача изменена другим пользователем — повторите назначение.';
          return 'error';
        }
        return readItem(it).then(function (ok) {
          if (!ok) return 'error';
          if (it.status === 'skipped') return 'skipped';
          return putItem(it, target, accept, true);
        });
      }
      if (r.status === 422 && code === 'TASK_BLOCKED_BY_SICK_OR_TRIP') {
        it.status = 'blocked'; it.error = '';
        it.blocked = {
          blocked_days: r.data.blocked_days || [], suggested_start: r.data.suggested_start || null,
          suggested_end: r.data.suggested_end || null
        };
        return 'blocked';
      }
      if (code === 'employee_not_found') return 'no_employee';
      it.status = 'error'; it.error = errText(r);
      return 'error';
    });
  }
  function runAssign(only, accept) {
    var M = S.modal;
    if (!M || M.busy || !canWrite()) return Promise.resolve();
    if (!M.target) { M.error = 'Выберите сотрудника, которому передать задачи.'; renderModal(); return Promise.resolve(); }
    var items = only ? [only] : M.items.filter(function (it) {
      return it.checked && it.status !== 'done' && it.status !== 'skipped';
    });
    if (!items.length) { M.error = 'Отметьте хотя бы одну задачу.'; renderModal(); return Promise.resolve(); }
    M.error = '';
    M.busy = true;
    renderModal();
    var target = M.target, changed = false, noEmp = false;
    return M.ready.then(function () {
      return items.reduce(function (p, it) {
        return p.then(function () {
          if (noEmp) return null;
          var go = it.task ? Promise.resolve(true) : readItem(it);
          return go.then(function (ok) {
            if (!ok || it.status === 'skipped') return null;
            return putItem(it, target, accept, false).then(function (res) {
              if (res === 'done') changed = true;
              if (res === 'no_employee') noEmp = true;
            });
          });
        });
      }, Promise.resolve());
    }).then(function () {
      M.busy = false;
      if (noEmp) {
        M.error = ERR_TEXT.employee_not_found + ' Возможно, его уже удалили — выберите другого.';
        M.target = '';
        return loadEmployees(true).then(function () { if (S.modal === M) renderModal(); });
      }
      if (changed) {
        toast('Задачи переназначены', 'success');
        notifyChanged();
        if (S.active) load();
      }
      if (S.modal === M) renderModal();
      return null;
    });
  }

  function renderModal() {
    var M = S.modal;
    if (!M || !DOM.modal) return;
    var n = M.items.length;
    var left = M.items.filter(function (it) { return it.status !== 'done' && it.status !== 'skipped'; }).length;
    var dis = M.busy ? ' disabled' : '';
    var h = '<div class="tk-modal" role="dialog" aria-modal="true" aria-label="Замена исполнителя">';
    h += '<h4 class="tk-mtitle">У ' + esc(M.fullName || GONE_NAME) + ' было ' + n + ' ' +
      plural(n, 'открытая задача', 'открытые задачи', 'открытых задач') + '</h4>';
    h += '<p class="tk-muted">Сотрудник удалён. Передайте задачи другому исполнителю или нажмите «Позже» — ' +
      'они останутся без исполнителя (счётчик ⚠ на вкладке «Задачи»).</p>';
    if (M.error) h += '<div class="tk-msg tk-msg-error" role="alert">' + esc(M.error) + '</div>';
    h += '<ul class="tk-mlist">';
    M.items.forEach(function (it) {
      var finished = it.status === 'done' || it.status === 'skipped';
      h += '<li class="tk-mit tk-mit-' + esc(it.status) + '" data-tk-mitem="' + esc(it.id) + '"><label>' +
        '<input type="checkbox" data-tk-mchk="' + esc(it.id) + '"' + (it.checked ? ' checked' : '') + (finished || M.busy ? ' disabled' : '') + '> ' +
        '<b>' + esc(it.title) + '</b></label> <span class="tk-muted">' + esc(fmtPeriod(it)) + '</span>';
      if (it.others && it.others.length && it.status !== 'done') {
        h += '<div class="tk-muted">Остаётся исполнителем: ' + esc(it.others.map(empName).join(', ')) + '</div>';
      }
      if (it.status === 'done') h += '<div class="tk-mok">✓ Назначена: ' + esc(it.assignedTo || '') + '</div>';
      if (it.status === 'skipped') h += '<div class="tk-muted">' + esc(it.note || 'Пропущена.') + '</div>';
      if (it.status === 'error') h += '<div class="tk-merr" role="alert">' + esc(it.error || 'Ошибка.') + '</div>';
      if (it.status === 'blocked' && it.blocked) {
        h += '<div class="tk-box tk-box-warn tk-mblocked"><b>Не переназначена:</b> у выбранного сотрудника больничный или командировка в срок задачи.<ul class="tk-notes">';
        (it.blocked.blocked_days || []).forEach(function (d) {
          h += '<li>' + esc(fmtDay(d.date)) + ' — ' + esc(empName(d.employee_id)) + ' (' + esc(REASON_TEXT[d.reason] || d.reason) + ')</li>';
        });
        h += '</ul>';
        if (it.blocked.suggested_start) {
          var sg = itemSuggestion(it);
          h += '<div>Ближайший свободный срок: <b>' + esc(fmtDay(dateOf(sg.start_at)) + (timeOf(sg.start_at) ? ' ' + timeOf(sg.start_at) : '') +
            (sg.end_at ? ' — ' + fmtDay(dateOf(sg.end_at)) + (timeOf(sg.end_at) ? ' ' + timeOf(sg.end_at) : '') : '')) + '</b> ' +
            '<button type="button" class="tk-btn tk-primary" data-tk-act="mAccept" data-id="' + esc(it.id) + '"' + dis + '>Принять предложенную дату</button></div>';
        } else {
          h += '<div>Подходящую дату подобрать не удалось — выберите другого сотрудника или измените срок в карточке задачи.</div>';
        }
        h += '</div>';
      }
      h += '</li>';
    });
    h += '</ul>';
    h += '<div class="tk-mrow"><label>Передать: <select data-tk-mtarget="1"' + dis + '>' +
      empOptions(M.target, '— выберите сотрудника —') + '</select></label></div>';
    h += '<div class="tk-actions"><button type="button" class="tk-btn tk-primary" data-tk-act="mAssign"' + dis + '>Назначить</button>' +
      '<button type="button" class="tk-btn" data-tk-act="mLater"' + dis + '>' + (left ? 'Позже' : 'Закрыть') + '</button></div></div>';
    DOM.modal.innerHTML = h;
  }

  function onModalChange(ev) {
    var t = ev.target, M = S.modal;
    if (!t || !t.dataset || !M || M.busy) return;
    if (t.dataset.tkMtarget !== undefined) {
      M.target = t.value;
      M.error = '';
      // причина блокировки относилась к прежнему сотруднику — сбрасываем
      M.items.forEach(function (it) { if (it.status === 'blocked' || it.status === 'error') { it.status = 'pending'; it.blocked = null; it.error = ''; } });
      renderModal();
      return;
    }
    if (t.dataset.tkMchk !== undefined) {
      var it = modalItem(t.dataset.tkMchk);
      if (it) it.checked = !!t.checked;
    }
  }
  function onModalKey(ev) {
    if (ev && ev.key === 'Escape' && S.modal && !S.modal.busy) closeModal();
  }
  function closeModal() {
    var M = S.modal;
    if (!M || M.busy) return;
    S.modal = null;
    var el = DOM.modal;
    DOM.modal = null;
    if (el) {
      if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
      else if (el.remove) el.remove();
    }
    if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', onModalKey);
    refreshOrphanCount();
  }

  /**
   * Окно замены после удаления сотрудника (вызывается из #deleteEmp, index.html).
   * tasks — результат openTasksFor(empId).tasks, снятый ДО удаления. Только admin; остальным — ничего.
   * «Назначить» — PUT по каждой отмеченной задаче; «Позже» — закрыть (задачи остаются в счётчике ⚠).
   */
  function offerReassign(empId, fullName, tasks) {
    var list = (tasks || []).filter(function (t) { return t && t.id; });
    refreshOrphanCount();                              // задачи сотрудника уже без исполнителя
    if (!list.length) return Promise.resolve(false);
    return refreshUser().then(function () {
      if (!canWrite()) return false;
      return loadEmployees(true).then(function () {
        var gone = normEmpId(empId);
        // сервер мог не применить удаление (stale-защита save.php) — тогда окно не показываем
        if (S.employees.some(function (e) { return e.id === gone; })) return false;
        S.employees = S.employees.filter(function (e) { return e.id !== gone; });
        S.empById = {};
        S.employees.forEach(function (e) { S.empById[e.id] = e; });
        if (S.modal) closeModal();
        var M = S.modal = {
          empId: gone, fullName: fullName || '', target: '', error: '', busy: false, ready: null,
          items: list.map(function (t) {
            return { id: String(t.id), title: t.title || '', start_at: t.start_at, end_at: t.end_at || null,
              version: t.version, checked: true, status: 'pending', error: '', blocked: null, others: [], task: null };
          })
        };
        var el = document.createElement('div');
        el.id = 'tasksReassignModal';
        el.className = 'tk-modal-back';
        el.addEventListener('click', onClick);
        el.addEventListener('change', onModalChange);
        DOM.modal = el;
        renderModal();
        (document.body || document.documentElement).appendChild(el);
        if (typeof document.addEventListener === 'function') document.addEventListener('keydown', onModalKey);
        M.ready = Promise.all(M.items.map(function (it) { return readItem(it); })).then(function () {
          if (S.modal === M) renderModal();
        });
        return M.ready.then(function () { return true; });
      });
    });
  }

  function css() {
    return '' +
      '#tasksView{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px;color:var(--text);font-size:13px}' +
      '.vacation-panel.tasks-tab-active .vacation-legend{display:none}' +
      '.tk-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}' +
      '.tk-title{margin:0;font-size:16px}' +
      '.tk-switch{display:inline-flex;border:1px solid var(--divider);border-radius:8px;overflow:hidden}' +
      '.tk-sw{border:0;background:#fff;padding:6px 14px;cursor:pointer;color:var(--text);font:inherit}' +
      '.tk-sw+.tk-sw{border-left:1px solid var(--divider)}' +
      '.tk-sw.active{background:var(--rt-purple);color:#fff}' +
      '.tk-btn{border:1px solid var(--divider);background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--text);font:inherit}' +
      '.tk-btn:hover{background:rgba(119,0,255,.06)}' +
      '.tk-btn[disabled]{opacity:.5;cursor:default}' +
      '.tk-primary{background:var(--rt-blue);border-color:var(--rt-blue);color:#fff}.tk-primary:hover{background:#0077b3}' +
      '.tk-danger{color:var(--sick-red);border-color:var(--sick-red)}' +
      '.tk-ro{font-size:12px;color:var(--accent);border:1px dashed var(--divider);border-radius:10px;padding:2px 10px}' +
      '.tk-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}' +
      '.tk-filters label{display:flex;gap:4px;align-items:center}' +
      '.tk-filters select,.tk-form input,.tk-form select,.tk-form textarea{border:1px solid var(--divider);border-radius:6px;padding:4px 6px;font:inherit;background:#fff;color:var(--text)}' +
      '.tk-tablewrap{overflow:auto}' +
      '.tk-table{border-collapse:collapse;width:100%}' +
      '.tk-table th,.tk-table td{border-bottom:1px solid var(--divider);padding:6px 8px;text-align:left;vertical-align:top}' +
      '.tk-row{cursor:pointer}.tk-row:hover{background:rgba(0,136,204,.06)}' +
      '.tk-nowrap{white-space:nowrap}' +
      '.tk-name{color:var(--rt-blue);text-decoration:none;border-bottom:1px dotted var(--rt-blue)}' +
      '.tk-hi{color:var(--rt-orange);font-weight:600}' +
      '.tk-dim{opacity:.6}' +
      '.tk-tag{display:inline-block;font-size:11px;border:1px solid var(--divider);border-radius:10px;padding:0 7px;margin:2px 4px 0 0;background:#fff}' +
      '.tk-tag.tk-hi{border-color:var(--rt-orange)}' +
      '.tk-warn{color:var(--sick-red);border-color:var(--sick-red)}' +
      '.tk-pending{color:#8a6d00;border-color:#d4b106;background:#fffbe6}' +
      '.tk-neutral{color:var(--accent);background:rgba(138,155,181,.12)}' +
      '.tk-closed{color:var(--accent)}' +
      '.tk-muted,.tk-empty{color:var(--accent)}' +
      '.tk-msg{border-radius:8px;padding:8px 12px;margin:8px 0;border:1px solid var(--divider)}' +
      '.tk-msg-error{background:rgba(244,67,54,.08);border-color:var(--sick-red);color:#a3261b}' +
      '.tk-msg-ok{background:rgba(76,175,80,.1);border-color:var(--vacation-green)}' +
      '.tk-x{border:0;background:transparent;cursor:pointer;font-size:15px;line-height:1;color:inherit}' +
      '.tk-split{display:flex;gap:14px;align-items:flex-start}' +
      '.tk-cols{flex:1 1 auto;min-width:0;display:flex;gap:14px}' +
      '.tk-col{flex:1;min-width:160px;border:1px solid var(--divider);border-radius:8px;padding:6px 8px;min-height:120px}' +
      '.tk-card{border:1px solid var(--divider);border-radius:8px;padding:8px 10px;background:#fff;margin:6px 0;cursor:pointer}' +
      '.tk-card[draggable=true]{cursor:grab}' +
      '.tk-sel{outline:2px solid var(--rt-blue);box-shadow:0 0 8px rgba(0,136,204,.35)}' +
      '.tk-sub{color:var(--accent);margin:2px 0}' +
      '.tk-detail{flex:0 0 300px;max-width:100%;border:1px solid var(--divider);border-radius:8px;padding:10px 12px;background:#fff}' +
      '.tk-dhead{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}' +
      '.tk-dtitle{font-size:14px}' +
      '.tk-kv{margin:8px 0}.tk-kv>span{display:block;color:var(--accent);font-size:11px;text-transform:uppercase}' +
      '.tk-pre{white-space:pre-wrap;word-break:break-word}' +
      '.tk-ck,.tk-notes{margin:4px 0 0;padding-left:16px}.tk-ck{list-style:none;padding-left:0}.tk-done{text-decoration:line-through;color:var(--accent)}' +
      '.tk-box{border:1px solid var(--divider);border-radius:8px;padding:6px 10px;margin:8px 0;background:rgba(138,155,181,.08)}' +
      '.tk-box-warn{border-color:var(--sick-red);background:rgba(244,67,54,.07)}' +
      '.tk-box-pending{border-color:#d4b106;background:#fffbe6}' +
      '.tk-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
      '.tk-wk{flex:1 1 auto;min-width:0;display:grid;border:1px solid var(--divider);border-radius:8px;overflow:hidden}' +
      '.tk-wk-h{padding:4px 6px;border-bottom:1px solid var(--divider);border-right:1px solid var(--divider);background:rgba(138,155,181,.08)}' +
      '.tk-wk-c{padding:4px;border-right:1px solid var(--divider);min-height:160px}' +
      '.tk-we{background:var(--weekend-bg)}' +
      '.tk-today{box-shadow:inset 0 -2px 0 var(--rt-blue)}' +
      '.tk-ev{background:rgba(0,136,204,.14);border-left:3px solid var(--rt-blue);border-radius:4px;padding:3px 5px;margin-bottom:4px;font-size:11px;cursor:pointer;overflow:hidden}' +
      '.tk-ev.tk-conf{border-left-color:var(--sick-red);background:rgba(244,67,54,.1)}' +
      '.tk-ev.tk-hl{border-left-color:var(--rt-purple);background:rgba(119,0,255,.14)}' +
      '.tk-ev-when{color:var(--accent)}.tk-ev-desc{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}' +
      '.tk-caltitle{min-width:130px;text-align:center}' +
      '.tk-form{max-width:640px}' +
      '.tk-f{margin:10px 0}.tk-f>label{display:block;color:var(--accent);font-size:11px;text-transform:uppercase;margin-bottom:3px}' +
      '.tk-f input[type=text],.tk-f textarea{width:100%}' +
      '.tk-f-off{opacity:.55}' +
      '.tk-chips{margin-bottom:4px}.tk-chip{display:inline-block;border:1px solid var(--divider);border-radius:12px;padding:1px 8px;margin:0 4px 4px 0;background:#fff}' +
      '.tk-radio label,.tk-check{margin-right:14px;color:var(--text);font-size:13px;text-transform:none}' +
      '.tk-dt{margin-top:6px}.tk-dt span{display:inline-block;min-width:54px;color:var(--accent)}' +
      '.tk-ckrow{display:flex;gap:6px;align-items:center;margin-bottom:4px}.tk-ckrow input[type=text]{flex:1}' +
      // T1-8: «Исполнитель удалён»
      '.tk-orph-cnt{display:inline-block;margin-left:6px;padding:0 7px;border-radius:9px;background:var(--rt-orange);color:#fff;font-size:11px;font-weight:700;line-height:16px;vertical-align:middle}' +
      '.tk-plate{display:inline-block;background:#e4e6eb;color:#555;border-radius:10px;padding:1px 8px;font-size:12px}' +
      '.tk-row.tk-orph>td:first-child{box-shadow:inset 4px 0 0 var(--rt-orange)}' +
      '.tk-gone{color:var(--accent);text-decoration:line-through}' +
      '.tk-boardmain{flex:1 1 auto;min-width:0}' +
      '.tk-sec{border:1px solid var(--rt-orange);border-radius:8px;padding:6px 8px;margin-bottom:12px;background:rgba(255,79,18,.05)}' +
      '.tk-sec-cards{display:flex;gap:8px;flex-wrap:wrap}.tk-sec-cards .tk-card{flex:1 1 220px;max-width:320px}' +
      '.tk-card.tk-orph{border-left:4px solid var(--rt-orange)}' +
      '.tk-ev.tk-orph{border:1.5px dashed var(--rt-orange);background:rgba(255,79,18,.06)}' +
      '.tk-orph-lbl{color:var(--rt-orange)}' +
      '.tk-box-orph{border-color:var(--rt-orange);background:rgba(255,79,18,.08)}' +
      '.tk-modal-back{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:20000;display:flex;align-items:center;justify-content:center}' +
      '.tk-modal{background:#fff;border-radius:12px;width:560px;max-width:calc(100% - 24px);max-height:86vh;overflow:auto;padding:16px 18px;color:var(--text);font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.35)}' +
      '.tk-mtitle{margin:0 0 6px;font-size:16px}' +
      '.tk-mlist{list-style:none;margin:8px 0;padding:0}' +
      '.tk-mit{border:1px solid var(--divider);border-radius:8px;padding:6px 10px;margin-bottom:6px}' +
      '.tk-mit-done{background:rgba(76,175,80,.08)}.tk-mok{color:#2e7d32}.tk-merr{color:#a3261b}' +
      '.tk-mrow{margin:10px 0}.tk-mrow select{border:1px solid var(--divider);border-radius:6px;padding:4px 6px;font:inherit;background:#fff;color:var(--text)}' +
      '@media (max-width:760px){#tasksView{padding:8px}.tk-split{flex-direction:column}.tk-detail{flex:1 1 auto;width:100%}' +
      '.tk-cols{width:100%;flex-direction:column}.tk-wk{width:100%;overflow-x:auto}.tk-wk-c{min-height:90px}}';
  }

  // ---------------------------------------------------------------- init
  function injectStyles() {
    if (document.getElementById('tasksModuleStyles')) return;
    var st = document.createElement('style');
    st.id = 'tasksModuleStyles';
    st.textContent = css();
    document.head.appendChild(st);
  }
  function init() {
    if (S.inited) return;
    DOM.root = document.getElementById('tasksView');
    DOM.tab = document.getElementById('tabTasks');
    if (!DOM.root || !DOM.tab) return;           // разметка не вставлена — модуль не активируется
    S.inited = true;
    injectStyles();
    DOM.tab.addEventListener('click', function () { activate(); });
    ['tabMatrix', 'tabTrips'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', deactivate);
    });
    // Trips.switchTab может вызываться программно (в т.ч. изнутри trips.js) и сам
    // показывает матрицу/командировки — тогда уходим с вкладки «Задачи».
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function () {
        if (_leaving || !S.active) return;
        var mw = document.getElementById('matrixWrapper'), tv = document.getElementById('tripsListView');
        if ((mw && mw.style.display === 'block') || (tv && tv.style.display === 'block')) deactivate();
      });
      ['matrixWrapper', 'tripsListView'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) mo.observe(el, { attributes: true, attributeFilter: ['style'] });
      });
    }
    DOM.root.addEventListener('click', onClick);
    DOM.root.addEventListener('change', onChange);
    DOM.root.addEventListener('input', onInput);
    // Enter в поле формы не должен перезагружать страницу; сохранение — только кнопкой.
    DOM.root.addEventListener('submit', function (ev) { if (ev.preventDefault) ev.preventDefault(); });
    DOM.root.addEventListener('dragstart', onDragStart);
    DOM.root.addEventListener('dragover', onDragOver);
    DOM.root.addEventListener('drop', onDrop);
    // T1-8: счётчик ⚠ на вкладке — при старте и при каждом открытии панели отпусков
    var trg = document.getElementById('vacationTrigger');
    if (trg) trg.addEventListener('click', function () { refreshOrphanCount(); });
    refreshOrphanCount();
  }
  function autoInit() {
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
  }

  window.Tasks = {
    init: init,
    open: openTasksPanel,
    activate: activate,
    deactivate: deactivate,
    reload: load,
    canWrite: canWrite,
    openTasksFor: openTasksFor,           // T1-8: до удаления сотрудника (index.html #deleteEmp)
    offerReassign: offerReassign,         // T1-8: после удаления (index.html #deleteEmp)
    refreshOrphans: refreshOrphanCount,
    isActive: function () { return S.active; },
    // для тестов (scripts/test_tasks_frontend.js); в UI не используется
    __t: {
      S: S, ACTIONS: ACTIONS, render: render, onClick: onClick, onChange: onChange, onDrop: onDrop, onDragStart: onDragStart,
      truncate: truncate, weekStart: weekStart, addDays: addDays, fmtPeriod: fmtPeriod, normEmpId: normEmpId,
      applyFilters: applyFilters, buildPayload: buildPayload, draftError: draftError, esc: esc,
      isOrphan: isOrphan, removedDate: removedDate, plural: plural, modalEl: function () { return DOM.modal; }
    }
  };
  window.openTasksPanel = openTasksPanel;

  autoInit();
})();
