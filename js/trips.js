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
    
    // Initialize if not already done
    if (_state.trips.length === 0) {
      loadTrips();
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
    if (trip) {
      createTripModal();
      showTripModal(trip);
    }
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
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.addParticipantRow()">+ Добавить сотрудника</button>
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
          <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.addParticipantRow()">+ Добавить сотрудника</button>
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
  // EXTERNAL API
  // =====================

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
    isSupervisor: isSupervisor
  };

  // Auto-initialize when script loads
  autoInit();

})();