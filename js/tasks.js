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
    invalid_label: 'Метка некорректна: тег — до 30 символов, все теги вместе — до 200.',
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
    version_required: 'Не передана версия задачи — перезагрузите карточку.',
    // V6.3-2 (Д-1): повторы; понятный текст приходит с сервера (message), эти — запасные
    invalid_occurrence: 'Повтор указан неверно.',
    occurrence_duplicate: 'Повтор совпадает с основной датой задачи или другим повтором.',
    occurrences_too_many: 'Повторов не больше 100.',
    invalid_occurrences: 'Повторы заданы неверно.',
    occurrence_not_found: 'Повтор не найден (возможно, уже удалён) — календарь обновлён.'
  };
  var OCC_MAX = 100;                           // V6.3-2: максимум повторов у задачи (как на сервере)

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
    cal: { mode: 'week', anchor: null, emp: '', only: false, adAll: false, scrollTop: null, scrollLeft: 0, fresh: false, flashOcc: null },
    form: null,                   // { id, version, draft, blocked, error } | null
    msg: null,                    // { type: 'error'|'ok'|'info', text }
    loading: false,
    loadError: null,
    busy: false,
    dragId: null,
    loadSeq: 0,
    orphanCount: 0,                // T1-8: открытые задачи без исполнителя (?orphans=1)
    modal: null,                   // T1-8: окно замены { empId, fullName, items, target, error, busy }
    att: null,                     // V7: окно вложений { taskId, title, list, canUpload, limits, loading, error, queue, pending }
    dirty: false,                  // T1-11: sync принёс изменения, пока панель/форма закрыта — перечитать при возврате
    sort: { key: '', dir: '' }     // V6-1 (R-17): сортировка Списка: key = priority|status, dir = asc|desc; '' = без сортировки
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

  // ---- V6.3-2 (Д-1): повторы. Задача = одна запись; выполнений несколько: основная дата + t.occurrences[{id,start_at,end_at}]
  function occsOf(t) { return Array.isArray(t && t.occurrences) ? t.occurrences : []; }
  function whenKey(s) { var m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(s || '')); return m ? m[1] + (m[2] ? 'T' + m[2] : '') : String(s || ''); }
  // все выполнения по возрастанию: [{ start_at, end_at, main, id }]
  function allWhens(t) {
    var out = [{ start_at: t.start_at, end_at: t.end_at == null ? null : t.end_at, main: true, id: null }];
    occsOf(t).forEach(function (o) { out.push({ start_at: o.start_at, end_at: o.end_at == null ? null : o.end_at, main: false, id: o.id }); });
    return out.sort(function (a, b) { return whenKey(a.start_at) < whenKey(b.start_at) ? -1 : whenKey(a.start_at) > whenKey(b.start_at) ? 1 : 0; });
  }
  // ближайшее предстоящее выполнение (сервер: next_at = start_at этого выполнения; все прошли — последнее)
  function nextWhen(t) {
    var all = allWhens(t), key = whenKey(t.next_at || t.start_at);
    for (var i = 0; i < all.length; i++) if (whenKey(all[i].start_at) === key) return all[i];
    return all[0];
  }
  function dueText(t) { return fmtPeriod(nextWhen(t)); }                       // «Срок» Списка/Доски — next_at
  function allDatesText(t) {                                                     // подсказка: все даты выполнения
    return allWhens(t).map(function (w) { return (w.main ? '' : '↻ ') + fmtPeriod(w); }).join('\n');
  }
  function occBadge(t) {
    var n = occsOf(t).length;
    if (!n) return '';
    return ' <span class="tk-occ-n" data-tk-occ-n="' + n + '" title="' + esc('Повторов: ' + n + '. Даты выполнения:\n' + allDatesText(t)) + '">↻ ' + n + '</span>';
  }
  // порядок по сроку: по next_at (стабильно — при равенстве остаётся порядок сервера)
  function sortByDue(rows) {
    return rows.map(function (t, i) { return { t: t, i: i, k: whenKey(t.next_at || t.start_at) }; })
      .sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i; })
      .map(function (x) { return x.t; });
  }
  function taskDays(t) { return Array.isArray(t.days) && t.days.length ? t.days : [t.first_day, t.last_day].filter(Boolean); }

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
    if (code === 'invalid_label' && r.data && r.data.message) return String(r.data.message);     // V6.2 (W-4): понятный текст сервера
    // V6.3-2: ошибки повторов несут понятный текст сервера («Повтор 2 (…) совпадает с …»)
    if (/^(invalid_occurrence|occurrence_duplicate|occurrences_too_many|invalid_occurrences)$/.test(code || '') && r.data && r.data.message) return String(r.data.message);
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
  function load(silent) {
    var seq = ++S.loadSeq;
    S.dirty = false;
    var q = '';
    if (S.view === 'calendar') {
      var r = calRange();
      q = '?from=' + r.from + '&to=' + r.to;
    }
    if (!silent) { S.loading = true; render(); }
    return api('GET', API + q).then(function (res) {
      if (seq !== S.loadSeq) return;       // устаревший ответ
      S.loading = false;
      if (res.ok && res.data.success) {
        S.tasks = res.data.tasks || [];
        S.loadError = null;
      } else if (!silent) {
        S.loadError = errText(res);
      } else {
        return;                            // фоновое обновление не удалось — остаётся прежний список без ошибки
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
  // V6.2 (W-4): метка = теги через запятую (сервер хранит «тег1, тег2» и отдаёт labels[]).
  // splitTags — та же нормализация, что на сервере: split по «,», trim, схлопнуть пробелы, без пустых и дублей (без учёта регистра).
  var TAG_MAX = 30, LABEL_MAX = 200;
  function splitTags(v) {
    var out = [], seen = {};
    String(v == null ? '' : v).split(',').forEach(function (p) {
      var tag = p.replace(/\s+/g, ' ').trim(), key = tag.toLowerCase();
      if (!tag || seen[key]) return;
      seen[key] = 1;
      out.push(tag);
    });
    return out;
  }
  function tagsOf(t) { return Array.isArray(t.labels) ? t.labels.slice() : splitTags(t.label); }
  function labelsOf(tasks) {
    var seen = {}, out = [];
    tasks.forEach(function (t) {
      tagsOf(t).forEach(function (tag) { var k = tag.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(tag); } });
    });
    return out.sort(function (a, b) {
      var x = a.toLowerCase(), y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  function hasTag(t, tag) {
    var k = String(tag).toLowerCase();
    return tagsOf(t).some(function (x) { return x.toLowerCase() === k; });
  }
  function matchDue(t, due) {
    if (!due) return true;
    var today = todayYmd(), days = taskDays(t);          // V6.3-2: дни ВСЕХ выполнений (основная дата + повторы)
    if (due === 'overdue') return t.status === 'open' && days[days.length - 1] < today;
    if (due === 'today') return days.indexOf(today) >= 0 || (t.first_day <= today && today <= t.last_day);
    if (due === 'week') {
      var ws = weekStart(today), we = addDays(ws, 6);
      return days.some(function (d) { return d >= ws && d <= we; }) || (t.first_day <= we && t.last_day >= ws);
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
      if (f.label && !hasTag(t, f.label)) return false;      // V6.2 (W-4): задача содержит тег
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
  // V6-1 (R-12…R-14): тег-фильтр — кнопка, ведущая в «Список» с одним фильтром (ACTIONS.filterBy)
  function tagBtn(cls, text, field, value, hint) {
    // span[role=button], а не <button>: внутри draggable-карточки Доски кнопка в Firefox не даёт тащить карточку; Enter/Space — onKeyTag
    return '<span role="button" tabindex="0" class="tk-tag tk-tagbtn' + (cls ? ' ' + cls : '') + '" data-tk-act="filterBy" data-f="' + field +
      '" data-v="' + esc(value) + '" title="' + esc(hint) + '">' + esc(text) + '</span>';
  }
  function priorityTag(t, link) {
    var p = +t.priority;
    var text = PRIORITY_TEXT[p] || p;
    if (link) return tagBtn(p === 1 ? 'tk-hi' : '', text, 'priority', String(t.priority), 'Показать в Списке все задачи с приоритетом «' + text + '»');
    return '<span class="tk-tag' + (p === 1 ? ' tk-hi' : '') + '">' + esc(text) + '</span>';
  }
  function statusTag(t, link) {
    var closed = t.status === 'closed';
    var text = closed ? 'Закрыта' : 'Открыта';
    if (link) return tagBtn(closed ? 'tk-closed' : '', text, 'status', closed ? 'closed' : 'open', 'Показать в Списке все задачи со статусом «' + text + '»');
    return '<span class="tk-tag' + (closed ? ' tk-closed' : '') + '">' + text + '</span>';
  }
  function conflictReasons(t) {
    var seen = {}, out = [];
    (t.conflict_days || []).forEach(function (c) {
      if (!seen[c.reason]) { seen[c.reason] = 1; out.push(REASON_TEXT[c.reason] || c.reason); }
    });
    return out;
  }
  function badgesHtml(t, link, noAtt) {
    var h = '';
    // V6.2 (W-4): каждый тег — отдельный чип (link → кликабельный: в «Список» с фильтром по этому тегу)
    tagsOf(t).forEach(function (tag) {
      h += link ? tagBtn('tk-ltag', tag, 'label', tag, 'Показать в Списке все задачи с меткой «' + tag + '»') : '<span class="tk-tag tk-ltag">' + esc(tag) + '</span>';
    });
    if (t.checklist && t.checklist.length) {
      var done = t.checklist.filter(function (c) { return c.done; }).length;
      h += '<span class="tk-tag">☑ ' + done + '/' + t.checklist.length + '</span>';
    }
    if (!noAtt) h += attCountTag(t);                    // V7: «скрепка N» (в карточке вместо него — кнопка-значок)
    if (t.conflict) {
      h += '<span class="tk-tag tk-warn" title="Задача легла на дни, когда у исполнителя больничный или командировка">конфликт: ' + esc(conflictReasons(t).join(', ') || 'больничный/командировка') + '</span>';
    }
    if (t.check_state === 'pending') {
      h += '<span class="tk-tag tk-pending" title="Проверка правил (n8n) ещё не выполнена — будет перепроверена автоматически">не проверено</span>';
    }
    if (t.status === 'closed') h += '<span class="tk-tag tk-closed">закрыта</span>';
    return h;
  }
  // подстрока карточки Доски: ФИО — ссылка «Список по сотруднику» (V6-5, P2-1; span[role=button], не <a>: <a> внутри draggable-карточки
  // перехватывает перетаскивание, как и <button>, см. tagBtn); удалённый исполнитель открытой задачи зачёркнут (как в Списке/карточке)
  var BOARD_NAMES_MAX = 2;      // V6.2 (W-3) / V6.3-1 (И-1): в плитке Доски и в колонке «Исполнитель» Списка не больше 2 исполнителей, дальше «…»
  // V6.3-1 (И-1): общий помощник Доски и Списка — первые BOARD_NAMES_MAX исполнителей (one(p) → html) через «, »; при большем числе — «…» отдельным чипом
  // (не часть фамилии: пробел + свой фон). Полный список — title контейнера (namesTitle).
  var NAMES_MORE_HTML = ' <span class="tk-more">…</span>';
  function limitNames(t, one) {
    var all = assigneesOf(t);
    return all.slice(0, BOARD_NAMES_MAX).map(one).join(', ') + (all.length > BOARD_NAMES_MAX ? NAMES_MORE_HTML : '');
  }
  function nameStrike(t) {
    var open = t.status === 'open' && !t.archived;
    return limitNames(t, function (p) {
      if (p.removed) return open ? '<s class="tk-gone" title="Сотрудник удалён">' + esc(personName(p)) + '</s>' : esc(personName(p));
      return '<span role="button" tabindex="0" class="tk-name tk-namebtn" data-tk-act="filterEmp" data-emp="' + esc(p.employee_id) + '"' +
        ' title="Показать в Списке все задачи сотрудника">' + esc(personName(p)) + '</span>';
    });
  }
  // полный список ФИО для title подстроки плитки Доски (W-3); только когда список обрезан («…»)
  function namesTitle(t) {
    var all = assigneesOf(t);
    return all.length > BOARD_NAMES_MAX ? 'Исполнители: ' + all.map(personName).join(', ') : '';
  }
  // V6-1 (R-8): «!» у исполнителя, который в дни задачи в отпуске/отгуле (notes[]) или на больничном/в командировке (conflict_days[])
  var RISK_ORDER = ['vacation', 'day_off', 'sick', 'trip'];
  function riskText(t, empId) {
    var by = { vacation: [], day_off: [], sick: [], trip: [] };
    (t.notes || []).forEach(function (n) {
      if (n.employee_id === empId && (n.kind === 'vacation' || n.kind === 'day_off') && parseYmd(n.date)) by[n.kind].push(n.date);
    });
    (t.conflict_days || []).forEach(function (c) {
      if (c.employee_id === empId && by[c.reason] && parseYmd(c.date)) by[c.reason].push(c.date);
    });
    var parts = [];
    RISK_ORDER.forEach(function (k) {
      var ds = by[k].filter(function (d, i, arr) { return arr.indexOf(d) === i; }).sort();
      if (!ds.length) return;
      var ranges = [], from = ds[0], prev = ds[0];
      for (var i = 1; i <= ds.length; i++) {
        if (i < ds.length && ds[i] === addDays(prev, 1)) { prev = ds[i]; continue; }
        ranges.push(from === prev ? fmtDm(from) : fmtDm(from) + '–' + fmtDm(prev));
        from = prev = ds[i];
      }
      parts.push((NOTE_TEXT[k] || REASON_TEXT[k] || k) + ' ' + ranges.join(', '));
    });
    return parts.join('; ');
  }
  function warnIcon(t, empId) {
    var txt = riskText(t, empId);
    if (!txt) return '';
    return '<span class="tk-warnico" role="img" aria-label="' + esc(txt) + '" title="' + esc(txt) + '">!</span>';
  }
  // V6-1 (R-17): стабильная сортировка Списка по приоритету/статусу; вторичный порядок — исходный
  function sortRows(rows) {
    var k = S.sort.key, dir = S.sort.dir === 'desc' ? -1 : 1;
    if (!k || !S.sort.dir) return rows;
    var val = function (t) {
      if (k === 'priority') { var p = +t.priority; return p >= 1 && p <= 3 ? p : 9; }
      return t.status === 'closed' ? 1 : 0;
    };
    return rows.map(function (t, i) { return { t: t, i: i, v: val(t) }; }).sort(function (a, b) {
      return a.v === b.v ? a.i - b.i : (a.v - b.v) * dir;
    }).map(function (x) { return x.t; });
  }
  function sortTh(key, label) {
    var on = S.sort.key === key && S.sort.dir;
    var arrow = on ? (S.sort.dir === 'desc' ? '↓' : '↑') : '↕';
    var hint = key === 'priority' ? 'от высокого к низкому / обратно' : 'Открыта → Закрыта / обратно';
    return '<th class="tk-sortable" aria-sort="' + (on ? (S.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none') + '">' +
      '<button type="button" class="tk-sortbtn' + (on ? ' tk-sorted' : '') + '" data-tk-act="sortBy" data-key="' + key + '" title="Сортировка: ' + hint + ' / без сортировки">' +
      esc(label) + '<span class="tk-arr' + (on ? '' : ' tk-arr-off') + '" aria-hidden="true">' + arrow + '</span></button></th>';
  }
  function descCell(t) {
    var full = String(t.description == null ? '' : t.description).trim();
    if (!full) return '<td class="tk-desc"><span class="tk-muted">—</span></td>';
    return '<td class="tk-desc" title="' + esc(full) + '">' + esc(truncate(full, 80)) + '</td>';
  }
  // limit=true — Список (V6.3-1, И-1): не больше BOARD_NAMES_MAX + «…»; без limit — карточка задачи (все исполнители)
  function nameLinks(t, warn, limit) {
    var a = assigneesOf(t);
    if (!a.length) return '<span class="tk-muted">—</span>';
    if (isOrphan(t)) return plateHtml(t);
    var open = t.status === 'open' && !t.archived;
    var one = function (p) {
      if (p.removed) {
        // удалённый: у открытой задачи с другими исполнителями — зачёркнут; у закрытой — без пометок
        return open ? '<s class="tk-gone" title="Сотрудник удалён">' + esc(personName(p)) + '</s>' : esc(personName(p));
      }
      return '<a href="#" class="tk-name" data-tk-act="filterEmp" data-emp="' + esc(p.employee_id) + '">' +
        esc(personName(p)) + '</a>' + (warn ? warnIcon(t, p.employee_id) : '');
    };
    return limit ? limitNames(t, one) : a.map(one).join(', ');
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

  // V6.3-4 (И-2, P2-1/P3-1): «Исполнитель» 128 → 192 px (+64) строго за счёт «Описания», всё остальное и ширина таблицы — как при 128 px.
  // Способ: таблицу сначала раскладываем автоматически в «замерочном» состоянии (.tk-measure: «Исполнитель» 128 px, прежние минимумы) —
  // браузер сам решает, сколько получает каждая колонка при данных и окне, — затем фиксируем эти ширины (table-layout:fixed),
  // меняя только две: «Исполнитель» 128 → 192 и «Описание» − 64. Всё синхронно, до отрисовки кадра, поэтому без мерцания.
  var LIST_EXEC_NEW = 192, LIST_DESC_MIN = 156, LIST_FIT = { w: -1, ro: null, fonts: false, key: '', ws: null, total: 0 };
  // ws — замеренные ширины колонок при «Исполнителе» 128 px; ei/di — индексы «Исполнителя»/«Описания». Меняются только эти две.
  function listFitCalc(ws, ei, di) {
    var r = ws.slice(), delta = LIST_EXEC_NEW - ws[ei];     // delta = 64 при «Исполнителе» 128
    r[ei] = LIST_EXEC_NEW;
    r[di] = Math.max(ws[di] - delta, LIST_DESC_MIN);        // «Описание» отдаёт прибавку (минимум 220 → 156 px, чтобы таблица не росла)
    return r;
  }
  function fitListWidths(force) {
    var root = DOM.root, tbl = root && root.querySelector && root.querySelector('table.tk-table-v62');
    if (!tbl || !tbl.tHead || !tbl.tHead.rows[0] || typeof tbl.getBoundingClientRect !== 'function') return;
    try {
      var ths = Array.prototype.slice.call(tbl.tHead.rows[0].cells), i, ei = -1, di = -1;
      for (i = 0; i < ths.length; i++) {
        if (ths[i].classList.contains('tk-c-exec')) ei = i;
        if (ths[i].classList.contains('tk-c-desc')) di = i;
      }
      tbl.classList.remove('tk-fit'); tbl.style.width = '';
      ths.forEach(function (th) { th.style.width = ''; });
      if (ei < 0 || di < 0) return;
      // та же таблица (HTML) при той же ширине панели — ширины те же: повторную перерисовку (sync, фильтр без изменений) не замеряем заново
      var key = root.clientWidth + '|' + tbl.innerHTML, ws, total;
      if (!force && LIST_FIT.ws && LIST_FIT.key === key && LIST_FIT.ws.length === ths.length) {
        ws = LIST_FIT.ws; total = LIST_FIT.total;
      } else {
        tbl.classList.add('tk-measure');
        total = tbl.getBoundingClientRect().width;
        ws = ths.map(function (th) { return th.getBoundingClientRect().width; });
        tbl.classList.remove('tk-measure');
        LIST_FIT.w = root.clientWidth;
        LIST_FIT.ws = null;
        if (!total) return;                                 // панель скрыта (display:none) — подгонит ResizeObserver, когда покажут
        ws = listFitCalc(ws, ei, di);
        LIST_FIT.key = key; LIST_FIT.ws = ws; LIST_FIT.total = total;
      }
      tbl.style.width = total + 'px';
      ths.forEach(function (th, k) { th.style.width = ws[k] + 'px'; });
      tbl.classList.add('tk-fit');
      if (!LIST_FIT.ro && typeof ResizeObserver === 'function') {
        LIST_FIT.ro = new ResizeObserver(function () {
          if (S.view === 'list' && DOM.root && DOM.root.clientWidth !== LIST_FIT.w) fitListWidths();
        });
        LIST_FIT.ro.observe(root);
      }
      if (!LIST_FIT.fonts && typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
        LIST_FIT.fonts = true;
        document.fonts.ready.then(function () { if (S.view === 'list') fitListWidths(true); });
      }
    } catch (e) { /* без подгонки остаётся автораскладка с «Исполнителем» 192 px */ }
  }

  function renderList() {
    var f = S.filters;
    var rows = sortRows(sortByDue(applyFilters(S.tasks, f, true)));      // V6.3-2: по умолчанию — по сроку (next_at)
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
    // V6.2 (W-1): Задача · Описание · Исполнитель (узкая, ~50 % прежней) · Срок · Приор. · Статус; W-2: последняя колонка «Править» (только admin)
    var admin = canWrite();
    h += '<div class="tk-tablewrap"><table class="tk-table tk-table-v62"><thead><tr><th class="tk-c-task">Задача</th><th class="tk-c-desc">Описание</th><th class="tk-c-exec">Исполнитель</th><th>Срок</th>' +
      sortTh('priority', 'Приор.') + sortTh('status', 'Статус') +
      (admin ? '<th class="tk-c-edit"><span class="tk-sr">Править</span></th>' : '') + '</tr></thead><tbody>';
    rows.forEach(function (t) {
      h += '<tr class="tk-row' + (t.status === 'closed' ? ' tk-dim' : '') + (isOrphan(t) ? ' tk-orph' : '') + '" data-tk-act="openTask" data-id="' + esc(t.id) + '" data-view="board">' +
        '<td class="tk-c-task"><b>' + esc(t.title) + '</b><div class="tk-badges">' + badgesHtml(t, true).replace('<span class="tk-tag tk-closed">закрыта</span>', '') + '</div></td>' +
        descCell(t) + '<td class="tk-c-exec"' + (!isOrphan(t) && namesTitle(t) ? ' title="' + esc(namesTitle(t)) + '"' : '') + '>' + nameLinks(t, true, true) + '</td>' +
        '<td class="tk-nowrap" data-tk-due="1"' + (occsOf(t).length ? ' title="' + esc(allDatesText(t)) + '"' : '') + '>' + esc(dueText(t)) + occBadge(t) + '</td>' +
        '<td class="' + (+t.priority === 1 ? 'tk-hi' : '') + '">' + esc(PRIORITY_TEXT[t.priority] || t.priority) + '</td>' +
        '<td>' + (t.status === 'closed' ? 'Закрыта' : 'Открыта') + '</td>' +
        (admin ? '<td class="tk-c-edit"><button type="button" class="tk-editbtn" data-tk-act="editTask" data-id="' + esc(t.id) + '" title="Править" aria-label="Править задачу «' + esc(t.title) + '»">✎</button></td>' : '') +
        '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function cardHtml(t) {
    var admin = canWrite();
    return '<div class="tk-card' + (t.id === S.selectedId ? ' tk-sel' : '') + (t.status === 'closed' ? ' tk-dim' : '') + (isOrphan(t) ? ' tk-orph' : '') + '"' +
      ' data-tk-act="openTask" data-id="' + esc(t.id) + '" data-view="board"' + (admin ? ' draggable="true" data-tk-drag="' + esc(t.id) + '"' : '') + '>' +
      '<b>' + esc(t.title) + '</b>' +
      '<div class="tk-sub"' + (!isOrphan(t) && namesTitle(t) ? ' title="' + esc(namesTitle(t)) + '"' : '') + '>' + (isOrphan(t) ? plateHtml(t) : nameStrike(t)) + ' · ' + esc(dueText(t)) + occBadge(t) + '</div>' +
      '<div class="tk-badges">' + statusTag(t, true) + priorityTag(t, true) +
      badgesHtml(t, true).replace('<span class="tk-tag tk-closed">закрыта</span>', '') + '</div></div>';
  }

  function renderBoard() {
    var rows = sortByDue(applyFilters(S.tasks, { emp: S.filters.emp }, false));
    var orph = rows.filter(isOrphan);
    var open = rows.filter(function (t) { return t.status === 'open' && !isOrphan(t); });
    var closed = rows.filter(function (t) { return t.status === 'closed'; }).sort(function (a, b) {
      return String(b.closed_at || '').localeCompare(String(a.closed_at || ''));
    });
    var h = '<div class="tk-filters"><label>Сотрудник <select data-tk-filter="emp">' + empOptions(S.filters.emp, 'Все', true) + '</select></label>';
    if (S.filters.emp) h += '<button type="button" class="tk-btn" data-tk-act="clearEmp">× Все сотрудники</button>';
    if (canWrite()) h += '<span class="tk-muted">Перетащите карточку в другую колонку, чтобы закрыть или переоткрыть задачу.</span>';
    h += '</div><div class="tk-split tk-split-board"><div class="tk-boardmain">';
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
  // ---- V6-2: календарь по часам (Неделя / День), как в Outlook
  var CAL_HOUR_PX = 48;            // высота часа; 24 равные строки = 1152 px (полчаса = 24 px)
  var CAL_SLOT_MIN = 30;           // шаг ячейки (клик → форма)
  var CAL_MIN_DUR = 30;            // минимальная длительность плитки, мин
  var CAL_DEF_DUR = 60;            // задача только с началом = 1 час
  var CAL_SCROLL_H = 8;            // при открытии прокрутка к 08:00
  var CAL_AD_MAX = 3;              // плиток в полосе «Весь день» до «+N ещё»
  var CAL_GUT_PX = 46;             // колонка часов
  var CAL_COL_MIN_PX = 96;         // минимальная ширина колонки дня (на узком экране — горизонтальная прокрутка)

  function minOf(hm) {
    var m = /^(\d{2}):(\d{2})/.exec(String(hm || ''));
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function hhmm(min) { return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  // R-3: список времени «—, 00:00, 00:30 … 23:30»; некратное 30 мин значение остаётся отдельным выбранным пунктом.
  function timeOptionsHtml(value) {
    var v = String(value || ''), items = [{ value: '', label: '—' }], m, i;
    for (m = 0; m < 1440; m += CAL_SLOT_MIN) items.push({ value: hhmm(m), label: hhmm(m) });
    if (v && !items.some(function (it) { return it.value === v; })) {
      for (i = 1; i < items.length && items[i].value < v; i++) { /* позиция по порядку */ }
      items.splice(i, 0, { value: v, label: v });
    }
    return optionsHtml(items, v);
  }
  function timeSelectHtml(field, value) {
    return '<select class="tk-time" data-tk-field="' + field + '">' + timeOptionsHtml(value) + '</select>';
  }

  // R-9: интервал плитки в минутах от 00:00 для задачи одного дня со временем начала; иначе null («Весь день»).
  function calSlotOf(t) {
    if (t.first_day !== t.last_day) return null;
    var s = minOf(timeOf(t.start_at));
    if (s == null) return null;
    var e = t.end_at ? minOf(timeOf(t.end_at)) : null;
    if (e == null) e = s + CAL_DEF_DUR;
    if (e < s + CAL_MIN_DUR) e = s + CAL_MIN_DUR;
    if (e > 1440) e = 1440;
    return { s: s, e: e };
  }

  // R-11: классическая раскладка колонок (Outlook/Google). items: [{s, e, k}] (минуты, e > s; k — ключ для стабильной сортировки).
  // Группа = транзитивно пересекающиеся интервалы; внутри группы — жадное назначение дорожки;
  // все плитки группы получают cols = число дорожек группы. Касание концов (e == s) — не пересечение.
  function calLayout(items) {
    var sorted = items.slice().sort(function (a, b) { return a.s - b.s || b.e - a.e || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0); });
    var cluster = [], colEnd = [], clusterEnd = -1;
    function flush() {
      for (var i = 0; i < cluster.length; i++) cluster[i].cols = colEnd.length;
      cluster = []; colEnd = []; clusterEnd = -1;
    }
    sorted.forEach(function (it) {
      if (cluster.length && it.s >= clusterEnd) flush();
      var c = 0;
      while (c < colEnd.length && colEnd[c] > it.s) c++;
      colEnd[c] = it.e;
      it.col = c;
      cluster.push(it);
      if (it.e > clusterEnd) clusterEnd = it.e;
    });
    flush();
    return sorted;
  }

  // R-10: черновик новой задачи по клику на ячейку (день, начало в минутах): «Период» в пределах дня, конец = +1 ч.
  // Выбран «Период», а не «Срок (один день)»: у однодневного срока есть только начало, конец (время) задать нельзя.
  function calSlotDraft(date, startMin) {
    var endMin = startMin + 60;
    return { kind: 'period', startDate: date, startTime: hhmm(startMin), endDate: date, endTime: endMin >= 1440 ? '23:59' : hhmm(endMin) };
  }

  function tileWhen(t, date) {
    var first = t.first_day, last = t.last_day, st = timeOf(t.start_at), et = timeOf(t.end_at);
    if (first === last) return st ? st + (et ? '–' + et : '') : '';
    if (date === first) return (st ? st + ' ' : '') + '→';
    if (date === last) return '→' + (et ? ' ' + et : '');
    return '…';
  }
  // R-6: плитка = время + тема (жирно) + значки; исполнители — только в подсказке (title) и в карточке.
  function tileHtml(t, date, pos) {
    var when = tileWhen(t, date), orph = isOrphan(t);
    var names = assigneeNames(t).join(', ');
    var vac = (t.notes || []).filter(function (n) { return n.date === date && (n.kind === 'vacation' || n.kind === 'day_off'); });
    var hl = S.cal.emp && hasAssignee(t, S.cal.emp);
    var tip = [t.title];
    if (when) tip.push(when === '…' ? 'продолжение' : when);
    tip.push(orph ? plateText(t) : (names ? 'Исполнители: ' + names : ''));
    if (vac.length) tip.push(NOTE_TEXT[vac[0].kind]);
    if (t.conflict) tip.push('Конфликт' + (conflictReasons(t).length ? ': ' + conflictReasons(t).join(', ') : ''));
    if (t.check_state === 'pending') tip.push('Не проверено');
    var style = '', cls = pos ? ' tk-ev-t' + (pos.h < 40 ? ' tk-ev-s' : '') + (pos.cols >= 3 && S.cal.mode === 'week' ? ' tk-ev-n' : '') : ' tk-ev-ad', data = '';
    if (pos) {
      style = ' style="top:' + pos.top + 'px;height:' + pos.h + 'px;left:' + round4(pos.col * 100 / pos.cols) + '%;width:calc(' + round4(100 / pos.cols) + '% - 6px)"';
      data = ' data-col="' + pos.col + '" data-cols="' + pos.cols + '" data-s="' + pos.s + '" data-e="' + pos.e + '"';
    }
    // V6.3-2: плитка повтора — значок ↻, data-occ; клик открывает карточку той же задачи (data-id = id задачи)
    var isOcc = t._occ != null;
    if (isOcc) { tip.splice(1, 0, 'Повтор (↻) — задача выполняется и на другие даты'); data += ' data-occ="' + esc(t._occ) + '"'; }
    return '<div class="tk-ev' + (t.id === S.selectedId ? ' tk-sel' : '') + (t.conflict ? ' tk-conf' : '') + (isOcc ? ' tk-occ' : '') +
      (orph ? ' tk-orph' : '') + (t.status === 'closed' ? ' tk-dim' : '') + (hl ? ' tk-hl' : '') + (isOcc && t._occ === S.cal.flashOcc ? ' tk-flash' : '') +
      (canWrite() ? ' tk-dnd' : '') + cls + '" data-tk-act="openTask" data-id="' + esc(t.id) + '"' + (canWrite() ? ' data-tk-dnd="1"' : '') + data + style +
      ' title="' + esc(tip.filter(Boolean).join('\n')) + '">' +
      (isOcc ? '<span class="tk-ev-rep" aria-label="Повтор">↻</span>' : '') +
      (when ? '<span class="tk-ev-when">' + esc(when) + '</span> ' : '') +
      '<b class="tk-ev-title">' + esc(t.title) + '</b>' +
      (attsOf(t).length ? '<span class="tk-ev-att" title="' + esc('Вложений: ' + attsOf(t).length) + '">' + CLIP_SVG + '</span>' : '') +   // V7
      (orph ? '<span class="tk-ev-ic tk-ic-orph" title="Без исполнителя">0</span>' : '') +
      (t.conflict ? '<span class="tk-ev-ic tk-ic-conf" title="Конфликт">!</span>' : '') +
      (t.check_state === 'pending' ? '<span class="tk-ev-ic tk-ic-pend" title="Не проверено">?</span>' : '') + '</div>';
  }
  // V6.3-2 (Д-1): календарь рисует «выполнения»: основная дата — сама задача, каждый повтор — копия-«экземпляр»
  // с датами повтора (_occ = id повтора). Остальные поля (тема, исполнители, статус…) общие с задачей.
  function calInstOf(t, occ) {
    var s = dateOf(occ.start_at), e = occ.end_at ? dateOf(occ.end_at) : s;
    return Object.assign({}, t, { start_at: occ.start_at, end_at: occ.end_at == null ? null : occ.end_at, first_day: s, last_day: e < s ? s : e, _occ: occ.id });
  }
  function calInstById(taskId, occId) {
    var t = findTask(taskId);
    if (!t) return null;
    for (var i = 0, os = occsOf(t); i < os.length; i++) if (String(os[i].id) === String(occId)) return calInstOf(t, os[i]);
    return null;
  }
  function calInstances(tasks) {
    var out = [];
    tasks.forEach(function (t) {
      out.push(t);
      occsOf(t).forEach(function (o) { out.push(calInstOf(t, o)); });
    });
    return out;
  }
  function calDayTasks(tasks, d) {
    return tasks.filter(function (t) { return t.first_day <= d && d <= t.last_day; });
  }
  // раскладка одного дня: { timed: [{t, s, e, col, cols}], allDay: [t] }
  function calDayLayout(tasks, d) {
    var timed = [], allDay = [];
    calDayTasks(tasks, d).forEach(function (t) {
      var sl = calSlotOf(t);
      if (sl) timed.push({ t: t, s: sl.s, e: sl.e, k: String(t.id) + (t._occ != null ? '#' + t._occ : '') }); else allDay.push(t);
    });
    allDay.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)) || (a._occ != null ? 1 : 0) - (b._occ != null ? 1 : 0); });
    calLayout(timed);
    return { d: d, timed: timed, allDay: allDay };
  }
  function renderCalendar() {
    var days = calDays();
    var today = todayYmd();
    var canClick = canWrite();
    var tasks = calInstances(S.tasks.filter(function (t) { return !(S.cal.only && S.cal.emp) || hasAssignee(t, S.cal.emp); }));   // V6.3-2: + плитки повторов
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
    var cols = 'grid-template-columns:' + CAL_GUT_PX + 'px repeat(' + days.length + ',minmax(0,1fr))';
    var inW = CAL_GUT_PX + days.length * (days.length === 1 ? 160 : CAL_COL_MIN_PX);
    h += '</div><div class="tk-split"><div class="tk-wk" data-tk-cal="' + esc(S.cal.mode) + '"><div class="tk-cal-in" style="min-width:' + inW + 'px">';
    // шапка
    h += '<div class="tk-cal-hd" style="' + cols + '"><div class="tk-gut"></div>';
    days.forEach(function (d) {
      var wd = dowOf(d), hol = holidayLabelFor(d);
      h += '<div class="tk-wk-h' + (wd === 0 || wd === 6 ? ' tk-we' : '') + (d === today ? ' tk-today' : '') + '" data-date="' + d + '"><b>' + esc(fmtDay(d)) + '</b>' +
        (hol ? ' <span class="tk-tag tk-neutral" title="' + esc(hol) + '">' + esc(truncate(hol, 14)) + '</span>' : '') + '</div>';
    });
    h += '</div>';
    var perDay = days.map(function (d) { return calDayLayout(tasks, d); });
    // «Весь день»: задачи без времени и многодневные
    var overflow = perDay.some(function (x) { return x.allDay.length > CAL_AD_MAX; });
    var open = !!S.cal.adAll;
    h += '<div class="tk-cal-ad' + (open ? ' tk-ad-open' : '') + '" data-tk-ad="1" style="' + cols + '"><div class="tk-gut tk-gut-ad">Весь день</div>';
    perDay.forEach(function (x, i) {
      var wd = dowOf(x.d), shown = open ? x.allDay : x.allDay.slice(0, CAL_AD_MAX);
      h += '<div class="tk-ad-c' + (wd === 0 || wd === 6 ? ' tk-we' : '') + '" data-date="' + x.d + '">' +
        shown.map(function (t) { return tileHtml(t, x.d); }).join('') +
        (!open && x.allDay.length > shown.length
          ? '<button type="button" class="tk-ad-more" data-tk-act="calAdToggle">+' + (x.allDay.length - shown.length) + ' ещё</button>' : '') +
        (open && overflow && i === 0 ? '<button type="button" class="tk-ad-more" data-tk-act="calAdToggle">свернуть</button>' : '') + '</div>';
    });
    h += '</div>';
    // сетка часов 00:00 … 24:00
    var now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    h += '<div class="tk-cal-bd" style="' + cols + '"><div class="tk-gut">';
    for (var hr = 0; hr < 24; hr++) h += '<div class="tk-hr">' + pad(hr) + ':00</div>';
    h += '</div>';
    perDay.forEach(function (x) {
      var wd = dowOf(x.d);
      h += '<div class="tk-day' + (wd === 0 || wd === 6 ? ' tk-we' : '') + (canClick ? ' tk-can' : '') + '" data-date="' + x.d + '">';
      for (var m = 0; m < 1440; m += CAL_SLOT_MIN) {
        h += '<div class="tk-slot' + (m % 60 ? ' tk-half' : '') + '"' +
          (canClick ? ' data-tk-act="calCell" data-date="' + x.d + '" data-min="' + m + '"' : '') + '></div>';
      }
      x.timed.forEach(function (it) {
        var top = round4(it.s * CAL_HOUR_PX / 60), ht = Math.max(round4((it.e - it.s) * CAL_HOUR_PX / 60), 18);
        h += tileHtml(it.t, x.d, { top: top, h: ht, col: it.col, cols: it.cols, s: it.s, e: it.e });
      });
      if (x.d === today) h += '<div class="tk-now" style="top:' + round4(nowMin * CAL_HOUR_PX / 60) + 'px" title="Сейчас ' + hhmm(nowMin) + '"></div>';
      h += '</div>';
    });
    h += '</div></div></div>' + renderDetail() + '</div>';
    var anyTile = perDay.some(function (x) { return x.timed.length || x.allDay.length; });
    if (!anyTile && !S.loading) h += '<p class="tk-empty">На этот период задач нет.</p>';
    return h;
  }
  // прокрутка календаря: render() перерисовывает всё — запоминаем положение, а при первом открытии идём к 08:00
  function calEl() {
    return DOM.root && typeof DOM.root.querySelector === 'function' ? DOM.root.querySelector('.tk-wk') : null;
  }
  function calScrollSave() {
    var el = calEl();
    if (el && !S.cal.fresh) { S.cal.scrollTop = el.scrollTop; S.cal.scrollLeft = el.scrollLeft; }
  }
  function calScrollApply() {
    var el = calEl();
    if (!el) return;
    if (S.cal.fresh) { S.cal.scrollTop = null; S.cal.scrollLeft = 0; S.cal.fresh = false; }
    el.scrollTop = S.cal.scrollTop == null ? CAL_SCROLL_H * CAL_HOUR_PX : S.cal.scrollTop;
    if (S.cal.scrollLeft) el.scrollLeft = S.cal.scrollLeft;
  }

  // ---------------------------------------------------------------- V6.2-2: перетаскивание плиток (W-5) и копирование ПКМ (W-6)
  // Только мышь (pointerType 'mouse') и только admin (canWrite()). Касания и прокрутка пальцем не затрагиваются.
  var CAL_DRAG_PX = 5;             // сдвиг мыши, с которого «клик» становится перетаскиванием
  var CAL_END_MAX = 1439;          // конец не за 23:59 дня
  var DRAG = null;                 // активное перетаскивание
  var _noClick = 0;                // до этого момента (мс) подавляем click, пришедший после перетаскивания
  var _lastPtr = 'mouse';          // pointerType последнего нажатия (контекстное меню от долгого касания не перехватываем)
  var _clip = null;                // буфер копирования (в памяти страницы, не системный буфер обмена)
  var HOOK = { hit: null };        // тесты подменяют определение места под курсором (в шиме нет геометрии)

  function daysBetween(a, b) { return Math.round((utcOf(b) - utcOf(a)) / 86400000); }
  function shiftWhen(s, n) { s = String(s); return addDays(s.slice(0, 10), n) + s.slice(10); }
  function whenAt(date, min) { return date + 'T' + hhmm(min); }
  function snapMin(m) { return Math.max(0, Math.min(1410, Math.round(m / CAL_SLOT_MIN) * CAL_SLOT_MIN)); }
  function calUnchanged(t) { return { unchanged: true, start_at: t.start_at, end_at: t.end_at == null ? null : t.end_at, first_day: t.first_day, last_day: t.last_day }; }

  // W-5: новое время плитки при сбросе. t — задача; tgt:
  //   { kind: 'slot', date, min }  — «Неделя»/«День», плитка с временем: начало = ячейка (шаг 30 мин), длительность прежняя, конец ≤ 23:59;
  //   { kind: 'days', days: n }    — «Весь день» и «Месяц»: сдвиг на n дней, оба конца, время суток сохраняется.
  // Результат: { start_at, end_at, first_day, last_day } | { unchanged: true, … } | { error }.
  function calDropCalc(t, tgt) {
    if (!t || !tgt) return { error: 'bad_args' };
    if (tgt.kind === 'days') {
      var n = Math.round(+tgt.days);
      if (!n) return calUnchanged(t);
      return {
        start_at: shiftWhen(t.start_at, n), end_at: t.end_at ? shiftWhen(t.end_at, n) : null,
        first_day: addDays(t.first_day, n), last_day: addDays(t.last_day, n)
      };
    }
    if (tgt.kind !== 'slot' || !parseYmd(tgt.date)) return { error: 'bad_args' };
    var sl = calSlotOf(t);
    if (!sl) return { error: 'not_timed' };
    var min = snapMin(tgt.min);
    if (tgt.date === t.first_day && min === snapMin(sl.s)) return calUnchanged(t);   // отпустили на старом месте
    var end = null;
    if (t.end_at) {
      var er = minOf(timeOf(t.end_at));
      end = er == null ? tgt.date : whenAt(tgt.date, Math.min(min + Math.max(0, er - sl.s), CAL_END_MAX));
    }
    return { start_at: whenAt(tgt.date, min), end_at: end, first_day: tgt.date, last_day: tgt.date };
  }

  // W-6 → V6.3-2 (Д-1): снимок для буфера. «Вставить» теперь ДОБАВЛЯЕТ ПОВТОР этой же задачи (новая задача не создаётся),
  // поэтому копируется только ссылка на задачу (id, версия — запасная, актуальная берётся при вставке) и её срок для расчёта ячейки.
  // occId — id повтора, если скопирована плитка повтора.
  function calClipOf(t, occId) {
    return {
      id: t.id, version: t.version, title: String(t.title), occ: occId == null ? null : occId,
      start_at: t.start_at, end_at: t.end_at == null ? null : t.end_at, first_day: t.first_day, last_day: t.last_day
    };
  }
  // W-6: срок копии. tgt: { kind: 'slot', date, min } (ячейка часа/получаса), { kind: 'allday', date } (полоса «Весь день»),
  // { kind: 'month', date } (день месяца: то же время суток, что у оригинала).
  function calPasteCalc(clip, tgt) {
    if (!clip || !tgt || !parseYmd(tgt.date)) return { error: 'bad_args' };
    var span = daysBetween(clip.first_day, clip.last_day);
    if (tgt.kind === 'month') {
      var n = daysBetween(clip.first_day, tgt.date);
      return {
        start_at: shiftWhen(clip.start_at, n), end_at: clip.end_at ? shiftWhen(clip.end_at, n) : null,
        first_day: addDays(clip.first_day, n), last_day: addDays(clip.last_day, n)
      };
    }
    if (tgt.kind === 'allday') {
      return { start_at: tgt.date, end_at: span > 0 ? addDays(tgt.date, span) : null, first_day: tgt.date, last_day: addDays(tgt.date, span) };
    }
    if (tgt.kind !== 'slot') return { error: 'bad_args' };
    var min = snapMin(tgt.min), os = minOf(timeOf(clip.start_at)), oe = minOf(timeOf(clip.end_at)), end = null, last = tgt.date;
    if (clip.end_at) {
      if (os != null && oe != null) {
        var total = min + span * 1440 + oe - os;                       // длительность прежняя
        if (span === 0) total = Math.max(Math.min(total, CAL_END_MAX), min);
        var dd = Math.floor(total / 1440);
        last = addDays(tgt.date, dd);
        end = whenAt(last, total - dd * 1440);
      } else {
        last = addDays(tgt.date, span);
        end = span === 0 && oe == null ? tgt.date : last + (oe != null ? 'T' + hhmm(oe) : '');
      }
    }
    return { start_at: whenAt(tgt.date, min), end_at: end, first_day: tgt.date, last_day: last };
  }
  function fmtWhen(startAt) { var tm = timeOf(startAt); return fmtDm(dateOf(startAt)) + (tm ? ' ' + tm : ''); }

  // --- сохранение переноса. Основная дата — существующий update с version (W-5); плитка переносится сразу, при ошибке — откат.
  // Плитка повтора (t._occ) → calMoveOcc: переносится только этот повтор (occ_move).
  function calMove(t, calc) {
    if (!canWrite() || !t || !calc || calc.unchanged || calc.error) return Promise.resolve();
    if (t._occ != null) return calMoveOcc(t, calc);
    if (S.busy) { toast('Дождитесь завершения предыдущего действия.', 'info'); return Promise.resolve(); }
    var old = t, id = t.id;
    S.msg = null;
    mergeTask(Object.assign({}, t, { start_at: calc.start_at, end_at: calc.end_at, first_day: calc.first_day, last_day: calc.last_day }));
    render();
    S.busy = true;
    return api('PUT', API + '?id=' + encodeURIComponent(id), { start_at: calc.start_at, end_at: calc.end_at == null ? '' : calc.end_at, version: t.version }).then(function (r) {
      S.busy = false;
      if (r.ok && r.data && r.data.success) {
        notifyChanged();
        if (r.data.task) mergeTask(r.data.task);
        toast('Задача перенесена: ' + fmtWhen(calc.start_at), 'success');
        return load(true);
      }
      var code = r.data && r.data.error, text;
      mergeTask(old);                                      // откат плитки
      if (r.status === 409 && code === 'VERSION_CONFLICT') {
        notifyChanged();
        if (r.data.task) mergeTask(r.data.task);
        text = 'Задача уже изменена другим пользователем — календарь обновлён, перенос не выполнен. Повторите его при необходимости.';
        S.msg = { type: 'error', text: text };
        toast('Конфликт версий: календарь обновлён', 'error');
        render();
        return load(true);
      }
      if (r.status === 422 && code === 'TASK_BLOCKED_BY_SICK_OR_TRIP') text = r.data.message ? 'Перенос невозможен: ' + r.data.message : 'Перенос невозможен: исполнитель в эти дни на больничном или в командировке.';
      else text = 'Перенос не выполнен: ' + errText(r);
      S.msg = { type: 'error', text: text };
      toast(text, 'error');
      render();
    });
  }

  // V6.3-2: перенос ОДНОГО повтора (POST action=occ_move с version задачи); основная дата и другие повторы не меняются
  function calMoveOcc(inst, calc) {
    var main = findTask(inst.id), occId = inst._occ;
    if (!main) return Promise.resolve();
    if (S.busy) { toast('Дождитесь завершения предыдущего действия.', 'info'); return Promise.resolve(); }
    var old = main;
    S.msg = null;
    mergeTask(Object.assign({}, main, { occurrences: occsOf(main).map(function (o) {
      return String(o.id) === String(occId) ? { id: o.id, start_at: calc.start_at, end_at: calc.end_at == null ? null : calc.end_at } : o;
    }) }));
    render();
    S.busy = true;
    return api('POST', API + '?id=' + encodeURIComponent(main.id) + '&action=occ_move', { version: main.version, occurrence_id: occId, start_at: calc.start_at }).then(function (r) {
      S.busy = false;
      if (r.ok && r.data && r.data.success) {
        notifyChanged();
        if (r.data.task) mergeTask(r.data.task);
        toast('Повтор перенесён: ' + fmtWhen(r.data.occurrence ? r.data.occurrence.start_at : calc.start_at), 'success');
        return load(true);
      }
      return occFail(r, old, 'Перенос повтора не выполнен');
    });
  }
  // общий разбор неудачи действия с повтором: откат плитки, 409 → свежая задача, понятное сообщение сервера
  function occFail(r, old, prefix) {
    var code = r.data && r.data.error, text;
    if (old) mergeTask(old);                               // откат плитки
    if (r.status === 409 && code === 'VERSION_CONFLICT') {
      notifyChanged();
      if (r.data.task) mergeTask(r.data.task);
      text = 'Задача уже изменена другим пользователем — календарь обновлён, действие не выполнено. Повторите его при необходимости.';
      S.msg = { type: 'error', text: text };
      toast('Конфликт версий: календарь обновлён', 'error');
      render();
      return load(true);
    }
    if (r.status === 404 && code === 'occurrence_not_found') {
      text = ERR_TEXT.occurrence_not_found;
      notifyChanged();
      S.msg = { type: 'error', text: text };
      toast(text, 'error');
      render();
      return load(true);
    }
    if (r.status === 422 && code === 'TASK_BLOCKED_BY_SICK_OR_TRIP') text = prefix + ': ' + (r.data.message || 'исполнитель в эти дни на больничном или в командировке.');
    else text = prefix + ': ' + errText(r);
    S.msg = { type: 'error', text: text };
    toast(text, 'error');
    render();
    return Promise.resolve();
  }

  // --- «Вставить повтор»: добавляет повтор скопированной задачи (occ_add с version); новая задача НЕ создаётся
  function calPaste(tgt) {
    if (!canWrite() || !_clip) return Promise.resolve();
    if (S.busy) { toast('Дождитесь завершения предыдущего действия.', 'info'); return Promise.resolve(); }
    var calc = calPasteCalc(_clip, tgt);
    if (!calc || calc.error) return Promise.resolve();
    var clip = _clip, cur = findTask(clip.id);
    // повтор наследует «вид» срока задачи: у задачи без времени — только дата; у задачи со временем время обязательно
    // (вставка в «Весь день» → время начала самой задачи)
    var base = cur || clip, hasT = !!timeOf(base.start_at), startAt = calc.start_at;
    if (!hasT) startAt = dateOf(startAt);
    else if (!timeOf(startAt)) startAt = dateOf(startAt) + 'T' + timeOf(base.start_at);
    calc = Object.assign({}, calc, { start_at: startAt });
    S.busy = true;
    S.msg = null;
    return api('POST', API + '?id=' + encodeURIComponent(clip.id) + '&action=occ_add', { version: cur ? cur.version : clip.version, start_at: calc.start_at }).then(function (r) {
      S.busy = false;
      if (r.ok && r.data && r.data.success && r.data.task) {
        var task = r.data.task, occ = r.data.occurrence || {};
        notifyChanged();
        mergeTask(task);
        S.cal.flashOcc = occ.id == null ? null : occ.id;
        render();
        calToast('Повтор добавлен на ' + fmtWhen(occ.start_at || calc.start_at), 'Открыть', function () { S.selectedId = task.id; S.msg = null; render(); });
        var flash = S.cal.flashOcc;
        setTimeout(function () {
          if (flash == null || S.cal.flashOcc !== flash) return;
          S.cal.flashOcc = null;
          var el = DOM.root && DOM.root.querySelector ? DOM.root.querySelector('.tk-flash') : null;
          if (el && el.classList) el.classList.remove('tk-flash');
        }, 4500);
        return load(true);
      }
      return occFail(r, null, 'Повтор не добавлен');
    });
  }
  function calCopy(id, occId) {
    var t = findTask(id);
    if (!canWrite() || !t) return;
    _clip = calClipOf(t, occId);
    toast('Скопировано: «' + truncate(t.title, 40) + '». ПКМ по свободному месту календаря → «Вставить повтор».', 'info');
  }
  // V6.3-2: «Удалить повтор» (ПКМ по плитке повтора), с подтверждением; удаляется только этот повтор — задача и остальные даты остаются
  function calDeleteOcc(id, occId) {
    var t = findTask(id), occ = null;
    if (!canWrite() || !t) return Promise.resolve();
    occsOf(t).forEach(function (o) { if (String(o.id) === String(occId)) occ = o; });
    if (!occ) return Promise.resolve();
    if (S.busy) { toast('Дождитесь завершения предыдущего действия.', 'info'); return Promise.resolve(); }
    if (typeof window.confirm === 'function' && !window.confirm('Удалить повтор ' + fmtWhen(occ.start_at) + ' задачи «' + t.title + '»? Сама задача и её остальные даты останутся.')) return Promise.resolve();
    S.busy = true;
    S.msg = null;
    return api('POST', API + '?id=' + encodeURIComponent(t.id) + '&action=occ_delete', { version: t.version, occurrence_id: occ.id }).then(function (r) {
      S.busy = false;
      if (r.ok && r.data && r.data.success) {
        notifyChanged();
        if (r.data.task) mergeTask(r.data.task);
        render();
        toast('Повтор удалён: ' + fmtWhen(occ.start_at), 'success');
        return load(true);
      }
      return occFail(r, null, 'Повтор не удалён');
    });
  }

  // --- всплывающее сообщение с действием (общий showToast действий не поддерживает)
  var _ctoast = null, _ctoastTimer = null;
  function calToastClose() {
    if (_ctoastTimer) { clearTimeout(_ctoastTimer); _ctoastTimer = null; }
    if (_ctoast && _ctoast.parentNode && _ctoast.parentNode.removeChild) _ctoast.parentNode.removeChild(_ctoast);
    _ctoast = null;
  }
  function calToast(text, actionLabel, onAction) {
    calToastClose();
    if (!document.body || !document.createElement) return;
    var el = document.createElement('div');
    el.className = 'tk-ctoast';
    if (el.setAttribute) el.setAttribute('role', 'status');
    el.innerHTML = '<span class="tk-ctoast-t">' + esc(text) + '</span>' +
      (actionLabel ? '<button type="button" class="tk-ctoast-act" data-tk-ctoast="act">' + esc(actionLabel) + '</button>' : '') +
      '<button type="button" class="tk-ctoast-x" data-tk-ctoast="x" title="Закрыть" aria-label="Закрыть">×</button>';
    el.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-tk-ctoast]') : null;
      if (!b) return;
      var k = b.dataset.tkCtoast;
      calToastClose();
      if (k === 'act' && onAction) onAction();
    });
    document.body.appendChild(el);
    _ctoast = el;
    _ctoastTimer = setTimeout(calToastClose, 10000);
  }

  // --- контекстное меню календаря (ПКМ): «Копировать» по плитке, «Вставить» по пустому месту
  var _ctx = null;
  function ctxClose() {
    if (!_ctx) return;
    var c = _ctx;
    _ctx = null;
    document.removeEventListener('keydown', c.onKey, true);
    document.removeEventListener('pointerdown', c.onOut, true);
    document.removeEventListener('wheel', c.onAway, true);
    document.removeEventListener('scroll', c.onAway, true);
    if (typeof window.removeEventListener === 'function') { window.removeEventListener('blur', c.onAway); window.removeEventListener('resize', c.onAway); }
    if (c.el.parentNode && c.el.parentNode.removeChild) c.el.parentNode.removeChild(c.el);
  }
  function ctxOpen(x, y, items) {
    ctxClose();
    if (!document.body || !document.createElement) return;
    var el = document.createElement('div');
    el.className = 'tk-ctx';
    if (el.setAttribute) el.setAttribute('role', 'menu');
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.innerHTML = items.map(function (it, i) {
      return '<button type="button" class="tk-ctx-i" role="menuitem" data-tk-ctx="' + i + '"' + (it.disabled ? ' disabled' : '') +
        (it.title ? ' title="' + esc(it.title) + '"' : '') + '>' + esc(it.label) + '</button>';
    }).join('');
    el.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-tk-ctx]') : null;
      var it = b ? items[+b.dataset.tkCtx] : null;
      if (!it || it.disabled) return;
      ctxClose();
      it.run();
    });
    var c = {
      el: el,
      onKey: function (ev) { if (ev.key === 'Escape' || ev.key === 'Esc' || ev.key === 'Tab') { if (ev.key !== 'Tab' && ev.preventDefault) ev.preventDefault(); ctxClose(); } },
      onOut: function (ev) { var t = ev.target; if (!(t && t.closest && t.closest('.tk-ctx'))) ctxClose(); },
      onAway: function () { ctxClose(); }
    };
    document.body.appendChild(el);
    _ctx = c;
    document.addEventListener('keydown', c.onKey, true);
    document.addEventListener('pointerdown', c.onOut, true);
    document.addEventListener('wheel', c.onAway, true);
    document.addEventListener('scroll', c.onAway, true);
    if (typeof window.addEventListener === 'function') { window.addEventListener('blur', c.onAway); window.addEventListener('resize', c.onAway); }
    if (typeof el.getBoundingClientRect === 'function' && window.innerWidth) {      // не выходить за экран
      var r = el.getBoundingClientRect();
      if (r.right > window.innerWidth - 4) el.style.left = Math.max(4, Math.round(window.innerWidth - r.width - 4)) + 'px';
      if (r.bottom > window.innerHeight - 4) el.style.top = Math.max(4, Math.round(window.innerHeight - r.height - 4)) + 'px';
    }
    var first = el.querySelector ? el.querySelector('.tk-ctx-i:not([disabled])') : null;
    if (first && first.focus) first.focus();
  }
  function onContextMenu(ev) {
    var t = ev.target;
    if (!t || !t.closest || !t.closest('.tk-wk')) return;       // вне календаря — родное меню браузера
    if (!canWrite()) return;                                     // supervisor/viewer — родное меню
    if (ev.pointerType === 'touch' || (!ev.pointerType && _lastPtr === 'touch')) return;
    if (DRAG) { if (ev.preventDefault) ev.preventDefault(); dragAbort(); return; }
    var tile = t.closest('.tk-ev'), items = null, tgt = null;
    if (tile && tile.dataset && tile.dataset.id) {
      var id = tile.dataset.id, occ = tile.dataset.occ;
      items = [{ label: 'Копировать', run: function () { calCopy(id, occ === undefined ? null : occ); } }];
      // V6.3-2: плитка повтора — ещё и «Удалить повтор» (с подтверждением)
      if (occ !== undefined) items.push({ label: 'Удалить повтор', run: function () { calDeleteOcc(id, occ); } });
    } else {
      var slot = t.closest('[data-tk-act="calCell"]'), ad = slot ? null : t.closest('.tk-ad-c');
      if (slot && slot.dataset && parseYmd(slot.dataset.date)) tgt = { kind: 'slot', date: slot.dataset.date, min: +slot.dataset.min };
      else if (ad && ad.dataset && parseYmd(ad.dataset.date)) tgt = { kind: 'allday', date: ad.dataset.date };
      if (!tgt) return;                                          // шапка, колонка часов и т. п. — родное меню
      items = [{
        label: 'Вставить повтор', disabled: !_clip,
        title: _clip ? 'Добавить скопированной задаче повтор на это время' : 'Сначала скопируйте задачу: ПКМ по плитке → «Копировать»',
        run: function () { calPaste(tgt); }
      }];
    }
    if (ev.preventDefault) ev.preventDefault();
    ctxOpen(ev.clientX || 0, ev.clientY || 0, items);
  }

  // --- перетаскивание
  function calHitDom(x, y, D) {
    var wk = calEl();
    if (!wk || !wk.getBoundingClientRect || !DOM.root.querySelectorAll) return null;
    var wr = wk.getBoundingClientRect();
    if (x < wr.left || x > wr.right || y < wr.top || y > wr.bottom) return null;   // за пределами календаря — «никуда»
    var gut = DOM.root.querySelector('.tk-gut');
    if (gut && x < gut.getBoundingClientRect().right) return null;
    var cols = DOM.root.querySelectorAll('.tk-day');
    for (var i = 0; i < cols.length; i++) {
      var r = cols[i].getBoundingClientRect();
      if (x >= r.left && x < r.right) {
        return { date: cols[i].dataset.date, col: cols[i], min: D.kind === 'timed' ? snapMin((y - D.gy - r.top) * 60 / CAL_HOUR_PX) : null };
      }
    }
    return null;
  }
  function calHit(x, y, D) { return HOOK.hit ? HOOK.hit(x, y, D) : calHitDom(x, y, D); }

  function shadowClear() {
    if (DRAG && DRAG.shadow && DRAG.shadow.parentNode && DRAG.shadow.parentNode.removeChild) DRAG.shadow.parentNode.removeChild(DRAG.shadow);
    if (DRAG) DRAG.shadow = null;
  }
  function shadowDraw(hit, calc) {
    shadowClear();
    if (!hit || !calc || calc.error || !document.createElement) return;
    var D = DRAG, host = null, el = document.createElement('div'), cls = 'tk-shadow' + (calc.unchanged ? ' tk-shadow-same' : '');
    if (D.kind === 'timed') {
      host = hit.col;
      var sl = calSlotOf({ first_day: calc.first_day, last_day: calc.last_day, start_at: calc.start_at, end_at: calc.end_at });
      if (!sl || !host) return;
      el.style.top = round4(sl.s * CAL_HOUR_PX / 60) + 'px';
      el.style.height = Math.max(round4((sl.e - sl.s) * CAL_HOUR_PX / 60), 18) + 'px';
      var et = calc.end_at ? timeOf(calc.end_at) : '';
      el.innerHTML = esc(timeOf(calc.start_at) + (et ? '–' + et : ''));
    } else {
      host = DOM.root.querySelector ? DOM.root.querySelector('.tk-ad-c[data-date="' + hit.date + '"]') : null;
      if (!host) return;
      cls += ' tk-shadow-ad';
      el.innerHTML = esc(calc.first_day === calc.last_day ? fmtDay(calc.first_day) : fmtDm(calc.first_day) + ' — ' + fmtDm(calc.last_day));
    }
    el.className = cls;
    if (el.setAttribute) el.setAttribute('aria-hidden', 'true');
    host.appendChild(el);
    D.shadow = el;
  }
  function dragUpdate() {
    var D = DRAG;
    if (!D || !D.started || D.cancelled) return;
    if (D.el && D.el.isConnected === false) { dragAbort(); return; }      // перерисовка (синхронизация) убрала плитку
    var hit = calHit(D.px, D.py, D), calc = null;
    if (hit) {
      calc = D.kind === 'timed' ? calDropCalc(D.t, { kind: 'slot', date: hit.date, min: hit.min })
        : calDropCalc(D.t, { kind: 'days', days: daysBetween(D.gDate, hit.date) });
    }
    D.hit = hit; D.calc = calc;
    shadowDraw(hit, calc);
  }
  function dragUnbind() {
    var D = DRAG;
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', onDragUp, true);
    document.removeEventListener('pointercancel', onDragCancel, true);
    document.removeEventListener('keydown', onDragKey, true);
    if (typeof window.removeEventListener === 'function') window.removeEventListener('blur', onDragCancel);
    if (D && D.timer) { clearInterval(D.timer); D.timer = null; }
    if (D && D.wk && D.wk.removeEventListener) D.wk.removeEventListener('scroll', dragUpdate);
  }
  function dragVisualOff() {
    shadowClear();
    if (DRAG && DRAG.el && DRAG.el.classList) DRAG.el.classList.remove('tk-drag-src');
    if (DOM.root && DOM.root.classList) DOM.root.classList.remove('tk-dragging');
  }
  // полная отмена (ПКМ, потеря окна, перерисовка): ничего не меняется
  function dragAbort() {
    if (!DRAG) return;
    if (DRAG.started) { dragVisualOff(); _noClick = Date.now() + 300; }
    dragUnbind();
    DRAG = null;
  }
  function onDragKey(ev) {
    if (!DRAG || (ev.key !== 'Escape' && ev.key !== 'Esc')) return;
    if (ev.preventDefault) ev.preventDefault();
    if (!DRAG.started) { dragUnbind(); DRAG = null; return; }
    // кнопка ещё нажата: убираем тень, но ждём отпускания, чтобы подавить click
    DRAG.cancelled = true;
    dragVisualOff();
    if (DRAG.timer) { clearInterval(DRAG.timer); DRAG.timer = null; }
  }
  function onDragCancel() { dragAbort(); }
  function onDragUp(ev) {
    var D = DRAG;
    if (!D) return;
    if (!D.started) { dragUnbind(); DRAG = null; return; }              // обычный клик: пойдёт на открытие карточки
    D.px = ev.clientX; D.py = ev.clientY;
    if (!D.cancelled) dragUpdate();
    var calc = D.cancelled ? null : D.calc, t = D.t;
    dragVisualOff();
    _noClick = Date.now() + 300;                                        // click после перетаскивания не должен ничего открывать
    dragUnbind();
    DRAG = null;
    if (calc && !calc.unchanged && !calc.error) calMove(t, calc);
  }
  function dragAutoscroll() {
    var D = DRAG, wk = D && D.wk;
    if (!D || !D.started || D.cancelled || !wk || !wk.getBoundingClientRect) return;
    var r = wk.getBoundingClientRect();
    if (D.px < r.left || D.px > r.right) return;
    var hd = DOM.root.querySelector('.tk-cal-hd'), ad = DOM.root.querySelector('.tk-cal-ad');
    var top = r.top + (hd ? hd.offsetHeight : 36) + (ad && !/tk-ad-open/.test(ad.className || '') ? ad.offsetHeight : 0) + 28;
    if (D.py < top) wk.scrollTop -= 16;
    else if (D.py > r.bottom - 28) wk.scrollTop += 16;
  }
  function onDragMove(ev) {
    var D = DRAG;
    if (!D || D.cancelled) return;
    if (ev.buttons === 0) { dragAbort(); return; }                      // кнопку отпустили вне окна
    if (!D.started) {
      if (Math.abs(ev.clientX - D.x0) < CAL_DRAG_PX && Math.abs(ev.clientY - D.y0) < CAL_DRAG_PX) return;
      var t = D.occ != null ? calInstById(D.id, D.occ) : findTask(D.id);       // V6.3-2: плитка повтора → «экземпляр» с датами повтора
      if (!t) { dragUnbind(); DRAG = null; return; }
      D.t = t;
      D.started = true;
      if (D.el && D.el.classList) D.el.classList.add('tk-drag-src');
      if (DOM.root.classList) DOM.root.classList.add('tk-dragging');
      D.wk = calEl();
      if (D.wk && D.wk.addEventListener) D.wk.addEventListener('scroll', dragUpdate);
      D.timer = setInterval(dragAutoscroll, 40);
    }
    D.px = ev.clientX; D.py = ev.clientY;
    dragUpdate();
  }
  function onCalPointerDown(ev) {
    _lastPtr = ev.pointerType || 'mouse';
    if (ev.pointerType && ev.pointerType !== 'mouse') return;           // касания и перо — только прокрутка/клик как раньше
    if (ev.button !== undefined && ev.button !== 0) return;
    if (!canWrite() || DRAG || S.busy) return;
    var tg = ev.target, el = tg && tg.closest ? tg.closest('.tk-wk .tk-ev') : null;
    if (!el || !el.dataset || !el.dataset.id) return;
    var timed = el.dataset.s !== undefined, col = !timed && el.closest ? el.closest('[data-date]') : null;
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { top: ev.clientY };
    var t = el.dataset.occ !== undefined ? calInstById(el.dataset.id, el.dataset.occ) : findTask(el.dataset.id);
    if (!t) return;
    DRAG = {
      id: t.id, occ: el.dataset.occ !== undefined ? el.dataset.occ : null, el: el, kind: timed ? 'timed' : 'allday', x0: ev.clientX, y0: ev.clientY, px: ev.clientX, py: ev.clientY,
      gy: ev.clientY - rect.top, gDate: timed ? t.first_day : (col && col.dataset.date) || t.first_day,
      started: false, cancelled: false, shadow: null, hit: null, calc: null, timer: null, wk: null, t: t
    };
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', onDragUp, true);
    document.addEventListener('pointercancel', onDragCancel, true);
    document.addEventListener('keydown', onDragKey, true);
    if (typeof window.addEventListener === 'function') window.addEventListener('blur', onDragCancel);
  }
  function onClickCapture(ev) {
    if (!_noClick) return;
    var fresh = Date.now() < _noClick;
    _noClick = 0;
    if (fresh) { if (ev.stopPropagation) ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); }
  }

  // ---------------------------------------------------------------- V7: вложения задач
  // Карточка — только значок-скрепка (счётчик); клик → модальное окно: список файлов, «Выбрать файлы», перетаскивание,
  // полоса загрузки у каждого файла. Права (как на сервере, api/task_files.php): admin — любая неархивная задача;
  // supervisor — только задача, которую создал сам (created_by), удаляет только свои файлы; viewer — смотрит и скачивает.
  var ATT_API = 'api/task_files.php';
  var ATT_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv', 'rtf',
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'zip', '7z', 'rar'];
  var ATT_MAX_FILES = 10;
  var ATT_DEF_MAX = 5 * 1024 * 1024;
  var ATT_FORMATS_TEXT = 'PDF, Word, Excel, PowerPoint, ODF, TXT, CSV, RTF, JPG, PNG, WEBP, GIF, HEIC, ZIP, 7Z, RAR';
  var CLIP_SVG = '<svg class="tk-clip" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">' +
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var DL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var _attSeq = 0;

  function attsOf(t) { return (t && Array.isArray(t.attachments)) ? t.attachments : []; }
  function myLogin() { return S.user && S.user.username ? String(S.user.username) : ''; }
  function isSupervisor() { return !!(S.user && S.user.role === 'supervisor'); }
  function canAttach(t) {
    if (!t || t.archived || !S.user) return false;
    return isAdmin() || (isSupervisor() && !!t.created_by && String(t.created_by) === myLogin());
  }
  function canDetach(t, a) { return canAttach(t) && (isAdmin() || (!!a && a.uploaded_by === myLogin())); }
  function attExt(name) { var m = /\.([^.\\/]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function attKind(ext) {
    if (ext === 'pdf') return 'PDF';
    if (/^(doc|docx|odt|rtf)$/.test(ext)) return 'DOC';
    if (/^(xls|xlsx|ods|csv)$/.test(ext)) return 'XLS';
    if (/^(ppt|pptx|odp)$/.test(ext)) return 'PPT';
    if (/^(jpg|jpeg|png|webp|gif|heic|heif)$/.test(ext)) return 'IMG';
    if (/^(zip|7z|rar)$/.test(ext)) return 'ZIP';
    return 'TXT';
  }
  function fmtSize(n) {
    n = +n || 0;
    if (n < 1024) return n + ' Б';
    if (n < 1048576) return String(Math.max(1, Math.round(n / 1024))) + ' КБ';
    return String(Math.round(n / 104857.6) / 10).replace('.', ',') + ' МБ';
  }
  function fmtStamp(s) {
    var d = s ? new Date(s) : null;
    if (!d || isNaN(d.getTime())) return '';
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function attCountTag(t) {
    var n = attsOf(t).length;
    return n ? '<span class="tk-tag tk-att-n" title="' + esc('Вложений: ' + n) + '">' + CLIP_SVG + ' ' + n + '</span>' : '';
  }
  // значок в шапке карточки: есть файлы или можно прикрепить; иначе ничего
  function attBtnHtml(t) {
    var n = attsOf(t).length;
    if (!n && !canAttach(t)) return '';
    var tip = n ? 'Вложения: ' + n : 'Прикрепить файлы';
    return '<button type="button" class="tk-attbtn' + (n ? ' tk-attbtn-has' : '') + '" data-tk-act="attOpen" data-id="' + esc(t.id) + '" title="' + esc(tip) +
      '" aria-label="' + esc(tip) + '">' + CLIP_SVG + (n ? '<span class="tk-attn">' + n + '</span>' : '') + '</button>';
  }
  function attErrText(status, data) {
    var code = data && data.error, A = S.att;
    var mb = fmtSize((data && data.max_file_bytes) || (A && A.limits && A.limits.max_file_bytes) || ATT_DEF_MAX);
    if (status === 413 && !code) code = 'file_too_large';            // nginx/Apache отрезали тело раньше PHP
    if (status === 0) code = 'network';
    if (status === 401) code = 'unauthorized';
    var T = {
      file_too_large: 'Файл больше ' + mb + '.',
      unsupported_format: 'Формат не поддерживается — допустимые форматы перечислены под зоной загрузки.',
      content_mismatch: 'Содержимое файла не соответствует его расширению.',
      too_many_files: 'У задачи уже ' + ATT_MAX_FILES + ' файлов — больше прикрепить нельзя.',
      total_too_large: 'Суммарный объём вложений задачи больше 50 МБ.',
      empty_file: 'Файл пустой.',
      no_file: 'Файл не получен сервером.',
      upload_failed: 'Файл не загрузился — повторите.',
      task_archived: 'Задача в архиве — вложения недоступны.',
      forbidden: 'Недостаточно прав: прикреплять и удалять файлы может администратор, а руководитель — только в задаче, которую создал сам.',
      not_found: 'Файл или задача не найдены (возможно, уже удалены).',
      network: 'Нет связи с сервером. Повторите позже.',
      unauthorized: 'Сессия истекла — войдите заново.'
    };
    return T[code] || ('Ошибка сервера' + (code ? ' (' + code + ')' : status ? ' (' + status + ')' : '') + '.');
  }
  // проверка до отправки (сервер проверяет то же самое и ещё содержимое)
  function attPrecheck(file, maxBytes) {
    var ext = attExt(file && file.name);
    if (ATT_EXT.indexOf(ext) < 0) return 'Формат ' + (ext ? '«.' + ext + '» ' : 'без расширения ') + 'не поддерживается.';
    if (!(file.size > 0)) return attErrText(400, { error: 'empty_file' });
    if (file.size > maxBytes) return attErrText(413, { error: 'file_too_large', max_file_bytes: maxBytes });
    return '';
  }
  function attSync(taskId, list) {
    var t = findTask(taskId);
    if (t) { t.attachments = list; render(); }
  }

  // --- модальное окно
  function attOpen(taskId) {
    var t = findTask(taskId);
    if (!t) return Promise.resolve();
    attClose(true);
    var A = S.att = { taskId: t.id, title: t.title, list: attsOf(t).slice(), canUpload: canAttach(t), limits: null,
      loading: true, error: '', queue: [], pending: false };
    attMount();
    return api('GET', ATT_API + '?task_id=' + encodeURIComponent(t.id)).then(function (r) {
      if (S.att !== A) return;
      A.loading = false;
      if (r.ok && r.data && r.data.success) {
        A.list = r.data.attachments || [];
        A.canUpload = !!r.data.can_upload;
        A.limits = r.data.limits || null;
        attSync(A.taskId, A.list);
      } else {
        A.error = attErrText(r.status, r.data);
      }
      attRender();
    });
  }
  // новая задача (форма admin): файлы копятся в S.form.pendingFiles и загружаются после первого сохранения
  function attOpenPending() {
    if (!S.form || !canWrite()) return Promise.resolve();
    attClose(true);
    var A = S.att = { taskId: null, title: String(S.form.draft.title || '').trim() || 'Новая задача', list: [], canUpload: true, limits: null,
      loading: true, error: '', queue: [], pending: true };
    attMount();
    return api('GET', ATT_API + '?limits=1').then(function (r) {
      if (S.att !== A) return;
      A.loading = false;
      if (r.ok && r.data && r.data.limits) A.limits = r.data.limits;
      attRender();
    });
  }
  function attMount() {
    var el = document.createElement('div');
    el.id = 'tasksAttModal';
    el.className = 'tk-modal-back tk-att-back';
    el.addEventListener('click', onAttClick);
    el.addEventListener('change', onAttChange);
    el.addEventListener('dragenter', onAttDrag);
    el.addEventListener('dragover', onAttDrag);
    el.addEventListener('dragleave', onAttDragLeave);
    el.addEventListener('drop', onAttDrop);
    DOM.att = el;
    attRender();
    (document.body || document.documentElement).appendChild(el);
    if (typeof document.addEventListener === 'function') document.addEventListener('keydown', onAttKey);
  }
  function attClose(silent) {
    var el = DOM.att;
    S.att = null;
    DOM.att = null;
    if (el) {
      if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
      else if (el.remove) el.remove();
    }
    if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', onAttKey);
    if (!silent && S.form) render();                    // форма: обновить счётчик «Вложения · N»
  }
  function attMaxBytes(A) { return (A && A.limits && A.limits.max_file_bytes) || ATT_DEF_MAX; }
  function attPendingList() { return (S.form && S.form.pendingFiles) || []; }

  function attRender() {
    var A = S.att;
    if (!A || !DOM.att) return;
    var items = A.pending ? attPendingList() : A.list;
    var n = items.length, max = attMaxBytes(A);
    var h = '<div class="tk-modal tk-att-modal" role="dialog" aria-modal="true" aria-label="Вложения задачи">';
    h += '<div class="tk-att-head"><h4 class="tk-mtitle">' + CLIP_SVG + ' Вложения' + (n ? ' · ' + n : '') + '</h4>' +
      '<button type="button" class="tk-x tk-att-x" data-tk-act="attClose" title="Закрыть" aria-label="Закрыть">×</button></div>';
    h += '<div class="tk-att-task tk-muted">' + esc(A.title) + '</div>';
    if (A.error) h += '<div class="tk-msg tk-msg-error" role="alert">' + esc(A.error) + '</div>';
    if (A.loading) h += '<p class="tk-muted">Загрузка…</p>';
    h += '<ul class="tk-att-list" data-tk-att-list="1">';
    if (A.pending) {
      items.forEach(function (p) {
        var ext = attExt(p.name);
        h += '<li class="tk-att-it" data-tk-att-pend="' + esc(p.key) + '"><span class="tk-att-type tk-att-k-' + attKind(ext).toLowerCase() + '">' + attKind(ext) + '</span>' +
          '<span class="tk-att-main"><span class="tk-att-name">' + esc(p.name) + '</span><span class="tk-muted tk-att-meta">' + esc(fmtSize(p.size)) +
          ' · загрузится после сохранения задачи</span></span>' +
          '<button type="button" class="tk-x tk-att-del" data-tk-act="attUnqueue" data-key="' + esc(p.key) + '" title="Убрать" aria-label="Убрать файл ' + esc(p.name) + '">×</button></li>';
      });
    } else {
      var t = findTask(A.taskId) || { id: A.taskId, archived: 0, created_by: null };
      items.forEach(function (a) {
        var ext = a.ext || attExt(a.name), href = ATT_API + '?id=' + encodeURIComponent(a.id);
        // картинка/PDF: имя открывает в новой вкладке, отдельный значок справа — скачать; остальное: имя скачивает
        var link = a.inline
          ? '<a class="tk-att-name" href="' + esc(href + '&inline=1') + '" target="_blank" rel="noopener" title="Открыть в новой вкладке">' + esc(a.name) + '</a>'
          : '<a class="tk-att-name" href="' + esc(href) + '" download title="Скачать">' + esc(a.name) + '</a>';
        var dl = a.inline ? '<a class="tk-att-dl" href="' + esc(href) + '" download title="Скачать" aria-label="Скачать ' + esc(a.name) + '">' + DL_SVG + '</a>' : '';
        h += '<li class="tk-att-it" data-tk-att-id="' + esc(a.id) + '"><span class="tk-att-type tk-att-k-' + attKind(ext).toLowerCase() + '">' + attKind(ext) + '</span>' +
          '<span class="tk-att-main">' + link + '<span class="tk-muted tk-att-meta">' + esc([fmtSize(a.size), a.uploaded_by || '', fmtStamp(a.uploaded_at)].filter(Boolean).join(' · ')) + '</span></span>' + dl +
          ((A.canUpload && canDetach(t, a))
            ? '<button type="button" class="tk-x tk-att-del" data-tk-act="attDelete" data-att="' + esc(a.id) + '" title="Удалить файл" aria-label="Удалить файл ' + esc(a.name) + '">×</button>'
            : '') + '</li>';
      });
    }
    if (!n && !A.loading) h += '<li class="tk-att-empty tk-muted">Файлов нет.</li>';
    h += '</ul>';
    // очередь загрузки: полоса у каждого файла, ошибка — у своего файла
    if (A.queue.length) {
      h += '<ul class="tk-att-queue" data-tk-att-queue="1">' + A.queue.map(function (q) {
        var st = q.status === 'error' ? '<span class="tk-merr">' + esc(q.error) + '</span>'
          : q.status === 'wait' ? '<span class="tk-muted">в очереди</span>' : '<span class="tk-muted">' + q.pct + '%</span>';
        return '<li class="tk-att-q tk-att-q-' + q.status + '" data-tk-att-q="' + esc(q.key) + '"><div class="tk-att-qrow"><span class="tk-att-name">' + esc(q.name) + '</span> <span class="tk-att-qst">' + st + '</span>' +
          (q.status === 'error' ? ' <button type="button" class="tk-x" data-tk-act="attDismiss" data-key="' + esc(q.key) + '" title="Убрать" aria-label="Убрать">×</button>' : '') + '</div>' +
          (q.status !== 'error' ? '<div class="tk-att-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + q.pct + '"><i style="width:' + q.pct + '%"></i></div>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    if (A.canUpload && !A.loading) {
      var left = ATT_MAX_FILES - n - A.queue.filter(function (q) { return q.status === 'wait' || q.status === 'up'; }).length;
      h += '<div class="tk-att-drop" data-tk-att-drop="1">' +
        '<div class="tk-att-droptext">' + CLIP_SVG + ' <span class="tk-att-dnd">Перетащите файлы сюда или </span>' +
        '<button type="button" class="tk-btn tk-primary" data-tk-act="attPick"' + (left > 0 ? '' : ' disabled') + '>Выбрать файлы</button></div>' +
        '<input type="file" multiple class="tk-att-input" data-tk-att-input="1" tabindex="-1" aria-hidden="true" accept="' + esc(ATT_EXT.map(function (e) { return '.' + e; }).join(',')) + '">' +
        '<div class="tk-muted tk-hint">До ' + esc(fmtSize(max)) + ' на файл, до ' + ATT_MAX_FILES + ' файлов на задачу' + (left > 0 && left < ATT_MAX_FILES ? ' (ещё ' + left + ')' : '') +
        '. Форматы: ' + ATT_FORMATS_TEXT + '.' + (A.pending ? ' Файлы загрузятся после сохранения задачи.' : '') + '</div></div>';
    } else if (!A.loading && !A.canUpload && !A.pending) {
      var tt = findTask(A.taskId);
      h += '<p class="tk-muted tk-hint">' + (tt && tt.archived ? 'Задача в архиве.' : 'Прикреплять файлы к этой задаче вы не можете — только смотреть и скачивать.') + '</p>';
    }
    h += '<div class="tk-actions"><button type="button" class="tk-btn" data-tk-act="attClose">Закрыть</button></div></div>';
    DOM.att.innerHTML = h;
  }

  function attEnqueue(files) {
    var A = S.att;
    if (!A || !A.canUpload || !files) return;
    var max = attMaxBytes(A), arr = [];
    for (var i = 0; i < files.length; i++) arr.push(files[i]);
    if (!arr.length) return;
    var have = (A.pending ? attPendingList().length : A.list.length) +
      A.queue.filter(function (q) { return q.status === 'wait' || q.status === 'up'; }).length;
    arr.forEach(function (f) {
      var err = attPrecheck(f, max), key = 'q' + (++_attSeq);
      if (!err && have >= ATT_MAX_FILES) err = attErrText(422, { error: 'too_many_files' });
      if (err) { A.queue.push({ key: key, name: f.name, size: f.size, status: 'error', pct: 0, error: err }); return; }
      have++;
      if (A.pending) {
        if (!S.form.pendingFiles) S.form.pendingFiles = [];
        S.form.pendingFiles.push({ key: key, name: f.name, size: f.size, file: f });
      } else {
        A.queue.push({ key: key, name: f.name, size: f.size, file: f, status: 'wait', pct: 0, error: '' });
      }
    });
    attRender();
    if (!A.pending) attPump(A);
  }
  // по одному файлу за раз (полоса — у текущего), окно можно закрыть — загрузка продолжится
  function attPump(A) {
    if (A.running) return;
    var q = null;
    for (var i = 0; i < A.queue.length; i++) if (A.queue[i].status === 'wait') { q = A.queue[i]; break; }
    if (!q) return;
    A.running = true;
    q.status = 'up';
    if (S.att === A) attRender();
    attSend(A.taskId, q.file, function (pct) {
      q.pct = pct;
      if (S.att === A) attBar(q);
    }).then(function (res) {
      A.running = false;
      if (res.ok) {
        A.queue = A.queue.filter(function (x) { return x !== q; });
        A.list = res.data.attachments || A.list;
        attSync(A.taskId, A.list);
        if (S.att !== A) toast('Файл «' + truncate(q.name, 40) + '» прикреплён', 'success');
      } else {
        q.status = 'error';
        q.error = attErrText(res.status, res.data);
        if (S.att !== A) toast('Файл «' + truncate(q.name, 40) + '» не прикреплён: ' + q.error, 'error');
      }
      if (S.att === A) attRender();
      attPump(A);
    });
  }
  // точечно обновить полосу (без перерисовки окна на каждом событии progress)
  function attBar(q) {
    var li = DOM.att && DOM.att.querySelector ? DOM.att.querySelector('[data-tk-att-q="' + q.key + '"]') : null;
    if (!li) { attRender(); return; }
    var bar = li.querySelector('.tk-att-bar i'), st = li.querySelector('.tk-att-qrow .tk-muted'), pb = li.querySelector('.tk-att-bar');
    if (bar) bar.style.width = q.pct + '%';
    if (st) st.textContent = q.pct + '%';
    if (pb && pb.setAttribute) pb.setAttribute('aria-valuenow', String(q.pct));
  }
  // XHR — ради upload.onprogress (fetch прогресс отправки не отдаёт)
  function attSend(taskId, file, onPct) {
    return new Promise(function (resolve) {
      var xhr;
      try {
        xhr = new XMLHttpRequest();
        xhr.open('POST', ATT_API + '?task_id=' + encodeURIComponent(taskId), true);
        xhr.withCredentials = true;
      } catch (e) { resolve({ ok: false, status: 0, data: { error: 'network' } }); return; }
      if (xhr.upload) {
        xhr.upload.onprogress = function (ev) {
          if (ev && ev.lengthComputable && ev.total > 0) onPct(Math.min(99, Math.floor(ev.loaded * 100 / ev.total)));
        };
      }
      xhr.onload = function () {
        var data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { data = null; }
        onPct(100);
        resolve({ ok: xhr.status === 201 && !!(data && data.success), status: xhr.status, data: data || {} });
      };
      xhr.onerror = function () { resolve({ ok: false, status: 0, data: { error: 'network' } }); };
      var fd = new FormData();
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  }
  // после создания задачи из формы: отложенные файлы по одному; итог — сообщением
  function attUploadPending(taskId, pend) {
    var fails = [], okN = 0;
    var chain = Promise.resolve();
    pend.forEach(function (p) {
      chain = chain.then(function () {
        return attSend(taskId, p.file, function () {}).then(function (res) {
          if (res.ok) { okN++; attSync(taskId, res.data.attachments || []); }
          else fails.push(p.name + ' — ' + attErrText(res.status, res.data));
        });
      });
    });
    return chain.then(function () {
      if (fails.length) {
        S.msg = { type: 'error', text: 'Задача создана. Прикреплено файлов: ' + okN + ' из ' + pend.length + '. Не прикреплены: ' + fails.join('; ') };
        toast('Не все файлы прикреплены', 'error');
      } else {
        S.msg = { type: 'ok', text: 'Задача создана, файлов прикреплено: ' + okN };
      }
      render();
    });
  }
  function attDelete(attId) {
    var A = S.att;
    if (!A || A.pending) return Promise.resolve();
    var a = null;
    A.list.forEach(function (x) { if (String(x.id) === String(attId)) a = x; });
    if (!a) return Promise.resolve();
    if (typeof window.confirm === 'function' && !window.confirm('Удалить файл «' + a.name + '»? Он будет удалён с сервера.')) return Promise.resolve();
    return api('DELETE', ATT_API + '?id=' + encodeURIComponent(a.id)).then(function (r) {
      if (S.att !== A) return;
      if (r.ok && r.data && r.data.success) {
        A.list = r.data.attachments || [];
        A.error = '';
        attSync(A.taskId, A.list);
        toast('Файл удалён', 'success');
      } else {
        A.error = attErrText(r.status, r.data);
        if (r.status === 404) {                                  // уже удалён — перечитать список
          return api('GET', ATT_API + '?task_id=' + encodeURIComponent(A.taskId)).then(function (r2) {
            if (S.att === A && r2.ok && r2.data) { A.list = r2.data.attachments || []; attSync(A.taskId, A.list); attRender(); }
          });
        }
      }
      attRender();
    });
  }

  // --- события окна
  function onAttClick(ev) {
    var t = ev.target;
    // окно живёт в body, вне панели отпусков: без этого index.html (клик «вне панели») закрыл бы панель «Задач» под окном
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (t === DOM.att) { attClose(); return; }                 // клик по затемнению
    var el = t && t.closest ? t.closest('[data-tk-act]') : null;
    if (!el) return;
    var fn = ACTIONS[el.dataset.tkAct];                         // обработчики att* — в общей таблице ACTIONS
    if (typeof fn === 'function') fn(el, ev);
  }
  function onAttChange(ev) {
    var t = ev.target;
    if (!t || !t.dataset || t.dataset.tkAttInput === undefined) return;
    var files = t.files;
    attEnqueue(files);
    try { t.value = ''; } catch (e) { /* ignore */ }
  }
  var _attOverT = null;
  function attOver(on) {
    var z = DOM.att && DOM.att.querySelector ? DOM.att.querySelector('[data-tk-att-drop]') : null;
    if (z && z.classList) z.classList.toggle('tk-att-over', !!on);
  }
  function hasFiles(ev) {
    var dt = ev && ev.dataTransfer;
    if (!dt || !dt.types) return false;
    for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    return false;
  }
  // перетаскивание: файлы можно бросить в любое место окна; браузер не должен открыть файл вместо загрузки
  function onAttDrag(ev) {
    if (!hasFiles(ev)) return;
    if (ev.preventDefault) ev.preventDefault();
    var ok = !!(S.att && S.att.canUpload && !S.att.loading);
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = ok ? 'copy' : 'none';
    if (!ok) return;
    attOver(true);
    if (_attOverT) clearTimeout(_attOverT);
    _attOverT = setTimeout(function () { attOver(false); }, 180);
  }
  function onAttDragLeave() { /* подсветку гасит таймер onAttDrag — без мигания на дочерних элементах */ }
  function onAttDrop(ev) {
    if (!hasFiles(ev)) return;
    if (ev.preventDefault) ev.preventDefault();
    if (_attOverT) { clearTimeout(_attOverT); _attOverT = null; }
    attOver(false);
    if (S.att && S.att.canUpload && !S.att.loading) attEnqueue(ev.dataTransfer.files);
  }
  function onAttKey(ev) {
    if (ev && ev.key === 'Escape' && S.att) attClose();
  }

  // --- карточка (справа)
  function renderDetail() {
    var t = S.selectedId ? findTask(S.selectedId) : null;
    if (!t) return '<aside class="tk-detail"><p class="tk-empty">Выберите задачу, чтобы увидеть карточку.</p></aside>';
    var h = '<aside class="tk-detail"><div class="tk-dhead"><b class="tk-dtitle">' + esc(t.title) + '</b>' +
      '<span class="tk-dhead-r">' + attBtnHtml(t) + statusTag(t, true) + '</span></div>';      // V7: значок вложений
    h += '<div class="tk-badges">' + priorityTag(t, true) + badgesHtml(t, true, true).replace('<span class="tk-tag tk-closed">закрыта</span>', '') + '</div>';
    if (occsOf(t).length) {
      // V6.3-2: перечень всех дат выполнения (основная + повторы); ближайшая (next_at) отмечена
      var nk = whenKey(nextWhen(t).start_at);
      h += '<div class="tk-kv" data-tk-dates="1"><span>Даты выполнения · ' + (occsOf(t).length + 1) + '</span><ul class="tk-dates">' + allWhens(t).map(function (w) {
        var isNext = whenKey(w.start_at) === nk;
        return '<li class="' + (isNext ? 'tk-next' : '') + '">' + (w.main ? '' : '<span class="tk-rep" title="Повтор">↻</span> ') + '<b>' + esc(fmtPeriod(w)) + '</b>' +
          (w.main ? ' <span class="tk-muted">основная</span>' : '') + (isNext ? ' <span class="tk-tag">ближайшая</span>' : '') + '</li>';
      }).join('') + '</ul></div>';
    } else {
      h += '<div class="tk-kv"><span>Срок</span><b>' + esc(fmtPeriod(t)) + '</b></div>';
    }
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
        var what = (NOTE_TEXT[n.kind] || n.kind) + (n.kind === 'holiday' && n.label ? ' (' + n.label + ')' : '');
        if (n.kind === 'vacation' || n.kind === 'day_off') {
          // V6-1 (R-7): яркая оранжевая плашка с косой штриховкой; (R-15): ФИО — ссылка на матрицу отпусков на эту дату
          var nm = n.employee_id ? empName(n.employee_id) : '';
          var who = !n.employee_id ? '' : (S.empById[n.employee_id]
            ? '<a href="#" class="tk-name tk-name-vac" data-tk-act="openMatrix" data-emp="' + esc(n.employee_id) + '" data-date="' + esc(n.date) +
              '" title="Открыть матрицу отпусков на эту дату">' + esc(nm) + '</a>' + esc(': ')
            : esc(nm + ': '));
          return '<li class="tk-note-vac" data-tk-note="' + esc(n.kind) + '">' + esc(fmtDay(n.date)) + ' — ' + who + esc(what) + '</li>';
        }
        var who2 = n.employee_id ? empName(n.employee_id) + ': ' : '';
        return '<li>' + esc(fmtDay(n.date)) + ' — ' + esc(who2 + what) + '</li>';
      }).join('') + '</ul></div>';
    }
    if (t.archived) h += '<div class="tk-box">Задача в архиве.</div>';
    if (canWrite() && !t.archived) {
      h += '<div class="tk-actions">' +
        '<button type="button" class="tk-btn tk-primary" data-tk-act="editTask" data-id="' + esc(t.id) + '">Править</button>' +
        (t.status === 'open'
          ? '<button type="button" class="tk-btn" data-tk-act="closeTask" data-id="' + esc(t.id) + '">Закрыть</button>'
          : '<button type="button" class="tk-btn" data-tk-act="reopenTask" data-id="' + esc(t.id) + '">Переоткрыть</button>') +
        '<button type="button" class="tk-btn tk-danger" data-tk-act="archiveTask" data-id="' + esc(t.id) + '">В архив</button></div>';
    }
    return h + '</aside>';
  }

  // --- форма (только admin)
  function emptyDraft(pre) {
    var d = S.view === 'calendar' ? (S.cal.anchor || todayYmd()) : todayYmd();
    var dr = {
      title: '', description: '', assignees: S.filters.emp ? [S.filters.emp] : [],
      watchers: [], kind: 'single', startDate: d, startTime: '', endDate: d, endTime: '',
      priority: 2, labels: [], labelInput: '', checklist: [], occ: []
    };
    // V6-2 (R-10): дата/время из клика по ячейке календаря
    if (pre) ['kind', 'startDate', 'startTime', 'endDate', 'endTime'].forEach(function (k) { if (pre[k] !== undefined) dr[k] = pre[k]; });
    return dr;
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
      priority: +t.priority || 2, labels: tagsOf(t), labelInput: '',
      checklist: (t.checklist || []).map(function (c) { return { id: c.id, text: c.text, done: !!c.done }; }),
      occ: occsOf(t).map(function (o) { return { date: dateOf(o.start_at), time: timeOf(o.start_at) }; })     // V6.3-2: повторы (дата + время)
    };
  }
  // ---- V6.3-2 (Д-1): раздел «Повторения» формы. Строка = { date: 'YYYY-MM-DD', time: 'HH:MM' | '' }.
  // У задачи без времени (startTime пуст) повтор — только дата (время строки игнорируется и не отправляется).
  function occHasTime(d) { return !!d.startTime; }
  function occKey(d, r) { return (r.date || '') + (occHasTime(d) ? 'T' + (r.time || d.startTime) : ''); }
  function occSort(d) {
    if (!d.occ) d.occ = [];
    d.occ.sort(function (a, b) {
      var x = occKey(d, a), y = occKey(d, b);
      if (!a.date !== !b.date) return a.date ? -1 : 1;          // строки без даты — в конец
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  // клиентская проверка повторов → { index, text } | { index: null, text } | null (сервер проверяет то же и сам)
  function occDraftError(d) {
    var rows = d.occ || [], seen = {}, mainKey = occKey(d, { date: d.startDate, time: d.startTime });
    if (rows.length > OCC_MAX) return { index: null, text: 'Повторов не больше ' + OCC_MAX + '.' };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!parseYmd(r.date)) return { index: i, text: 'Укажите дату повтора.' };
      var k = occKey(d, r);
      if (k === mainKey) return { index: i, text: 'Повтор совпадает с основной датой задачи — выберите другое время или дату.' };
      if (seen[k] !== undefined) return { index: i, text: 'Повтор совпадает с повтором ' + (seen[k] + 1) + ' — удалите дубль.' };
      seen[k] = i;
    }
    return null;
  }
  function occPayload(d) {
    return (d.occ || []).map(function (r) { return { start_at: r.date + (occHasTime(d) ? 'T' + (r.time || d.startTime) : '') }; });
  }
  function occTimeOptions(value) {
    var v = String(value || ''), items = [], m, i;
    for (m = 0; m < 1440; m += CAL_SLOT_MIN) items.push({ value: hhmm(m), label: hhmm(m) });
    if (v && !items.some(function (it) { return it.value === v; })) {
      for (i = 0; i < items.length && items[i].value < v; i++) { /* позиция по порядку */ }
      items.splice(i, 0, { value: v, label: v });
    }
    return optionsHtml(items, v);
  }
  function renderOccSection(d, F) {
    var rows = d.occ || [], err = F && F.occErr, timed = occHasTime(d);
    var h = '<div class="tk-occs" data-tk-occs="1">';
    rows.forEach(function (r, i) {
      var bad = err && err.index === i;
      h += '<div class="tk-occrow' + (bad ? ' tk-occ-bad' : '') + '" data-tk-occrow="' + i + '"><span class="tk-occ-ic" aria-hidden="true">↻</span>' +
        '<input type="date" aria-label="Дата повтора ' + (i + 1) + '" data-tk-occ-date="' + i + '" value="' + esc(r.date) + '">' +
        (timed ? ' <select class="tk-time" aria-label="Время повтора ' + (i + 1) + '" data-tk-occ-time="' + i + '">' + occTimeOptions(r.time || d.startTime) + '</select>' : '') +
        ' <button type="button" class="tk-x" data-tk-act="removeOcc" data-idx="' + i + '" title="Удалить повтор" aria-label="Удалить повтор ' + (i + 1) + '">×</button>' +
        (bad ? '<div class="tk-occ-err" role="alert" data-tk-occ-err="' + i + '">' + esc(err.text) + '</div>' : '') + '</div>';
    });
    if (err && err.index === null) h += '<div class="tk-occ-err" role="alert" data-tk-occ-err="all">' + esc(err.text) + '</div>';
    if (!rows.length) h += '<span class="tk-muted tk-occ-none">повторов нет</span>';
    h += '<div><button type="button" class="tk-btn" data-tk-act="addOcc"' + (rows.length >= OCC_MAX ? ' disabled' : '') + '>+ Добавить повтор</button></div>' +
      '<div class="tk-muted tk-hint">Задача выполняется и в эти даты. Длительность повтора — как у задачи' + (timed ? '' : ' (у задачи без времени — дата)') +
      '; тема, исполнители, чек-лист и статус общие.</div></div>';
    return h;
  }
  function tagChipsHtml(d) {
    return d.labels.map(function (tag, i) {
      return '<span class="tk-chip tk-tagchip" data-tk-tag="' + esc(tag) + '">' + esc(tag) +
        ' <button type="button" class="tk-x" data-tk-act="removeTag" data-idx="' + i + '" title="Убрать тег" aria-label="Убрать тег «' + esc(tag) + '»">×</button></span>';
    }).join('');
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
      '<input type="date" data-tk-field="startDate" value="' + esc(d.startDate) + '"> ' + timeSelectHtml('startTime', d.startTime) + '</div>' +
      (d.kind === 'period' ? '<div class="tk-dt"><span>Конец</span><input type="date" data-tk-field="endDate" value="' + esc(d.endDate) + '"> ' + timeSelectHtml('endTime', d.endTime) + '</div>' : ''));
    h += fieldRow('Повторения', renderOccSection(d, F), 'tk-f-occ');
    h += fieldRow('Приоритет', '<select data-tk-field="priority">' + optionsHtml([
      { value: 1, label: '1 — высокий' }, { value: 2, label: '2 — обычный' }, { value: 3, label: '3 — низкий' }], d.priority) + '</select>');
    // V6.2 (W-4): метка — теги-чипы: Enter/запятая → чип, × и Backspace в пустом вводе удаляют, подсказки — существующие теги
    h += fieldRow('Метка', '<div class="tk-tagsbox" data-tk-tagsbox="1"><span class="tk-tagchips" data-tk-tagchips="1">' + tagChipsHtml(d) + '</span>' +
      '<input type="text" maxlength="' + LABEL_MAX + '" list="tkLabels" autocomplete="off" placeholder="тег и Enter" aria-label="Добавить тег" data-tk-field="labelInput" value="' + esc(d.labelInput) + '"></div>' +
      '<datalist id="tkLabels">' + labelsOf(S.tasks).map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist>' +
      '<div class="tk-muted tk-hint">Enter или запятая — добавить тег; × или Backspace в пустом поле — убрать. Тег до ' + TAG_MAX + ' символов, все вместе до ' + LABEL_MAX + '.</div>');
    h += fieldRow('Чек-лист', '<div class="tk-cklist">' + d.checklist.map(function (c, i) {
      return '<div class="tk-ckrow"><input type="checkbox" data-tk-ck-done="' + i + '"' + (c.done ? ' checked' : '') + '> ' +
        '<input type="text" maxlength="300" data-tk-ck-text="' + i + '" value="' + esc(c.text) + '"> ' +
        '<button type="button" class="tk-x" data-tk-act="removeCheck" data-idx="' + i + '" title="Удалить пункт">×</button></div>';
    }).join('') + '</div><button type="button" class="tk-btn" data-tk-act="addCheck">+ пункт</button>');
    // V7: вложения — та же кнопка-окно; у новой задачи файлы ждут первого сохранения
    var attN = F.id ? attsOf(findTask(F.id)).length : (F.pendingFiles || []).length;
    h += fieldRow('Вложения', '<button type="button" class="tk-btn tk-attformbtn" data-tk-act="attOpenForm">' + CLIP_SVG + ' Вложения' + (attN ? ' · ' + attN : '') + '</button>' +
      '<div class="tk-muted tk-hint">' + (F.id ? 'Файлы прикрепляются сразу, без кнопки «Сохранить».' : 'Файлы загрузятся после сохранения задачи.') + '</div>');
    var wnames = d.watchers.map(empName).join(', ');
    h += fieldRow('Наблюдатель', '<select disabled title="Поле хранится, но в MVP неактивно"><option>' + esc(wnames || 'не используется в MVP') + '</option></select>', 'tk-f-off');
    h += '<div class="tk-actions"><button type="button" class="tk-btn tk-primary" data-tk-act="saveForm"' + (S.busy ? ' disabled' : '') + '>Сохранить</button>' +
      '<button type="button" class="tk-btn" data-tk-act="cancelForm">Отмена</button></div></form>';
    return h;
  }

  function render() {
    if (!DOM.root) return;
    var showForm = !!(S.form && canWrite());
    var showCal = !showForm && S.view === 'calendar';
    calScrollSave();                                   // V6-2: запомнить прокрутку календаря перед перерисовкой
    if (!showForm && !showCal) S.cal.scrollTop = null; // ушли из календаря — при возврате снова 08:00
    var h = '<div class="tk-wrap">' + renderBar() + renderMsg();
    if (S.loadError) h += '<div class="tk-msg tk-msg-error">' + esc(S.loadError) + '</div>';
    if (showForm) h += renderForm();
    else if (S.view === 'board') h += renderBoard();
    else if (S.view === 'calendar') h += renderCalendar();
    else h += renderList();
    h += '</div>';
    DOM.root.innerHTML = h;
    if (!showForm && !showCal && S.view !== 'board') fitListWidths();   // V6.3-4: ширины колонок Списка (синхронно, до отрисовки — без мерцания)
    if (showCal) calScrollApply();
    if (!S.form && typeof DOM.root.querySelector === 'function') {
      var sel = DOM.root.querySelector('.tk-sel');
      if (sel && sel.scrollIntoView) { try { sel.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
    }
    // V6.3-2: ошибка повтора — показать нужную строку формы
    if (showForm && S.form.occErr && typeof DOM.root.querySelector === 'function') {
      var oe = DOM.root.querySelector('.tk-occ-bad') || DOM.root.querySelector('[data-tk-occ-err]');
      if (oe && oe.scrollIntoView) { try { oe.scrollIntoView({ block: 'center' }); } catch (e2) { /* ignore */ } }
    }
  }

  // ---------------------------------------------------------------- form logic
  function draftError(d) {
    if (!String(d.title).trim()) return ERR_TEXT.title_required;
    var le = labelError(draftTags(d));
    if (le) return le;
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
  // V6.2 (W-4): чипы + введённый, но не превращённый в чип текст → строка «тег1, тег2» (сервер нормализует так же)
  function draftTags(d) { return splitTags((d.labels || []).concat(splitTags(d.labelInput)).join(',')); }
  function draftLabel(d) { return draftTags(d).join(', '); }
  function labelError(tags) {
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].length > TAG_MAX) return 'Тег «' + truncate(tags[i], 20) + '» длиннее ' + TAG_MAX + ' символов.';
    }
    if (tags.join(', ').length > LABEL_MAX) return 'Все теги вместе длиннее ' + LABEL_MAX + ' символов — уберите лишние.';
    return '';
  }
  function buildPayload(d, isNew) {
    var p = {
      title: String(d.title).trim(),
      description: String(d.description || '').trim(),
      assignees: d.assignees.slice(),
      start_at: d.startDate + (d.startTime ? 'T' + d.startTime : ''),
      end_at: d.kind === 'period' ? (d.endDate + (d.endTime ? 'T' + d.endTime : '')) : (isNew ? null : ''),
      priority: +d.priority || 2,
      label: draftLabel(d),
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
    // V6.3-2 (Д-1): повторы — полная замена набора (при правке тоже: пустой список = все повторы удалены)
    p.occurrences = occPayload(d);
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
  // P3-4: poll() применил дельту sync (index.html) — сотрудника могли удалить в другом клиенте.
  // Всегда: счётчик ⚠ (один ?orphans=1). Если панель задач открыта и форма правки закрыта — перечитываем
  // справочник сотрудников и текущее представление, не трогая фильтры, выбранную задачу, окно замены и форму.
  function isPanelOpen() {
    if (!S.active) return false;
    var p = panelEl();
    return !p || !p.classList || p.classList.contains('open');
  }
  function onRemoteChange() {
    var cnt = refreshOrphanCount();
    if (!S.active) return cnt;
    if (!isPanelOpen() || S.form) { S.dirty = true; return cnt; }   // перечитаем, когда панель/форма освободятся
    S.dirty = false;
    return Promise.all([cnt, loadEmployees(true).then(function () { return load(true); })]);
  }
  function flushDirty() {
    if (!S.dirty || !S.active || !isPanelOpen() || S.form) return;
    S.dirty = false;
    loadEmployees(true).then(function () { return load(true); });
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
        var inRange = taskDays(task).some(function (d) { return d >= rg.from && d <= rg.to; });   // V6.3-2: видна и по повтору
        if (!inRange && (task.first_day > rg.to || task.last_day < rg.from)) S.cal.anchor = task.first_day;
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
        if (r.data.occurrence_index != null) {
          // V6.3-2: блок на повторе — ошибка у нужной строки (больничный/командировка исполнителя в день повтора)
          S.form.blocked = null;
          S.form.error = '';
          S.form.occErr = { index: +r.data.occurrence_index, text: r.data.message || 'Повтор попадает на больничный или командировку исполнителя.' };
        } else {
          S.form.blocked = {
            blocked_days: r.data.blocked_days || [], suggested_start: r.data.suggested_start || null,
            suggested_end: r.data.suggested_end || null
          };
          S.form.error = '';
        }
      } else {
        S.msg = { type: 'error', text: 'Действие заблокировано: дни на больничном/в командировке.' };
      }
      render();
      return Promise.resolve();
    }
    // V6.3-2: ошибки повторов (формат/дубль) — у нужной строки формы (index — позиция в отправленном списке)
    if (S.form && /^(invalid_occurrence|occurrence_duplicate)$/.test(code || '') && r.data.index != null) {
      S.form.occErr = { index: +r.data.index, text: errText(r) };
      S.form.error = '';
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
    F.occErr = null;
    if (err) { F.error = err; render(); return Promise.resolve(); }
    occSort(F.draft);                                    // порядок строк = порядок в запросе (index ошибки сервера → строка)
    var oe = occDraftError(F.draft);
    if (oe) { F.error = ''; F.occErr = oe; render(); return Promise.resolve(); }
    F.error = '';
    S.busy = true;
    var isNew = !F.id, payload = buildPayload(F.draft, isNew), p;
    if (isNew) {
      p = api('POST', API, payload);
    } else {
      payload.version = F.version;
      p = api('PUT', API + '?id=' + encodeURIComponent(F.id), payload);
    }
    var pend = isNew ? (F.pendingFiles || []).slice() : [];
    return p.then(function (r) {
      if (isNew && pend.length && S.att && S.att.pending) attClose(true);
      var done = handleWriteResult(r, F.id, isNew ? 'Задача создана' : 'Задача сохранена');
      // V7: отложенные файлы новой задачи — после создания (задача уже сохранена, сбой файлов её не отменяет)
      if (isNew && pend.length && r.ok && r.data && r.data.task && r.data.task.id) {
        var tid = r.data.task.id;
        return Promise.resolve(done).then(function () { return attUploadPending(tid, pend); });
      }
      return done;
    });
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
  function openForm(id, focus, pre) {
    if (!canWrite()) return;
    var t = id ? findTask(id) : null;
    S.form = { id: t ? t.id : null, version: t ? t.version : null, draft: t ? draftFromTask(t) : emptyDraft(pre), blocked: null, error: '', focus: focus || '' };
    S.msg = null;
    render();
    if (focus === 'assignees' && DOM.root.querySelector) {
      var el = DOM.root.querySelector('[data-tk-field="assigneePick"]');
      if (el && el.focus) el.focus();
    }
  }

  // V6-1: переход в «Список» с одним фильтром (метка/приоритет/статус/сотрудник): остальные фильтры сброшены, выбор снят
  function goList(only) {
    S.filters = { emp: '', due: '', priority: '', label: '', status: '' };
    Object.keys(only).forEach(function (k) { S.filters[k] = only[k]; });
    S.selectedId = null;
    S.msg = null;
    S.form = null;
    if (S.view !== 'list') { S.view = 'list'; load(); } else { render(); }
  }

  var ACTIONS = {
    dismissMsg: function () { S.msg = null; render(); },
    // V7: вложения — значок в карточке, кнопка в форме, кнопки окна
    attOpen: function (el, ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); attOpen(el.dataset.id); },
    attOpenForm: function () {
      if (!S.form) return;
      if (S.form.id) attOpen(S.form.id); else attOpenPending();
    },
    attClose: function () { attClose(); },
    attPick: function () {
      var inp = DOM.att && DOM.att.querySelector ? DOM.att.querySelector('[data-tk-att-input]') : null;
      if (inp && inp.click) inp.click();
    },
    attDelete: function (el) { attDelete(el.dataset.att); },
    attDismiss: function (el) {
      if (!S.att) return;
      S.att.queue = S.att.queue.filter(function (q) { return q.key !== el.dataset.key; });
      attRender();
    },
    attUnqueue: function (el) {
      if (!S.form || !S.form.pendingFiles) return;
      S.form.pendingFiles = S.form.pendingFiles.filter(function (p) { return p.key !== el.dataset.key; });
      attRender();
    },
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
      // V6-1 (R-14): клик по ФИО → «Список», все строки этого сотрудника, остальные фильтры сброшены
      if (ev && ev.preventDefault) ev.preventDefault();
      goList({ emp: el.dataset.emp || '' });
    },
    // V6-1 (R-12/R-13): метка / приоритет / статус → «Список» с одним этим фильтром
    filterBy: function (el, ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      var f = el.dataset.f;
      if (f !== 'label' && f !== 'priority' && f !== 'status') return;
      var o = {};
      o[f] = el.dataset.v == null ? '' : String(el.dataset.v);
      goList(o);
    },
    // V6-1 (R-17): ↑ → ↓ → без сортировки; смена колонки начинает с ↑; фильтры не трогаем
    sortBy: function (el) {
      var key = el.dataset.key;
      if (key !== 'priority' && key !== 'status') return;
      if (S.sort.key !== key || !S.sort.dir) S.sort = { key: key, dir: 'asc' };
      else if (S.sort.dir === 'asc') S.sort = { key: key, dir: 'desc' };
      else S.sort = { key: '', dir: '' };
      render();
      var b = DOM.root && DOM.root.querySelector ? DOM.root.querySelector('[data-tk-act="sortBy"][data-key="' + key + '"]') : null;
      if (b && b.focus) b.focus();
    },
    // V6-1 (R-15): ФИО в пометке отпуска/отгула → матрица отпусков на эту дату (index.html: window.openMatrixAt)
    openMatrix: function (el, ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (typeof window.openMatrixAt !== 'function') { toast('Матрица отпусков недоступна', 'error'); return; }
      window.openMatrixAt({ employeeId: el.dataset.emp || '', date: el.dataset.date || '' });
    },
    clearEmp: function () { S.filters.emp = ''; render(); },
    newTask: function () { openForm(null); },
    editTask: function (el, ev) {
      // V6.2 (W-2): та же функция и у «Править» в карточке, и у ✎ в строке Списка; клик по ✎ не открывает карточку строки
      if (ev && ev.stopPropagation) ev.stopPropagation();
      openForm(el.dataset.id);
    },
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
      // V7 (решение владельца): при архивации вложения удаляются с сервера — предупреждаем
      var an = attsOf(t).length;
      if (typeof window.confirm === 'function' && !window.confirm('Отправить задачу «' + t.title + '» в архив?' +
        (an ? '\nВложения (' + an + ' ' + plural(an, 'файл', 'файла', 'файлов') + ') будут удалены с сервера без возможности восстановления.' : ''))) return;
      S.busy = true;
      api('DELETE', API + '?id=' + encodeURIComponent(t.id), { version: t.version }).then(function (r) {
        return handleWriteResult(r, t.id, 'Задача отправлена в архив');
      });
    },
    // V6.2 (W-4): × на чипе тега в форме
    removeTag: function (el) {
      if (!S.form) return;
      var i = +el.dataset.idx;
      if (i >= 0 && i < S.form.draft.labels.length) S.form.draft.labels.splice(i, 1);
      refreshTags(true);
    },
    saveForm: function () { submitForm(); },
    cancelForm: function () { if (S.att && S.att.pending) attClose(true); S.form = null; render(); flushDirty(); },
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
    // V6.3-2 (Д-1): «+ Добавить повтор» — строка с датой на день позже самой поздней даты (основная/повторы) и временем задачи
    addOcc: function () {
      if (!S.form) return;
      if (!S.form.draft.occ) S.form.draft.occ = [];
      if (S.form.draft.occ.length >= OCC_MAX) return;
      var d = S.form.draft, last = parseYmd(d.startDate) ? d.startDate : todayYmd();
      d.occ.forEach(function (r) { if (parseYmd(r.date) && r.date > last) last = r.date; });
      if (d.kind === 'period' && parseYmd(d.endDate) && d.endDate > last) last = d.endDate;
      d.occ.push({ date: addDays(last, 1), time: d.startTime || '' });
      S.form.occErr = null;
      occSort(d);
      render();
      var inp = DOM.root.querySelectorAll ? DOM.root.querySelectorAll('[data-tk-occ-date]') : null;
      if (inp && inp.length) {
        for (var i = 0; i < d.occ.length; i++) if (d.occ[i].date === addDays(last, 1) && inp[i] && inp[i].focus) { inp[i].focus(); break; }
      }
    },
    removeOcc: function (el) {
      if (!S.form || !S.form.draft.occ) return;
      S.form.draft.occ.splice(+el.dataset.idx, 1);
      S.form.occErr = null;
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
    calMode: function (el) { S.cal.mode = el.dataset.mode === 'day' ? 'day' : 'week'; load(); },
    // V6-2 (R-10): клик по пустой ячейке (день, полчаса) → «Новая задача»; только admin
    calCell: function (el) {
      if (!canWrite()) return;
      var date = el.dataset.date, m = +el.dataset.min;
      if (!parseYmd(date) || !(m >= 0 && m < 1440)) return;
      openForm(null, '', calSlotDraft(date, m));
    },
    // V6-2: «+N ещё» в полосе «Весь день» — развернуть/свернуть
    calAdToggle: function () { S.cal.adAll = !S.cal.adAll; render(); }
  };

  // ---------------------------------------------------------------- V6.2 (W-4): поле-теги формы
  // Добавить теги из строки (через запятую) в черновик; true — всё принято. Ошибка (тег > 30, всего > 200) — текст в форме, ввод сохраняется.
  function addDraftTags(raw) {
    var F = S.form, d = F.draft, err = '';
    splitTags(raw).forEach(function (tag) {
      if (err) return;
      var k = tag.toLowerCase();
      if (d.labels.some(function (x) { return x.toLowerCase() === k; })) return;
      err = labelError([tag]);
      if (!err) {
        var next = d.labels.concat([tag]);
        err = labelError(next);
        if (!err) d.labels = next;
      }
    });
    if (err) { F.error = err; F.tagErr = true; }
    else if (F.tagErr) { F.error = ''; F.tagErr = false; }
    return !err;
  }
  function focusTagInput() {
    var inp = DOM.root && DOM.root.querySelector ? DOM.root.querySelector('[data-tk-field="labelInput"]') : null;
    if (inp && inp.focus) inp.focus();
  }
  // перерисовать только чипы (фокус и прокрутка формы не теряются); нет разметки/ошибка → полная перерисовка
  function refreshTags(focus) {
    var F = S.form, q = DOM.root && DOM.root.querySelector ? DOM.root : null;
    var box = q ? q.querySelector('[data-tk-tagchips]') : null, inp = q ? q.querySelector('[data-tk-field="labelInput"]') : null;
    if (!F) return;
    if (!box || !inp || F.tagErr) { render(); if (focus) focusTagInput(); return; }
    box.innerHTML = tagChipsHtml(F.draft);
    inp.value = F.draft.labelInput;
    if (focus && inp.focus) inp.focus();
  }
  function onTagKey(ev) {
    if (ev.isComposing || !S.form) return;
    var d = S.form.draft, t = ev.target;
    if (ev.key === 'Enter' || ev.key === ',') {
      if (ev.preventDefault) ev.preventDefault();
      var raw = t.value != null ? t.value : d.labelInput;
      d.labelInput = raw;
      if (!String(raw).trim()) return;                           // пустой ввод: Enter/запятая ничего не делают
      if (addDraftTags(raw)) d.labelInput = '';
      refreshTags(true);
    } else if (ev.key === 'Backspace') {
      var cur = t.value != null ? t.value : d.labelInput;
      if (cur === '' && d.labels.length) {
        if (ev.preventDefault) ev.preventDefault();
        d.labels.pop();
        d.labelInput = '';
        refreshTags(true);
      }
    }
  }
  function onTagInput(ev, t) {
    var d = S.form.draft, v = t.value;
    if (v.indexOf(',') >= 0) {                                   // запятая / вставка строки «a, b, c»
      var parts = v.split(','), paste = ev.inputType === 'insertFromPaste' || ev.inputType === 'insertFromDrop' || parts.length > 2;
      var rest = paste ? '' : parts.pop();
      d.labelInput = addDraftTags(parts.join(',')) ? rest : v;
      refreshTags(true);
      return;
    }
    d.labelInput = v;
    // выбор подсказки из datalist (Chrome: insertReplacementText, Firefox: событие без inputType) → сразу чип
    if (v.trim() && (!ev.inputType || ev.inputType === 'insertReplacementText') && labelsOf(S.tasks).indexOf(v) >= 0) {
      if (addDraftTags(v)) d.labelInput = '';
      refreshTags(true);
    }
  }

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
  // V6-1: теги-фильтры — span[role=button]; с клавиатуры (Enter/Space) работают как клик
  function onKeyTag(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var t = ev.target;
    var el = t && t.closest ? t.closest('.tk-tagbtn[data-tk-act], .tk-namebtn[data-tk-act]') : null;
    if (!el) return;
    if (ev.preventDefault) ev.preventDefault();
    onClick({ target: el, preventDefault: function () {} });
  }
  function onKeyDown(ev) {
    var t = ev.target;
    if (t && t.dataset && t.dataset.tkField === 'labelInput') { onTagKey(ev); return; }   // V6.2 (W-4)
    onKeyTag(ev);
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
    // V6.3-2: строки «Повторения» — дата/время; после правки список сортируется (по возрастанию), ошибка у строки сбрасывается
    if (t.dataset.tkOccDate !== undefined || t.dataset.tkOccTime !== undefined) {
      var oi = +(t.dataset.tkOccDate !== undefined ? t.dataset.tkOccDate : t.dataset.tkOccTime), row = d.occ[oi];
      if (!row) return;
      if (t.dataset.tkOccDate !== undefined) row.date = t.value; else row.time = t.value;
      S.form.occErr = null;
      occSort(d);
      render();
      return;
    }
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
    if (['title', 'description', 'labelInput', 'startDate', 'startTime', 'endDate', 'endTime'].indexOf(f) >= 0) {
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
    if (f === 'labelInput') { onTagInput(ev, t); return; }
    if (f === 'title' || f === 'description') d[f] = t.value;
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
      S.cal.fresh = true;            // V6-2: открытие из матрицы/извне — снова прокрутка к 08:00
    } else {
      S.filters.emp = emp;
    }
    S.selectedId = opts.taskId || null;
    return activate();
  }

  /**
   * V8-T3 (п.5 владельца): кнопка «Задачи» в карточке сотрудника (index.html #tasksFromEmpCardBtn).
   * Открывает панель в «Списке» с фильтром по сотруднику (остальные фильтры сброшены).
   * admin — дополнительно открывается форма НОВОЙ задачи: emptyDraft() берёт исполнителя из S.filters.emp
   * (assignees: [S.filters.emp]), сохранение — штатный saveForm → POST api/tasks.php.
   * supervisor/viewer — только список (canWrite() = false: формы и кнопок записи нет, сервер всё равно отвечает 403).
   * Возвращает Promise<boolean>: true — панель открыта для этого сотрудника.
   */
  function openForEmployee(empId) {
    var emp = normEmpId(empId);
    if (!emp) return Promise.resolve(false);
    ensurePanelOpen();
    S.view = 'list';
    S.filters = { emp: emp, due: '', priority: '', label: '', status: '' };
    S.selectedId = null;
    S.msg = null;
    S.form = null;
    return activate().then(function () {
      if (!S.user) return false;
      if (S.empById[emp] === undefined) {
        // сотрудник есть только на клиенте (ещё не сохранён на сервере) — задачу на него сервер отклонил бы
        S.filters.emp = '';
        S.msg = { type: 'error', text: ERR_TEXT.employee_not_found };
        render();
        return false;
      }
      if (canWrite()) openForm(null);
      return true;
    });
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
  // P3-1: строка задачи в окне — из ответа сервера (название, срок, версия), а не из снимка при открытии окна
  function syncItemView(it, t) {
    if (!t) return;
    it.version = t.version;
    if (t.title != null) it.title = t.title;
    if (t.start_at != null) it.start_at = t.start_at;
    it.end_at = t.end_at || null;
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
      syncItemView(it, t);
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
        if (r.data.task) { it.task = r.data.task; syncItemView(it, r.data.task); }
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
  // P3-2: все назначены → «Задачи переназначены»; часть → «Переназначено N из M; остальные — см. окно» (info); ни одной → без тоста
  function assignToastText(done, total) {
    if (!done || !total) return null;
    if (done >= total) return { text: 'Задачи переназначены', type: 'success' };
    return { text: 'Переназначено ' + done + ' из ' + total + '; остальные — см. окно', type: 'info' };
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
    var target = M.target, noEmp = false;
    return M.ready.then(function () {
      return items.reduce(function (p, it) {
        return p.then(function () {
          if (noEmp) return null;
          var go = it.task ? Promise.resolve(true) : readItem(it);
          return go.then(function (ok) {
            if (!ok || it.status === 'skipped') return null;
            return putItem(it, target, accept, false).then(function (res) {
              if (res === 'no_employee') noEmp = true;
            });
          });
        });
      }, Promise.resolve());
    }).then(function () {
      M.busy = false;
      // P3-2: тост по факту — сколько из обработанных в этом запуске задач реально назначено
      var done = items.filter(function (it) { return it.status === 'done'; }).length;
      var toastText = assignToastText(done, items.length);
      if (toastText) toast(toastText.text, toastText.type);
      if (done) {
        notifyChanged();
        if (S.active) load();
      }
      if (noEmp) {
        M.error = ERR_TEXT.employee_not_found + ' Возможно, его уже удалили — выберите другого.';
        M.target = '';
        return loadEmployees(true).then(function () { if (S.modal === M) renderModal(); });
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
      '.tk-name{color:var(--rt-blue);text-decoration:none;border-bottom:1px dotted var(--rt-blue)}.tk-namebtn{cursor:pointer}' +
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
      // V6-2: календарь по часам (Неделя/День): один прокручиваемый контейнер, липкие шапка/«Весь день»/колонка часов
      '.tk-wk{flex:1 1 auto;min-width:0;border:1px solid var(--divider);border-radius:8px;overflow:auto;max-height:calc(100vh - 230px);min-height:320px;background:#fff;position:relative}' +
      '.tk-wk *{box-sizing:border-box}' +
      '.tk-cal-in{position:relative}' +
      '.tk-cal-hd,.tk-cal-ad,.tk-cal-bd{display:grid}' +
      '.tk-cal-hd{position:sticky;top:0;z-index:6;height:36px;background:#f1f3f8;border-bottom:1px solid var(--divider)}' +
      '.tk-wk-h{padding:4px 6px;border-right:1px solid var(--divider);overflow:hidden;white-space:nowrap;line-height:26px;min-width:0}' +
      '.tk-gut{position:sticky;left:0;z-index:4;background:#fff;border-right:1px solid var(--divider)}' +
      '.tk-cal-hd .tk-gut{z-index:7;background:#f1f3f8}' +
      '.tk-cal-ad{position:sticky;top:36px;z-index:5;background:#fff;border-bottom:2px solid var(--divider)}' +
      '.tk-cal-ad.tk-ad-open{position:static}' +
      '.tk-gut-ad{font-size:10px;line-height:1.15;color:var(--accent);padding:5px 3px;text-align:right;background:#f1f3f8}' +
      '.tk-ad-c{border-right:1px solid var(--divider);padding:2px;min-height:26px;min-width:0;overflow:hidden}' +
      '.tk-ad-more{display:block;width:100%;border:0;background:transparent;color:var(--rt-blue);font:inherit;font-size:11px;text-align:left;padding:1px 3px;cursor:pointer}' +
      '.tk-hr{height:' + CAL_HOUR_PX + 'px;border-top:1px solid var(--divider);font-size:11px;line-height:14px;color:var(--accent);text-align:right;padding:2px 4px 0}' +
      '.tk-hr:first-child{border-top-color:transparent}' +
      '.tk-day{position:relative;border-right:1px solid var(--divider);min-width:0}' +
      '.tk-slot{height:' + (CAL_HOUR_PX / 2) + 'px;border-top:1px solid var(--divider)}' +
      '.tk-slot.tk-half{border-top-color:rgba(138,155,181,.22)}' +
      '.tk-day .tk-slot:first-child{border-top-color:transparent}' +
      '.tk-day.tk-can .tk-slot{cursor:pointer}.tk-day.tk-can .tk-slot:hover{background:rgba(0,136,204,.09)}' +
      '.tk-we{background:var(--weekend-bg)}' +
      '.tk-today{box-shadow:inset 0 -2px 0 var(--rt-blue)}' +
      '.tk-now{position:absolute;left:0;right:0;height:0;border-top:2px solid #e53935;z-index:3;pointer-events:none}' +
      '.tk-now:before{content:"";position:absolute;left:-1px;top:-5px;width:8px;height:8px;border-radius:50%;background:#e53935}' +
      '.tk-ev{background:rgba(0,136,204,.14);border-left:3px solid var(--rt-blue);border-radius:4px;padding:3px 5px;margin-bottom:4px;font-size:11px;cursor:pointer;overflow:hidden}' +
      '.tk-ev.tk-ev-t{position:absolute;z-index:2;margin:0 0 0 1px;padding:1px 4px;line-height:14px;background:#d9edf7;box-shadow:0 0 0 1px #fff}' +
      '.tk-ev.tk-ev-s{white-space:nowrap;text-overflow:ellipsis}' +
      '.tk-ev.tk-ev-n{padding:1px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tk-ev.tk-ev-n .tk-ev-when{display:none}' +
      '.tk-ev.tk-ev-ad{margin-bottom:2px;padding:1px 4px;line-height:15px;white-space:nowrap;text-overflow:ellipsis}' +
      '.tk-ev.tk-conf{border-left-color:var(--sick-red);background:rgba(244,67,54,.1)}' +
      '.tk-ev.tk-ev-t.tk-conf{background:#fde3e0}' +
      '.tk-ev.tk-hl{border-left-color:var(--rt-purple);background:rgba(119,0,255,.14)}' +
      '.tk-ev.tk-ev-t.tk-hl{background:#e9dcfb}' +
      '.tk-ev.tk-sel{outline-offset:-1px;z-index:4}' +
      '.tk-ev-when{color:var(--accent)}.tk-ev-title{font-weight:700}' +
      '.tk-ev-ic{display:inline-block;min-width:13px;height:13px;line-height:13px;border-radius:7px;text-align:center;font-size:9px;font-weight:700;color:#fff;margin-left:3px;vertical-align:middle}' +
      '.tk-ic-conf{background:var(--sick-red)}.tk-ic-pend{background:#c99a00}.tk-ic-orph{background:var(--rt-orange)}' +
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
      '.tk-cols{width:100%;flex-direction:column}.tk-wk{width:100%;max-height:72vh}}';
  }

  // V6-1: стили Списка/Доски/карточки отдельным блоком (не правим общий css(): параллельные V6-2/V6-3 трогают соседние строки)
  function cssV61() {
    return '' +
      // R-4: Доска — три колонки равной ширины (Открыта / Закрыта / карточка); «Без исполнителя» — на всю ширину над ними
      '.tk-split-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:stretch}' +
      '.tk-split-board>.tk-boardmain,.tk-split-board .tk-cols{display:contents}' +
      '.tk-split-board .tk-sec{grid-column:1/-1;margin-bottom:0}' +
      '.tk-split-board .tk-col,.tk-split-board .tk-detail{box-sizing:border-box;min-width:0;min-height:120px;padding:6px 8px;flex:none;width:auto;overflow-wrap:anywhere}' +
      '.tk-split-board .tk-card{padding:5px 8px;margin:4px 0;font-size:12px}' +
      '.tk-split-board .tk-sub{font-size:11px;margin:1px 0}' +
      '.tk-split-board .tk-detail{font-size:12px}' +
      '.tk-split-board .tk-col>b{font-size:12px}' +
      // R-12/13: теги-фильтры
      '.tk-tagbtn{cursor:pointer}.tk-tagbtn:hover,.tk-tagbtn:focus-visible{background:rgba(0,136,204,.12);border-color:var(--rt-blue);outline:0}' +
      // R-5: шапка Списка, зебра
      '.tk-tablewrap{overflow:auto;max-height:calc(100vh - 230px);min-height:160px;border:1px solid #b9c6da;border-radius:8px}' +
      '.tk-table{border-collapse:separate;border-spacing:0}' +
      '.tk-table th{position:sticky;top:0;z-index:2;background:#dde6f3;color:#12203a;font-weight:700;font-size:12px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;' +
        'padding:8px;border-bottom:2px solid #1a2b49;border-right:1px solid #b9c6da}' +
      '.tk-table th:last-child{border-right:0}' +
      '.tk-table tbody tr:nth-child(even){background:#f1f5fb}' +
      '.tk-table tbody tr.tk-row:hover{background:#e0eefa}' +
      '.tk-sortbtn{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;padding:0;margin:0;font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit;cursor:pointer}' +
      '.tk-sortbtn:hover,.tk-sortbtn:focus-visible{text-decoration:underline;outline:0}' +
      '.tk-sortbtn.tk-sorted{color:#0b4f8a}.tk-arr{font-size:13px;line-height:1}.tk-arr-off{opacity:.5}' +
      // R-16: колонка «Описание»
      '.tk-desc{min-width:150px;max-width:260px;overflow-wrap:anywhere;color:var(--text)}' +
      // R-8: «!» у исполнителя
      '.tk-warnico{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-left:4px;border-radius:50%;background:#ff8a00;color:#1a2b49;' +
        'font:700 10px/1 sans-serif;vertical-align:middle;cursor:help}' +
      // R-7: пометки отпуска/отгула — яркая оранжевая плашка с мелкой бледной косой штриховкой
      '.tk-notes li.tk-note-vac{list-style:none;margin:3px 0 3px -16px;padding:3px 8px;border-radius:6px;border:1px solid #e07800;color:#1a2b49;font-weight:600;' +
        'background:repeating-linear-gradient(45deg,rgba(255,255,255,.3) 0,rgba(255,255,255,.3) 1.5px,rgba(255,255,255,0) 1.5px,rgba(255,255,255,0) 4px),#ff8a00}' +
      '.tk-note-vac a.tk-name-vac{color:#1a2b49;border-bottom:0;text-decoration:underline;font-weight:700}' +
      '.tk-note-vac a.tk-name-vac:hover{background:rgba(255,255,255,.45)}' +
      '@media (max-width:760px){.tk-split-board{grid-template-columns:minmax(0,1fr)}.tk-tablewrap{max-height:calc(100vh - 260px)}}';
  }

  // V6.2-1 (W-1…W-4): только новые правила
  function cssV621() {
    return '' +
      // W-1: «Исполнитель» — половина прежней ширины (замер на 1280: 255.8 px → 128 px), «Описание» забирает остаток, ФИО переносятся
      '.tk-table-v62{width:100%}' +
      '.tk-table-v62 th.tk-c-exec,.tk-table-v62 td.tk-c-exec{width:192px;min-width:192px;max-width:192px;overflow-wrap:anywhere}' +
      '.tk-table-v62 td.tk-desc{min-width:220px;max-width:none}' +
      '.tk-table-v62 th.tk-c-task,.tk-table-v62 td.tk-c-task{min-width:160px}' +
      // W-2: «Править» в строке
      '.tk-table-v62 th.tk-c-edit,.tk-table-v62 td.tk-c-edit{width:44px;min-width:44px;max-width:44px;padding:4px;text-align:center;vertical-align:middle}' +
      '.tk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
      '.tk-editbtn{width:32px;height:32px;padding:0;border:1px solid #b9c6da;border-radius:6px;background:#fff;color:#1a2b49;font-size:16px;line-height:1;cursor:pointer}' +
      '.tk-editbtn:hover,.tk-editbtn:focus-visible{background:rgba(0,136,204,.12);border-color:var(--rt-blue);outline:0}' +
      // W-4: поле-теги формы
      '.tk-f .tk-tagsbox{display:flex;flex-wrap:wrap;gap:4px;align-items:center;border:1px solid var(--divider);border-radius:6px;padding:3px 6px;background:#fff}' +
      '.tk-tagsbox:focus-within{border-color:var(--rt-blue)}' +
      '.tk-tagchips{display:contents}' +
      '.tk-tagsbox .tk-tagchip{margin:0;background:#eef4fb;border-color:#b9c6da;font-size:12px;padding:0 4px 0 8px;overflow-wrap:anywhere}' +
      '.tk-f .tk-tagsbox input[type=text]{flex:1 1 120px;width:auto;min-width:120px;border:0;outline:0;padding:4px 2px;background:transparent}' +
      '.tk-hint{font-size:11px;margin-top:3px}' +
      '.tk-ltag{overflow-wrap:anywhere}';
  }

  // V6.3-1 (И-1, И-2): только новые правила (ширина «Исполнителя» 192 px — в cssV621, строка W-1)
  function cssV631() {
    return '' +
      // И-1: «…» — отдельный чип, не часть фамилии (Список и Доска)
      '.tk-more{display:inline-block;margin-left:2px;padding:0 6px;border-radius:9px;background:#dfe7f3;border:1px solid #b9c6da;color:#33415c;font-weight:700;line-height:1.3;cursor:help}' +
      // V6.3-4 (И-2, P2-1/P3-1): «Задача» больше не закреплена. Ширины колонок считает fitListWidths():
      // замер при «Исполнителе» 128 px (.tk-measure) → фиксация (.tk-fit): «Исполнитель» 192, «Описание» − 64, остальное и таблица — как при 128
      '.tk-table-v62.tk-measure th.tk-c-exec,.tk-table-v62.tk-measure td.tk-c-exec{width:128px;min-width:128px;max-width:128px}' +
      '.tk-table-v62.tk-fit{table-layout:fixed;width:auto}' +
      '.tk-table-v62.tk-fit th,.tk-table-v62.tk-fit td{box-sizing:border-box}' +
      '.tk-table-v62.tk-fit th.tk-c-task,.tk-table-v62.tk-fit td.tk-c-task,.tk-table-v62.tk-fit td.tk-desc{min-width:0;overflow-wrap:anywhere}';
  }

  // V6.2-2: стили перетаскивания, контекстного меню и всплывающего сообщения календаря (только новые правила)
  function cssV62() {
    return '' +
      '.tk-ev.tk-dnd{cursor:grab;-webkit-user-select:none;user-select:none}' +
      '.tk-dragging,.tk-dragging *{cursor:grabbing!important;-webkit-user-select:none!important;user-select:none!important}' +
      '.tk-ev.tk-drag-src{opacity:.4}' +
      '.tk-shadow{position:absolute;left:1px;right:5px;z-index:8;box-sizing:border-box;border:2px dashed var(--rt-blue);border-radius:4px;background:rgba(0,136,204,.2);' +
        'padding:1px 4px;font-weight:700;font-size:11px;line-height:14px;color:#0b4f8a;overflow:hidden;pointer-events:none}' +
      '.tk-shadow.tk-shadow-same{border-color:#8a9bb5;background:rgba(138,155,181,.16);color:#51607a}' +
      '.tk-shadow.tk-shadow-ad{position:static;display:block;margin:2px 0;line-height:15px}' +
      '.tk-ev.tk-flash{outline:2px solid #ff9800;outline-offset:-1px;z-index:5;animation:tkflash 1s ease-in-out 3}' +
      '@keyframes tkflash{0%,100%{box-shadow:0 0 0 0 rgba(255,152,0,0)}50%{box-shadow:0 0 0 4px rgba(255,152,0,.55)}}' +
      '.tk-ctx{position:fixed;z-index:5002;min-width:170px;padding:4px;background:#fff;border:1px solid var(--divider);border-radius:8px;box-shadow:0 6px 24px rgba(26,43,73,.28);font-size:13px}' +
      '.tk-ctx-i{display:block;width:100%;text-align:left;border:0;background:transparent;padding:7px 12px;border-radius:6px;font:inherit;color:var(--text);cursor:pointer}' +
      '.tk-ctx-i:hover:not(:disabled),.tk-ctx-i:focus-visible{background:rgba(0,136,204,.12);outline:0}' +
      '.tk-ctx-i:disabled{opacity:.45;cursor:default}' +
      '.tk-ctoast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:5001;display:flex;align-items:center;gap:12px;max-width:min(92vw,460px);' +
        'padding:10px 14px;background:#1a2b49;color:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(26,43,73,.35);font:600 13px/1.3 Inter,sans-serif}' +
      '.tk-ctoast-act{border:0;background:transparent;color:#7fd0ff;font:inherit;text-decoration:underline;cursor:pointer;padding:2px 4px}' +
      '.tk-ctoast-x{border:0;background:transparent;color:#cfd8e8;font-size:16px;line-height:1;cursor:pointer;padding:0 2px}';
  }

  // V6.3-2 (Д-1): повторы — «↻ N» в Списке/Доске, плитка повтора в календаре, даты в карточке, раздел «Повторения» формы (только новые правила)
  function cssV632() {
    return '' +
      '.tk-occ-n{display:inline-block;margin-left:4px;padding:0 6px;border-radius:9px;border:1px solid var(--rt-blue);background:#e8f4fb;color:#0b4f8a;font:600 11px/16px sans-serif;white-space:nowrap;cursor:help;vertical-align:baseline}' +
      '.tk-ev.tk-occ{border-left-style:dashed;background:#e3f1fa}' +
      '.tk-ev.tk-ev-t.tk-occ{background:#e3f1fa}' +
      '.tk-ev-rep{display:inline-block;margin-right:3px;font-weight:700;color:var(--rt-blue)}' +
      '.tk-dates{list-style:none;margin:4px 0 0;padding:0}' +
      '.tk-dates li{margin:2px 0;padding:2px 6px;border-radius:6px}' +
      '.tk-dates li.tk-next{background:rgba(0,136,204,.12)}' +
      '.tk-rep{color:var(--rt-blue);font-weight:700}' +
      '.tk-occs{border:1px solid var(--divider);border-radius:8px;padding:6px 8px;background:#fff}' +
      '.tk-occrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;padding:2px 4px;border-radius:6px}' +
      '.tk-occ-ic{color:var(--rt-blue);font-weight:700}' +
      '.tk-occrow.tk-occ-bad{background:rgba(244,67,54,.08);outline:1px solid var(--sick-red)}' +
      '.tk-occ-err{flex:1 1 100%;color:#a3261b;font-size:12px}' +
      '.tk-occ-none{display:inline-block;margin-right:8px}' +
      '@media (max-width:760px){.tk-occrow input[type=date]{flex:1 1 140px;min-width:0}}';
  }

  // ---------------------------------------------------------------- init
  // V7: вложения — только новые правила (стиль окна — общий .tk-modal окна замены)
  function cssV7() {
    return '' +
      '.tk-clip{vertical-align:-3px;flex:none}' +
      '.tk-dhead-r{display:inline-flex;align-items:center;gap:6px;flex:none}' +
      '.tk-attbtn{display:inline-flex;align-items:center;gap:3px;height:24px;padding:0 7px;border:1px solid var(--divider);border-radius:12px;background:#fff;color:#6b7a90;cursor:pointer;font:600 11px/1 sans-serif}' +
      '.tk-attbtn:hover,.tk-attbtn:focus-visible{border-color:var(--rt-purple);color:var(--rt-purple);background:rgba(119,0,255,.06);outline:0}' +
      '.tk-attbtn-has{color:var(--rt-purple);border-color:rgba(119,0,255,.45)}' +
      '.tk-attn{min-width:8px;text-align:center}' +
      '.tk-tag.tk-att-n{color:#5b2bb5;white-space:nowrap}.tk-tag.tk-att-n .tk-clip{width:12px;height:12px;vertical-align:-2px}' +
      '.tk-ev-att{display:inline-flex;margin-left:3px;color:var(--rt-purple);vertical-align:middle}.tk-ev-att .tk-clip{width:11px;height:11px}' +
      '.tk-att-modal{width:600px}' +
      '.tk-att-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}' +
      '.tk-att-head .tk-mtitle .tk-clip{color:var(--rt-purple);vertical-align:-2px}' +
      '.tk-att-x{font-size:22px;padding:0 4px;color:#6b7a90}.tk-att-x:hover{color:var(--rt-purple)}' +
      '.tk-att-task{margin:-2px 0 8px;overflow-wrap:anywhere}' +
      '.tk-att-list,.tk-att-queue{list-style:none;margin:6px 0;padding:0}' +
      '.tk-att-it{display:flex;align-items:center;gap:8px;border:1px solid var(--divider);border-radius:8px;padding:6px 8px;margin-bottom:6px}' +
      '.tk-att-it:hover{background:rgba(119,0,255,.03)}' +
      '.tk-att-type{flex:none;width:34px;height:22px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font:700 9px/1 sans-serif;letter-spacing:.03em;color:#fff;background:#8a94a6}' +
      '.tk-att-k-pdf{background:#d93a2b}.tk-att-k-doc{background:#2b5fb4}.tk-att-k-xls{background:#1f8a4c}.tk-att-k-ppt{background:#d0611a}' +
      '.tk-att-k-img{background:var(--rt-purple)}.tk-att-k-zip{background:#7a6a2b}' +
      '.tk-att-main{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}' +
      '.tk-att-name{overflow-wrap:anywhere;color:var(--rt-blue);text-decoration:none;font-weight:600}a.tk-att-name:hover{text-decoration:underline}' +
      '.tk-att-meta{font-size:11px}' +
      '.tk-att-dl{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;color:#6b7a90;text-decoration:none}' +
      '.tk-att-dl:hover,.tk-att-dl:focus-visible{color:var(--rt-blue);background:rgba(0,136,204,.08);outline:0}' +
      '.tk-att-del{flex:none;color:#6b7a90;font-size:18px;padding:0 4px}.tk-att-del:hover{color:var(--sick-red)}' +
      '.tk-att-empty{padding:6px 2px}' +
      '.tk-att-q{border:1px dashed var(--divider);border-radius:8px;padding:6px 8px;margin-bottom:6px}' +
      '.tk-att-q-error{border-style:solid;border-color:rgba(211,47,47,.35);background:rgba(211,47,47,.04)}' +
      '.tk-att-qrow{display:flex;align-items:baseline;gap:6px}.tk-att-qrow .tk-att-name{color:var(--text);flex:none;max-width:55%}' +
      '.tk-att-qst{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}.tk-att-qrow .tk-x{flex:none;margin-left:auto}' +
      '.tk-att-bar{height:6px;border-radius:3px;background:rgba(119,0,255,.10);overflow:hidden;margin-top:5px}' +
      '.tk-att-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--rt-purple),var(--rt-blue));transition:width .15s linear}' +
      '.tk-att-drop{border:2px dashed rgba(119,0,255,.35);border-radius:10px;padding:14px 12px;margin:8px 0 4px;text-align:center;background:rgba(119,0,255,.025);transition:background .12s,border-color .12s}' +
      '.tk-att-drop.tk-att-over{border-color:var(--rt-purple);background:rgba(119,0,255,.09)}' +
      '.tk-att-droptext{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;color:#4a5568}.tk-att-droptext .tk-clip{color:var(--rt-purple)}' +
      '.tk-att-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}' +
      '.tk-attformbtn{display:inline-flex;align-items:center;gap:5px}.tk-attformbtn .tk-clip{color:var(--rt-purple)}' +
      '@media (max-width:760px){.tk-att-dnd{display:none}.tk-att-modal{padding:12px}.tk-att-drop{padding:10px}}';
  }

  function injectStyles() {
    if (document.getElementById('tasksModuleStyles')) return;
    var st = document.createElement('style');
    st.id = 'tasksModuleStyles';
    st.textContent = css() + cssV61() + cssV621() + cssV62() + cssV631() + cssV632() + cssV7();
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
    DOM.root.addEventListener('keydown', onKeyDown);
    DOM.root.addEventListener('change', onChange);
    DOM.root.addEventListener('input', onInput);
    // Enter в поле формы не должен перезагружать страницу; сохранение — только кнопкой.
    DOM.root.addEventListener('submit', function (ev) { if (ev.preventDefault) ev.preventDefault(); });
    DOM.root.addEventListener('dragstart', onDragStart);
    DOM.root.addEventListener('dragover', onDragOver);
    DOM.root.addEventListener('drop', onDrop);
    // V6.2-2: перетаскивание плиток календаря (pointer, только мышь) и ПКМ-меню; click после перетаскивания гасим в фазе перехвата
    DOM.root.addEventListener('click', onClickCapture, true);
    DOM.root.addEventListener('pointerdown', onCalPointerDown);
    DOM.root.addEventListener('contextmenu', onContextMenu);
    // T1-8: счётчик ⚠ на вкладке — при старте и при каждом открытии панели отпусков
    var trg = document.getElementById('vacationTrigger');
    if (trg) trg.addEventListener('click', function () { refreshOrphanCount(); setTimeout(flushDirty, 0); });
    refreshOrphanCount();
  }
  function autoInit() {
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
  }

  window.Tasks = {
    init: init,
    open: openTasksPanel,
    openForEmployee: openForEmployee,     // V8-T3: кнопка «Задачи» в карточке сотрудника (index.html)
    activate: activate,
    deactivate: deactivate,
    reload: function () { return load(); },
    onRemoteChange: onRemoteChange,       // T1-11: index.html poll() после применённой дельты sync
    canWrite: canWrite,
    openTasksFor: openTasksFor,           // T1-8: до удаления сотрудника (index.html #deleteEmp)
    offerReassign: offerReassign,         // T1-8: после удаления (index.html #deleteEmp)
    refreshOrphans: refreshOrphanCount,
    isActive: function () { return S.active; },
    // для тестов (scripts/test_tasks_frontend.js); в UI не используется
    __t: {
      S: S, ACTIONS: ACTIONS, render: render, listFitCalc: listFitCalc, onClick: onClick, onChange: onChange, onDrop: onDrop, onDragStart: onDragStart,
      splitTags: splitTags, tagsOf: tagsOf, labelsOf: labelsOf, errText: errText,       // V6.2-1 (W-4)
      truncate: truncate, weekStart: weekStart, addDays: addDays, fmtPeriod: fmtPeriod, normEmpId: normEmpId,
      applyFilters: applyFilters, buildPayload: buildPayload, draftError: draftError, esc: esc,
      isOrphan: isOrphan, removedDate: removedDate, plural: plural, modalEl: function () { return DOM.modal; },
      attEl: function () { return DOM.att; }, attOpen: attOpen, attEnqueue: attEnqueue, attPrecheck: attPrecheck, canAttach: canAttach, canDetach: canDetach,   // V7
      attKind: attKind, fmtSize: fmtSize, attErrText: attErrText, attUploadPending: attUploadPending, ATT_EXT: ATT_EXT,
      calLayout: calLayout, calSlotOf: calSlotOf, calSlotDraft: calSlotDraft, calDayLayout: calDayLayout, timeOptionsHtml: timeOptionsHtml,
      calScrollApply: calScrollApply, calScrollSave: calScrollSave, CAL_HOUR_PX: CAL_HOUR_PX,
      calDropCalc: calDropCalc, calPasteCalc: calPasteCalc, calClipOf: calClipOf, calMove: calMove, calPaste: calPaste, calCopy: calCopy,
      calDeleteOcc: calDeleteOcc, calInstances: calInstances, calInstById: calInstById, dueText: dueText, allDatesText: allDatesText, nextWhen: nextWhen,   // V6.3-2 (Д-1)
      occDraftError: occDraftError, occPayload: occPayload, occSort: occSort,
      onCalPointerDown: onCalPointerDown, onContextMenu: onContextMenu, onClickCapture: onClickCapture, HOOK: HOOK,
      drag: function () { return DRAG; }, clip: function () { return _clip; }, clearClip: function () { _clip = null; }, ctxOpen: function () { return !!_ctx; }, ctxClose: ctxClose, calToastClose: calToastClose
    }
  };
  window.openTasksPanel = openTasksPanel;

  autoInit();
})();
