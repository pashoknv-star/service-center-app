# E8 — Совместное редактирование матрицы (протокол синхронизации)

Реализация варианта **«оптимистичная конкуренция (версии записей) + polling-дельта»**.
Стек не изменился: PHP + SQLite + обычный HTTP (без WebSocket/SSE).

## Схема БД (v3)

- `schedule_entries.version INTEGER NOT NULL DEFAULT 1` — версия записи.
  Старые строки (до миграции) получают версию 1 автоматически.
- Новая таблица `sync_log`:
  ```sql
  sync_log (id INTEGER PK AUTOINCREMENT, entity_type TEXT, entity_id TEXT,
            action TEXT, actor TEXT, updated_at TEXT)
  ```
  Пишется при каждом изменении entries/employees (`save.php`), при внешнем
  импорте (`vacation_import.php`, actor = `external_api`). Ротация: не более
  ~10000 последних событий (`save.php` чистит старые при каждом сохранении).

Миграция v2→v3 выполняется автоматически при первом обращении (`db.php migrate()`):
`ALTER TABLE schedule_entries ADD COLUMN version ...` + `CREATE TABLE sync_log`.

## Версии записей (оптимистичная конкуренция)

- `load.php` теперь отдаёт `entries[key].version` и `lastSyncId` (курсор).
- `save.php`: entry в payload может содержать `entryVersion`:
  - версия клиента == версии сервера → принимается, версия +1, событие в sync_log;
  - расхождение → **конфликт**: entry не принимается, серверное состояние
    сохраняется, в ответе `conflicts[]`:
    ```json
    { "key": "emp_1:2026-09-07", "clientVersion": 1, "serverVersion": 2,
      "serverEntry": { ...актуальная серверная запись... } }
    ```
  - `entryVersion` отсутствует (старый фронт) → прежнее поведение, конфликтов нет.
- Ответ `save.php`: `{ success, savedAt, conflicts: [...] }`.

## Polling-дельта — `api/sync.php`

**GET `api/sync.php?afterId=N`** (любая авторизованная роль):

```json
{
  "success": true,
  "serverTime": "2026-08-16T18:30:00+00:00",
  "afterId": 0,
  "lastSyncId": 42,
  "entries": { "emp_1:2026-09-07": { "employeeId": "...", "date": "...", "status": "...",
               "comment": "...", "approvalStatus": "...", "version": 2, "updatedAt": "..." } },
  "deletedEntries": ["emp_1:2026-09-08"],
  "employeesChanged": ["emp_1"],
  "employeesDeleted": ["emp_9"]
}
```

Семантика: отдаются **актуальные** состояния записей, изменённых с момента
`afterId`. Если записи уже нет в БД — ключ попадает в `deletedEntries`.
Клиент мержит дельту поверх локального состояния и обновляет курсор
`lastSyncId`.

**POST `api/sync.php`** — пред-проверка версий перед сохранением:
`{ "keys": ["emp_1:2026-09-07"] }` → `{ "versions": { "emp_1:2026-09-07": 2 } }`.

## Рекомендуемый цикл клиента

1. `GET load.php` → состояние + `lastSyncId` (начальный курсор).
2. Таймер (например 15–30 сек) + событие focus окна: `GET sync.php?afterId=курсор`
   → мерж изменений → новый курсор.
3. При правке ячейки: локально, затем `POST save.php` с полным состоянием,
   где изменённые entries содержат `entryVersion`.
4. Если ответ содержит `conflicts` — обновить затронутые ячейки серверными
   версиями (`serverEntry`), показать уведомление пользователю.

## Что защищается

- Затирание чужих правок (lost update) при одновременном редактировании:
  супервайзер ГКС и супервайзер ГЭ работают в разных зонах, но общий
  администратор + внешний API теперь не перезапишут чужую правку молча.
- Удаления по SYNC-логике save.php («Очистить») работают как раньше —
  конфликт-детекция включается только на upsert-путь с явной версией.
