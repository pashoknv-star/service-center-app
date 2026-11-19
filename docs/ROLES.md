# Роли и права доступа

Источник правды — код (`api/auth.php`); этот документ — выжимка на 2026-11-19, каждый пункт со ссылкой `файл:строка`, прочитанной в рабочем дереве. Роль определяется `user_role()` (`api/auth.php:88-98`): `is_admin=1` → admin, иначе `can_edit=1` → supervisor, иначе viewer.

## Роли (сводка)

| Роль | Метка в UI | Флаги в `users` | Суть |
|---|---|---|---|
| admin | Администратор | `is_admin=1` | полный доступ |
| supervisor | Супервайзер | `can_edit=1`, `scope_group_id` = своя зона | правка только своей зоны |
| viewer | Наблюдатель | `can_edit=0`, `is_admin=0`, `scope_group_id` NULL | только чтение |

Метки — `index.html:2313`.

## Роль viewer («Наблюдатель»)

Только чтение. Любая запись (POST/PUT/DELETE) возвращает 403 `forbidden`, анонимный запрос — 401.

### Может

| Что | Как | Источник |
|---|---|---|
| Войти, сменить **свой** пароль | `login.php`, `change_password.php` — только `require_auth()`, без проверки роли; новый пароль ≥ 8 символов | `api/change_password.php:34`, `:53` |
| Видеть Матрицу, сотрудников, группы, должности, записи | `load.php` и `reset.php` — `require_auth()` | `api/load.php:25`, `api/reset.php:25` |
| Получать обновления других клиентов | `sync.php` GET — любая роль; записью (POST) только edit | `api/sync.php:91-97` |
| Скачать экспорт JSON (не меняет данные) | `export.php` — `require_auth()` | `api/export.php:27` |
| Видеть календарь праздников | `holidays.php` GET — `require_auth()` | `api/holidays.php:40-42` |
| Видеть командировки | `trips.php` GET | `api/trips.php:53` (шапка) |
| Видеть задачи, связи, метки | `tasks.php` GET — любой авторизованный | `api/tasks.php:934-938` |
| Видеть и скачивать вложения задач | `task_files.php` GET — `require_auth()` | `api/task_files.php:74`, `api/task_files_lib.php:249` |

### Не может (403)

| Что | Чем закрыто | Источник |
|---|---|---|
| Править сотрудников, группы, должности, записи Матрицы, сохранять состояние | `require_edit()` | `api/employees.php:91,139,246`; `api/groups.php:59,85,134`; `api/positions.php:59,85,134`; `api/entries.php:84,196,289`; `api/save.php:27` |
| Загружать фото | `require_edit()` | `api/upload.php:38` |
| Создавать/править/подтверждать/удалять командировки | `require_edit()` (мутации) | `api/trips.php:429` |
| Создавать/править/архивировать задачи, менять статус, метки, связи | `require_admin()` (запись — только admin) | `api/tasks.php:1109-1110` |
| Прикреплять и удалять вложения задач | `tf_can_upload`/`tf_can_delete`: viewer — нет | `api/task_files_lib.php:249-268` |
| Менять праздники | `require_admin()` для POST/PUT/DELETE | `api/holidays.php:40-44` |
| Импорт данных, экспорт аудит-лога, relay командировок | `require_admin()` | `api/import.php:33`, `api/audit_export.php:35`, `api/trip_relay.php:106` |
| Принудительно удалять утверждённые записи | `require_admin()` | `api/entries.php:339` |

### В интерфейсе

Тело получает класс `role-viewer` (`index.html:2353`): поля карточки сотрудника заблокированы, кнопки правки скрыты (`index.html:1629-1640`); бейдж «viewer» (`index.html:1615`, `:2152`). Это только удобство — защита на сервере (таблица выше).

## Как создаётся viewer

В интерфейсе создания пользователей нет. Dev-БД: `viewer_test` (пароль стартовый, только dev). Прод: учётка заводится вручную в `users` (`id`, `username`, `password_hash` = `password_hash()` PHP, `display_name`, `can_edit=0`, `is_admin=0`, `scope_group_id=NULL`, схема — `api/schema.sql:101-109`) с бэкапом БД до правки; CLI PHP на Hostland 5.3 — хеш считать локально. Пароли в репозиторий и отчёты не записываются. Состояние прода — Kanban/роадмап (этап «Р-1»).

## admin и supervisor (для сравнения)

- admin — всё, включая запись задач, праздники, импорт, аудит-экспорт (`api/auth.php:146-157` (`require_admin`), `can_edit_group` → `:172`).
- supervisor — `require_edit()` проходит; правка групп/сотрудников/командировок только своей зоны (`can_edit_group`, `api/auth.php:164-186`); командировки подтверждённые — только чтение (`api/trips.php:50-51`); задачи — запись запрещена (только admin), вложения — только к своим задачам (`api/task_files_lib.php:249-258`).

## Не проверено

Поведение каждой кнопки UI для viewer в браузере в этой правке не прогонялось; сервер-часть прочитана по исходникам. Приёмочные прогоны ролей — `reports/V7/V7_REPORT.md` (V1), `reports/V6_2/V6.2-3_ACCEPTANCE.md`.
