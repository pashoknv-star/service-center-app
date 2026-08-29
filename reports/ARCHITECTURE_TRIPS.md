# Архитектура фичи «Командировки» — решение координатора

Дата: 2026-08-29. Основание: reports/T1_frontend_audit.md, reports/T2_backend_audit.md + верификация координатора.

## 1. Source of truth

**Отдельная сущность в БД (миграция schema v5 → v6):**

```sql
CREATE TABLE IF NOT EXISTS trips (
    id          TEXT PRIMARY KEY,           -- genId('trip_'), сервер
    title       TEXT NOT NULL,              -- цель/название
    location    TEXT,                       -- населённый пункт
    comment     TEXT,
    status      TEXT NOT NULL DEFAULT 'forecast',  -- forecast | confirmed
    version     INTEGER NOT NULL DEFAULT 1, -- E8 optimistic concurrency
    created_by  TEXT,
    created_at  TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS trip_participants (
    trip_id     TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    start_date  TEXT NOT NULL,              -- индивидуальный период
    end_date    TEXT NOT NULL,
    PRIMARY KEY (trip_id, employee_id),
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
```

- Статусы — ровно два по ТЗ: `forecast` / `confirmed`. Подтверждение = явное действие [Подтвердить командировку].
- localStorage НЕ источник истины; server-first как сейчас.
- Миграция: schema.sql + `applyIncrementalMigrations($current < 6)` + SCHEMA_VERSION=6; прод не пересоздавать, DDL идемпотентный, применится первым HTTP-запросом.

## 2. Матрица: оверлей, а не записи

- `schedule_entries` НЕ используется для хранения командировок новой механикой. Ячейки командировки в матрице рендерятся из TripsState (дериват): forecast = бледная синяя + diagonal hatch (CSS `repeating-linear-gradient`), confirmed = текущий `--trip-blue` без штриховки.
- Приоритет рендера ячейки: `sick` (ЭЛН) > trip-оверлей > vacation/day_off/рабочий. ЭЛН не трогает объект Trip — только визуально перекрывает.
- Legacy: статус 'trip' в schedule_entries (существует сегодня, TYPE_TO_STATUS.trip) — **депрекейтед как write-path**. Опция «Командировка» в посуточном popup перестаёт писать 'trip'-entries и открывает draft Trip-карточку. Миграция данных: существующие подряд идущие 'trip'-entries группируются в Trip-объекты (status=confirmed — визуал не меняется). На dev-БД entries=0; на проде проверить при деплое.

## 3. API (новый api/trips.php, паттерн E8 — НЕ копировать entries.php)

- `GET trips.php` (auth, любая роль) — список + lastSyncId.
- `POST` (require_edit; supervisor — все участники его зоны) — создание: валидация дат, участников, пересечений; genId; version=1; sync_log('trip', id, 'upsert'); audit('trip.create'). Viewer → 403 (server-side).
- `PUT ?id=` (require_edit + зона) — изменение полей/состава/дат с entryVersion-сверкой → conflict {serverTrip} (как save.php), НЕ silent overwrite.
- `PUT ?id=&action=confirm` (require_edit + зона) — forecast→confirmed (явное действие; подтверждённая правится только admin — паттерн approved-guard).
- `DELETE ?id=` (require_edit; confirmed → только admin) — sync_log delete.
- **Пересечения** (backend, в транзакции): для каждого участника ∀дата ∉ schedule_entries(status IN ('vacation','day_off')) → 409 overlapping_entry {employeeId, date, status}. sick разрешён (визуальный приоритет, объект не трогаем).
- sync.php GET расширяется веткой entity_type='trip' → tripsChanged/tripsDeleted в дельте.

## 4. Уведомления — существующая механика

- Создатель: `showToast('Заведена новая командировка', 'success')` (:4784) после успешного POST-ответа.
- Другие пользователи: через polling-дельту sync.php (20с/focus) — новое trip-событие → тот же showToast. Второго механизма уведомлений не создаём.

## 5. Frontend

- Вкладки: в `.vacation-panel-header` (:1806) `<h2>Матрица отпусков` → пара кнопок-вкладок [Матрица отпусков][Командировки]; одна панель, два view (matrix view | trips list view). Год/стрелки не трогаем.
- TripsState в StorageAdapter: load в ScheduleState (+trips), отдельный save-путь (точечный, НЕ full-state), versionMap для trips.
- Ctrl-мультивыбор карточек — новая механика (в коде отсутствует, verified): ctrl+click по карточкам/строкам → CSS-класс выделения, остальные строки `.dimmed`; выбранные ≠ открытие «Карточка сотрудника» (guard в обработчике). Один механизм для входа №2 (матрица) и режима [Добавить сотрудника] в карточке командировки.
- Вход №2: после Ctrl-выбора кнопка [Командировки] активна; выделение диапазона на одном выбранном → авто-повтор на остальных (draft); [Командировки] → карточка-draft с людьми/датами, пустые title/location/comment, status=forecast. Объект не сохраняется до [Сохранить].
- Вход №3: кнопка [Командировка] в панели «Карточка сотрудника»; нет forecast → новая с сотрудником; есть → селектор forecast-командировок (подтверждённые НЕ предлагаются), даты автозаполняются: min(start)/max(end) участников (явное правило, не скрытая логика).
- [Календарь]: переход в матрицу, выделение диапазона на строке участника переиспользует существующий drag/range (handleCellMouseDown/Enter/Up :3663+), результат пишется в поле дат карточки.

## 6. Роли

- admin: всё, включая правку confirmed.
- supervisor-1/2: create/edit/confirm, только участники своей зоны (scope_group_id), confirmed read-only (как approved-guard).
- viewer: только чтение (GET); POST/PUT/DELETE → 403 на API; кнопки скрыты/заблокированы в UI.

## 7. Открытые decision-точки (дефолты выбраны, ждут подтверждения)

- D1: существующие на проде legacy 'trip'-entries → мигрировать в Trip(status=confirmed). Дефолт принят.
- D2: подтверждать командировку может admin и supervisor своей зоны. Дефолт принят.

## 8. Порядок реализации (фазы 3–8 плана)

3: backend (миграция v6, trips.php, sync-ветка, smoke) → 4: frontend (StorageAdapter trips, вкладка, список, карточка, участники, [Календарь], [Добавить сотрудника], showToast) → 5: matrix integration (оверлей-рендер, Ctrl-выбор, dimming, проброс диапазона, конфликты, popup-маршрутизация) → 6: QA (функционал, роли, sync 2 сессии, 53 UX-состояния, регрессия) → 7: cross-review → 8: фиксы + финальная регрессия + отчёт.

Деплой на Hostland — отдельной командой «Деплой» (не входит в фазы 3–8).
