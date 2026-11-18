/**
 * Trips Module - Frontend Implementation for "Командировки" feature
 * 
 * Этап 4: Точный API + UI (табы, список, карточка)
 * - State: { trips: [], lastSyncId: 0 } (no localStorage)
 * - API: GET/POST/PUT/DELETE api/trips.php, syncDelta
 * - UI: tabs, trip list, trip modal
 * - 5 surgical inserts in index.html only
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[Trips]';

  // API endpoints
  var API_BASE = 'api/trips.php';
  var API_SYNC = 'api/sync.php';

  // Trip status constants
  var TRIP_STATUS = {
    FORECAST: 'forecast',
    CONFIRMED: 'confirmed'
  };

  /** V8-T2: подпись статуса для списка/формы (статус меняется только кнопками формы). */
  function tripStatusLabel(status) {
    return status === TRIP_STATUS.CONFIRMED ? 'Подтверждена' : 'Прогноз';
  }

  // State management
  var _state = {
    trips: [],
    lastSyncId: 0
  };

  // Cache DOM elements
  var _dom = {
    panelTabs: null,
    tabMatrix: null,
    tabTrips: null,
    tripsListView: null,
    matrixWrapper: null,
    tripsList: null,
    newTripBtn: null,
    tripModal: null
  };

  // Current state
  var _currentTab = 'matrix';
  var _currentUser = null;
  var _lastLocalActionAt = 0;
  // V8-T1: что показано в форме командировки в панели (null — формы нет) и
  // активный режим выбора дат в Матрице (null — режима нет).
  var _formTrip = null;
  var _datePick = null;

  // =====================
  // INITIALIZATION
  // =====================

  /**
   * Watch #authOverlay: when login completes (overlay gets 'hidden' class),
   * reload trips and repaint. Covers the session race where backoff retries
   * ran out before the user finished logging in.
   */
  function watchAuthOverlay() {
    if (_authWatchInstalled) return;
    _authWatchInstalled = true;
    var authEl = document.getElementById('authOverlay');
    if (!authEl || typeof MutationObserver === 'undefined') return;
    var observer = new MutationObserver(function() {
      if (authEl.className.indexOf('hidden') >= 0) {
        observer.disconnect();
        _authWatchInstalled = false;
        loadTrips().then(function(ok) {
          if (ok) {
            try { overlay(window.currentYear); } catch (e) { console.warn(LOG_PREFIX, 'Overlay error:', e); }
          }
        });
      }
    });
    observer.observe(authEl, { attributes: true, attributeFilter: ['class'] });
    console.log(LOG_PREFIX, 'authOverlay observer installed');
  }

  /**
   * Auto-initialize: call on DOM ready or immediately if already loaded
   */
  function init() {
    console.log(LOG_PREFIX, 'Initializing...');

    // Create trip modal root portal for consistent stacking context
    var portalRoot = document.getElementById('tripModalRoot');
    if (!portalRoot) {
      portalRoot = document.createElement('div');
      portalRoot.id = 'tripModalRoot';
      document.body.appendChild(portalRoot);
      console.log(LOG_PREFIX, 'Created trip modal root portal');
    }

    // T5-DEFECT-1: patch renderVacationMatrix so trips overlay renders with the
    // matrix. Safe here (DOM-ready): the inline script has executed by now.
    if (!_renderPatched && typeof window.renderVacationMatrix === 'function') {
      _renderPatched = true;
      var _origRender = window.renderVacationMatrix;
      window.renderVacationMatrix = function() {
        var r = _origRender.apply(this, arguments);
        try {
          overlay(window.currentYear);
        } catch (e) {
          console.warn(LOG_PREFIX, 'Overlay error:', e);
        }
        return r;
      };
      console.log(LOG_PREFIX, 'renderVacationMatrix monkey-patched with overlay hook');
      // Render overlay for an already-drawn matrix.
      try { overlay(window.currentYear); } catch (e) { console.warn(LOG_PREFIX, 'Overlay error:', e); }
    }

    // Initialize if not already done. loadTrips() is async — the overlay
    // painted above ran on an empty state, so re-run overlay() once the trips
    // arrive, otherwise cells/classes/click-listeners never appear.
    // Self-healing: on session race (load fires before login -> 401) retry
    // with backoff until authorized (max ~5 attempts / ~8s total).
    // If retries run out, a MutationObserver on #authOverlay picks the load
    // up the moment the user completes login (class -> 'auth-overlay hidden').
    if (_state.trips.length === 0) {
      var attempts = 0;
      var tryLoad = function() {
        attempts++;
        loadTrips().then(function(ok) {
          if (ok) {
            try { overlay(window.currentYear); } catch (e) { console.warn(LOG_PREFIX, 'Overlay error:', e); }
          } else if (attempts < 5) {
            setTimeout(tryLoad, attempts * 1500);
          } else {
            console.warn(LOG_PREFIX, 'Gave up loading trips after', attempts, 'attempts');
            watchAuthOverlay();
          }
        });
      };
      tryLoad();
    }
    
    // Setup event listeners after DOM is ready
    setupEventListeners();
    
    // Check if we should sync
    if (_state.lastSyncId > 0) {
      pollForChanges();
    }
  }

  /**
   * Initialize from script insertion point
   */
  function autoInit() {
    if (document.readyState !== 'loading') {
      init();
    } else {
      document.addEventListener('DOMContentLoaded', init);
    }
  }

  // =====================
  // API CLIENT
  // =====================

  /**
   * Generic API fetch wrapper
   */
  function api(method, url, body) {
    var options = {
      method: method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    return fetch(url, options)
      .then(function(response) {
        return response.json().then(function(data) {
          return {
            ok: response.ok,
            status: response.status,
            data: data
          };
        });
      });
  }

  /**
   * Load all trips from server
   */
  function loadTrips() {
    return api('GET', API_BASE)
      .then(function(response) {
        if (response.ok && response.data.success) {
          _state.trips = response.data.trips || [];
          _state.lastSyncId = response.data.lastSyncId || 0;
          console.log(LOG_PREFIX, 'Loaded', _state.trips.length, 'trips');
          return true;
        }
        throw new Error('Failed to load trips: ' + (response.data.error || 'Unknown error'));
      })
      .catch(function(error) {
        console.error(LOG_PREFIX, 'Error loading trips:', error);
        return false;
      });
  }

  /**
   * Create a new trip
   */
  function createTrip(payload) {
    var defaultPayload = {
      title: '',
      location: '',
      comment: '',
      status: TRIP_STATUS.FORECAST,
      participants: []
    };

    var data = Object.assign({}, defaultPayload, payload);

    // Validation
    if (!data.title || data.title.trim() === '') {
      throw new Error('Название командировки обязательно');
    }

    if (data.participants.length === 0) {
      throw new Error('Добавьте хотя бы одного участника');
    }

    // Validate dates
    data.participants.forEach(function(participant) {
      if (!participant.startDate || !participant.endDate) {
        throw new Error('Укажите даты для всех участников');
      }
      if (participant.startDate > participant.endDate) {
        throw new Error('Дата начала не может быть позже даты окончания');
      }
    });

    return api('POST', API_BASE, data)
      .then(function(response) {
        if (response.ok && response.data.success) {
          var newTrip = response.data.trip;
          _state.trips.push(newTrip);
          _state.lastSyncId = newTrip.version;
          _lastLocalActionAt = Date.now();
          
          // Show success message
          if (typeof window.showToast === 'function') {
            window.showToast('Заведена новая командировка', 'success');
          }
          
          return newTrip;
        } else {
          // Handle error responses
          var error = response.data;
          
          if (response.status === 409 && error.error === 'overlapping_entry') {
            throw new Error('Пересечение с отпуском/отгулом: ' + 
              (error.employeeId || 'сотрудник') + ' ' + (error.date || 'дата'));
          }
          
          if (response.status === 409 && error.error === 'version_conflict') {
            throw new Error('Дрейф версий: данные на сервере изменены');
          }
          
          if (response.status === 403) {
            // V8-T2: причина отказа понятным текстом (чужая зона / подтверждённая),
            // иначе общая формулировка.
            throw new Error(error && (error.error === 'zone_forbidden' || error.error === 'confirmed_immutable')
              ? tripErrorMessage(error) : 'Недостаточно прав для операции');
          }
          
          throw new Error(tripErrorMessage(error));
        }
      });
  }

  /**
   * Update an existing trip
   */
  function updateTrip(id, payload) {
    var trip = _state.trips.find(function(t) { return t.id === id; });
    if (!trip) {
      throw new Error('Командировка не найдена');
    }

    var data = Object.assign({}, payload);
    data.entryVersion = trip.version;

    return api('PUT', API_BASE + '?id=' + id, data)
      .then(function(response) {
        if (response.ok && response.data.success) {
          var updatedTrip = response.data.trip;
          var index = _state.trips.findIndex(function(t) { return t.id === id; });
          if (index !== -1) {
            _state.trips[index] = updatedTrip;
            _state.lastSyncId = updatedTrip.version;
            _lastLocalActionAt = Date.now();
          }
          return updatedTrip;
        } else {
          var error = response.data;
          
          if (response.status === 409 && error.error === 'version_conflict') {
            // Update local state with server version
            var serverTrip = error.serverTrip;
            var index = _state.trips.findIndex(function(t) { return t.id === id; });
            if (index !== -1) {
              _state.trips[index] = serverTrip;
            }
            throw new Error('Другой пользователь изменил командировку. Загружена серверная версия');
          }
          
          throw new Error(tripErrorMessage(error));
        }
      });
  }

  /**
   * Confirm a trip (admin/supervisor only)
   */
  function confirmTrip(id) {
    return api('PUT', API_BASE + '?id=' + id + '&action=confirm')
      .then(function(response) {
        if (response.ok && response.data.success) {
          var trip = response.data.trip;
          var index = _state.trips.findIndex(function(t) { return t.id === id; });
          if (index !== -1) {
            _state.trips[index] = trip;
            _state.lastSyncId = trip.version;
            _lastLocalActionAt = Date.now();
          }
          return trip;
        } else {
          // V8-T2: понятный текст по коду сервера (location_required, zone_forbidden …),
          // а не сырой код; сам код остаётся в err.code для вызывающего.
          var data = response.data || {};
          var err = new Error(response.status === 403 && !data.error
            ? 'Недостаточно прав для подтверждения'
            : (tripErrorMessage(data) || 'Не удалось подтвердить'));
          err.code = data.error || null;
          throw err;
        }
      });
  }

  /**
   * Delete a trip
   */
  function deleteTrip(id) {
    var trip = _state.trips.find(function(t) { return t.id === id; });
    if (!trip) {
      throw new Error('Командировка не найдена');
    }

    return api('DELETE', API_BASE + '?id=' + id)
      .then(function(response) {
        if (response.ok && response.data.success) {
          _state.trips = _state.trips.filter(function(t) { return t.id !== id; });
          _lastLocalActionAt = Date.now();
          
          if (typeof window.showToast === 'function') {
            window.showToast('Командировка удалена', 'success');
          }
          
          return true;
        } else {
          throw new Error(response.data.error || 'Не удалось удалить');
        }
      });
  }

  /**
   * Apply sync delta (tripsChanged/tripsDeleted)
   */
  function syncDelta(d) {
    var changed = false;
    var now = Date.now();

    // Process changed trips
    if (d.tripsChanged) {
      for (var tripId in d.tripsChanged) {
        var serverTrip = d.tripsChanged[tripId];
        var localTrip = _state.trips.find(function(t) { return t.id === tripId; });
        
        // Skip if it's our own action (within last 3 seconds)
        if (localTrip && serverTrip.version === localTrip.version) {
          continue;
        }
        
        // Update or add
        var index = _state.trips.findIndex(function(t) { return t.id === tripId; });
        if (index !== -1) {
          _state.trips[index] = serverTrip;
        } else {
          _state.trips.push(serverTrip);
        }
        changed = true;
      }
    }

    // Process deleted trips
    if (d.tripsDeleted && d.tripsDeleted.length > 0) {
      _state.trips = _state.trips.filter(function(t) {
        return d.tripsDeleted.indexOf(t.id) === -1;
      });
      changed = true;
    }

    if (changed) {
      _state.lastSyncId = Math.max(_state.lastSyncId, d.lastSyncId || 0);
      
      // Show notification if not our own action and UI is visible
      if (now - _lastLocalActionAt > 3000) {
        if (typeof window.showToast === 'function') {
          window.showToast('Командировки обновлены', 'info');
        }
      }
      
      // Refresh list if trips tab is active
      if (_currentTab === 'trips') {
        renderTripsList();
      }
    }
  }

  // =====================
  // USER MANAGEMENT
  // =====================

  /**
   * Get current user info
   */
  function getCurrentUser() {
    if (_currentUser) return _currentUser;
    
    // Check if currentUser/global user exists
    if (typeof window.currentUser !== 'undefined') {
      _currentUser = window.currentUser;
    } else if (typeof window.user !== 'undefined') {
      _currentUser = window.user;
    } else {
      // Fallback to session API
      api('GET', 'api/session.php')
        .then(function(response) {
          if (response.ok && response.data.authenticated) {
            _currentUser = response.data.user;
          }
        })
        .catch(function(error) {
          console.error(LOG_PREFIX, 'Error getting user session:', error);
        });
    }
    
    return _currentUser;
  }

  /**
   * Check if user can edit
   */
  function canEdit() {
    var user = getCurrentUser();
    return user && user.canEdit;
  }

  /**
   * Check if user is admin
   */
  function isAdmin() {
    var user = getCurrentUser();
    return user && user.isAdmin;
  }

  /**
   * Check if user is supervisor
   */
  function isSupervisor() {
    var user = getCurrentUser();
    return user && user.role === 'supervisor';
  }

  // =====================
  // UI COMPONENTS
  // =====================

  /**
   * Inject CSS styles
   */
  function injectStyles() {
    var style = document.createElement('style');
    style.textContent = `
      /* Trip blue color — semantic trip marker. The site keeps .trip-blue/.trip dots
         in trip-blue; this is command-trip semantics, NOT a UI accent. */
      .trip-blue { color: var(--trip-blue); }
      
      /* Matrix trip overlays — high specificity to win over .day-holiday /
         .day-weekend background rules in the host page.
         :not(.type-sick) keeps ЭЛН (sick leave) visually ABOVE trips
         (spec §4): a sick day inside a trip range stays red. */
      .matrix-table .day-cell-data.type-trip-confirmed:not(.type-sick),
      .day-cell-data.type-trip-confirmed:not(.type-sick) {
        background-color: var(--trip-blue) !important;
        background-image: none !important;
      }
      
      .matrix-table .day-cell-data.type-trip-forecast:not(.type-sick),
      .day-cell-data.type-trip-forecast:not(.type-sick) {
        background-color: rgba(33, 150, 243, 0.35) !important;
        background-image: repeating-linear-gradient(
          45deg,
          transparent 0 3px,
          rgba(33, 150, 243, 0.45) 3px 6px
        ) !important;
      }
      
      /* Sick-day priority extends to cursor: a sick cell inside a trip keeps
         the default cursor, hinting it opens the sick-day flow, not the trip. */
      .matrix-table .day-cell-data.type-sick { cursor: default; }

      /* Trip status indicators — semantic trip-blue (statuses of a trip) */
      .status-forecast {
        background-color: rgba(33, 150, 243, 0.35);
        background-image: repeating-linear-gradient(
          45deg,
          transparent 0 3px,
          rgba(33, 150, 243, 0.35) 3px 6px
        );
      }
      
      .status-confirmed {
        background-color: var(--trip-blue);
      }
      
      /* Panel tabs — aligned with site palette: purple accent, divider
         borders, 8px radius, site hover-tint */
      .panel-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 16px;
      }
      
      .panel-tab {
        padding: 8px 16px;
        border: 1px solid var(--divider);
        background: white;
        cursor: pointer;
        border-radius: 8px;
        transition: all 0.2s;
        color: var(--text);
      }
      
      .panel-tab:hover {
        background: rgba(119, 0, 255, 0.06);
      }
      
      .panel-tab.active {
        background: var(--rt-purple);
        color: white;
        border-color: var(--rt-purple);
      }
      
      /* Trip list */
      .trip-list-item {
        border: 1px solid var(--divider);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 8px;
        background: white;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .trip-list-item:hover {
        box-shadow: 0 2px 6px rgba(0,0,0,0.04);
      }
      
      .trip-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      
      .trip-status {
        width: 20px;
        height: 20px;
        border-radius: 3px;
        display: inline-block;
      }
      
      .trip-title {
        font-weight: bold;
        flex: 1;
        color: var(--text);
      }
      
      .trip-location {
        color: var(--accent);
        font-size: 0.9em;
      }
      
      .trip-dates {
        color: var(--accent);
        font-size: 0.85em;
      }
      
      .trip-participants {
        color: var(--text);
        font-size: 0.9em;
      }
      
      /* Trip modal root portal */
      #tripModalRoot {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 2500;
        display: block;
      }
      
      #tripModalRoot > * {
        pointer-events: auto;
      }
      
      /* Trip modal */
      .trip-modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        z-index: auto;
      }
      
      .trip-modal-content {
        background: white;
        margin: 50px auto;
        padding: 24px;
        width: 90%;
        max-width: 600px;
        border-radius: 8px;
        max-height: 80vh;
        overflow-y: auto;
      }
      
      .trip-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--divider);
      }
      
      .trip-modal-title {
        font-size: 1.2em;
        font-weight: bold;
        color: var(--text);
      }
      
      /* Trip panel form — V8-T4: вид как у формы «Новая задача» (js/tasks.js: .tk-form/.tk-f/.tk-actions/.tk-btn).
         Одна колонка, значения повторяют стили задачи; правила — только внутри #tripFormPanel
         (старая модалка и draft-диалог используют те же имена классов и не затрагиваются). */
      #tripFormPanel {
        box-sizing: content-box;
        max-width: 640px;
        padding: 12px 16px;
        background: white;
        color: var(--text);
        font-size: 13px;
      }
      @media (max-width: 760px) {
        #tripFormPanel { padding: 8px; }
      }
      #tripFormPanel .trip-form-title {
        margin: 1.33em 0;
        font-size: inherit;
        font-weight: bold;
      }
      #tripFormPanel .trip-form-title .trip-status-label {
        margin-left: 8px;
        font-weight: normal;
        font-size: 11px;
      }
      #tripFormPanel .trip-form-row {
        display: block;
        margin: 10px 0;
      }
      #tripFormPanel .trip-form-row > .trip-form-label {
        display: block;
        color: var(--accent);
        font-size: 11px;
        font-weight: normal;
        text-transform: uppercase;
        margin-bottom: 3px;
      }
      #tripFormPanel .trip-form-input {
        padding: 4px 6px;
        border: 1px solid var(--divider);
        border-radius: 6px;
        font: inherit;
        color: var(--text);
        background: #fff;
      }
      #tripFormPanel input.trip-form-input[type=text],
      #tripFormPanel input.trip-form-input[type=tel],
      #tripFormPanel input.trip-form-input[type=number],
      #tripFormPanel textarea.trip-form-input {
        width: 100%;
        box-sizing: border-box;
      }
      #tripFormPanel .trip-transport-column + .trip-transport-column {
        margin-top: 6px;
      }
      #tripFormPanel .trip-check {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
        color: var(--text);
        font-size: 13px;
        text-transform: none;
      }
      #tripFormPanel .trip-participant-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 0;
        border: 0;
        margin-bottom: 6px;
      }
      #tripFormPanel .trip-participant-name {
        flex: 1 1 100%;
        min-width: 0;
      }
      #tripFormPanel .trip-participant-date {
        width: auto;
        flex: 1 1 110px;
        min-width: 0;
      }
      #tripFormPanel .trip-participant-row .trip-btn {
        padding: 4px 8px;
      }
      #tripFormPanel .trip-btn {
        border: 1px solid var(--divider);
        background: #fff;
        border-radius: 8px;
        padding: 6px 12px;
        cursor: pointer;
        color: var(--text);
        font: inherit;
      }
      #tripFormPanel .trip-btn:hover { background: rgba(119, 0, 255, 0.06); }
      #tripFormPanel .trip-btn:disabled { opacity: 0.5; cursor: default; }
      #tripFormPanel .trip-btn-primary { background: var(--rt-blue); border-color: var(--rt-blue); color: #fff; }
      #tripFormPanel .trip-btn-primary:hover { background: #0077b3; }
      #tripFormPanel .trip-btn-confirm { background: #1565C0; border-color: #1565C0; color: #fff; }
      #tripFormPanel .trip-btn-confirm:hover { background: #0d47a1; }
      #tripFormPanel .trip-btn-danger { background: #fff; color: var(--sick-red); border-color: var(--sick-red); }
      #tripFormPanel .trip-btn-danger:hover { background: rgba(244, 67, 54, 0.08); }
      #tripFormPanel .trip-form-msg:empty,
      #tripFormPanel .trip-form-msg > span:empty { display: none; }
      #tripFormPanel .trip-form-error { margin: 4px 0; }
      #tripFormPanel .trip-panel-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      #tripFormPanel .trip-form-note { margin: 8px 0; }
      /* форма длиннее окна — прокрутка внутри панели (как у #tasksView) */
      #tripsListView:has(#tripFormPanel) {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
      }
      
      .trip-close {
        background: none;
        border: none;
        font-size: 1.5em;
        cursor: pointer;
        padding: 0;
        width: 30px;
        height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text);
      }
      
      .trip-form {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      
      .trip-form-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .trip-form-label {
        font-weight: bold;
        color: var(--text);
      }
      
      .trip-form-input {
        padding: 8px;
        border: 1px solid var(--divider);
        border-radius: 8px;
        font-size: 14px;
        color: var(--text);
        background: white;
      }
      
      .trip-form-input:focus {
        outline: none;
        border-color: var(--rt-purple);
      }
      
      .trip-form-error {
        color: var(--sick-red);
        font-size: 0.85em;
        margin-top: 4px;
      }
      
      .trip-participant-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border: 1px solid var(--divider);
        border-radius: 8px;
        margin-bottom: 8px;
      }
      
      .trip-participant-name {
        flex: 1;
      }
      
      .trip-participant-date {
        width: 120px;
      }
      
      .trip-actions {
        display: flex;
        gap: 8px;
        margin-top: 20px;
      }
      
      .trip-btn {
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
      }
      
      .trip-btn-primary {
        background: var(--rt-purple);
        color: white;
      }
      
      .trip-btn-secondary {
        background: rgba(119, 0, 255, 0.06);
        color: var(--text);
      }
      
      .trip-btn-danger {
        background: var(--sick-red);
        color: white;
      }

      /* V8-T2: «Подтвердить» — отдельная кнопка рядом с «На подтверждение» */
      .trip-btn-confirm {
        background: #1565C0;
        color: white;
      }

      /* V8-T2: подпись статуса (список и заголовок формы) */
      .trip-status-label {
        font-size: 0.8em;
        padding: 2px 8px;
        border-radius: 10px;
        white-space: nowrap;
        color: var(--text);
        border: 1px solid var(--divider);
      }
      .trip-status-label-confirmed {
        background: #1565C0;
        color: white;
        border-color: transparent;
      }
      .trip-status-label-forecast {
        background: rgba(33, 150, 243, 0.15);
      }
      .trip-form-note {
        color: var(--accent);
        font-size: 0.9em;
        margin: 4px 0 8px;
      }
      
      .trip-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      /* E5-1: вертикальный контейнер-ярлык pick-режима «Добавить сотрудника».
         Панель уезжает за левый край ПОЛНОСТЬЮ (translateX(-100%), left:0),
         поэтому ярлык живёт отдельно, fixed у левого края экрана (append в
         body), НЕ на кромке панели. Две кнопки столбиком, текст 0°. */
      .trip-pick-edge {
        position: fixed;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 56px;
        z-index: 1150;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 6px;
        box-sizing: border-box;
        background: #fff;
        border: 1px solid var(--divider);
        border-radius: 0 10px 10px 0;
        box-shadow: 4px 0 16px rgba(0, 0, 0, 0.18);
      }
      .trip-pick-edge-btn {
        display: block;
        width: 40px;
        height: 120px;
        padding: 8px 4px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .trip-pick-edge-btn-primary {
        background: var(--rt-purple);
        color: white;
      }
      .trip-pick-edge-btn-primary:hover {
        background: color-mix(in srgb, var(--rt-purple) 85%, black);
      }
      .trip-pick-edge-btn-secondary {
        background: rgba(119, 0, 255, 0.06);
        color: var(--text);
      }
      .trip-pick-edge-btn-secondary:hover {
        background: rgba(119, 0, 255, 0.12);
      }

      /* V8-T1 п.2: режим выбора дат участника в Матрице отпусков */
      .trip-datepick-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 24px;
        background: rgba(119, 0, 255, 0.08);
        border-bottom: 1px solid var(--divider);
        font-size: 13px;
        color: var(--text);
      }
      body.trip-datepick .matrix-table .day-cell-data { cursor: not-allowed; }
      body.trip-datepick .matrix-table tr.trip-datepick-row .day-cell-data { cursor: crosshair; }
      .matrix-table tr.trip-datepick-row .name-col {
        background: rgba(119, 0, 255, 0.18) !important;
        font-weight: 700;
      }
      .matrix-table .day-cell-data.trip-datepick-sel {
        background-color: rgba(119, 0, 255, 0.35) !important;
        background-image: none !important;
        outline: 2px solid var(--rt-purple);
        outline-offset: -2px;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Find matrix wrapper (parent of matrix-table)
   */
  function findMatrixWrapper() {
    if (_dom.matrixWrapper) return _dom.matrixWrapper;
    
    var matrixTable = document.getElementById('matrixTable');
    if (matrixTable) {
      _dom.matrixWrapper = matrixTable.closest('.matrix-wrapper') || matrixTable.parentElement;
    }
    
    return _dom.matrixWrapper;
  }

  /**
   * Setup UI components
   */
  function setupUI() {
    // Find or create elements
    _dom.panelTabs = document.getElementById('panelTabs') || createPanelTabs();
    _dom.tabMatrix = document.getElementById('tabMatrix');
    _dom.tabTrips = document.getElementById('tabTrips');
    _dom.tripsListView = document.getElementById('tripsListView') || createTripsListView();
    _dom.matrixWrapper = findMatrixWrapper();
    _dom.tripsList = document.getElementById('tripsList');
    _dom.newTripBtn = document.getElementById('newTripBtn');
    
    // Setup tab switching
    if (_dom.tabMatrix && _dom.tabTrips) {
      _dom.tabMatrix.addEventListener('click', function() { switchTab('matrix'); });
      _dom.tabTrips.addEventListener('click', function() { switchTab('trips'); });
    }
    
    // Setup new trip button
    if (_dom.newTripBtn) {
      _dom.newTripBtn.addEventListener('click', openNewTripModal);
    }
    
    // T5-DEFECT-6: Remove tab-glow listener, use updateTabGlow function instead
    // tab-glow effect is now handled by updateTabGlow()
  }

  /**
   * Create panel tabs
   */
  function createPanelTabs() {
    var tabs = document.createElement('div');
    tabs.id = 'panelTabs';
    tabs.className = 'panel-tabs';
    tabs.innerHTML = `
      <button type="button" class="panel-tab active" id="tabMatrix">Матрица отпусков</button>
      <button type="button" class="panel-tab" id="tabTrips">Командировки</button>
    `;
    return tabs;
  }

  /**
   * Create trips list view
   */
  function createTripsListView() {
    var container = document.createElement('div');
    container.id = 'tripsListView';
    container.style.display = 'none';
    container.innerHTML = `
      <h3>Командировки</h3>
      <button type="button" class="btn" id="newTripBtn">+ Новая командировка</button>
      <div id="tripsList"></div>
    `;
    return container;
  }

  /**
   * Create trip modal
   */
  function createTripModal() {
    if (_dom.tripModal) return _dom.tripModal;
    
    var modal = document.createElement('div');
    modal.className = 'trip-modal';
    modal.innerHTML = `
      <div class="trip-modal-content">
        <div class="trip-modal-header">
          <h2 class="trip-modal-title">Командировка</h2>
          <button class="trip-close" onclick="window.Trips.closeTripModal()">×</button>
        </div>
        <div class="trip-form" id="tripForm"></div>
      </div>
    `;
    var portalRoot = document.getElementById('tripModalRoot');
    if (portalRoot) {
      portalRoot.appendChild(modal);
    } else {
      document.body.appendChild(modal);
    }
    _dom.tripModal = modal;
    return modal;
  }

  /**
   * Switch between tabs
   */
  function switchTab(tab) {
    // V8-T1: уход с вкладки «Матрица отпусков» во время выбора дат = отмена выбора.
    if (_datePick && tab !== 'matrix') endDatePick(false);
    _currentTab = tab;
    
    if (_dom.tabMatrix && _dom.tabTrips) {
      _dom.tabMatrix.classList.toggle('active', tab === 'matrix');
      _dom.tabTrips.classList.toggle('active', tab === 'trips');
    }
    
    if (_dom.matrixWrapper && _dom.tripsListView) {
      _dom.matrixWrapper.style.display = tab === 'matrix' ? 'block' : 'none';
      _dom.tripsListView.style.display = tab === 'trips' ? 'block' : 'none';
    }
    
    // Toggle trips-tab-active class on vacation panel to hide/show legend
    var vacationPanel = document.querySelector('.vacation-panel');
    if (vacationPanel) {
      vacationPanel.classList.toggle('trips-tab-active', tab === 'trips');
    }
    
    if (tab === 'trips') {
      renderTripsList();
    }
  }

  /**
   * Render trips list
   */
  function renderTripsList() {
    // Err3 fix: innerHTML-замены tripsListView (форма в панели) отсоединяют
    // закэшированный _dom.tripsList — перепривязываем при каждом рендере.
    var liveList = document.getElementById('tripsList');
    if (liveList && _dom.tripsList !== liveList) {
      _dom.tripsList = liveList;
    }
    if (!_dom.tripsList) return;
    
    var trips = _state.trips;
    var user = getCurrentUser();
    
    // Hide new trip button for viewers
    if (_dom.newTripBtn && user && !user.canEdit) {
      _dom.newTripBtn.style.display = 'none';
    }
    
    if (trips.length === 0) {
      _dom.tripsList.innerHTML = '<p>Командировок нет</p>';
      return;
    }
    
    var html = '';
    trips.forEach(function(trip) {
      var statusIcon = trip.status === TRIP_STATUS.FORECAST ? '▧' : '■';
      var statusClass = 'status-' + trip.status;
      var statusLabel = tripStatusLabel(trip.status);
      
      var minDate = trip.participants.reduce(function(min, p) {
        return min ? Math.min(min, new Date(p.startDate).getTime()) : new Date(p.startDate).getTime();
      }, null);
      
      var maxDate = trip.participants.reduce(function(max, p) {
        return max ? Math.max(max, new Date(p.endDate).getTime()) : new Date(p.endDate).getTime();
      }, null);
      
      var dateRange = minDate && maxDate ? 
        formatDate(new Date(minDate)) + ' — ' + formatDate(new Date(maxDate)) : '';
      
      html += `
        <div class="trip-list-item" onclick="window.Trips.openTripModal('${trip.id}')">
          <div class="trip-header">
            <span class="trip-status ${statusClass}" title="${statusLabel}">${statusIcon}</span>
            <span class="trip-status-label trip-status-label-${trip.status}">${statusLabel}</span>
            <span class="trip-title">${escapeHtml(trip.title)}</span>
            <span class="trip-location">${escapeHtml(trip.location || '')}</span>
          </div>
          <div class="trip-dates">${dateRange}</div>
          <div class="trip-participants">${trip.participants.length} сотр.</div>
        </div>
      `;
    });
    
    _dom.tripsList.innerHTML = html;
  }

  /**
   * Open new trip modal
   */
  function openNewTripModal() {
    // Switch to trips tab
    switchTab('trips');
    
    // Render trip form in panel instead of modal
    renderTripFormInPanel(null);
  }

  /**
   * Render trip form in tripsListView panel
   */
  function renderTripFormInPanel(trip) {
    var tripsListView = document.getElementById('tripsListView');
    if (!tripsListView) return;

    var user = getCurrentUser();
    // Err3 fix: если сессия ещё не резолвилась (новая вкладка/страница),
    // подтянуть пользователя сейчас и перерендерить форму после — иначе
    // кнопки «Удалить»/«Подтвердить» пропадают из разметки (user=null).
    if (!user) {
      api('GET', 'api/session.php').then(function(response) {
        if (response.ok && response.data && response.data.authenticated) {
          _currentUser = response.data.user;
          renderTripFormInPanel(trip);
        }
      }).catch(function() { /* stay anonymous: viewer-like form */ });
      return;
    }
    var isEdit = trip && trip.id;
    // V8-T2: форма только для чтения — viewer; supervisor у подтверждённой и у прогноза
    // чужой зоны (сервер: confirmed_immutable / zone_forbidden). Права — как на сервере.
    var isViewer = !canEditTripForm(trip, user);
    var isConfirmedTrip = !!(isEdit && trip.status === TRIP_STATUS.CONFIRMED);
    var canConfirmBtn = !isViewer && !isConfirmedTrip && (isEdit ? canConfirmTrip(trip, user) : !!user.canEdit);
    var readOnlyNote = '';
    if (isViewer && user.canEdit && isEdit) {
      readOnlyNote = isConfirmedTrip
        ? 'Подтверждённую командировку может править только администратор.'
        : 'Командировка сотрудников другого отдела — только просмотр.';
    }

    // V8-T1: запомнить, что именно показано в форме (saveTrip берёт из него
    // прежние значения для полей, которых в разметке нет, и прежний телефон).
    _formTrip = trip || null;

    // V8-T1 п.5: у новой командировки (id нет — состав пришёл из Матрицы /
    // карточки сотрудника / createTripFromSelection) повтор сотрудника в
    // составе схлопывается с сообщением. Сохранённые командировки не трогаем.
    if (trip && !isEdit && trip.participants && trip.participants.length > 1) {
      var uniq = dedupeParticipants(trip.participants);
      if (uniq.duplicates.length > 0) {
        trip = Object.assign({}, trip, { participants: uniq.list });
        _formTrip = trip;
        notifyAlreadyInTrip(uniq.duplicates);
      }
    }

    // V8-T1 п.3: плечо «нужен билет» отражает данные записи независимо от роли;
    // select способа блокируется ТОЛЬКО для viewer или когда плечо не требуется.
    var outRequired = !trip || trip.transportOutRequired === 1 || trip.transportOutRequired === null || trip.transportOutRequired === undefined;
    var backRequired = !trip || trip.transportBackRequired === 1 || trip.transportBackRequired === null || trip.transportBackRequired === undefined;
    var phoneShown = trip && trip.phone ? displayPhone(trip.phone) : '';
    
    tripsListView.innerHTML = `
      <div id="tripFormPanel">
        <h4 class="trip-form-title">${isEdit ? 'Редактирование командировки' : 'Новая командировка'}${isEdit ? ' <span class="trip-status-label trip-status-label-' + trip.status + '" id="tripStatusBadge">' + tripStatusLabel(trip.status) + '</span>' : ''}</h4>
        ${readOnlyNote ? '<div class="trip-form-note" id="tripReadOnlyNote">' + readOnlyNote + '</div>' : ''}
        <div class="trip-form-fields">
            <div class="trip-form-row">
              <label class="trip-form-label">Название</label>
              <input type="text" class="trip-form-input" id="tripTitle" value="${trip ? escapeHtml(trip.title) : ''}" ${isViewer ? 'disabled' : ''}>
            </div>
            <div class="trip-form-row">
              <label class="trip-form-label">Место назначения</label>
              <input type="text" class="trip-form-input" id="tripLocation" value="${trip ? escapeHtml(trip.location || '') : ''}" placeholder="Город (обязательно для подтверждения)" ${isViewer ? 'disabled' : ''}>
            </div>
            <div class="trip-form-row">
              <label class="trip-form-label">Комментарий</label>
              <textarea class="trip-form-input" id="tripComment" rows="2" ${isViewer ? 'disabled' : ''}>${trip ? escapeHtml(trip.comment || '') : ''}</textarea>
            </div>
            <div class="trip-form-row">
              ${trip && trip.participants && trip.participants.length > 0 ? '<label class="trip-form-label">Участники</label>' : ''}
              <div id="tripParticipants">
                ${trip && trip.participants ? trip.participants.map(function(p, i) {
                  return renderParticipantRow(p, i, isViewer);
                }).join('') : ''}
              </div>
              <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.startEmployeePick()" ${isViewer ? 'disabled' : ''}>+ Добавить сотрудника</button>
            </div>
            <div class="trip-form-row">
              <label class="trip-form-label">Место отправления</label>
              <input type="text" class="trip-form-input" id="tripOrigin" value="${trip ? escapeHtml(trip.origin || '') : ''}" placeholder="Город/Аэропорт" ${isViewer ? 'disabled' : ''}>
            </div>
            <div class="trip-form-row">
              <label class="trip-form-label">Данные о гостинице</label>
              <textarea class="trip-form-input" id="tripHotel" rows="3" ${isViewer ? 'disabled' : ''}>${trip ? escapeHtml(trip.hotel || '') : ''}</textarea>
            </div>
            <div class="trip-form-row">
              <label class="trip-form-label">Бизнес-процесс (HelpMe)</label>
              <input type="text" class="trip-form-input" id="tripBusinessProcess" list="businessProcessList" value="${trip ? escapeHtml(trip.businessProcess || '') : ''}" placeholder="Начните вводить..." ${isViewer ? 'disabled' : ''}>
              <datalist id="businessProcessList">
                <option value="Проведение технических работ">
                <option value="Проверка систем">
                <option value="Консультации">
                <option value="Обучение">
                <option value="Встреча с клиентом">
              </datalist>
            </div>
            <div class="trip-form-row">
              <label class="trip-form-label">Телефон сотрудника</label>
              <input type="tel" class="trip-form-input" id="tripPhone" value="${escapeHtml(phoneShown)}" maxlength="32" placeholder="+7 (999) 000-00-00" oninput="window.Trips.maskPhoneField(this)" onfocus="window.Trips.phoneFieldFocus(this)" onblur="window.Trips.phoneFieldBlur(this)" ${isViewer ? 'disabled' : ''}>
            </div>
            <div class="trip-form-row">
              <label class="trip-form-label">Сумма аванса, руб.</label>
              <input type="number" class="trip-form-input" id="tripAdvanceAmount" min="0" step="1" value="${trip && trip.advanceAmount !== null ? trip.advanceAmount : ''}" placeholder="Не указано" ${isViewer ? 'disabled' : ''}>
            </div>
            <div class="trip-form-row trip-transport-block">
              <label class="trip-form-label">Транспорт (билеты)</label>
              <div class="trip-transport-columns">
                <div class="trip-transport-column">
                  <label class="trip-check">
                    <input type="checkbox" id="transportOutRequired" ${outRequired ? 'checked' : ''} ${isViewer ? 'disabled' : ''} onchange="window.Trips.toggleTransportSelect('transportOut')">
                    <span>Выезд нужен билет</span>
                  </label>
                  <select class="trip-form-input" id="transportOutMode" ${isViewer || !outRequired ? 'disabled' : ''}>
                    <option value="">Выберите способ</option>
                    <option value="avia" ${trip && trip.transportOutMode === 'avia' ? 'selected' : ''}>Авиа</option>
                    <option value="zd" ${trip && trip.transportOutMode === 'zd' ? 'selected' : ''}>ЖД</option>
                  </select>
                </div>
                <div class="trip-transport-column">
                  <label class="trip-check">
                    <input type="checkbox" id="transportBackRequired" ${backRequired ? 'checked' : ''} ${isViewer ? 'disabled' : ''} onchange="window.Trips.toggleTransportSelect('transportBack')">
                    <span>Возврат нужен билет</span>
                  </label>
                  <select class="trip-form-input" id="transportBackMode" ${isViewer || !backRequired ? 'disabled' : ''}>
                    <option value="">Выберите способ</option>
                    <option value="avia" ${trip && trip.transportBackMode === 'avia' ? 'selected' : ''}>Авиа</option>
                    <option value="zd" ${trip && trip.transportBackMode === 'zd' ? 'selected' : ''}>ЖД</option>
                  </select>
                </div>
              </div>
            </div>
        </div>
        <div class="trip-form-msg"><span id="tripConfirmMsg"></span></div>
        <div class="trip-panel-actions">
            ${/* V8-T2: статус меняется только кнопками. Прогноз/новая: «На подтверждение» (сохранить прогноз) и
                  «Подтвердить» (сохранить и подтвердить; не показывается тем, кому сервер откажет). Подтверждённая:
                  только «Сохранить» (статус и заявки не трогаются). Только чтение: заблокированная «Сохранить».
                  V8-T4: порядок кнопок как у задачи — главные слева, «Отмена» следом. */ ''}
            <button type="button" id="tripSaveBtn" class="trip-btn trip-btn-primary" onclick="window.Trips.saveTrip('${trip && trip.id ? trip.id : 'null'}')" ${isViewer ? 'disabled' : ''}>${isViewer || isConfirmedTrip ? 'Сохранить' : 'На подтверждение'}</button>
            ${canConfirmBtn ? `<button type="button" id="tripConfirmBtn" class="trip-btn trip-btn-confirm" onclick="window.Trips.saveAndConfirmTrip('${trip && trip.id ? trip.id : 'null'}')">Подтвердить</button>` : ''}
            <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.closeTripForm()">Отмена</button>
            ${/* Err6 fix: "Удалить" только при редактировании (trip.id); из матрицы приходит псевдо-trip без id */ trip && trip.id && user && canDeleteTrip(trip, user) ? `<button type="button" class="trip-btn trip-btn-danger" onclick="window.Trips.handleDeleteTripClick('${trip.id}')">Удалить</button>` : ''}
        </div>
      </div>
    `;
    updateConfirmButtonState();
  }

  /**
   * Close trip form in panel and show trips list
   */
  function closeTripForm() {
    // V8-T1: режим выбора дат в Матрице не должен пережить форму.
    if (_datePick) endDatePick(false);
    _formTrip = null;
    // V2-B fix (coordinator): mid-pick close must restore the panel first —
    // otherwise the panel stays slid off-screen with a dead edge button.
    if (window._employeePickActive) {
      try { endEmployeePick(); } catch (e) { console.warn(LOG_PREFIX, e); }
    }
    var tripsListView = document.getElementById('tripsListView');
    if (!tripsListView) return;

    // Err3 fix: во время показа формы каркас списка (#tripsList и кнопка
    // «+ Новая командировка») полностью заменён innerHTML-формой —
    // восстанавливаем исходную разметку списка перед рендером.
    if (!document.getElementById('tripsList')) {
      tripsListView.innerHTML = '<h3>Командировки</h3>' +
        '<button type="button" class="btn" id="newTripBtn">+ Новая командировка</button>' +
        '<div id="tripsList"></div>';
      var newBtn = tripsListView.querySelector('#newTripBtn');
      if (newBtn) {
        (function(btn){
          btn.addEventListener('click', function() {
            try { renderTripFormInPanel(null); } catch (e) { console.warn(LOG_PREFIX, e); }
          });
        })(newBtn);
      }
      _dom.newTripBtn = newBtn;
    }

    // Err3 fix: renderTripFormInPanel заменяет innerHTML tripsListView,
    // после чего закэшированный _dom.tripsList указывает на отсоединённый
    // узел и renderTripsList() молча пишет в никуда (список «не обновлялся»
    // после удаления/сохранения). Перепривязываем кэш к живому DOM.
    var liveList = document.getElementById('tripsList');
    if (liveList && _dom.tripsList !== liveList) {
      _dom.tripsList = liveList;
    }

    // Re-render the trips list
    renderTripsList();
  }

  /**
   * Open existing trip modal
   */
  function openTripModal(id, onRendered) {
    var trip = _state.trips.find(function(t) { return t.id === id; });
    if (!trip) return;

    // Switch to trips tab
    switchTab('trips');

    // Err3 fix: рендерить форму ТОЛЬКО после resolve сессии. Раньше форма
    // рендерилась сразу — getCurrentUser() возвращал null на свежей
    // странице, и кнопки «Удалить»/«Подтвердить» (гейт `trip && user &&`)
    // просто не попадали в разметку.
    var renderForm = function() {
      renderTripFormInPanel(trip);
      if (typeof onRendered === 'function') onRendered(trip);
    };
    if (getCurrentUser()) { renderForm(); return; }
    api('GET', 'api/session.php').then(function(response) {
      if (response.ok && response.data && response.data.authenticated) {
        _currentUser = response.data.user;
      }
      renderForm();
    }).catch(function() { renderForm(); });
  }

  /**
   * Show trip modal with trip data
   */
  function showTripModal(trip) {
    if (!_dom.tripModal) return;
    
    _dom.tripModal.style.display = 'block';
    
    var form = document.getElementById('tripForm');
    var user = getCurrentUser();
    var isViewer = user && !user.canEdit;
    
    if (trip) {
      var title = 'Редактирование командировки';
      var canConfirm = canConfirmTrip(trip, user) && trip.status === TRIP_STATUS.FORECAST;
      var canDelete = user && canDeleteTrip(trip, user);
      
      form.innerHTML = `
        <div class="trip-form-row">
          <label class="trip-form-label">Название</label>
          <input type="text" class="trip-form-input" id="tripTitle" value="${escapeHtml(trip.title)}" ${isViewer ? 'disabled' : ''}>
        </div>
        <div class="trip-form-row">
          <label class="trip-form-label">Место</label>
          <input type="text" class="trip-form-input" id="tripLocation" value="${escapeHtml(trip.location || '')}" ${isViewer ? 'disabled' : ''}>
        </div>
        <div class="trip-form-row">
          <label class="trip-form-label">Комментарий</label>
          <textarea class="trip-form-input" id="tripComment" rows="3" ${isViewer ? 'disabled' : ''}>${escapeHtml(trip.comment || '')}</textarea>
        </div>
        <div class="trip-form-row">
          <label class="trip-form-label">Участники</label>
          <div id="tripParticipants">
            ${trip.participants.map(function(p, i) {
              return renderParticipantRow(p, i, isViewer);
            }).join('')}
          </div>
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.startEmployeePick()">+ Добавить сотрудника</button>
        </div>
        <div class="trip-actions">
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.closeTripForm()">Отменить</button>
          <button type="button" class="trip-btn trip-btn-primary" onclick="window.Trips.saveTrip('${trip.id}')" ${isViewer ? 'disabled' : ''}>Сохранить</button>
          ${canDelete ? `<button type="button" class="trip-btn trip-btn-danger" onclick="window.Trips.handleDeleteTripClick('${trip.id}')">Удалить</button>` : ''}
        </div>
      `;
    } else {
      var title = 'Новая командировка';
      
      form.innerHTML = `
        <div class="trip-form-row">
          <label class="trip-form-label">Название</label>
          <input type="text" class="trip-form-input" id="tripTitle" placeholder="Название командировки">
        </div>
        <div class="trip-form-row">
          <label class="trip-form-label">Место</label>
          <input type="text" class="trip-form-input" id="tripLocation" placeholder="Место командировки">
        </div>
        <div class="trip-form-row">
          <label class="trip-form-label">Комментарий</label>
          <textarea class="trip-form-input" id="tripComment" rows="3" placeholder="Дополнительная информация"></textarea>
        </div>
        <div class="trip-form-row">
          <label class="trip-form-label">Участники</label>
          <div id="tripParticipants"></div>
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.startEmployeePick()">+ Добавить сотрудника</button>
        </div>
        <div class="trip-actions">
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.closeTripForm()">Отменить</button>
          <button type="button" class="trip-btn trip-btn-primary" onclick="window.Trips.saveTrip()">Сохранить</button>
        </div>
      `;
    }
  }

  /**
   * Render participant row
   */
  function renderParticipantRow(participant, index, isViewer) {
    var participantName = participant.employeeId ? (getEmployeeName(participant.employeeId) || participant.name || '') : (participant.name || '');
    
    return `
      <div class="trip-participant-row" data-emp-id="${participant.employeeId || ''}">
        <input type="text" class="trip-form-input trip-participant-name" value="${escapeHtml(participantName)}" ${isViewer ? 'disabled' : ''} placeholder="ФИО">
        <input type="date" class="trip-form-input trip-participant-date" value="${participant.startDate || ''}" ${isViewer ? 'disabled' : ''}>
        <input type="date" class="trip-form-input trip-participant-date" value="${participant.endDate || ''}" ${isViewer ? 'disabled' : ''}>
        <button type="button" class="trip-btn trip-btn-secondary" title="Выбрать даты в календаре" onclick="window.Trips.startCalendarPick(null, ${index})" ${isViewer ? 'disabled' : ''}>📅</button>
        <button type="button" class="trip-btn trip-btn-danger" onclick="window.Trips.removeParticipantRow(${index})" ${isViewer ? 'disabled' : ''}>×</button>
      </div>
    `;
  }

  /**
   * Collect current participant-row field values from the live DOM.
   */
  function collectParticipantRowData() {
    var participantsContainer = document.getElementById('tripParticipants');
    if (!participantsContainer) return [];
    var rows = participantsContainer.querySelectorAll('.trip-participant-row');
    return Array.prototype.map.call(rows, function(row) {
      var nameInput = row.querySelector('.trip-participant-name');
      return {
        name: nameInput.value,
        // Err2 fix: сохраняем employeeId — rerenderParticipantRows рендерит
        // ФИО именно по employeeId (renderParticipantRow). Без этого после
        // удаления одной строки остальные теряли ФИО (пустые поля).
        employeeId: row.getAttribute('data-emp-id') || null,
        startDate: row.querySelector('.trip-participant-date').value,
        endDate: row.querySelectorAll('.trip-participant-date')[1].value,
        disabled: nameInput.disabled
      };
    });
  }

  /**
   * Re-render all participant rows with fresh sequential indices. Previously
   * `addParticipantRow` used `innerHTML +=`, which rebuilt the container and
   * left stale onclick indices: after removing one row the remaining rows
   * shifted but their × handlers still targeted the old positions (removing
   * the WRONG row). Rebuilding from the collected values on every mutation
   * keeps DOM rows, indices and input values in lockstep.
   */
  function rerenderParticipantRows(rowData) {
    var participantsContainer = document.getElementById('tripParticipants');
    if (!participantsContainer) return;
    participantsContainer.innerHTML = rowData.map(function(data, i) {
      return renderParticipantRow(data, i, !!data.disabled);
    }).join('');
    // Err2 fix: лейбл «Участники» скрывается и при удалении последнего
    // участника, не только при первичном рендере формы.
    var rowsWrap = participantsContainer.closest('.trip-form-row');
    if (rowsWrap) {
      var label = rowsWrap.querySelector('.trip-form-label');
      if (label) label.style.display = rowData.length > 0 ? '' : 'none';
    }
    updateConfirmButtonState();
  }

  /**
   * Add participant row. Must read existing values FIRST — `innerHTML +=`
   * would rebuild all rows and destroy typed input values.
   */
  function addParticipantRow() {
    var rowData = collectParticipantRowData();
    rowData.push({ name: '', startDate: '', endDate: '', disabled: rowData.length > 0 ? rowData[0].disabled : false });
    rerenderParticipantRows(rowData);
  }

  /**
   * Toggle transport select disabled state based on checkbox
   * E12-3: transport block
   */
  function toggleTransportSelect(type) {
    var checkboxId = type === 'transportOut' ? 'transportOutRequired' : 'transportBackRequired';
    var selectId = type === 'transportOut' ? 'transportOutMode' : 'transportBackMode';
    var checkbox = document.getElementById(checkboxId);
    var select = document.getElementById(selectId);
    if (checkbox && select) {
      select.disabled = !checkbox.checked;
      if (!checkbox.checked) {
        select.value = '';
      }
    }
  }

  /**
   * V8-T1 п.4: национальная часть номера (до 10 цифр) из любого ввода.
   * Принимает 8XXXXXXXXXX, 7XXXXXXXXXX, +7XXXXXXXXXX, XXXXXXXXXX и уже
   * отформатированное «+7 (999) 123-45-67». Префикс «+7», который поле
   * ставит само, отбрасывается (иначе вставка поверх него давала бы «7…»).
   */
  function phoneNationalDigits(value) {
    var s = String(value == null ? '' : value);
    var digits = s.replace(/\D/g, '');
    if (/^\s*\+\s*7/.test(s)) digits = digits.slice(1);
    // 11 цифр с «8» или «7» впереди — внутренний префикс РФ, не часть номера.
    if (digits.length === 11 && (digits.charAt(0) === '8' || digits.charAt(0) === '7')) digits = digits.slice(1);
    return digits.slice(0, 10);
  }

  /** «+7 » + национальная часть по маске «+7 (999) 123-45-67» (прогрессивно). */
  function formatPhoneRu(national) {
    var d = String(national || '');
    var out = '+7 ';
    if (d.length > 0) out += '(' + d.slice(0, 3);
    if (d.length > 3) out += ') ' + d.slice(3, 6);
    if (d.length > 6) out += '-' + d.slice(6, 8);
    if (d.length > 8) out += '-' + d.slice(8, 10);
    return out;
  }

  /**
   * Национальная часть ТОЛЬКО для настоящего российского номера (10 цифр или 11 с
   * 7/8/+7 впереди); иначе null. Номера иного вида (иностранные, короткие) в
   * прежних записях не разбираются и показываются/сохраняются как хранятся.
   */
  function ruNationalStrict(stored) {
    var s = String(stored == null ? '' : stored);
    var digits = s.replace(/\D/g, '');
    if (/^\s*\+\s*7/.test(s)) return digits.length === 11 ? digits.slice(1) : null;
    if (digits.length === 11 && /^[78]/.test(digits)) return digits.slice(1);
    if (digits.length === 10) return digits;
    return null;
  }

  /** Телефон в виде для показа в поле: российский → единая маска, иначе как хранится. */
  function displayPhone(stored) {
    var national = ruNationalStrict(stored);
    return national ? formatPhoneRu(national) : String(stored == null ? '' : stored);
  }

  /** Канонический вид для сервера и робота: +7XXXXXXXXXX или null. */
  function canonicalPhone(value) {
    var d = phoneNationalDigits(value);
    return d.length === 10 ? '+7' + d : null;
  }

  /**
   * V8-T1 п.4: фокус на пустом поле телефона — ставим «+7 » (удалить нельзя:
   * maskPhoneField возвращает префикс при любом вводе).
   */
  function phoneFieldFocus(el) {
    if (!el || el.disabled) return;
    // Заполненное поле (в т.ч. прежний нестандартный номер) не трогаем: приведение
    // к маске — только при вводе, иначе простой клик по полю искажал бы старую запись.
    if (String(el.value || '').trim() !== '') return;
    el.value = '+7 ';
    var end = el.value.length;
    try { el.setSelectionRange(end, end); } catch (e) { /* type=tel: ок */ }
    maskPhoneField(el);
  }

  /** Уход с поля: один лишь префикс — это «пусто» (виден placeholder). */
  function phoneFieldBlur(el) {
    if (!el) return;
    if (String(el.value || '').replace(/\D/g, '') === '7' && phoneNationalDigits(el.value) === '') {
      el.value = '';
    }
  }

  /**
   * E12-3 / V8-T1 п.4: маска телефона.
   * - всегда «+7 » впереди, ввод приводится к «+7 (999) 123-45-67»;
   * - обязательное поле: меньше 10 цифр — подсветка и setCustomValidity.
   */
  function maskPhoneField(el) {
    var national = phoneNationalDigits(el.value);
    // Номер уже полный, а в конец дописали ещё цифру: лишнее игнорируем, а не
    // «сдвигаем» номер (иначе у номера на 8/7, напр. 8-800…, срабатывал бы
    // срез внутреннего префикса РФ).
    var prev = el.__tripPhoneNat;
    if (prev && prev.length === 10 && national !== prev && /^\s*\+\s*7/.test(el.value) &&
        el.value.replace(/\D/g, '').slice(1, 11) === prev) {
      national = prev;
    }
    el.__tripPhoneNat = national;
    var formatted = formatPhoneRu(national);
    if (el.value !== formatted) {
      el.value = formatted;
      var end = formatted.length;
      try { el.setSelectionRange(end, end); } catch (e) { /* type=tel: ок */ }
    }

    // E12-3: empty/short phone = not allowed (block submission with error)
    if (national.length < 10) {
      el.classList.add('trip-form-error');
      el.setCustomValidity('Телефон сотрудника: 10 цифр после +7');
      return;
    }
    
    el.classList.remove('trip-form-error');
    el.setCustomValidity('');
  }

  /**
   * E12-3: Advance amount validation helper
   * - Empty = correct (not specified)
   * - Integer >= 0, otherwise error
   */
  function validateAdvanceAmount(el) {
    var value = el.value.trim();
    
    // E12-3: empty advanceAmount = not specified
    if (value === '') {
      el.classList.remove('trip-form-error');
      el.setCustomValidity('');
      return;
    }
    
    var num = Number(value);
    
    // E12-3: non-integer/empty string = error
    if (!Number.isInteger(num) || num < 0) {
      el.classList.add('trip-form-error');
      el.setCustomValidity('Сумма аванса: целое число >= 0');
      return;
    }
    
    el.classList.remove('trip-form-error');
    el.setCustomValidity('');
  }

  /**
   * Remove participant row
   */
  function removeParticipantRow(index) {
    var participantsContainer = document.getElementById('tripParticipants');
    if (participantsContainer && participantsContainer.children[index]) {
      // Read remaining values first (the removed row's sibling values are
      // still intact in the live DOM), then drop the row and re-render with
      // fresh indices, so the remaining × handlers point at their own rows.
      var rowData = collectParticipantRowData();
      rowData.splice(index, 1);
      rerenderParticipantRows(rowData);
    }
  }

  /**
   * Close trip modal
   */
  function closeTripModal() {
    if (_dom.tripModal) {
      _dom.tripModal.style.display = 'none';
    }
  }

  // =====================
  // V8-T1: общие помощники формы (участники, ошибки, сообщения сервера)
  // =====================

  /** Id сотрудника без префикса «emp_»: в Матрице он числовой, на сервере — «emp_<n>». */
  function normEmpId(v) {
    return String(v == null ? '' : v).replace(/^emp_/, '');
  }

  /**
   * V8-T1 п.5: убрать повторы сотрудника из списка участников.
   * @return {{list: Array, duplicates: Array}} list — без повторов (порядок сохранён),
   *         duplicates — отброшенные повторные элементы.
   */
  function dedupeParticipants(participants) {
    var seen = {};
    var list = [];
    var duplicates = [];
    (participants || []).forEach(function(p) {
      var key = normEmpId(p && p.employeeId);
      if (key && seen[key]) {
        duplicates.push(p);
        return;
      }
      if (key) seen[key] = true;
      list.push(p);
    });
    return { list: list, duplicates: duplicates };
  }

  /** Сообщение «уже в командировке» (имена — из записи, иначе из Матрицы). */
  function notifyAlreadyInTrip(duplicates, toastType) {
    var names = [];
    (duplicates || []).forEach(function(d) {
      var n = (d && (d.name || d.fullName)) || getEmployeeName(d && d.employeeId) || '';
      if (n && names.indexOf(n) === -1) names.push(n);
    });
    var text = names.length === 1
      ? 'Сотрудник «' + names[0] + '» уже в командировке'
      : (names.length > 1 ? 'Уже в командировке: ' + names.join(', ') : 'Сотрудник уже в командировке');
    if (typeof window.showToast === 'function') {
      window.showToast(text, toastType || 'info');
    }
    return text;
  }

  /** Понятный текст по коду ошибки api/trips.php (в ответе может быть и свой message). */
  function tripErrorMessage(error) {
    var map = {
      duplicate_participant: 'Сотрудник уже в командировке',
      participants_required: 'Добавьте хотя бы одного участника',
      title_required: 'Название обязательно',
      missing_dates: 'Укажите даты командировки',
      invalid_date: 'Некорректная дата',
      date_range_invalid: 'Дата начала не может быть позже даты окончания',
      participant_not_found: 'Сотрудник не найден',
      zone_forbidden: 'Нельзя оформить командировку сотрудника другого отдела',
      advance_invalid: 'Сумма аванса: целое число >= 0',
      transport_mode_invalid: 'Способ проезда: Авиа или ЖД',
      confirmed_immutable: 'Подтверждённую командировку может править только администратор',
      // V8-T2: механика «прогноз → подтверждена»
      location_required: 'Укажите место назначения — без него командировку нельзя подтвердить',
      invalid_status_transition: 'Подтвердить можно только командировку-прогноз',
      invalid_status: 'Недопустимый статус командировки',
      not_found: 'Командировка не найдена (возможно, её уже удалили)'
    };
    var code = error && error.error;
    var text = (code && map[code]) || (error && error.message) || code || 'Неизвестная ошибка';
    if (code === 'duplicate_participant' && error.message) text = error.message;
    return text;
  }

  /**
   * Save trip (create or update)
   *
   * V8-T1 п.1: ни один выход не молчит — каждая ошибка валидации показывается
   * у поля (и тостом), а любое неожиданное исключение превращается в сообщение
   * (раньше ReferenceError/TypeError уходили только в консоль, и кнопка
   * «Сохранить» выглядела мёртвой).
   */
  var _saving = false;
  function saveTrip(id, mode) {
    // E6-T1 fix: строки 'undefined'/'null'/пустая — это «создание», а не
    // редактирование. Раньше saveTrip('undefined') проходил проверку truthy,
    // updateTrip бросал синхронное «Командировка не найдена» мимо .catch.
    if (id === 'null' || id === 'undefined' || id === '') id = null;
    // V8-T2: mode 'confirm' — «Подтвердить» (сохранить и подтвердить); иначе —
    // «На подтверждение» / «Сохранить» (статус не меняется, кроме создания прогноза).
    if (mode !== 'confirm') mode = 'save';
    // Повторный клик, пока предыдущий запрос не завершён, игнорируется: два POST
    // (дубль командировки) и два confirm невозможны.
    if (_saving) return;
    try {
      saveTripImpl(id, mode);
    } catch (e) {
      _saving = false;
      console.error(LOG_PREFIX, 'saveTrip failed:', e);
      showError(null, 'Не удалось сохранить: ' + (e && e.message ? e.message : e));
    }
  }

  /** V8-T2: «Подтвердить» — сохранить форму и подтвердить командировку. */
  function saveAndConfirmTrip(id) {
    saveTrip(id, 'confirm');
  }

  function formEl(id) { return document.getElementById(id); }
  /** Значение поля формы; если поля в форме нет — значение из записи формы (ctx). */
  function formVal(id, fallback) {
    var el = formEl(id);
    if (el) return String(el.value == null ? '' : el.value);
    return fallback == null ? '' : String(fallback);
  }

  function saveTripImpl(id, mode) {
    clearFormErrors();
    var ctx = _formTrip || {};

    // V8-T2: «Место назначения» и «Комментарий» есть в форме; если поля нет (форма
    // иного вида) — прежнее значение записи. Статуса в форме нет: статус меняется
    // только кнопками (создание = всегда прогноз; правка статус не передаёт —
    // сервер оставляет прежний; подтверждение — отдельным PUT ...&action=confirm).
    var title = formVal('tripTitle').trim();
    var location = formVal('tripLocation', ctx.location).trim();
    var comment = formVal('tripComment', ctx.comment).trim();

    if (!title) {
      showError('tripTitle', 'Название обязательно');
      return;
    }

    // V8-T2 п.7: «Подтвердить» без места назначения не отправляется (ни сохранение,
    // ни confirm) — ошибка у поля. «На подтверждение» место не требует.
    if (mode === 'confirm' && !location) {
      showError('tripLocation', 'Укажите место назначения — без него командировку нельзя подтвердить');
      return;
    }

    var participants = [];
    var participantRows = document.querySelectorAll('#tripParticipants .trip-participant-row');
    var hasMissingDates = false;
    var hasRowError = false;
    var seenEmployees = {};
    var duplicates = [];

    participantRows.forEach(function(row) {
      var nameInput = row.querySelector('.trip-participant-name');
      var dateInputs = row.querySelectorAll('.trip-participant-date');
      var name = nameInput.value.trim();
      var attrEmpId = row.getAttribute('data-emp-id');
      var startDate = dateInputs[0].value;
      var endDate = dateInputs[1].value;
      
      // E6-T1: пропустить строку можно только если она ПОЛНОСТЬЮ пуста —
      // нет ни имени, ни data-emp-id.
      if (!name && !attrEmpId) {
        return;
      }
      
      // E6-T1 fix: непустая строка без дат — ошибка валидации формы, а не
      // «молчаливый пропуск»: раньше такие строки выбрасывались, список
      // участников оставался пустым и пользователь получал неверное
      // «Добавьте хотя бы одного участника».
      if (!startDate || !endDate) {
        if (!hasMissingDates) showError(!startDate ? dateInputs[0] : dateInputs[1], 'Укажите даты командировки');
        hasMissingDates = true;
        return;
      }
      if (startDate > endDate) {
        showError(dateInputs[1], 'Дата начала не может быть позже даты окончания');
        hasRowError = true;
        return;
      }
      
      // E6-T1 fix: employeeId берём ПЕРВИЧНО из data-emp-id строки
      // (renderParticipantRow/syncPickedEmployeesToForm кладут туда готовый
      // id выбора). Нормализуем через resolveEmployeesList() к точному id
      // серверной записи — сравнение с norm() без префикса emp_, как в
      // confirmEmployeePick; сервер принимает только полные id 'emp_<n>'
      // (api/trips.php participant_not_found). window.employees хост не
      // выставляет (IIFE-замыкание index.html), поэтому старый путь
      // findEmployeeIdByName всегда давал null и строку отбрасывало с
      // «Сотрудник не найден». Поиск по имени — только fallback для строк
      // без data-emp-id.
      var employeeId = null;
      if (attrEmpId) {
        var wanted = normEmpId(attrEmpId);
        var employee = resolveEmployeesList().find(function(e) { return normEmpId(e.id) === wanted; });
        employeeId = employee ? employee.id : null;
      } else {
        employeeId = findEmployeeIdByName(name);
      }
      if (!employeeId) {
        showError(nameInput, 'Сотрудник не найден');
        hasRowError = true;
        return;
      }
      // Канонический формат id для API — 'emp_<n>' (та же нормализация, что
      // в selectTripForEmployee): __serverEmployees отдаёт legacy-числовые
      // id, а api/trips.php ищет участника по полному 'emp_<n>'.
      employeeId = /^emp_/.test(String(employeeId)) ? String(employeeId) : 'emp_' + employeeId;

      // V8-T1 п.5: один сотрудник — одна строка (сервер тоже отклонит дубль).
      if (seenEmployees[employeeId]) {
        duplicates.push({ employeeId: employeeId, name: name });
        showError(nameInput, 'Сотрудник «' + name + '» уже в командировке');
        hasRowError = true;
        return;
      }
      seenEmployees[employeeId] = true;
      
      participants.push({
        employeeId: employeeId,
        startDate: startDate,
        endDate: endDate
      });
    });
    
    // E6-T1 fix: даты обязательны — ровно это сообщение и никаких
    // запросов к серверу.
    if (hasMissingDates || hasRowError) {
      return;
    }
    
    // «Добавьте хотя бы одного участника» — когда в форме нет ни одной
    // заполненной строки (строк нет вообще или все полностью пусты).
    // V8-T1: раньше при пустых строках выход был молчаливым.
    if (participants.length === 0) {
      showError(formEl('tripParticipants'), 'Добавьте хотя бы одного участника');
      return;
    }
    
    // E12-3: validate RPA fields before building payload
    // Collect RPA field values first
    var origin = formVal('tripOrigin', ctx.origin).trim();
    var hotel = formVal('tripHotel', ctx.hotel).trim();
    var businessProcess = formVal('tripBusinessProcess', ctx.businessProcess).trim();
    var phoneRaw = formVal('tripPhone', ctx.phone).trim();
    var advanceAmount = formVal('tripAdvanceAmount', ctx.advanceAmount == null ? '' : ctx.advanceAmount).trim();
    
    // Phone validation: обязателен; на сервер уходит +7XXXXXXXXXX (V8-T1 п.4).
    // Раньше проверка читала несуществующую переменную phoneEl (ReferenceError
    // → сохранение обрывалось молча) и считала цифры регэкспом /[^\\d]/ (класс
    // «не обратный слэш и не буква d»), т.е. «цифр» всегда было 0.
    // Прежняя запись с нестандартным номером (не РФ): пока поле не менялось,
    // номер остаётся как был — сохранение из-за него не блокируется.
    var phone;
    if (ctx.id && ctx.phone && phoneRaw === displayPhone(ctx.phone)) {
      var legacyNational = ruNationalStrict(ctx.phone);
      if (legacyNational) phone = '+7' + legacyNational;
      else phone = phoneRaw.replace(/\D/g, '').length >= 10 ? String(ctx.phone) : null;
    } else {
      phone = canonicalPhone(phoneRaw);
    }
    if (!phone) {
      showError('tripPhone', 'Телефон сотрудника: введите 10 цифр после +7');
      return;
    }
    
    // AdvanceAmount validation: empty = allowed, else must be integer >= 0
    if (advanceAmount) {
      var num = Number(advanceAmount);
      if (!Number.isInteger(num) || num < 0) {
        showError('tripAdvanceAmount', 'Сумма аванса: целое число >= 0');
        return;
      }
    }
    
    // Transport validation: if checkbox checked, select must be filled
    var transportOutRequired = !!(formEl('transportOutRequired') || {}).checked;
    var transportOutMode = formVal('transportOutMode');
    if (transportOutRequired && !transportOutMode) {
      showError('transportOutMode', 'Выберите способ проезда «туда»');
      return;
    }
    var transportBackRequired = !!(formEl('transportBackRequired') || {}).checked;
    var transportBackMode = formVal('transportBackMode');
    if (transportBackRequired && !transportBackMode) {
      showError('transportBackMode', 'Выберите способ проезда «обратно»');
      return;
    }
    
    var payload = {
      title: title,
      location: location,
      comment: comment,
      participants: participants,
      // E12-3: RPA v1.2 (HelpMe) fields
      origin: origin || null,
      hotel: hotel || null,
      transportOutRequired: transportOutRequired ? 1 : 0,
      transportOutMode: transportOutMode || null,
      transportBackRequired: transportBackRequired ? 1 : 0,
      transportBackMode: transportBackMode || null,
      advanceAmount: advanceAmount !== '' ? advanceAmount : null,
      businessProcess: businessProcess || null,
      phone: phone
    };
    // V8-T2: статус в payload — только при создании (всегда прогноз); при правке не
    // передаётся (у подтверждённой остаётся подтверждённой, у прогноза — прогнозом;
    // прогноз → подтверждена только через confirmTrip()).
    if (!id) payload.status = TRIP_STATUS.FORECAST;
    
    // createTrip/updateTrip валидируют синхронно и бросают исключение —
    // ловим его здесь, а не теряем.
    var promise;
    _saving = true;
    try {
      promise = id ? updateTrip(id, payload) : createTrip(payload);
    } catch (e) {
      _saving = false;
      showError(null, e.message);
      return;
    }
    
    var wasNew = !id;
    var savedTrip = null;   // что уже лежит на сервере (после шага «сохранить»)
    promise
      .then(function(trip) {
        savedTrip = trip;
        if (mode !== 'confirm') return trip;
        // V8-T2: единый путь постановки заявок — PUT ?action=confirm после сохранения.
        return confirmTrip(trip.id).catch(function(err) {
          if (err && typeof err === 'object') err.confirmStage = true;
          throw err;
        });
      })
      .then(function(trip) {
        _saving = false;
        // Форма живёт в панели «Командировки», а не в модалке: закрыть её
        // и вернуть список (closeTripModal тут ничего не делал).
        closeTripForm();
        if (typeof window.showToast === 'function') {
          if (mode === 'confirm') window.showToast('Командировка подтверждена', 'success');
          else if (!wasNew) window.showToast('Командировка сохранена', 'success');
        }
        // «Заведена новая командировка» показывает createTrip (только после
        // ответа сервера). Матрица — перерисовать наложение командировок
        // (класс type-trip-forecast / type-trip-confirmed берётся из _state.trips,
        // который confirmTrip уже обновил — без перезагрузки страницы).
        try { overlay(); } catch (e) { console.warn(LOG_PREFIX, 'Overlay error:', e); }
      })
      .catch(function(error) {
        _saving = false;
        if (error && error.confirmStage && savedTrip) {
          // V8-T2: сохранение прошло, подтверждение — нет. Командировка остаётся
          // прогнозом; форму перерисовываем уже по сохранённой записи (иначе повторный
          // клик по новой форме создал бы вторую командировку), ошибка видна, подтвердить
          // можно позже.
          try { overlay(); } catch (e) { /* не критично */ }
          renderTripFormInPanel(savedTrip);
          showError(formEl('tripConfirmMsg'),
            'Командировка сохранена как прогноз, но не подтверждена: ' + (error.message || error));
          return;
        }
        showError(null, error.message);
      });
  }

  /**
   * Confirm trip
   */
  function handleConfirmTripClick(id) {
    if (!confirm('Подтвердить командировку?')) {
      return;
    }
    
    confirmTrip(id)
      .then(function(trip) {
        closeTripModal();
        if (_currentTab === 'trips') {
          renderTripsList();
        }
      })
      .catch(function(error) {
        showError(null, error.message);
      });
  }

  /**
   * Delete trip
   */
  function handleDeleteTripClick(id) {
    if (!confirm('Удалить командировку?')) {
      return;
    }

    // Err3 fix: deleteTrip кидает СИНХРОННОЕ исключение ('Командировка не
    // найдена'), когда id отсутствует в client-state (протухшая форма,
    // трип удалён в другой сессии и т.п.) — throw улетал мимо .catch
    // хендлера, клик «ничего не делал». Оборачиваем и лечим перезагрузкой.
    try {
      deleteTrip(id)
        .then(function() {
          closeTripForm();          // Err3: форма в панели, а не модалка
          if (_currentTab === 'trips') {
            renderTripsList();
          }
        })
        .catch(function(error) {
          if (/не найдена/.test(String(error && error.message))) {
            // Трип уже нет на сервере/в state — освежаем state, закрываем
            // протухшую форму и показываем список.
            loadTrips().then(function() {
              closeTripForm();
              renderTripsList();
              if (typeof window.showToast === 'function') {
                window.showToast('Командировка уже удалена — список обновлён', 'info');
              }
            });
            return;
          }
          showError(null, error.message);
        });
    } catch (e) {
      // Синхронный throw из deleteTrip (трип не в state).
      loadTrips().then(function() {
        closeTripForm();
        renderTripsList();
        if (typeof window.showToast === 'function') {
          window.showToast('Командировка не найдена — список обновлён', 'info');
        }
      });
    }
  }

  /**
   * Show error message
   *
   * V8-T1 п.1: `field` — id поля ИЛИ сам элемент (раньше элемент молча терялся:
   * getElementById(элемент) → null, и сообщение «у поля» не показывалось).
   * Сообщение выводится под полем (у строки участника — под строкой), поле
   * получает фокус; предыдущие сообщения формы снимаются перед новым сохранением
   * (clearFormErrors) и сами исчезают через 8 с. Дублируется тостом.
   */
  function showError(field, message) {
    var el = field && typeof field === 'object' ? field : (field ? document.getElementById(field) : null);
    if (el && el.parentNode) {
      var errorDiv = document.createElement('div');
      errorDiv.className = 'trip-form-error';
      errorDiv.setAttribute('data-trip-err', '1');
      errorDiv.setAttribute('role', 'alert');
      errorDiv.textContent = message;
      var row = el.closest ? el.closest('.trip-participant-row') : null;
      if (row && row.parentNode) {
        row.parentNode.insertBefore(errorDiv, row.nextSibling);
      } else {
        el.parentNode.appendChild(errorDiv);
      }
      setTimeout(function() {
        if (errorDiv.parentNode) errorDiv.parentNode.removeChild(errorDiv);
      }, 8000);
      try {
        if (typeof el.focus === 'function' && !el.disabled) el.focus();
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
      } catch (e) { /* не критично */ }
    }
    
    if (typeof window.showToast === 'function') {
      window.showToast(message, 'error');
    }
  }

  /** Снять прежние сообщения об ошибках формы (перед новой проверкой). */
  function clearFormErrors() {
    var olds = document.querySelectorAll('#tripFormPanel [data-trip-err]');
    Array.prototype.forEach.call(olds, function(n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
  }

  // T5-DEFECT-6: Update tab-glow effect based on selection count
  function updateTabGlow() {
    if (Trips.selection.count() > 0) {
      _dom.tabTrips.classList.add('tab-glow');
    } else {
      _dom.tabTrips.classList.remove('tab-glow');
    }
  }

  // =====================
  // EMPLOYEE TRIP BUTTON
  // =====================

  /**
   * Show trip selection modal
   */
  function showTripSelectionModal(trips, employeeId) {
    var modal = document.createElement('div');
    modal.className = 'trip-modal';
    modal.style.display = 'block';
    modal.innerHTML = `
      <div class="trip-modal-content">
        <div class="trip-modal-header">
          <h2>Выберите командировку</h2>
          <button class="trip-close" onclick="this.closest('.trip-modal').remove()">×</button>
        </div>
        <div style="margin-bottom: 20px;">Для сотрудника: ${getEmployeeName(employeeId)}</div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${trips.map(function(trip) {
            var minDate = trip.participants.reduce(function(min, p) {
              return min ? Math.min(min, new Date(p.startDate).getTime()) : new Date(p.startDate).getTime();
            }, null);
            
            var maxDate = trip.participants.reduce(function(max, p) {
              return max ? Math.max(max, new Date(p.endDate).getTime()) : new Date(p.endDate).getTime();
            }, null);
            
            var dateRange = minDate && maxDate ? 
              formatDate(new Date(minDate)) + ' — ' + formatDate(new Date(maxDate)) : '';
            
            return `
              <div class="trip-list-item" onclick="window.Trips.selectTripForEmployee('${trip.id}', '${employeeId}')">
                <div class="trip-header">
                  <span class="trip-status status-forecast">▧</span>
                  <span class="trip-title">${escapeHtml(trip.title)}</span>
                  <span class="trip-location">${escapeHtml(trip.location || '')}</span>
                </div>
                <div class="trip-dates">${dateRange}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
    var portalRoot = document.getElementById('tripModalRoot');
    if (portalRoot) {
      portalRoot.appendChild(modal);
    } else {
      document.body.appendChild(modal);
    }
  }

  /**
   * Select trip for employee
   */
  function selectTripForEmployee(tripId, employeeId) {
    var trip = _state.trips.find(function(t) { return t.id === tripId; });
    // Phase 7 fixes: (1) close THIS selection modal only — other .trip-modal
    // nodes (the edit modal just opened) must survive; (2) numeric ids from
    // the inline editor ('1') must be normalised to 'emp_1' for the API/DOM.
    var selModal = Array.prototype.slice.call(document.querySelectorAll('.trip-modal'))
      .find(function(m) { return m.textContent.indexOf('Выберите командировку') >= 0 && !m.querySelector('#tripForm'); });
    if (selModal) selModal.remove();

    if (trip) {
      var normEmpId = /^emp_/.test(String(employeeId)) ? String(employeeId) : 'emp_' + employeeId;
      var addRow = function() {
        var participantsContainer = document.getElementById('tripParticipants');
        if (!participantsContainer) return;
        var minDate = trip.participants.reduce(function(min, p) {
          return min ? Math.min(min, new Date(p.startDate).getTime()) : new Date(p.startDate).getTime();
        }, null);

        var maxDate = trip.participants.reduce(function(max, p) {
          return max ? Math.max(max, new Date(p.endDate).getTime()) : new Date(p.endDate).getTime();
        }, null);

        participantsContainer.innerHTML += renderParticipantRow({
          employeeId: normEmpId,
          startDate: minDate ? formatDate(new Date(minDate)) : '',
          endDate: maxDate ? formatDate(new Date(maxDate)) : ''
        }, participantsContainer.children.length, false);
      };

      // R3 (замечание 11): убрана setTimeout-гонка. Строка участника рендерится
      // ДЕТЕРМИНИРОВАННО после resolve сессии/рендера формы через onRendered.
      openTripModal(tripId, addRow);
    }
  }

  // =====================
  // UTILITIES
  // =====================

  /**
   * Escape HTML
   */
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format date as YYYY-MM-DD
   */
  function formatDate(date) {
    if (!date) return '';
    var d = new Date(date);
    var year = d.getFullYear();
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  /**
   * Get employee name by ID
   */
  function getEmployeeName(employeeId) {
    // Normalise both sides: the inline editor exposes numeric ids ('1'),
    // the server/API uses 'emp_1'. Accept either.
    var norm = function(v) { return String(v).replace(/^emp_/, ''); };
    var wanted = norm(employeeId);
    // 1) window.employees (host page may expose it in some builds)
    if (Array.isArray(window.employees)) {
      var employee = window.employees.find(function(e) { return norm(e.id) === wanted; });
      if (employee) return employee.name || employee.fullName || '';
    }
    // 2) DOM fallback: matrix rows carry data-emp="<numeric id>" and the
    // employee name in the first cell. Works in current builds where the
    // employees array lives in the host closure (not global).
    var cell = document.querySelector('.day-cell-data[data-emp="' + wanted + '"]');
    if (cell) {
      var row = cell.closest('tr');
      var label = row && (row.querySelector('.employee-name, .emp-name, td:first-child'));
      if (label) {
        var text = (label.textContent || '').trim();
        if (text) return text;
      }
    }
    return '';
  }

  /**
   * Find employee ID by name (fallback for rows without data-emp-id).
   *
   * E6-T1 fix: раньше читали только window.employees, который хост-страница
   * НЕ выставляет (employees — closure `let` в IIFE index.html), поэтому
   * функция всегда возвращала null и saveTrip отбрасывал строку с
   * «Сотрудник не найден». Теперь источник — resolveEmployeesList()
   * (server-mirror __serverEmployees → window.employees → DOM-матрица),
   * сравнение по name/fullName без регистра. window.employees оставлен
   * первым источником на случай, если хост вдруг выставит его.
   */
  function findEmployeeIdByName(name) {
    if (!name) return null;
    var wanted = String(name).trim().toLowerCase();
    var employees = resolveEmployeesList();
    var employee = employees.find(function(e) {
      var n = e.name || e.fullName || '';
      return String(n).trim().toLowerCase() === wanted;
    });
    return employee ? employee.id : null;
  }

  /**
   * Resolve the host page's employee records.
   *
   * js/trips.js runs in its own IIFE and cannot see the `employees` variable
   * (a closure `let` inside index.html's inline script — not a global). The
   * host page never assigns `window.employees`, so `employees` here would be
   * undefined (TypeError on `.find`). Prefer a global when the host exposes
   * one; otherwise fall back to the rendered matrix DOM, whose `.day-cell-data`
   * cells carry `data-emp="<numeric id>"` in the employee's row (same pattern
   * getEmployeeName uses).
   */
  function resolveEmployeesList() {
    // R4 (D4): host mirror with zone data (set by index.html from the server
    // response, see __serverEmployees). Prefer it over the DOM fallback so
    // canDeleteTrip/canConfirmTrip can resolve participant zones.
    if (Array.isArray(window.__serverEmployees)) return window.__serverEmployees;
    if (Array.isArray(window.employees)) return window.employees;
    var empById = {};
    document.querySelectorAll('.day-cell-data[data-emp]').forEach(function(cell) {
      var id = cell.getAttribute('data-emp');
      if (!id || empById[id]) return;
      var row = cell.closest('tr');
      var label = row && row.querySelector('.employee-name, .emp-name, td:first-child');
      var name = label ? (label.textContent || '').trim() : '';
      empById[id] = { id: id, name: name, dept: null, slot: 0 };
    });
    return Object.keys(empById).map(function(k) { return empById[k]; });
  }

  /**
   * Zone-string of an employee record. Records carry the zone either as
   * server-style 'g0'/'g1' (load.php employees[].groupId) or as the legacy
   * numeric dept (0/1) after serverToLegacy(). Normalise both to 'g<n>'
   * so a zone comparison never depends on the representation the host
   * happens to expose.
   */
  function employeeZone(emp) {
    if (!emp) return null;
    var raw = emp.groupId != null ? emp.groupId : emp.dept;
    if (raw === undefined || raw === null || raw === '') return null;
    var s = String(raw).trim();
    if (/^g\d+$/i.test(s)) return s.toLowerCase();
    var n = parseInt(s, 10);
    return (Number.isInteger(n) && String(n) === s) ? ('g' + n) : null;
  }

  /**
   * Check if user can delete trip (role AND zone, per ТЗ §6).
   * Admin: any trip. Supervisor: only own-zone forecast trips. Viewer: none.
   * The zone is resolved from the participant employees (employeeZone); when
   * no participant zone can be resolved we FAIL CLOSED (no delete button) —
   * the server enforces zone_forbidden anyway, so hiding the button is a UX
   * improvement, never a security boundary.
   */
  function canDeleteTrip(trip, user) {
    if (!user) return false;
    if (user.isAdmin) return true;

    if (trip.status === TRIP_STATUS.FORECAST && user.role === 'supervisor') {
      var scope = user.scopeGroupId;
      if (!scope) return false;
      var participants = (trip.participants || []).filter(function(p) { return p && p.employeeId; });
      if (participants.length === 0) return false;
      var scopeNorm = String(scope).toLowerCase();
      return participants.every(function(p) {
        var emp = resolveEmployeesList().find(function(e) { return normEmpId(e.id) === normEmpId(p.employeeId); });
        var zone = employeeZone(emp);
        return zone !== null && zone === scopeNorm;
      });
    }

    return false;
  }

  /**
   * Zone-aware confirm guard (ТЗ §6) — mirrors canDeleteTrip for admin vs
   * supervisor. Only used to decide whether to RENDER the «Подтвердить»
   * button; the server is the actual enforcement point.
   */
  function canConfirmTrip(trip, user) {
    if (!user) return false;
    if (user.isAdmin) return true;
    if (trip.status !== TRIP_STATUS.FORECAST) return false;
    if (user.role !== 'supervisor') return false;
    return canDeleteTrip(trip, user);
  }

  /**
   * V8-T2: можно ли править форму командировки (кнопки «На подтверждение»/«Сохранить»).
   * Зеркало сервера (api/trips.php, PUT): viewer — нет; admin — любую; supervisor —
   * только прогноз своей зоны (подтверждённая → confirmed_immutable, чужая зона →
   * zone_forbidden). Новая командировка (нет id) — любому, кто может править
   * (зону участников сервер проверяет при POST). Только для показа: решает сервер.
   */
  function canEditTripForm(trip, user) {
    if (!user || !user.canEdit) return false;
    if (user.isAdmin) return true;
    if (!trip || !trip.id) return true;
    return trip.status === TRIP_STATUS.FORECAST && canDeleteTrip(trip, user);
  }

  /**
   * V8-T2: кнопка «Подтвердить» скрыта, если сервер откажет: supervisor и среди
   * участников формы есть сотрудник не его зоны (или зона не определилась).
   * Вызывается при отрисовке формы и при каждой смене состава участников.
   */
  function updateConfirmButtonState() {
    var btn = document.getElementById('tripConfirmBtn');
    if (!btn) return;
    var user = getCurrentUser();
    if (!user || user.isAdmin) { btn.style.display = ''; return; }
    var scope = String(user.scopeGroupId || '').toLowerCase();
    var allOwn = !!scope;
    var emps = resolveEmployeesList();
    Array.prototype.forEach.call(document.querySelectorAll('#tripParticipants .trip-participant-row'), function(row) {
      var attr = row.getAttribute('data-emp-id');
      if (!attr) return;
      var emp = emps.find(function(e) { return normEmpId(e.id) === normEmpId(attr); });
      var zone = employeeZone(emp);
      if (zone === null || zone !== scope) allOwn = false;
    });
    btn.style.display = allOwn ? '' : 'none';
  }

  /**
   * Poll for changes
   */
  function pollForChanges() {
    if (_state.lastSyncId === 0) return;
    
    setTimeout(function() {
      api('GET', API_SYNC + '?afterId=' + _state.lastSyncId)
        .then(function(response) {
          if (response.ok && response.data) {
            if (response.data.tripsChanged || response.data.tripsDeleted) {
              syncDelta(response.data);
            }
          }
          pollForChanges(); // Continue polling
        })
        .catch(function(error) {
          console.error(LOG_PREFIX, 'Poll error:', error);
          setTimeout(pollForChanges, 20000); // Wait 20s on error
        });
    }, 20000); // Poll every 20 seconds
  }

  // =====================
  // EVENT LISTENERS
  // =====================

  function setupEventListeners() {
    injectStyles();
    setupUI();
  }

  // =====================
  // MATRIX INTEGRATION
  // =====================

  /**
   * Calendar day-of-year for "YYYY-MM-DD" (1 = Jan 1), matching the matrix
   * convention (dayOfYearToDate is its inverse). Avoids Date-timezone math
   * which shifts the result by one day (UTC parse vs local midnight).
   */
  function dateStrToDayOfYear(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    var cum = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var doy = 0;
    for (var i = 0; i < mo - 1; i++) doy += cum[i];
    return doy + d;
  }

  /**
   * Matrix overlay: render trips in the vacation matrix
   */
  function overlay(currentYear) {
    if (!currentYear) {
      // currentYear lives in the inline script's closure (not on window).
      // The authoritative displayed year is the #yearDisplay element.
      var yd = document.getElementById('yearDisplay');
      currentYear = yd ? parseInt(yd.textContent, 10) : new Date().getFullYear();
      if (isNaN(currentYear)) currentYear = new Date().getFullYear();
    }
    
    // Trips overlay: apply trip data to matrix cells
    var matrixBody = document.querySelector('#matrixBody');
    if (!matrixBody) return;

    // Get all trips overlapping the current year. NOTE: the API list response
    // carries dates only inside participants (no top-level startDate), and a
    // participant range may span a year boundary (e.g. Dec 28 -> Jan 5).
    var yearTrips = _state.trips.filter(function(trip) {
      var parts = trip.participants || [];
      for (var i = 0; i < parts.length; i++) {
        var s = new Date(parts[i].startDate).getFullYear();
        var e = new Date(parts[i].endDate).getFullYear();
        if (!isNaN(s) && !isNaN(e) && (s <= currentYear) && (e >= currentYear)) {
          return true;
        }
      }
      return false;
    });

    // Clear existing trip overlays
    matrixBody.querySelectorAll('.day-cell-data').forEach(function(cell) {
      var existingTripClasses = cell.classList.value.split(' ').filter(function(cls) {
        return cls.startsWith('type-trip-');
      });
      existingTripClasses.forEach(function(cls) {
        cell.classList.remove(cls);
      });
    });

    // Apply trip overlays to matrix cells
    yearTrips.forEach(function(trip) {
      trip.participants.forEach(function(participant) {
        var empId = participant.employeeId;
        // Matrix cells carry numeric employee ids (data-emp="1"), while the
        // API returns string ids ("emp_1"). Normalise to the numeric suffix.
        var domEmpId = String(empId).replace(/^emp_/, '');
        var startDate = new Date(participant.startDate);
        var endDate = new Date(participant.endDate);
        
        // Calculate day of year range, clamped to the displayed year so
        // year-spanning trips (Dec 28 -> Jan 5) render in both years.
        // dateStrToDayOfYear matches the matrix convention (no TZ shift).
        var startDay, endDay;
        if (startDate.getFullYear() < currentYear) {
          startDay = 1;
        } else {
          startDay = dateStrToDayOfYear(participant.startDate);
        }
        if (endDate.getFullYear() > currentYear) {
          var isLeap = (currentYear % 4 === 0 && currentYear % 100 !== 0) || currentYear % 400 === 0;
          endDay = isLeap ? 366 : 365;
        } else {
          endDay = dateStrToDayOfYear(participant.endDate);
        }
        if (startDay === null || endDay === null) return;
        
        // Find cells for this employee and date range
        var cells = matrixBody.querySelectorAll('.day-cell-data[data-emp="' + domEmpId + '"]');
        cells.forEach(function(cell) {
          var cellDay = parseInt(cell.dataset.day);
          if (cellDay >= startDay && cellDay <= endDay) {
            // Add trip overlay classes
            if (trip.status === TRIP_STATUS.CONFIRMED) {
              cell.classList.add('type-trip-confirmed');
            } else if (trip.status === TRIP_STATUS.FORECAST) {
              cell.classList.add('type-trip-forecast');
            }
          }
        });
      });
    });

    // Make cells clickable to open trip cards.
    // Sick days stay excluded (spec §4): ЭЛН has visual AND interaction
    // priority over the trip underneath — clicking a red cell keeps the
    // sick-day flow, not the trip modal.
    matrixBody.querySelectorAll('.day-cell-data.type-trip-confirmed:not(.type-sick), .day-cell-data.type-trip-forecast:not(.type-sick)').forEach(function(cell) {
      var empId = cell.dataset.emp;
      var day = parseInt(cell.dataset.day);
      // data-emp is numeric ("1"); participant.employeeId may be "emp_1".
      // Normalise for comparison (loose == also coerces, but be explicit).
      var normEmpId = String(empId).replace(/^emp_/, '');
      
      // Find trip containing this date for this employee. Compare via
      // day-of-year (same convention as painting) — Date-object comparison
      // mixes local midnight (new Date(y,0,d)) with UTC midnight (parsed
      // "YYYY-MM-DD") and off-by-one TZ shifts break the range check.
      var matchingTrip = yearTrips.find(function(trip) {
        return trip.participants.some(function(participant) {
          if (String(participant.employeeId).replace(/^emp_/, '') !== normEmpId) return false;
          var sy = parseInt(String(participant.startDate).substring(0, 4), 10);
          var ey = parseInt(String(participant.endDate).substring(0, 4), 10);
          var sd = (isNaN(sy) || sy < currentYear) ? 1 : dateStrToDayOfYear(participant.startDate);
          var ed = (isNaN(ey) || ey > currentYear) ? (dateStrToDayOfYear(currentYear + '-12-31')) : dateStrToDayOfYear(participant.endDate);
          return day >= sd && day <= ed;
        });
      });
      
      if (matchingTrip) {
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', function() {
          Trips.openTripModal(matchingTrip.id);
        });
      }
    });
  }

  // Public API
  window.Trips = {
    // Initialization
    init: init,
    autoInit: autoInit,
    
    // API methods
    loadTrips: loadTrips,
    createTrip: createTrip,
    updateTrip: updateTrip,
    confirmTrip: confirmTrip,
    deleteTrip: deleteTrip,
    syncDelta: syncDelta,
    
    // UI methods
    switchTab: switchTab,
    openTripModal: openTripModal,
    closeTripModal: closeTripModal,
    saveTrip: saveTrip,
    saveAndConfirmTrip: saveAndConfirmTrip,
    canEditTripForm: canEditTripForm,
    tripStatusLabel: tripStatusLabel,
    selectTripForEmployee: selectTripForEmployee,
    addParticipantRow: addParticipantRow,
    removeParticipantRow: removeParticipantRow,
    // V8-T1: обработчики разметки формы (oninput/onchange) — без экспорта
    // `window.Trips.maskPhoneField(this)` / `toggleTransportSelect(...)` падали TypeError'ом
    maskPhoneField: maskPhoneField,
    toggleTransportSelect: toggleTransportSelect,
    handleConfirmTripClick: handleConfirmTripClick,
    handleDeleteTripClick: handleDeleteTripClick,
    renderTripFormInPanel: renderTripFormInPanel,
    closeTripForm: closeTripForm,
    
    // Utilities
    getCurrentUser: getCurrentUser,
    canEdit: canEdit,
    isAdmin: isAdmin,
    isSupervisor: isSupervisor,
    canDeleteTrip: canDeleteTrip,
    canConfirmTrip: canConfirmTrip,
    employeeZone: employeeZone,
    
    // Matrix integration
    overlay: overlay,
    
    // V2-C Fix-4: helper to get selected employee IDs from matrix
    getSelectedEmployeeIds: function() {
      var selectedRows = document.querySelectorAll('.trip-row-selected');
      var empIds = [];
      selectedRows.forEach(function(row) {
        var nameCell = row.querySelector('.name-col[data-emp-id]');
        if (nameCell) {
          var empId = parseInt(nameCell.dataset.empId);
          if (!isNaN(empId)) {
            empIds.push(empId);
          }
        }
      });
      return empIds;
    },
    
    // V2-C Fix-4: helper to reset matrix selection (clear selected rows)
    resetMatrixSelection: function() {
      var selectedRows = document.querySelectorAll('.trip-row-selected');
      selectedRows.forEach(function(row) {
        row.classList.remove('trip-row-selected');
        row.classList.remove('trip-row-dimmed');
      });
      document.body.classList.remove('trip-rows-selected');
    },
    
    // Selection management - simple implementation for T5
    selection: {
      count: function() {
        return document.querySelectorAll('.trip-row-selected').length;
      },
      add: function(row) {
        if (row) {
          row.classList.add('trip-row-selected');
        }
        updateTabGlow();
      },
      remove: function(row) {
        if (row) {
          row.classList.remove('trip-row-selected');
        }
        updateTabGlow();
      },
      clear: function() {
        document.querySelectorAll('.trip-row-selected').forEach(function(row) {
          row.classList.remove('trip-row-selected');
        });
        updateTabGlow();
      }
    },
    
    // Draft operations
    openDraft: openDraft,
    createDraftFromSelection: createDraftFromSelection,
    startCalendarPick: startCalendarPick,
    cancelDatePick: cancelDatePick,
    // V8-T1: телефон и участники (используются разметкой формы и тестами)
    phoneFieldFocus: phoneFieldFocus,
    phoneFieldBlur: phoneFieldBlur,
    phoneNationalDigits: phoneNationalDigits,
    formatPhoneRu: formatPhoneRu,
    canonicalPhone: canonicalPhone,
    dedupeParticipants: dedupeParticipants,
    startEmployeePick: startEmployeePick,
    confirmEmployeePick: confirmEmployeePick,
    cancelEmployeePick: cancelEmployeePick,
    endEmployeePick: endEmployeePick
  };

  // Draft functions
  function openDraft(participants) {
    if (!participants || participants.length === 0) {
      console.warn('No participants provided for draft');
      return;
    }

    // Check for existing vacations at the selected dates
    var conflicts = [];
    participants.forEach(function(participant) {
      var empId = participant.employeeId;
      var startDate = new Date(participant.startDate);
      var endDate = new Date(participant.endDate);

      // D2: getDayVacationType is a host-page function (inline script of
      // index.html), not part of trips.js. If it is unavailable (page not
      // fully loaded, host changed, unit test), skip the conflict check with
      // a warning instead of throwing a TypeError and blocking the draft.
      if (typeof getDayVacationType !== 'function') {
        console.warn(LOG_PREFIX, 'getDayVacationType unavailable — skipping vacation-conflict check for', empId);
        return;
      }

      // D5: validate dates BEFORE iterating. `new Date('2026-13-40')` or
      // empty/undefined strings produce Invalid Date whose getFullYear etc.
      // return NaN; the day-of-year loop would then run forever or push
      // garbage into conflictDays. Invalid records are skipped (the server
      // re-validates on POST anyway).
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        console.warn(LOG_PREFIX, 'openDraft: skipping participant with invalid date range:', participant);
        return;
      }
      if (startDate.getTime() > endDate.getTime()) {
        console.warn(LOG_PREFIX, 'openDraft: skipping participant with startDate > endDate:', participant);
        return;
      }

      // Check for vacation entries during this period
      var hasConflict = false;
      var conflictDays = [];

      // Convert dates to day of year and check against vacation data
      for (var d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        var doy = Math.ceil((d - new Date(d.getFullYear(), 0, 1)) / (1000 * 60 * 60 * 24)) + 1;
        var vtype = getDayVacationType(empId, d.getFullYear(), doy);

        if (vtype && vtype !== 'work') {
          conflictDays.push(formatDateStr(d.getFullYear(), d.getMonth(), d.getDate()));
          hasConflict = true;
        }
      }
      
      if (hasConflict) {
        conflicts.push({
          employeeId: empId,
          employeeName: getEmployeeName(empId),
          conflicts: conflictDays
        });
      }
    });

    if (conflicts.length > 0) {
      // Show conflict dialog
      showTripConflictDialog(conflicts, participants);
    } else {
      // Open draft modal with no conflicts
      openDraftModal(participants);
    }
  }

  function showTripConflictDialog(conflicts, participants) {
    var conflictText = conflicts.map(function(c) {
      return c.employeeName + ': ' + c.conflicts.join(', ');
    }).join('\n');
    
    var modalContent = `
      <div style="max-width: 500px; padding: 20px;">
        <h3>Предупреждение: пересечение с отпуском/отгулом</h3>
        <p style="color: var(--sick-red); margin: 10px 0;">
          ФИО: ${conflicts.map(c => c.employeeName).join(', ')}
        </p>
        <p style="margin: 10px 0; color: var(--text);">
          Даты с конфликтами:
        </p>
        <div style="background: rgba(119,0,255,0.06); padding: 10px; border-radius: 8px; margin: 10px 0; color: var(--text);">
          ${conflictText}
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
          <button onclick="this.closest('.conflict-modal').remove(); Trips.selection.clear();" 
                  style="padding: 8px 16px; border: 1px solid var(--divider); background: white; cursor: pointer; border-radius: 8px; color: var(--text);">
            Отмена
          </button>
          <button onclick="this.closest('.conflict-modal').remove(); openDraftModal(${JSON.stringify(participants).replace(/"/g, '&quot;')});" 
                  style="padding: 8px 16px; background: var(--rt-purple); color: white; cursor: pointer; border-radius: 8px; border: none;">
            Создать командировку
          </button>
        </div>
      </div>
    `;
    
    var modal = document.createElement('div');
    modal.className = 'conflict-modal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center;';
    modal.innerHTML = modalContent;
    
    document.body.appendChild(modal);
  }

  function openDraftModal(participants) {
    // Create draft trip modal HTML
    var modalHtml = `
      <div class="trip-modal-overlay">
        <div class="trip-modal">
          <div class="trip-modal-header">
            <h3>Создать командировку</h3>
            <button class="trip-modal-close" onclick="this.closest('.trip-modal-overlay').remove()">×</button>
          </div>
          <div class="trip-modal-body">
            <div class="trip-form">
              <div class="trip-form-row">
                <label>Название:</label>
                <input type="text" id="draft-title" placeholder="Название командировки" style="width: 100%; padding: 8px; border: 1px solid var(--divider); border-radius: 8px; color: var(--text); background: white;">
              </div>
              <div class="trip-form-row">
                <label>Место:</label>
                <input type="text" id="draft-location" placeholder="Место командировки" style="width: 100%; padding: 8px; border: 1px solid var(--divider); border-radius: 8px; color: var(--text); background: white;">
              </div>
              <div class="trip-form-row">
                <label>Комментарий:</label>
                <textarea id="draft-comment" placeholder="Комментарий" style="width: 100%; padding: 8px; border: 1px solid var(--divider); border-radius: 8px; height: 80px; color: var(--text); background: white;"></textarea>
              </div>
              <div class="trip-form-row">
                <label>Участники:</label>
                <div style="max-height: 200px; overflow-y: auto; border: 1px solid var(--divider); border-radius: 8px; padding: 8px; color: var(--text);">
                  ${participants.map(p => `
                    <div style="padding: 4px 0;">
                      ${getEmployeeName(p.employeeId)}: ${formatDateStr(new Date(p.startDate).getFullYear(), new Date(p.startDate).getMonth(), new Date(p.startDate).getDate())} - 
                      ${formatDateStr(new Date(p.endDate).getFullYear(), new Date(p.endDate).getMonth(), new Date(p.endDate).getDate())}
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>
          <div class="trip-modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; padding: 16px;">
            <button class="trip-modal-btn-secondary" onclick="this.closest('.trip-modal-overlay').remove(); Trips.selection.clear();" style="padding: 8px 16px; border: 1px solid var(--divider); background: white; cursor: pointer; border-radius: 8px; color: var(--text);">Отмена</button>
            <button class="trip-modal-btn-primary" onclick="saveDraftTrip(${JSON.stringify(participants).replace(/"/g, '&quot;')});" style="padding: 8px 16px; border: none; background: var(--rt-purple); color: white; cursor: pointer; border-radius: 8px;">Создать</button>
          </div>
        </div>
      </div>
    `;
    
    var existingOverlay = document.querySelector('.trip-modal-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }
    
    var portalRoot = document.getElementById('tripModalRoot');
    if (portalRoot) {
      portalRoot.insertAdjacentHTML('beforeend', modalHtml);
    } else {
      document.body.insertAdjacentHTML('beforeend', modalHtml);
    }
    
    // Store participants for saving
    window.currentDraftParticipants = participants;
  }

  function saveDraftTrip(participants) {
    var title = document.getElementById('draft-title').value;
    var location = document.getElementById('draft-location').value;
    var comment = document.getElementById('draft-comment').value;
    // V8-T2: ручного выбора статуса нет — черновик всегда прогноз.
    var status = TRIP_STATUS.FORECAST;
    
    if (!title.trim()) {
      alert('Название командировки обязательно');
      return;
    }
    
    var draftTrip = {
      title: title,
      location: location || '',
      comment: comment || '',
      status: status,
      participants: participants,
      createdAt: new Date().toISOString()
    };
    
    // Save draft (in real implementation, this would send to server)
    console.log('Saving draft trip:', draftTrip);
    
    // Close modal and clear selection
    document.querySelector('.trip-modal-overlay').remove();
    Trips.selection.clear();
    
    // Show success message
    if (typeof window.showToast === 'function') {
      window.showToast('Черновик командировки создан', 'success');
    }
  }

  // V8-T1 п.2: выбор дат участника в Матрице отпусков.
  //
  // Кнопка 📅 в строке участника переключает панель на вкладку «Матрица отпусков»
  // (форма остаётся в DOM вкладки «Командировки», её поля не теряются), подсвечивает
  // строку нужного сотрудника и ждёт выбора: протяжка мышью по строке — период,
  // одиночный клик — один день. Результат подставляется в даты ЭТОГО участника, панель
  // возвращается на форму. Esc / «Отменить» / уход с вкладки — отмена без изменений.
  //
  // Обработчики ячеек матрицы принадлежат хост-странице (замыкание index.html:
  // handleCellMouseDown/MouseEnter/MouseUp/Click, глобального window.handleCellMouseUp
  // нет), поэтому перехват делается на document в фазе capture: пока режим включён,
  // события по ячейкам не доходят до хоста (меню «Отпуск/Командировка» не открывается)
  // и до наложения командировок (клик по ячейке чужой поездки).

  var _calendarPickCleanup = null;

  /** Год, показанный в Матрице (#yearDisplay; currentYear живёт в замыкании index.html). */
  function matrixYear() {
    var yd = document.getElementById('yearDisplay');
    var y = yd ? parseInt(yd.textContent, 10) : NaN;
    return isNaN(y) ? new Date().getFullYear() : y;
  }

  /** День года (1 = 1 января) → «YYYY-MM-DD» без часовых поясов. */
  function dayOfYearToDateStr(year, doy) {
    var d = new Date(Date.UTC(year, 0, doy));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  function datePickCell(target) {
    return target && target.closest ? target.closest('.day-cell-data') : null;
  }

  /** Погасить ближайший click по ячейке матрицы (см. onUp); сам снимается через 400 мс. */
  function swallowNextClick() {
    var off = function() { document.removeEventListener('click', swallow, true); };
    var swallow = function(e) {
      if (datePickCell(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      off();
    };
    document.addEventListener('click', swallow, true);
    setTimeout(off, 400);
  }

  function paintDatePick() {
    var dp = _datePick;
    if (!dp) return;
    // Матрица могла перерисоваться (смена года, синхронизация) — подсветку строки вернуть.
    var rowCell = document.querySelector('#matrixBody .day-cell-data[data-emp="' + dp.empKey + '"]');
    var rowTr = rowCell && rowCell.closest ? rowCell.closest('tr') : null;
    if (rowTr && rowTr !== dp.row) {
      if (dp.row && dp.row.classList) dp.row.classList.remove('trip-datepick-row');
      rowTr.classList.add('trip-datepick-row');
      dp.row = rowTr;
    }
    var painted = document.querySelectorAll('#matrixBody .day-cell-data.trip-datepick-sel');
    Array.prototype.forEach.call(painted, function(c) { c.classList.remove('trip-datepick-sel'); });
    if (dp.startDay == null) return;
    var lo = Math.min(dp.startDay, dp.endDay);
    var hi = Math.max(dp.startDay, dp.endDay);
    var cells = document.querySelectorAll('#matrixBody .day-cell-data[data-emp="' + dp.empKey + '"]');
    Array.prototype.forEach.call(cells, function(c) {
      var day = parseInt(c.getAttribute('data-day'), 10);
      if (day >= lo && day <= hi) c.classList.add('trip-datepick-sel');
    });
  }

  /**
   * Включить режим выбора дат для строки участника №index. false — режима нет
   * (строки/сотрудника/ячеек нет), причина показана сообщением.
   */
  function activateDatePick(index) {
    var rowEls = document.querySelectorAll('#tripParticipants .trip-participant-row');
    var rowEl = rowEls && rowEls[index];
    if (!rowEl) return false;

    var nameInput = rowEl.querySelector('.trip-participant-name');
    var name = nameInput ? String(nameInput.value || '').trim() : '';
    var empAttr = rowEl.getAttribute('data-emp-id') || '';
    if (!empAttr && name) empAttr = findEmployeeIdByName(name) || '';
    var empKey = normEmpId(empAttr);
    var warn = function(text) {
      if (typeof window.showToast === 'function') window.showToast(text, 'error');
      if (_calendarPickCleanup) _calendarPickCleanup();
      return false;
    };
    if (!empKey) return warn('Сначала выберите сотрудника в этой строке');

    var cells = document.querySelectorAll('#matrixBody .day-cell-data[data-emp="' + empKey + '"]');
    if (!cells || cells.length === 0) {
      return warn('Сотрудника' + (name ? ' «' + name + '»' : '') + ' нет в Матрице отпусков (проверьте фильтры и год)');
    }

    switchTab('matrix');

    var year = matrixYear();
    var dp = { rowIndex: index, empKey: empKey, name: name, year: year, startDay: null, endDay: null, dragging: false, handlers: null, bar: null };
    _datePick = dp;

    // Панель режима над Матрицей (внутри панели вкладок, чтобы не жить вне неё).
    var wrap = document.getElementById('matrixWrapper') || _dom.matrixWrapper;
    var bar = document.createElement('div');
    bar.id = 'tripDatePickBar';
    bar.className = 'trip-datepick-bar';
    bar.innerHTML = '<span class="trip-datepick-text">Выберите даты командировки: <b>' + escapeHtml(name || 'сотрудник') + '</b> — ' +
      'протяните мышью по его строке (клик — один день). Esc — отмена.</span>' +
      '<button type="button" class="trip-btn trip-btn-secondary">Отменить</button>';
    bar.querySelector('button').addEventListener('click', function() { cancelDatePick(); });
    if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(bar, wrap);
    dp.bar = bar;

    document.body.classList.add('trip-datepick');
    var tr = cells[0].closest ? cells[0].closest('tr') : null;
    if (tr) tr.classList.add('trip-datepick-row');
    dp.row = tr;
    dp.prevSuppress = Trips.suppressInfoPanel;
    Trips.suppressInfoPanel = function() { return true; };

    // Прокрутка к датам участника (начало его периода), иначе к сегодняшнему дню.
    var startAttr = String((rowEl.querySelectorAll('.trip-participant-date')[0] || {}).value || '');
    var focusDay = null;
    if (startAttr.indexOf(String(year)) === 0) focusDay = dateStrToDayOfYear(startAttr);
    if (!focusDay) {
      var now = new Date();
      if (now.getFullYear() === year) focusDay = dateStrToDayOfYear(formatDate(now));
    }
    var target = focusDay ? document.querySelector('#matrixBody .day-cell-data[data-emp="' + empKey + '"][data-day="' + focusDay + '"]') : null;
    if (wrap && (target || tr)) {
      var el = target || tr;
      var cr = el.getBoundingClientRect();
      var wr = wrap.getBoundingClientRect();
      wrap.scrollLeft += (cr.left - wr.left) - wrap.clientWidth / 2;
      wrap.scrollTop += (cr.top - wr.top) - wrap.clientHeight / 2;
    }

    var onDown = function(e) {
      if (!_datePick) return;
      var cell = datePickCell(e.target);
      if (!cell) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== undefined && e.button !== 0) return;
      if (String(cell.getAttribute('data-emp')) !== dp.empKey) {
        if (typeof window.showToast === 'function') {
          window.showToast('Выберите даты в строке сотрудника: ' + (dp.name || 'выбранного'), 'info');
        }
        return;
      }
      dp.startDay = dp.endDay = parseInt(cell.getAttribute('data-day'), 10);
      dp.dragging = true;
      paintDatePick();
    };
    var onOver = function(e) {
      if (!_datePick || !dp.dragging) return;
      var cell = datePickCell(e.target);
      if (!cell || String(cell.getAttribute('data-emp')) !== dp.empKey) return;
      dp.endDay = parseInt(cell.getAttribute('data-day'), 10);
      paintDatePick();
    };
    var onUp = function(e) {
      if (!_datePick || !dp.dragging) return;
      e.stopPropagation();
      dp.dragging = false;
      var cell = datePickCell(e.target);
      if (cell && String(cell.getAttribute('data-emp')) === dp.empKey) {
        dp.endDay = parseInt(cell.getAttribute('data-day'), 10);
      }
      // Одиночный клик: браузер пришлёт `click` по ячейке УЖЕ после mouseup, когда
      // режим снят, — без заслона он открыл бы меню дня хоста или карточку чужой
      // командировки. Гасим ближайший click (и снимаем заслон по таймеру).
      swallowNextClick();
      finishDatePick(Math.min(dp.startDay, dp.endDay), Math.max(dp.startDay, dp.endDay));
    };
    var onClick = function(e) {
      if (!_datePick) return;
      if (datePickCell(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    dp.handlers = { mousedown: onDown, mouseover: onOver, mouseup: onUp, click: onClick };
    Object.keys(dp.handlers).forEach(function(type) {
      document.addEventListener(type, dp.handlers[type], true);
    });
    return true;
  }

  /** Подставить выбранный период в строку участника и вернуться к форме. */
  function finishDatePick(lo, hi) {
    var dp = _datePick;
    if (!dp) return;
    var startStr = dayOfYearToDateStr(dp.year, lo);
    var endStr = dayOfYearToDateStr(dp.year, hi);
    endDatePick(true); // снять режим и вернуться на вкладку «Командировки»

    var rowEls = document.querySelectorAll('#tripParticipants .trip-participant-row');
    var rowEl = null;
    Array.prototype.forEach.call(rowEls, function(r, i) {
      if (!rowEl && normEmpId(r.getAttribute('data-emp-id')) === dp.empKey) rowEl = r;
    });
    if (!rowEl) rowEl = rowEls[dp.rowIndex];
    if (!rowEl) return;
    var dateInputs = rowEl.querySelectorAll('.trip-participant-date');
    dateInputs[0].value = startStr;
    dateInputs[1].value = endStr;
    Array.prototype.forEach.call(dateInputs, function(inp) {
      try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* не критично */ }
    });
    clearFormErrors();
    // Тоста нет: выбранные даты видны в полях строки, а тост ложится поверх
    // кнопки «Сохранить» (низ панели) и перехватывает по ней клик.
  }

  /**
   * Снять режим выбора дат. returnToForm — вернуться на вкладку «Командировки»
   * (при уходе с вкладки её переключает сам пользователь — false).
   */
  function endDatePick(returnToForm) {
    var dp = _datePick;
    if (dp) {
      _datePick = null;
      if (dp.handlers) {
        Object.keys(dp.handlers).forEach(function(type) {
          document.removeEventListener(type, dp.handlers[type], true);
        });
      }
      if (dp.bar && dp.bar.parentNode) dp.bar.parentNode.removeChild(dp.bar);
      if (dp.row && dp.row.classList) dp.row.classList.remove('trip-datepick-row');
      var painted = document.querySelectorAll('#matrixBody .day-cell-data.trip-datepick-sel');
      Array.prototype.forEach.call(painted, function(c) { c.classList.remove('trip-datepick-sel'); });
      if (document.body && document.body.classList) document.body.classList.remove('trip-datepick');
      Trips.suppressInfoPanel = dp.prevSuppress || function() { return false; };
    }
    if (_calendarPickCleanup) _calendarPickCleanup();
    if (dp && returnToForm) switchTab('trips');
  }

  /** Отмена выбора дат: форма возвращается как была. */
  function cancelDatePick() {
    if (_datePick) endDatePick(true);
    else if (_calendarPickCleanup) _calendarPickCleanup();
  }

  // T5-DEFECT-4: Calendar pick for trip dates (V8-T1: рабочая версия, см. блок выше)
  function startCalendarPick(tripId, participantIndex) {
    console.log(LOG_PREFIX, 'Starting calendar pick for trip:', tripId, participantIndex);

    // Повторный запуск (или запуск при незавершённом выборе) снимает прежний режим.
    if (_datePick) endDatePick(false);
    if (_calendarPickCleanup) _calendarPickCleanup();

    // Контекст выбора (его читают тесты гигиены R4 и внешние наблюдатели).
    window._calendarPickContext = {
      tripId: tripId || (_formTrip && _formTrip.id) || null,
      participantIndex: participantIndex
    };

    // D3: never leak the patch — capture the original and restore it on every
    // completion path (picked a range OR cancelled). window.handleCellMouseUp в
    // сборке хоста НЕ глобальный (замыкание), для хостов, где он выставлен,
    // обёртка только пропускает вызов к оригиналу.
    var origHandleCellMouseUp = window.handleCellMouseUp;
    var restoreCellMouseUp = function() {
      if (origHandleCellMouseUp) {
        window.handleCellMouseUp = origHandleCellMouseUp;
      } else {
        delete window.handleCellMouseUp;
      }
    };
    window.handleCellMouseUp = function(event) {
      if (origHandleCellMouseUp) {
        return origHandleCellMouseUp(event);
      }
    };

    // D3: Escape cancels pick mode AND restores the original handler, so the
    // calendar mode never survives after the user backs out.
    var escHandler = function(e) {
      if (e.key === 'Escape' && window._calendarPickContext) {
        console.log(LOG_PREFIX, 'Calendar pick cancelled (ESC)');
        cancelDatePick();
      }
    };
    document.addEventListener('keydown', escHandler, true);

    _calendarPickCleanup = function() {
      _calendarPickCleanup = null;
      window._calendarPickContext = null;
      restoreCellMouseUp();
      document.removeEventListener('keydown', escHandler, true);
    };

    // Сам выбор — в Матрице отпусков (если есть форма и строка участника).
    var active = activateDatePick(participantIndex);
    console.log(LOG_PREFIX, active ? 'Calendar pick mode activated. Press ESC to cancel.' : 'Calendar pick: no participant row to pick for');
    return active;
  }

  // R3 (замечание 10): Employee pick — панель уезжает, сотрудники выбираются
    // Ctrl+кликом ПО КАРТОЧКАМ на странице. Dock-список с чекбоксами УДАЛЁН.
    function startEmployeePick(draft) {
      console.log(LOG_PREFIX, 'Starting employee pick for draft:', draft);

      // Store draft context and suppress info panel (клик по карточке НЕ
      // открывает «Карточку сотрудника» — см. guard в openMatrixEmployeeCard).
      window._employeePickContext = draft || null;
      if (window._employeePickContext && !window._employeePickContext.participants) {
        window._employeePickContext.participants = [];
      }
      Trips.suppressInfoPanel = function() { return true; };
      window._employeePickActive = true;

      // E5-1: панель уезжает за левый край ПОЛНОСТЬЮ — только классом. Панель
      // ОСТАЁТСЯ position:fixed (никаких sticky): layout страницы не
      // пересчитывается, основное поле не сдвигается.
      var vacationPanel = document.querySelector('.vacation-panel');
      if (vacationPanel) {
        vacationPanel.classList.add('trip-panel-slided');
      }

      // E5-1: вертикальный контейнер-ярлык у левого края экрана
      // (position:fixed, append в body — НЕ внутрь панели, панель полностью
      // уехала). Две кнопки столбиком, текст горизонтальный (0°):
      // «Подтвердить» → confirmEmployeePick(), «Отменить» → cancelEmployeePick().
      var existingEdge = document.querySelector('.trip-pick-edge');
      if (existingEdge) existingEdge.remove();
      var edge = document.createElement('div');
      edge.className = 'trip-pick-edge';

      var btnConfirm = document.createElement('button');
      btnConfirm.type = 'button';
      btnConfirm.className = 'trip-pick-edge-btn trip-pick-edge-btn-primary';
      btnConfirm.textContent = 'Подтвердить';
      btnConfirm.addEventListener('click', function() {
        confirmEmployeePick();
      });

      var btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.className = 'trip-pick-edge-btn trip-pick-edge-btn-secondary';
      btnCancel.textContent = 'Отменить';
      btnCancel.addEventListener('click', function() {
        cancelEmployeePick();
      });

      edge.appendChild(btnConfirm);
      edge.appendChild(btnCancel);
      document.body.appendChild(edge);

      // E5-2: клики по карточкам сотрудников на странице в пик-режиме.
      // Листенер вешается на document (capture), чтобы перехватывать клик по
      // .employee ДО того, как host-обработчик откроет карточку. ЛЮБОЙ клик
      // по карточке (с Ctrl и без) перехватывается: preventDefault +
      // stopPropagation — «Карточка сотрудника» НЕ выезжает. Обычный клик =
      // одиночный выбор (замещает прежний), Ctrl/Cmd+клик = toggle
      // (мультивыбор). Используем ТОЛЬКО штатный класс .employee.selected —
      // новых подсветок нет.
      var clickHandler = function(event) {
        if (!window._employeePickActive) return;
        var card = event.target && event.target.closest ? event.target.closest('.employee') : null;
        if (!card) return;
        // Не перехватываем клики по элементам управления внутри карточки.
        if (event.target.closest('button, input, a')) return;
        var empId = card.getAttribute('data-id');
        if (!empId) return;

        // E5-2: любой клик по карточке в пик-режиме не доходит до
        // host-обработчика карточки.
        event.preventDefault();
        event.stopPropagation();

        if (event.ctrlKey || event.metaKey) {
          // Ctrl/Cmd+клик — добавить к выбору (или снять, если уже выбрана).
          toggleEmployeePickSelection(card, empId);
        } else {
          // Обычный клик — выбрать эту карточку, прежний выбор сбросить.
          selectSingleEmployeePick(card, empId);
        }
      };
      document.addEventListener('click', clickHandler, true);
      window._employeePickClickHandler = clickHandler;

      console.log(LOG_PREFIX, 'Employee pick active — Ctrl+click employee cards on the page');
    }

    // Dock-list функции больше не используются (dock удалён), но остаются
    // экспортированными для обратной совместимости (R1 Fix-2 экспортировал их;
    // R4 harness не вызывает их). populateEmployeePickList больше не нужен.
    function populateEmployeePickList() {
      // no-op: dock-list удалён в R3, список заменён выбором по карточкам.
    }

    /**
     * Toggle an employee card's pick state. `card` is the .employee DOM node,
     * `empId` — its data-id (string/number). Uses ONLY the standard .employee.selected
     * highlight (same as normal multi-select on the page) — no new highlight style.
     */
    function toggleEmployeePickSelection(card, empId) {
      if (!card) return;
      var normId = String(empId == null ? (card.getAttribute('data-id') || '') : empId).replace(/^emp_/, '');
      if (!normId) return;

      if (!window.Trips.pickedEmployees) {
        window.Trips.pickedEmployees = new Set();
      }

      // Normalise key to bare id ('1'), but keep the DOM card keyed the same way.
      if (window.Trips.pickedEmployees.has(normId)) {
        window.Trips.pickedEmployees.delete(normId);
        card.classList.remove('selected');
      } else {
        window.Trips.pickedEmployees.add(normId);
        card.classList.add('selected');
      }

      console.log(LOG_PREFIX, 'Employee selection toggled:', normId, 'selected:', window.Trips.pickedEmployees.has(normId));
    }

    /**
     * E5-2: одиночный выбор обычным кликом в пик-режиме. Прежний выбор
     * сбрасывается (штатная подсветка .selected снимается у всех карточек из
     * набора pickedEmployees), затем выбирается только эта карточка.
     */
    function selectSingleEmployeePick(card, empId) {
      var normId = String(empId == null ? (card.getAttribute('data-id') || '') : empId).replace(/^emp_/, '');
      if (!normId) return;

      if (!window.Trips.pickedEmployees) {
        window.Trips.pickedEmployees = new Set();
      }

      clearEmployeePickHighlights();

      window.Trips.pickedEmployees.add(normId);
      card.classList.add('selected');

      console.log(LOG_PREFIX, 'Employee selected (single):', normId, 'picked:', Array.from(window.Trips.pickedEmployees).join(','));
    }

    /**
     * E5-2: снять штатную подсветку .selected у всех карточек, входящих в
     * текущий набор pickedEmployees, и очистить набор.
     */
    function clearEmployeePickHighlights() {
      // E5 G2 fix (координатор, микрофикс по политике E10): снимаем подсветку
      // со ВСЕХ выбранных карточек, а не только входящих в текущий набор.
      // Иначе после confirmEmployeePick (подсветка остаётся, набор зануляется)
      // и повторного пика «осиротевшие» подсветки переживают cancel —
      // ТЗ E5-2: «снять .selected со всех выбранных карточек».
      document.querySelectorAll('.employee.selected').forEach(function(el) {
        el.classList.remove('selected');
      });
      if (window.Trips.pickedEmployees) {
        window.Trips.pickedEmployees.clear();
      }
    }

    /**
     * E5-2: кнопка «Отменить» — сбросить выбор (подсветка + набор) и вернуть
     * панель БЕЗ добавления участников.
     */
    function cancelEmployeePick() {
      clearEmployeePickHighlights();
      console.log(LOG_PREFIX, 'Employee pick cancelled — selection cleared');
      endEmployeePick();
    }

    function positionEmployeePickDock() {
      // no-op: dock удалён в R3; панель уезжает, кромка с кнопкой остаётся.
    }

    function endEmployeePick() {
      // Restore normal state
      Trips.suppressInfoPanel = function() { return false; };
      window._employeePickActive = false;
      window._employeePickConfirmMode = false; // Reset confirm mode

      var vacationPanel = document.querySelector('.vacation-panel');
      // D7: panel may be gone (logout race / panel closed during pick). Guard
      // before touching classList to avoid a TypeError on null.
      if (vacationPanel) {
        vacationPanel.classList.remove('trip-panel-slided');
        vacationPanel.style.position = '';
      }

      var edge = document.querySelector('.trip-pick-edge');
      if (edge) {
        edge.remove();
      }

      var clickHandler = window._employeePickClickHandler;
      if (clickHandler) {
        document.removeEventListener('click', clickHandler, true);
        window._employeePickClickHandler = null;
      }

      window._employeePickContext = null;
      window.Trips.pickedEmployees = null;

      console.log(LOG_PREFIX, 'Employee pick ended');
    }

    function confirmEmployeePick() {
      if (!window.Trips.pickedEmployees || window.Trips.pickedEmployees.size === 0) {
        alert('Выберите хотя бы одного сотрудника');
        return;
      }

      var selectedEmployees = Array.from(window.Trips.pickedEmployees);
      var draft = window._employeePickContext;

      // Resolve records through the same path other pickers use. Employee ids are
      // strings like 'emp_1' (server) or numbers (host closure); normalise both.
      var norm = function(v) { return String(v).replace(/^emp_/, ''); };
      var employees = resolveEmployeesList();

      if (draft && draft.participants) {
        // V8-T1 п.5: в черновик от карточки сотрудника уже положен сам
        // сотрудник — повторный выбор того же человека не добавляет вторую строку.
        var inDraft = {};
        draft.participants.forEach(function(p) { inDraft[norm(p.employeeId)] = true; });
        var draftDuplicates = [];
        selectedEmployees.forEach(function(empId) {
          var wanted = norm(empId);
          var employee = employees.find(function(e) { return norm(e.id) === wanted; });
          if (employee) {
            if (inDraft[norm(employee.id)]) {
              draftDuplicates.push({ employeeId: employee.id, name: employee.name || employee.fullName || '' });
              return;
            }
            inDraft[norm(employee.id)] = true;
            draft.participants.push({
              employeeId: employee.id,
              name: employee.name || employee.fullName || '',
              startDate: '', // Empty date as per П13 requirement
              endDate: ''     // Empty date as per П13 requirement
            });
          }
        });
        if (draftDuplicates.length > 0) notifyAlreadyInTrip(draftDuplicates);

        console.log(LOG_PREFIX, 'Employees added to draft:', selectedEmployees);
      }

      // Set confirm mode for toggle behavior
      window._employeePickConfirmMode = true;

      // E5 G2 fix (координатор): пик завершён — подсветки выбора больше не
      // нужны (участники видны в строках формы), снимаем их ДО endEmployeePick,
      // пока набор ещё жив. Иначе подсвеченные карточки «зависают» до
      // следующего пика.
      clearEmployeePickHighlights();

      // Err4 fix: по ТЗ один клик по edge-кнопке «✓ Добавить сотрудников»
      // должен и добавить участников, и вернуть панель в полный режим —
      // не оставлять её уехавшей с кнопкой «← Вернуть».
      endEmployeePick();

      // E10-5 fix (2026-09-28, координатор): если пик пришёл из карточки
      // сотрудника (draft), форма командировки ещё НЕ открыта — открыть её
      // в панели «Командировки» с выбранными участниками. Раньше
      // syncPickedEmployeesToForm молча выходил по (!container), и после
      // «Подтвердить» не происходило ничего — ощущалось как «кнопка
      // Командировка не реагирует».
      var formContainer = document.getElementById('tripParticipants');
      if (!formContainer && draft && draft.participants && draft.participants.length > 0) {
        switchTab('trips');
        renderTripFormInPanel({ participants: draft.participants });
        formContainer = document.getElementById('tripParticipants');
      }

      // Sync the picked employees into the trip form's participant rows (R2 form).
      // Если участники пришли через черновик (форма только что открыта из него),
      // сообщение о повторах уже показано выше — второй раз не повторяем.
      syncPickedEmployeesToForm(selectedEmployees, !!(draft && draft.participants));
    }

    /**
     * R3 (замечание 10/5): после подтверждения выбранные сотрудники появляются
     * строками в форме командировки (общий #tripParticipants у реальной формы
     * нового/редактируемого трипа; R2 in-panel форма — report-only, см. отчёт).
     */
    function syncPickedEmployeesToForm(selectedEmployees, silent) {
      var container = document.getElementById('tripParticipants');
      if (!container) return;
      var norm = normEmpId;
      var employees = resolveEmployeesList();
      var rowData = collectParticipantRowData();
      var existing = new Set();
      rowData = rowData.map(function(r) {
        // V8-T1 п.5: строка с data-emp-id учитывается по нему (раньше — только по
        // совпадению ФИО, и две строки одного сотрудника не распознавались).
        if (r.employeeId) {
          existing.add(norm(r.employeeId));
          return r;
        }
        // Resolve real id for name-only rows (from collect). renderParticipantRow
        // derives the name from employeeId, so tag it back on to survive re-render.
        var emp = employees.find(function(e) { return e.name === r.name; });
        if (emp) {
          r.employeeId = emp.id;
          existing.add(norm(emp.id));
        }
        return r;
      });

      var duplicates = [];
      selectedEmployees.forEach(function(empId) {
        var wanted = norm(empId);
        var employee = employees.find(function(e) { return norm(e.id) === wanted; });
        if (!employee) return;
        if (existing.has(wanted)) { // уже есть строка — вторую не создаём
          duplicates.push({ employeeId: employee.id, name: employee.name || employee.fullName || '' });
          return;
        }
        existing.add(wanted);
        rowData.push({
          employeeId: employee.id, // renderParticipantRow resolves name from employeeId
          name: employee.name || employee.fullName || '',
          startDate: '',
          endDate: '',
          disabled: false
        });
      });
      rerenderParticipantRows(rowData);
      if (duplicates.length > 0 && !silent) notifyAlreadyInTrip(duplicates);
    }

    function getEmployeesForPick() {
      // Get all active employees excluding those already in the draft
      var norm = function(v) { return String(v).replace(/^emp_/, ''); };
      var draftEmployees = new Set();
      if (window._employeePickContext && window._employeePickContext.participants) {
        window._employeePickContext.participants.forEach(function(p) {
          draftEmployees.add(norm(p.employeeId));
        });
      }

      return resolveEmployeesList().filter(function(emp) {
        return emp.name && emp.name !== 'Ставка' && !emp.name.startsWith('Ставка') &&
               !draftEmployees.has(norm(emp.id));
      }).sort(function(a, b) {
        if (a.dept !== b.dept) return a.dept - b.dept;
        return (a.slot || 0) - (b.slot || 0);
      });
    }

  // T5-DEFECT-2: Create draft from multi-row selection
  function createDraftFromSelection(empId, startDay, endDay) {
    console.log(LOG_PREFIX, 'Creating draft from selection:', empId, startDay, endDay);
    
    var selectedRows = document.querySelectorAll('.trip-row-selected');
    var participantDates = {};
    
    // Collect all selected rows for this employee
    selectedRows.forEach(function(row) {
      var rowEmpId = row.querySelector('.name-col') ? parseInt(row.querySelector('.name-col').getAttribute('data-emp-id')) : null;
      var rowStartDay = parseInt(row.querySelector('.name-col') ? row.querySelector('.name-col').getAttribute('data-start-day') : startDay);
      var rowEndDay = parseInt(row.querySelector('.name-col') ? row.querySelector('.name-col').getAttribute('data-end-day') : endDay);
      
      if (rowEmpId === empId) {
        // Ensure date ranges are merged properly
        if (!participantDates[rowEmpId]) {
          participantDates[rowEmpId] = { start: rowStartDay, end: rowEndDay };
        } else {
          participantDates[rowEmpId].start = Math.min(participantDates[rowEmpId].start, rowStartDay);
          participantDates[rowEmpId].end = Math.max(participantDates[rowEmpId].end, rowEndDay);
        }
      }
    });
    
    // Convert selected ranges to participants
    var participants = [];
    var normId = function(v) { return String(v).replace(/^emp_/, ''); };
    var employeesList = resolveEmployeesList();
    for (var emp in participantDates) {
      var range = participantDates[emp];
      var wanted = normId(emp);
      var employee = employeesList.find(function(e) { return normId(e.id) === wanted; });
      if (employee) {
        participants.push({
          employeeId: employee.id,
          name: employee.name || employee.fullName || '',
          startDate: formatDateStr(window.currentYear, 0, range.start),
          endDate: formatDateStr(window.currentYear, 0, range.end)
        });
      }
    }
    
    if (participants.length > 0) {
      openDraft(participants);
    } else {
      console.warn(LOG_PREFIX, 'No valid participants found for draft');
    }
  }

  // _renderPatched guards the renderVacationMatrix monkey-patch. The patch is
  // applied inside init() (DOM-ready), because renderVacationMatrix is declared
  // in the inline script AFTER js/trips.js loads — at load time it does not
  // exist yet and a top-level patch would silently no-op.
  var _renderPatched = false;
  // Guard for the authOverlay MutationObserver (session-race self-healing).
  var _authWatchInstalled = false;

  // Auto-initialize when script loads
  autoInit();

})();