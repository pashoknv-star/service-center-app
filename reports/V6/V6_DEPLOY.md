# V6 DEPLOY — Hostland, 2026-11-13

Команда владельца «Деплой» — 2026-11-13, вместе с решениями: должность «Директор», история Костецкого — очистить, других сотрудников «В2С» нет, зона «Управление СЦ».
Прод до выкладки: T1 (`85a746d`), `schema_version` 10. Выложено: `main` = `a16db33` (V6-1…V6-6, приёмка V6-4).

## Пакет
`/home/hermes/sc-hostland-deploy.tar.gz` — 39 файлов, 215 439 Б, md5 `5481beac…` (на сервере тот же). Сборка по allowlist `DEPLOY_HOSTLAND.md` §2, `check_no_pii.sh` OK, запрещённых файлов нет. JS: `js/storage.js js/trips.js js/tasks.js js/tasks_matrix.js`. `data/app.db` в пакете нет.

## Бэкапы (`/home/host1882970/backups/`)
- `app-pre-v6-2026-11-13-0558.db` — 1 638 400 Б, `integrity_check ok`, v10, 41 сотрудник / 1531 запись графика / 9 задач / 0 командировок;
- `www-pre-v6-2026-11-13-0558.tar.gz` — код до выкладки (без `app.db` и `images/`);
- `~/acl-before.txt` — снимок ACL `data/`, `images/`.

## Репетиция на копии боевой базы (локально, копия удалена `shred`)
Миграция v10→v11 локальным PHP 8.3: число строк в 8 таблицах до/после совпало, `g3` = «Управление СЦ», `integrity_check ok`, `foreign_key_check` пуст. DRY-RUN → APPLY → повтор = `NO-OP` — цифры те же, что на проде ниже.

## Выкладка
`DEPLOY_HOSTLAND.md` §4: распаковка через `/tmp/scnew`, служебные/тестовые файлы удалены, `chmod` только `api`, `data/holidays`, `js`, `index.html`, `upload.php`. ACL `data/`/`images/` — без изменений (diff пуст, проверено дважды: после кода и после фото).
Миграция v11 — анонимным `GET /api/tasks.php` (401): `schema_version` 11, `g3|Управление СЦ`, `integrity_check ok`, 41 / 1531 / 9 — без изменений.

## Шаг данных (`scripts/v6_director_data.sql`, `V6-3_DATA_STEP.md`)
Фото: `images/photo_1794600000_d1ec7040.jpg`, md5 `60032f4b…` (= `reports/V6/assets/director_avatar.jpg`), `chmod 644`, HTTP 200 `image/jpeg`.

DRY-RUN (`-readonly`) — контрольные строки совпали с ожиданием, STOP не потребовался:

| Строка | Ожидалось | Факт |
|---|---|---|
| schema_version | 11 | 11 |
| matches | 1 | 1 |
| target already exists | 0 | 0 |
| group g3 | Управление СЦ | Управление СЦ |
| другие сотрудники g3 | 0 | 0 |
| новая должность «Директор» | создать / найти | `pos_директор` — будет создана |
| удалится schedule_entries | — | 21 (vacation, 2026-07-27…2026-08-16) |
| vacation_balances / trip_participants / trip_requests / task_assignees | — | 0 / 0 / 0 / 0 |
| задач станут «Без исполнителя» | — | 0 |

APPLY: `APPLIED: 1 сотрудник обновлён, история очищена`; удалено 21 запись графика; остаток «Костецкий…» 0; история нового ФИО 0/0/0/0/0; `foreign_key_check` пуст; `integrity_check ok`. Повтор — `NO-OP`.

## Проверки после
| Проверка | Результат |
|---|---|
| Сотрудник: группа / должность / фото | `g3` / «Директор» / `images/photo_1794600000_d1ec7040.jpg` |
| Счётчики: сотрудники / график / задачи / командировки / должности | 41 / 1510 (= 1531 − 21) / 9 / 0 / 53 (+1) |
| `groups.g3` | «Управление СЦ» |
| `integrity_check` / `foreign_key_check` | ok / пусто |
| md5 на сервере = локальный HEAD | `index.html`, `js/tasks.js`, `js/tasks_matrix.js`, `js/storage.js`, `js/trips.js`, `api/db.php`, `api/tasks.php` — все совпали |
| Отдано браузеру (`/`, `/js/tasks.js`) = HEAD | совпало (`2f242adb…`, `a9b01cdd…`); «Управление СЦ» в `/` ×6, в `storage.js` ×1 |
| Анонимная матрица `DEPLOY_HOSTLAND.md` §10 | 15/15 OK; `X-Powered-By` нет; `/` без ПДн |
| ACL | без изменений |

## Владельцу
- **Ctrl+F5 во всех открытых вкладках.** Старая вкладка при сохранении может записать в `groups` старое имя зоны «В2С». После обновления вкладок проверю `g3`.
- Проверить вживую: золотая плитка «Управление СЦ» с вашим ФИО, фото и должностью «Директор»; ваша строка вверху матрицы без отпусков; Задачи — Календарь по часам, Список, Доска.
- Роадмап не отмечен — нужно ваше одобрение.

## Откат
```bash
WWW=~/host1882970.hostland.pro/htdocs/www
sqlite3 $WWW/data/app.db ".restore '/home/host1882970/backups/app-pre-v6-2026-11-13-0558.db'"   # внутрь файла, не cp
tar -xzf /home/host1882970/backups/www-pre-v6-2026-11-13-0558.tar.gz -C $WWW
```
