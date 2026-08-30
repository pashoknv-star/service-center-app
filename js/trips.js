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
    tripFromEmpBtn: null,
    tripModal: null
  };

  // Current state
  var _currentTab = 'matrix';
  var _currentUser = null;
  var _lastLocalActionAt = 0;

  // =====================
  // INITIALIZATION
  // =====================

  /**
   * Auto-initialize: call on DOM ready or immediately if already loaded
   */
  function init() {
    console.log(LOG_PREFIX, 'Initializing...');

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
            throw new Error('Недостаточно прав для операции');
          }
          
          throw new Error(error.error || 'Неизвестная ошибка');
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
          
          throw new Error(error.error || 'Неизвестная ошибка');
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
          throw new Error(response.data.error || 'Не удалось подтвердить');
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
      /* Trip blue color */
      .trip-blue { color: #2196F3; }
      
      /* Matrix trip overlays — high specificity to win over .day-holiday /
         .day-weekend background rules in the host page. */
      .matrix-table .day-cell-data.type-trip-confirmed,
      .day-cell-data.type-trip-confirmed {
        background-color: var(--trip-blue) !important;
        background-image: none !important;
      }
      
      .matrix-table .day-cell-data.type-trip-forecast,
      .day-cell-data.type-trip-forecast {
        background-color: rgba(33, 150, 243, 0.35) !important;
        background-image: repeating-linear-gradient(
          45deg,
          transparent 0 3px,
          rgba(33, 150, 243, 0.45) 3px 6px
        ) !important;
      }
      
      /* Trip status indicators */
      .status-forecast {
        background-color: rgba(33, 150, 243, 0.35);
        background-image: repeating-linear-gradient(
          45deg,
          transparent 0 3px,
          rgba(33, 150, 243, 0.35) 3px 6px
        );
      }
      
      .status-confirmed {
        background-color: #2196F3;
      }
      
      /* Panel tabs */
      .panel-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 16px;
      }
      
      .panel-tab {
        padding: 8px 16px;
        border: 1px solid #ddd;
        background: white;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s;
      }
      
      .panel-tab:hover {
        background: #f5f5f5;
      }
      
      .panel-tab.active {
        background: #2196F3;
        color: white;
        border-color: #2196F3;
      }
      
      /* Trip list */
      .trip-list-item {
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 12px;
        margin-bottom: 8px;
        background: white;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .trip-list-item:hover {
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
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
      }
      
      .trip-location {
        color: #666;
        font-size: 0.9em;
      }
      
      .trip-dates {
        color: #888;
        font-size: 0.85em;
      }
      
      .trip-participants {
        color: #555;
        font-size: 0.9em;
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
        z-index: 1000;
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
        border-bottom: 1px solid #eee;
      }
      
      .trip-modal-title {
        font-size: 1.2em;
        font-weight: bold;
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
        color: #333;
      }
      
      .trip-form-input {
        padding: 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 14px;
      }
      
      .trip-form-input:focus {
        outline: none;
        border-color: #2196F3;
      }
      
      .trip-form-error {
        color: #d32f2f;
        font-size: 0.85em;
        margin-top: 4px;
      }
      
      .trip-participant-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border: 1px solid #eee;
        border-radius: 4px;
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
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      }
      
      .trip-btn-primary {
        background: #2196F3;
        color: white;
      }
      
      .trip-btn-secondary {
        background: #f5f5f5;
        color: #333;
      }
      
      .trip-btn-danger {
        background: #d32f2f;
        color: white;
      }
      
      .trip-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
    _dom.tripFromEmpBtn = document.getElementById('tripFromEmpBtn');
    
    // Setup tab switching
    if (_dom.tabMatrix && _dom.tabTrips) {
      _dom.tabMatrix.addEventListener('click', function() { switchTab('matrix'); });
      _dom.tabTrips.addEventListener('click', function() { switchTab('trips'); });
    }
    
    // Setup new trip button
    if (_dom.newTripBtn) {
      _dom.newTripBtn.addEventListener('click', openNewTripModal);
    }
    
    // Setup employee trip button
    if (_dom.tripFromEmpBtn) {
      _dom.tripFromEmpBtn.addEventListener('click', openTripFromEmployee);
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
    document.body.appendChild(modal);
    _dom.tripModal = modal;
    return modal;
  }

  /**
   * Switch between tabs
   */
  function switchTab(tab) {
    _currentTab = tab;
    
    if (_dom.tabMatrix && _dom.tabTrips) {
      _dom.tabMatrix.classList.toggle('active', tab === 'matrix');
      _dom.tabTrips.classList.toggle('active', tab === 'trips');
    }
    
    if (_dom.matrixWrapper && _dom.tripsListView) {
      _dom.matrixWrapper.style.display = tab === 'matrix' ? 'block' : 'none';
      _dom.tripsListView.style.display = tab === 'trips' ? 'block' : 'none';
    }
    
    if (tab === 'trips') {
      renderTripsList();
    }
  }

  /**
   * Render trips list
   */
  function renderTripsList() {
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
            <span class="trip-status ${statusClass}">${statusIcon}</span>
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
    createTripModal();
    showTripModal(null);
  }

  /**
   * Open existing trip modal
   */
  function openTripModal(id) {
    var trip = _state.trips.find(function(t) { return t.id === id; });
    if (!trip) return;
    createTripModal();
    // getCurrentUser() may still be resolving the session asynchronously on a
    // fresh page load (_currentUser === null for one tick). Resolve first, then
    // render — showTripModal reads user.isAdmin synchronously.
    var render = function() { showTripModal(trip); };
    if (_currentUser) { render(); return; }
    api('GET', 'api/session.php').then(function(response) {
      if (response.ok && response.data && response.data.authenticated) {
        _currentUser = response.data.user;
      }
      render();
    }).catch(function() { render(); });
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
      var canConfirm = (user && user.isAdmin || isSupervisor()) && trip.status === TRIP_STATUS.FORECAST;
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
          <label class="trip-form-label">Статус</label>
          <select class="trip-form-input" id="tripStatus" ${isViewer || (trip.status === TRIP_STATUS.CONFIRMED && !user.isAdmin) ? 'disabled' : ''}>
            <option value="${TRIP_STATUS.FORECAST}" ${trip.status === TRIP_STATUS.FORECAST ? 'selected' : ''}>Прогнозируемая</option>
            <option value="${TRIP_STATUS.CONFIRMED}" ${trip.status === TRIP_STATUS.CONFIRMED ? 'selected' : ''}>Подтверждённая</option>
          </select>
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
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.closeTripModal()">Отмена</button>
          <button type="button" class="trip-btn trip-btn-primary" onclick="window.Trips.saveTrip(${trip.id})" ${isViewer ? 'disabled' : ''}>Сохранить</button>
          ${canConfirm ? `<button type="button" class="trip-btn trip-btn-primary" onclick="window.Trips.confirmTrip(${trip.id})">Подтвердить</button>` : ''}
          ${canDelete ? `<button type="button" class="trip-btn trip-btn-danger" onclick="window.Trips.deleteTrip(${trip.id})">Удалить</button>` : ''}
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
          <label class="trip-form-label">Статус</label>
          <select class="trip-form-input">
            <option value="${TRIP_STATUS.FORECAST}" selected>Прогнозируемая</option>
            <option value="${TRIP_STATUS.CONFIRMED}">Подтверждённая</option>
          </select>
        </div>
        <div class="trip-form-row">
          <label class="trip-form-label">Участники</label>
          <div id="tripParticipants"></div>
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.startEmployeePick()">+ Добавить сотрудника</button>
        </div>
        <div class="trip-actions">
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.closeTripModal()">Отмена</button>
          <button type="button" class="trip-btn trip-btn-primary" onclick="window.Trips.saveTrip()">Сохранить</button>
        </div>
      `;
      
      // Add one empty participant row
      addParticipantRow();
    }
  }

  /**
   * Render participant row
   */
  function renderParticipantRow(participant, index, isViewer) {
    var participantName = participant.employeeId ? getEmployeeName(participant.employeeId) : '';
    
    return `
      <div class="trip-participant-row">
        <input type="text" class="trip-form-input trip-participant-name" value="${escapeHtml(participantName)}" ${isViewer ? 'disabled' : ''} placeholder="ФИО">
        <input type="date" class="trip-form-input trip-participant-date" value="${participant.startDate || ''}" ${isViewer ? 'disabled' : ''}>
        <input type="date" class="trip-form-input trip-participant-date" value="${participant.endDate || ''}" ${isViewer ? 'disabled' : ''}>
        <button type="button" class="trip-btn trip-btn-secondary" title="Выбрать даты в календаре" onclick="window.Trips.startCalendarPick(null, ${index})" ${isViewer ? 'disabled' : ''}>📅</button>
        <button type="button" class="trip-btn trip-btn-danger" onclick="window.Trips.removeParticipantRow(${index})" ${isViewer ? 'disabled' : ''}>×</button>
      </div>
    `;
  }

  /**
   * Add participant row
   */
  function addParticipantRow() {
    var participantsContainer = document.getElementById('tripParticipants');
    if (participantsContainer) {
      var index = participantsContainer.children.length;
      participantsContainer.innerHTML += renderParticipantRow({}, index, false);
    }
  }

  /**
   * Remove participant row
   */
  function removeParticipantRow(index) {
    var participantsContainer = document.getElementById('tripParticipants');
    if (participantsContainer && participantsContainer.children[index]) {
      participantsContainer.removeChild(participantsContainer.children[index]);
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

  /**
   * Save trip (create or update)
   */
  function saveTrip(id) {
    var title = document.getElementById('tripTitle').value.trim();
    var location = document.getElementById('tripLocation').value.trim();
    var comment = document.getElementById('tripComment').value.trim();
    var status = document.getElementById('tripStatus').value;
    
    if (!title) {
      showError('tripTitle', 'Название обязательно');
      return;
    }
    
    var participants = [];
    var participantRows = document.querySelectorAll('#tripParticipants .trip-participant-row');
    
    participantRows.forEach(function(row) {
      var name = row.querySelector('.trip-participant-name').value.trim();
      var startDate = row.querySelector('.trip-participant-date').value;
      var endDate = row.querySelector('.trip-participant-date').value;
      
      if (name && startDate && endDate) {
        // Find employee by name (simplified)
        var employeeId = findEmployeeIdByName(name);
        if (!employeeId) {
          showError(row.querySelector('.trip-participant-name'), 'Сотрудник не найден');
          return;
        }
        
        participants.push({
          employeeId: employeeId,
          startDate: startDate,
          endDate: endDate
        });
      }
    });
    
    if (participants.length === 0) {
      showError(null, 'Добавьте хотя бы одного участника');
      return;
    }
    
    var payload = {
      title: title,
      location: location,
      comment: comment,
      status: status,
      participants: participants
    };
    
    var promise = id ? updateTrip(id, payload) : createTrip(payload);
    
    promise
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
   * Confirm trip
   */
  function confirmTrip(id) {
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
  function deleteTrip(id) {
    if (!confirm('Удалить командировку?')) {
      return;
    }
    
    deleteTrip(id)
      .then(function() {
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
   * Show error message
   */
  function showError(fieldId, message) {
    if (fieldId) {
      var field = document.getElementById(fieldId);
      if (field) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'trip-form-error';
        errorDiv.textContent = message;
        field.parentNode.appendChild(errorDiv);
        setTimeout(function() {
          errorDiv.remove();
        }, 5000);
      }
    }
    
    if (typeof window.showToast === 'function') {
      window.showToast(message, 'error');
    }
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
   * Open trip from employee editor
   */
  function openTripFromEmployee() {
    var currentEditingId = getCurrentEditingEmployeeId();
    if (!currentEditingId) {
      if (typeof window.showToast === 'function') {
        window.showToast('Нет открытого редактора сотрудника', 'error');
      }
      return;
    }
    
    var employeeTrips = _state.trips.filter(function(trip) {
      return trip.status === TRIP_STATUS.FORECAST && 
             trip.participants.some(function(p) { return p.employeeId === currentEditingId; });
    });
    
    if (employeeTrips.length === 0) {
      // Create new trip draft
      var newTrip = {
        id: null,
        title: '',
        location: '',
        comment: '',
        status: TRIP_STATUS.FORECAST,
        participants: [{
          employeeId: currentEditingId,
          startDate: '',
          endDate: ''
        }]
      };
      openNewTripModal();
    } else {
      // Show selection modal
      showTripSelectionModal(employeeTrips, currentEditingId);
    }
  }

  /**
   * Get currently editing employee ID
   */
  function getCurrentEditingEmployeeId() {
    // Try to find the current editing ID from various sources
    if (typeof window.editingId !== 'undefined') return window.editingId;
    if (typeof window.currentEditId !== 'undefined') return window.currentEditId;
    
    // Look for modal editor context
    var modal = document.querySelector('.modal-overlay');
    if (modal) {
      var match = modal.getAttribute('data-emp-id');
      if (match) return match;
    }
    
    return null;
  }

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
    document.body.appendChild(modal);
  }

  /**
   * Select trip for employee
   */
  function selectTripForEmployee(tripId, employeeId) {
    var trip = _state.trips.find(function(t) { return t.id === tripId; });
    if (trip) {
      // Open the trip modal for editing
      openTripModal(tripId);
      
      // Add the current employee as participant with min/max dates
      var participantsContainer = document.getElementById('tripParticipants');
      if (participantsContainer) {
        var minDate = trip.participants.reduce(function(min, p) {
          return min ? Math.min(min, new Date(p.startDate).getTime()) : new Date(p.startDate).getTime();
        }, null);
        
        var maxDate = trip.participants.reduce(function(max, p) {
          return max ? Math.max(max, new Date(p.endDate).getTime()) : new Date(p.endDate).getTime();
        }, null);
        
        participantsContainer.innerHTML += renderParticipantRow({
          employeeId: employeeId,
          startDate: minDate ? formatDate(new Date(minDate)) : '',
          endDate: maxDate ? formatDate(new Date(maxDate)) : ''
        }, participantsContainer.children.length, false);
      }
    }
    
    // Close selection modal
    document.querySelector('.trip-modal').remove();
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
    if (typeof window.employees !== 'undefined') {
      var employee = window.employees.find(function(e) { return e.id == employeeId; });
      return employee ? employee.name : '';
    }
    return '';
  }

  /**
   * Find employee ID by name (simplified)
   */
  function findEmployeeIdByName(name) {
    if (typeof window.employees !== 'undefined') {
      var employee = window.employees.find(function(e) { 
        return e.name.toLowerCase() === name.toLowerCase(); 
      });
      return employee ? employee.id : null;
    }
    return null;
  }

  /**
   * Check if user can delete trip
   */
  function canDeleteTrip(trip, user) {
    if (user.isAdmin) return true;
    
    if (trip.status === TRIP_STATUS.FORECAST && isSupervisor()) {
      // Supervisor can delete forecast trips for their zone
      // This is simplified - in real implementation would check zone
      return true;
    }
    
    return false;
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

    // Make cells clickable to open trip cards
    matrixBody.querySelectorAll('.day-cell-data.type-trip-confirmed, .day-cell-data.type-trip-forecast').forEach(function(cell) {
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
    openTripFromEmployee: openTripFromEmployee,
    
    // Utilities
    getCurrentUser: getCurrentUser,
    canEdit: canEdit,
    isAdmin: isAdmin,
    isSupervisor: isSupervisor,
    
    // Matrix integration
    overlay: overlay,
    
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
    startEmployeePick: startEmployeePick
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
        <p style="color: #d32f2f; margin: 10px 0;">
          ФИО: ${conflicts.map(c => c.employeeName).join(', ')}
        </p>
        <p style="margin: 10px 0;">
          Даты с конфликтами:
        </p>
        <div style="background: #fff3cd; padding: 10px; border-radius: 4px; margin: 10px 0;">
          ${conflictText}
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
          <button onclick="this.closest('.conflict-modal').remove(); Trips.selection.clear();" 
                  style="padding: 8px 16px; border: 1px solid #ccc; background: white; cursor: pointer; border-radius: 4px;">
            Отмена
          </button>
          <button onclick="this.closest('.conflict-modal').remove(); openDraftModal(${JSON.stringify(participants).replace(/"/g, '&quot;')});" 
                  style="padding: 8px 16px; background: #2196F3; color: white; cursor: pointer; border-radius: 4px;">
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
                <input type="text" id="draft-title" placeholder="Название командировки" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
              </div>
              <div class="trip-form-row">
                <label>Место:</label>
                <input type="text" id="draft-location" placeholder="Место командировки" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
              </div>
              <div class="trip-form-row">
                <label>Комментарий:</label>
                <textarea id="draft-comment" placeholder="Комментарий" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; height: 80px;"></textarea>
              </div>
              <div class="trip-form-row">
                <label>Статус:</label>
                <select id="draft-status" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
                  <option value="forecast">Прогноз</option>
                  <option value="confirmed">Подтверждена</option>
                </select>
              </div>
              <div class="trip-form-row">
                <label>Участники:</label>
                <div style="max-height: 200px; overflow-y: auto; border: 1px solid #ccc; border-radius: 4px; padding: 8px;">
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
            <button class="trip-modal-btn-secondary" onclick="this.closest('.trip-modal-overlay').remove(); Trips.selection.clear();">Отмена</button>
            <button class="trip-modal-btn-primary" onclick="saveDraftTrip(${JSON.stringify(participants).replace(/"/g, '&quot;')});">Создать</button>
          </div>
        </div>
      </div>
    `;
    
    var existingOverlay = document.querySelector('.trip-modal-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Store participants for saving
    window.currentDraftParticipants = participants;
  }

  function saveDraftTrip(participants) {
    var title = document.getElementById('draft-title').value;
    var location = document.getElementById('draft-location').value;
    var comment = document.getElementById('draft-comment').value;
    var status = document.getElementById('draft-status').value;
    
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

  // T5-DEFECT-4: Calendar pick modal for trip dates
  function startCalendarPick(tripId, participantIndex) {
    console.log(LOG_PREFIX, 'Starting calendar pick for trip:', tripId, participantIndex);
    
    // Store current context for pick mode
    window._calendarPickContext = {
      tripId: tripId,
      participantIndex: participantIndex
    };
    
    // Find the participant data
    var participants = [];
    if (tripId) {
      var trip = _state.trips.find(function(t) { return t.id === tripId; });
      if (trip && trip.participants && trip.participants[participantIndex]) {
        participants.push(trip.participants[participantIndex]);
      }
    }
    
    // Highlight the participant row if we have one
    if (participants.length > 0) {
      var empId = participants[0].employeeId;
      var participantRows = document.querySelectorAll('.trip-row-selected');
      participantRows.forEach(function(row) {
        if (row.getAttribute('data-emp-id') === empId.toString()) {
          row.classList.add('trip-row-selected');
        }
      });
    }
    
    // Focus on trips tab and show pick mode
    switchTab('trips');
    
    // Set up pick mode handler for mouseup events
    var origHandleCellMouseUp = window.handleCellMouseUp;
    window.handleCellMouseUp = function(event) {
      // If we're in pick mode, handle the pick
      if (window._calendarPickContext) {
        console.log(LOG_PREFIX, 'Calendar pick handling cell mouse up');
        
        // Find the day cell that was clicked
        var dayCell = event.target.closest('.day-cell-data');
        if (dayCell) {
          var day = parseInt(dayCell.getAttribute('data-day'));
          if (day) {
            // Record the pick
            var participantIndex = window._calendarPickContext.participantIndex;
            if (participantIndex !== undefined && _state.draft && _state.draft.participants && _state.draft.participants[participantIndex]) {
              _state.draft.participants[participantIndex].startDate = formatDateStr(window.currentYear, 0, day);
              _state.draft.participants[participantIndex].endDate = formatDateStr(window.currentYear, 0, day);
              
              // Update display and close pick mode
              console.log(LOG_PREFIX, 'Calendar pick completed:', _state.draft.participants[participantIndex]);
              window._calendarPickContext = null;
              
              // Switch back to trips tab and refresh
              switchTab('trips');
              return;
            }
          }
        }
      }
      
      // Call original handler if not in pick mode or no valid cell
      if (origHandleCellMouseUp) {
        origHandleCellMouseUp(event);
      }
    };
    
    console.log(LOG_PREFIX, 'Calendar pick mode activated. Press ESC to cancel.');
  }

  // T5-DEFECT-5: Employee pick slide panel
  function startEmployeePick(draft) {
    console.log(LOG_PREFIX, 'Starting employee pick for draft:', draft);
    
    // Store draft context and suppress info panel
    window._employeePickContext = draft;
    Trips.suppressInfoPanel = function() { return true; };
    
    // Slide the vacation panel
    var vacationPanel = document.querySelector('.vacation-panel');
    if (vacationPanel) {
      vacationPanel.classList.add('trip-panel-slided');
      vacationPanel.style.position = 'sticky';
    }
    
    // Create employee pick dock
    var dockHtml = `
      <div class="trip-pick-dock">
        <div class="dock-header">
          <span class="dock-title">Добавить сотрудника</span>
          <button class="dock-close" onclick="Trips.endEmployeePick()">×</button>
        </div>
        <div class="dock-content">
          <div class="dock-search">
            <input type="text" id="employeeSearch" placeholder="Поиск сотрудника..." />
          </div>
          <div class="dock-employees" id="employeeList">
            <!-- Employee list will be populated here -->
          </div>
        </div>
        <div class="dock-footer">
          <button class="dock-btn dock-btn-primary" onclick="Trips.confirmEmployeePick()">Добавить</button>
          <button class="dock-btn dock-btn-secondary" onclick="Trips.endEmployeePick()">Отмена</button>
        </div>
      </div>
    `;
    
    var existingDock = document.querySelector('.trip-pick-dock');
    if (existingDock) {
      existingDock.remove();
    }
    
    document.body.insertAdjacentHTML('beforeend', dockHtml);
    
    // Populate employee list
    populateEmployeePickList();
    
    // Position the dock
    positionEmployeePickDock();
  }
  
  function populateEmployeePickList() {
    var employeeList = document.getElementById('employeeList');
    if (!employeeList) return;
    
    var employees = getEmployeesForPick();
    var html = '';
    
    employees.forEach(function(emp) {
      var isSelected = window.Trips.pickedEmployees && window.Trips.pickedEmployees.has(emp.id);
      html += `
        <div class="dock-employee-item ${isSelected ? 'selected' : ''}" data-id="${emp.id}">
          <div class="employee-info">
            <div class="employee-name">${emp.name}</div>
            <div class="employee-dept">${emp.dept}</div>
          </div>
          <div class="employee-checkbox">
            ${isSelected ? '✓' : ''}
          </div>
        </div>
      `;
    });
    
    employeeList.innerHTML = html;
    
    // Add click handlers
    employeeList.querySelectorAll('.dock-employee-item').forEach(function(item) {
      item.addEventListener('click', function() {
        toggleEmployeePickSelection(this);
      });
    });
  }
  
  function toggleEmployeePickSelection(item) {
    var empId = parseInt(item.getAttribute('data-id'));
    item.classList.toggle('selected');
    
    if (!window.Trips.pickedEmployees) {
      window.Trips.pickedEmployees = new Set();
    }
    
    if (item.classList.contains('selected')) {
      window.Trips.pickedEmployees.add(empId);
    } else {
      window.Trips.pickedEmployees.delete(empId);
    }
    
    console.log(LOG_PREFIX, 'Employee selection toggled:', empId, 'selected:', window.Trips.pickedEmployees.has(empId));
  }
  
  function positionEmployeePickDock() {
    var dock = document.querySelector('.trip-pick-dock');
    if (dock) {
      dock.style.position = 'fixed';
      dock.style.left = '0px';
      dock.style.top = '50%';
      dock.style.transform = 'translateY(-50%)';
      dock.style.transition = 'left 0.25s ease';
    }
  }
  
  function endEmployeePick() {
    // Restore normal state
    Trips.suppressInfoPanel = function() { return false; };
    
    var vacationPanel = document.querySelector('.vacation-panel');
    if (vacationPanel) {
      vacationPanel.classList.remove('trip-panel-slided');
      vacationPanel.style.position = '';
    }
    
    var dock = document.querySelector('.trip-pick-dock');
    if (dock) {
      dock.remove();
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
    
    if (draft && draft.participants) {
      selectedEmployees.forEach(function(empId) {
        var employee = employees.find(function(e) { return e.id === empId; });
        if (employee) {
          draft.participants.push({
            employeeId: employee.id,
            name: employee.name
          });
        }
      });
      
      console.log(LOG_PREFIX, 'Employees added to draft:', selectedEmployees);
    }
    
    endEmployeePick();
  }
  
  function getEmployeesForPick() {
    // Get all active employees excluding those already in the draft
    var draftEmployees = new Set();
    if (window._employeePickContext && window._employeePickContext.participants) {
      window._employeePickContext.participants.forEach(function(p) {
        draftEmployees.add(p.employeeId);
      });
    }
    
    return employees.filter(function(emp) {
      return emp.name && emp.name !== 'Ставка' && !emp.name.startsWith('Ставка') && 
             !draftEmployees.has(emp.id);
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
    for (var emp in participantDates) {
      var range = participantDates[emp];
      var employee = employees.find(function(e) { return e.id === parseInt(emp); });
      if (employee) {
        participants.push({
          employeeId: employee.id,
          name: employee.name,
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

  // Auto-initialize when script loads
  autoInit();

})();