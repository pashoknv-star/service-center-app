/**
 * StorageAdapter — мост между legacy frontend форматом и server API.
 *
 * Фаза 3 (часть A).
 *
 * Подключается через обычный <script src="js/storage.js"></script> (НЕ ES module).
 * Экспортирует объект StorageAdapter в window.StorageAdapter.
 *
 * Legacy frontend продолжит использовать те же глобальные переменные:
 *   - employees:        [{ id (int), name, role, location, dept (0-6), photo, slot }]
 *   - vacationData:     { <year>: { <empId int>: [{ startDay, endDay, type }] } }
 *   - idCounter:        int
 *
 * Серверный формат (ScheduleState) см. api/load.php, api/save.php:
 *   - employees:        [{ id ('emp_42'), fullName, positionId, location, groupId ('g1'), ... }]
 *   - entries:          { "emp_42:2026-06-07": { employeeId, date, status, comment, approvalStatus } }
 *
 * Принцип: при ошибке сервера — fallback на localStorage, приложение НЕ крашится.
 */
(function () {
  'use strict';

  var LOG_PREFIX = '[StorageAdapter]';

  // Эндпоинты сервера (относительно корня приложения).
  var LOAD_URL = 'api/load.php';
  var SAVE_URL = 'api/save.php';

  // Legacy localStorage ключи (как в index.html).
  var STORAGE_KEY = 'staff_layout_v2';
  var VACATION_STORAGE_KEY = 'vacation_data_v3';

  // Зоны (должны совпадать с ZONES из index.html).
  var ZONES = [
    'Группа клиентского сервиса',
    'Группа эксплуатации',
    'Группа сопровождения',
    'В2С',
    'Супервайзер',
    'Энергетик',
    'Транспорт'
  ];

  // Дни в месяцах невисокосного года.
  var DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Кэш доступности сервера (обновляется после load()).
  // Стартуем оптимистично: если api/ существует рядом — считаем серверный режим.
  var _serverReachable = null;

  // ============================================================
  // УТИЛИТЫ ДАТ
  // ============================================================

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  }

  function getDaysInMonth(year, month /* 0-indexed */) {
    if (month === 1 && isLeapYear(year)) return 29;
    return DAYS_IN_MONTH[month];
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /**
   * dayOfYearToDate(year, dayOfYear) → 'YYYY-MM-DD'
   * dayOfYear — 1..365 (или 1..366 в високосный год).
   * Алгоритм: накопленные дни по месяцам, с учётом високосного года.
   */
  function dayOfYearToDate(year, dayOfYear) {
    var remaining = dayOfYear;
    for (var m = 0; m < 12; m++) {
      var dim = getDaysInMonth(year, m);
      if (remaining <= dim) {
        return year + '-' + pad2(m + 1) + '-' + pad2(remaining);
      }
      remaining -= dim;
    }
    // fallback — последний день года
    return year + '-12-31';
  }

  /**
   * dateToDayOfYear(year, dateStr) → int (1..366)
   * dateStr в формате 'YYYY-MM-DD'.
   * Обратное преобразование к dayOfYearToDate.
   */
  function dateToDayOfYear(year, dateStr) {
    var parts = String(dateStr).split('-');
    var month = parseInt(parts[1], 10); // 1..12
    var day = parseInt(parts[2], 10);   // 1..31
    var doy = 0;
    for (var m = 0; m < month - 1; m++) {
      doy += getDaysInMonth(year, m);
    }
    doy += day;
    return doy;
  }

  // ============================================================
  // УТИЛИТЫ RANGES
  // ============================================================

  /**
   * mergeAdjacentRanges(ranges) — объединить смежные ranges одного типа
   * в непрерывные. Мутирует массив на месте и возвращает его.
   *
   * ranges: [{ startDay, endDay, type }]
   * Логика: сортируем по startDay, затем склеиваем где
   *   prev.type === curr.type && prev.endDay + 1 >= curr.startDay.
   */
  function mergeAdjacentRanges(ranges) {
    if (!ranges || ranges.length === 0) return ranges;
    // Копируем, чтобы не мутировать вход (безопасность вызова).
    var arr = ranges.slice();
    arr.sort(function (a, b) { return a.startDay - b.startDay; });
    var merged = [arr[0]];
    for (var i = 1; i < arr.length; i++) {
      var prev = merged[merged.length - 1];
      var curr = arr[i];
      if (prev.type === curr.type && prev.endDay + 1 >= curr.startDay) {
        prev.endDay = Math.max(prev.endDay, curr.endDay);
        // E8: при слиянии смежных сохраняем максимальную версию записи.
        var pv = (typeof prev.version === 'number') ? prev.version : 0;
        var cv = (typeof curr.version === 'number') ? curr.version : 0;
        if (cv > pv) {
          prev.version = curr.version;
          if (curr.comment) prev.comment = curr.comment;
        }
      } else {
        merged.push(curr);
      }
    }
    // Обратно записать в исходный массив (сохраняем ссылку).
    ranges.length = 0;
    for (var j = 0; j < merged.length; j++) ranges.push(merged[j]);
    return ranges;
  }

  // ============================================================
  // КОНВЕРСИЯ: Server → Legacy
  // ============================================================

  /**
   * Преобразует ScheduleState (с сервера) в legacy формат.
   * Возвращает { employees, vacationData, idCounter }.
   */
  function serverToLegacy(state) {
    var serverEmployees = state.employees || [];
    var positions = state.positions || [];
    var entries = state.entries || {};
    var serverYear = state.year || (new Date().getFullYear());

    // Карта positionId → position.name (для человекочитаемого role).
    var posNameById = {};
    positions.forEach(function (p) {
      if (p && p.id) posNameById[p.id] = p.name;
    });

    var employees = [];
    var serverIdToLegacyId = {};
    var maxLegacyId = 0;

    serverEmployees.forEach(function (emp, index) {
      var rawId = (emp.id != null) ? String(emp.id).replace(/\D/g, '') : '';
      var legacyId = parseInt(rawId, 10) || (index + 1);
      if (legacyId > maxLegacyId) maxLegacyId = legacyId;

      var legacyEmp = {
        id: legacyId,
        name: emp.fullName || '',
        role: (emp.positionId && posNameById[emp.positionId]) ? posNameById[emp.positionId] : (emp.positionId || ''),
        location: emp.location || '',
        phone: emp.phone || '',
        dept: parseInt(String(emp.groupId || 'g0').replace(/\D/g, ''), 10) || 0,
        photo: emp.photoUrl || '',
        slot: (emp.sortOrder != null) ? emp.sortOrder : index
      };

      employees.push(legacyEmp);
      // Карта: server id → legacy int id (для entries).
      if (emp.id != null) serverIdToLegacyId[String(emp.id)] = legacyId;
      // Также fallback: 'emp_<legacyId>' → legacyId на случай рассинхрона ключей.
    });

    // vacationData из entries.
    // entries: { "empId:date": { employeeId, date, status, ... } }
    var vacationData = {};
    // E8-2: по-дневная карта версий 'empId:date' → version, собирается ДО
    // mergeAdjacentRanges (склейка ranges теряет по-дневные версии — на весь
    // range остаётся max). Карта — single source of truth для entryVersion.
    var versionMap = {};
    Object.keys(entries).forEach(function (key) {
      var entry = entries[key];
      if (!entry) return;
      var serverEmpId = entry.employeeId || (key.split(':')[0]);
      var dateStr = entry.date || (key.split(':')[1]);
      if (!serverEmpId || !dateStr) return;

      // Определить год из даты (YYYY-MM-DD → YYYY).
      var year = parseInt(String(dateStr).split('-')[0], 10) || serverYear;

      // Найти legacy empId.
      var legacyEmpId = serverIdToLegacyId[String(serverEmpId)];
      if (legacyEmpId == null) {
        // fallback: вытащить число из server id.
        legacyEmpId = parseInt(String(serverEmpId).replace(/\D/g, ''), 10) || 0;
      }
      if (!legacyEmpId) return;

      // E8-2: зафиксировать по-дневную версию.
      var vKey = legacyEmpId + ':' + dateStr;
      versionMap[vKey] = (typeof entry.version === 'number') ? entry.version : 1;

      var doy = dateToDayOfYear(year, dateStr);

      if (!vacationData[year]) vacationData[year] = {};
      if (!vacationData[year][legacyEmpId]) vacationData[year][legacyEmpId] = [];

      vacationData[year][legacyEmpId].push({
        startDay: doy,
        endDay: doy,
        type: entry.status || 'vacation',
        // E8: сохраняем серверную версию записи (для оптимистичной конкуренции)
        // и сопутствующие поля, которые раньше терялись при конверсии.
        version: (typeof entry.version === 'number') ? entry.version : 1,
        comment: entry.comment || undefined,
        approved: entry.approvalStatus === 'approved' ? true : undefined
      });
    });

    // Объединить смежные ranges для каждого сотрудника/года.
    Object.keys(vacationData).forEach(function (y) {
      Object.keys(vacationData[y]).forEach(function (empId) {
        mergeAdjacentRanges(vacationData[y][empId]);
      });
    });

    var idCounter = maxLegacyId + 1;

    return {
      employees: employees,
      vacationData: vacationData,
      idCounter: idCounter,
      // E8-2: по-дневная карта версий для window.__syncVersions.
      versionMap: versionMap
    };
  }

  // ============================================================
  // КОНВЕРСИЯ: Legacy → Server (ScheduleState payload для save.php)
  // ============================================================

  /**
   * slugify для устойчивых id позиций из названия роли.
   * Если роль пустая — 'pos_unassigned'.
   */
  function positionSlug(roleName) {
    var s = String(roleName || '').trim().toLowerCase();
    s = s.replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_+|_+$/g, '');
    return s ? ('pos_' + s) : 'pos_unassigned';
  }

  /**
   * Текущий год из глобального контекста (legacy currentYear) или по умолчанию.
   */
  function resolveYear() {
    try {
      if (typeof window.currentYear !== 'undefined' && window.currentYear) return window.currentYear;
    } catch (e) {}
    try {
      if (typeof currentYear !== 'undefined' && currentYear) return currentYear;
    } catch (e) {}
    return new Date().getFullYear();
  }

  /**
   * Преобразует legacy данные в payload для api/save.php.
   * Принимает { employees, vacationData, idCounter }.
   * Возвращает объект { groups, positions, employees, entries, holidays, vacationBalances, year }.
   */
  function legacyToServer(input) {
    var legacyEmployees = (input && input.employees) || [];
    var vacationData = (input && input.vacationData) || {};

    // --- groups: из уникальных dept (0-6 → g0-g6) ---
    var groups = [];
    var seenDept = {};
    legacyEmployees.forEach(function (e) {
      var d = e.dept;
      if (seenDept[d] == null) {
        seenDept[d] = true;
        groups.push({
          id: 'g' + d,
          name: ZONES[d] || ('Зона ' + d),
          sortOrder: d
        });
      }
    });
    // Гарантируем, что есть хотя бы зона 0 (на случай пустого списка).
    if (groups.length === 0) {
      groups.push({ id: 'g0', name: ZONES[0], sortOrder: 0 });
    }
    groups.sort(function (a, b) { return a.sortOrder - b.sortOrder; });

    // --- positions: из уникальных role ---
    var positions = [];
    var posByRole = {};       // roleName → positionId
    var posSeen = {};
    legacyEmployees.forEach(function (e) {
      var role = e.role || '';
      if (!posSeen[role]) {
        posSeen[role] = true;
        var pid = positionSlug(role);
        positions.push({ id: pid, name: role || 'Должность', sortOrder: positions.length });
        posByRole[role] = pid;
      }
    });

    // --- employees ---
    var serverEmployees = legacyEmployees.map(function (e) {
      var id = 'emp_' + e.id;
      return {
        id: id,
        fullName: e.name || '',
        positionId: posByRole[e.role] || positionSlug(e.role),
        location: e.location || '',
        groupId: 'g' + (e.dept != null ? e.dept : 0),
        phone: e.phone || '',
        photoUrl: e.photo || '',
        isTechnical: (String(e.name || '').indexOf('Ставка') === 0) || (e.name === 'Новый сотрудник'),
        requiresFullProfile: false,
        sortOrder: (e.slot != null) ? e.slot : 0
      };
    });

    // --- entries: из vacationData[year][empId] → распаковка ranges по дням ---
    var entries = {};
    var entryList = [];
    Object.keys(vacationData).forEach(function (yearStr) {
      var year = parseInt(yearStr, 10);
      var yearMap = vacationData[yearStr];
      if (!yearMap) return;
      Object.keys(yearMap).forEach(function (legacyEmpId) {
        var ranges = yearMap[legacyEmpId];
        if (!ranges || !ranges.length) return;
        var serverEmpId = 'emp_' + legacyEmpId;
        ranges.forEach(function (r) {
          if (!r) return;
          var start = r.startDay;
          var end = r.endDay;
          var type = r.type || 'vacation';
          for (var day = start; day <= end; day++) {
            var date = dayOfYearToDate(year, day);
            var key = serverEmpId + ':' + date;
            var entry = {
              employeeId: serverEmpId,
              date: date,
              // 2026-08-24: канонизация серверного статуса (день-off):
              // UI-тип 'dayoff' отправляется как 'day_off' — БД сходится
              // к одному написанию, отображение покрыто alias-ами в TYPE_CSS.
              status: (type === 'dayoff') ? 'day_off' : type,
              comment: '',
              // E8-2: approved только для реально согласованных диапазонов.
              // Раньше всегда шла 'approved' → все ячейки становились
              // «согласованными» после первого save и лочились на редактирование.
              approvalStatus: r.approved ? 'approved' : 'draft'
            };
            // E8-2: по-дневная карта версий — single source of truth.
            // Если день неизвестен карте (новая локальная правка) — не шлём
            // entryVersion вовсе (сервер примет безусловно, старое поведение).
            var vmap = (typeof window !== 'undefined' && window.__syncVersions) || {};
            if (typeof vmap[key] === 'number') entry.entryVersion = vmap[key];
            entries[key] = entry;
            entryList.push(entry);
          }
        });
      });
    });

    // --- year (meta) ---
    var year = resolveYear();

    return {
      groups: groups,
      positions: positions,
      employees: serverEmployees,
      entries: entries,
      holidays: {},
      vacationBalances: {},
      year: year
    };
  }

  // ============================================================
  // localStorage FALLBACK
  // ============================================================

  function readLegacyFromLocalStorage() {
    var employees = [];
    var idCounter = 1;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.employees)) {
          employees = parsed.employees;
        }
        if (parsed && typeof parsed.idCounter === 'number') {
          idCounter = parsed.idCounter;
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'localStorage read (staff) failed:', e);
    }

    var vacationData = {};
    try {
      var rawV = localStorage.getItem(VACATION_STORAGE_KEY);
      if (rawV) {
        vacationData = JSON.parse(rawV) || {};
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'localStorage read (vacation) failed:', e);
    }

    return { employees: employees, vacationData: vacationData, idCounter: idCounter };
  }

  function writeLegacyToLocalStorage(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        employees: data.employees || [],
        idCounter: data.idCounter || 1
      }));
    } catch (e) {
      console.warn(LOG_PREFIX, 'localStorage write (staff) failed:', e);
    }
    try {
      localStorage.setItem(VACATION_STORAGE_KEY, JSON.stringify(data.vacationData || {}));
    } catch (e) {
      console.warn(LOG_PREFIX, 'localStorage write (vacation) failed:', e);
    }
  }

  // ============================================================
  // ПУБЛИЧНЫЙ API
  // ============================================================

  var StorageAdapter = {
    /**
     * Загружает состояние с сервера и КОНВЕРТИРУЕТ в legacy формат.
     * Возвращает: { employees: [...], vacationData: {...}, idCounter: N }
     * При ошибке сервера — fallback на localStorage.
     */
    load: async function () {
      console.log(LOG_PREFIX, 'load() — попытка GET', LOAD_URL);
      try {
        var resp = await fetch(LOAD_URL, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          credentials: 'same-origin'
        });
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        var state = await resp.json();
        // E8: сохраняем курсор sync-лога для polling-дельты (api/sync.php).
        this.__lastSyncId = (typeof state.lastSyncId === 'number') ? state.lastSyncId : null;
        _serverReachable = true;
        console.log(LOG_PREFIX, 'load() — сервер ответил. employees:',
          (state.employees || []).length, 'entries:',
          Object.keys(state.entries || {}).length);

        var legacy = serverToLegacy(state);
        // E8: курсор доезжает до фронта в legacy-объекте.
        if (typeof legacy.lastSyncId === 'undefined') legacy.lastSyncId = null;
        legacy.lastSyncId = this.__lastSyncId;
        console.log(LOG_PREFIX, 'load() — конвертировано в legacy. employees:',
          legacy.employees.length, 'idCounter:', legacy.idCounter,
          'vacation years:', Object.keys(legacy.vacationData));
        return legacy;
      } catch (err) {
        _serverReachable = false;
        console.warn(LOG_PREFIX, 'load() — сервер недоступен, fallback на localStorage:', err);
        return readLegacyFromLocalStorage();
      }
    },

    /**
     * Сохраняет legacy данные на сервер (конверсия legacy → ScheduleState).
     * Принимает: { employees, vacationData, idCounter }
     * fire-and-forget (не блокирует UI). При ошибке — fallback на localStorage.
     */
    save: async function (input) {
      input = input || {};
      console.log(LOG_PREFIX, 'save() — конверсия legacy → server');
      // Всегда дублируем в localStorage (надёжность offline).
      try { writeLegacyToLocalStorage(input); } catch (_) {}

      try {
        var payload = legacyToServer(input);
        console.log(LOG_PREFIX, 'save() — POST', SAVE_URL,
          'employees:', payload.employees.length,
          'entries:', Object.keys(payload.entries).length,
          'year:', payload.year);

        var resp = await fetch(SAVE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload)
        });
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        var result = await resp.json();
        _serverReachable = true;
        console.log(LOG_PREFIX, 'save() — сервер подтвердил:', result);
        return result;
      } catch (err) {
        _serverReachable = false;
        console.warn(LOG_PREFIX, 'save() — сервер недоступен, данные сохранены локально:', err);
        return { success: false, fallback: true, error: String(err) };
      }
    },

    /**
     * Сохраняет только vacationData на сервер.
     * Принимает: vacationData { <year>: { <empId>: [ranges] } }
     * Для этого нужен текущий список employees — берётся из localStorage/глобального.
     * При ошибке — fallback на localStorage.
     */
    saveVacation: async function (vacationData) {
      console.log(LOG_PREFIX, 'saveVacation() — years:',
        vacationData ? Object.keys(vacationData) : 'none');
      // Дублируем в localStorage сразу (legacy-код тоже это делает, но безопасно).
      try {
        localStorage.setItem(VACATION_STORAGE_KEY, JSON.stringify(vacationData || {}));
      } catch (e) {
        console.warn(LOG_PREFIX, 'saveVacation() — localStorage write failed:', e);
      }

      try {
        // Получаем employees из localStorage, чтобы собрать полный payload.
        var legacy = readLegacyFromLocalStorage();
        var payload = legacyToServer({
          employees: legacy.employees,
          vacationData: vacationData,
          idCounter: legacy.idCounter
        });

        var resp = await fetch(SAVE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload)
        });
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        var result = await resp.json();
        _serverReachable = true;
        console.log(LOG_PREFIX, 'saveVacation() — сервер подтвердил:', result);
        return result;
      } catch (err) {
        _serverReachable = false;
        console.warn(LOG_PREFIX, 'saveVacation() — сервер недоступен:', err);
        return { success: false, fallback: true, error: String(err) };
      }
    },

    /**
     * Проверка доступности сервера (синхронная, по кэшу).
     * true — последний запрос к серверу успешен (или ещё не было сбоев).
     * false — последний запрос упал.
     * null — статус неизвестен (запроса ещё не было).
     */
    isServerMode: function () {
      if (_serverReachable === null) {
        // Оптимистично: считаем серверный режим, если не на file://.
        try {
          if (typeof location !== 'undefined' && location.protocol === 'file:') {
            return false;
          }
        } catch (e) {}
        return true;
      }
      return _serverReachable;
    }
  };

  // Экспорт утилит для тестирования/отладки (необязательная часть API).
  StorageAdapter._internal = {
    dayOfYearToDate: dayOfYearToDate,
    dateToDayOfYear: dateToDayOfYear,
    mergeAdjacentRanges: mergeAdjacentRanges,
    serverToLegacy: serverToLegacy,
    legacyToServer: legacyToServer,
    isLeapYear: isLeapYear,
    ZONES: ZONES
  };

  window.StorageAdapter = StorageAdapter;
  console.log(LOG_PREFIX, 'модуль инициализирован (server-first, localStorage fallback)');
})();
