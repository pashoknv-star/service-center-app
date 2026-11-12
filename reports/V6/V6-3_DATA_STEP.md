# V6-3 — данные «Директор СЦ» на проде: порядок на «Деплой»

**Статус: подготовлено, на проде НЕ выполнялось.** Выполняется только по команде владельца «Деплой», вместе с выкладкой кода V6-3 (`DEPLOY_HOSTLAND.md` §4).
Скрипт: `scripts/v6_director_data.sql`. Фото: `reports/V6/assets/director_avatar.jpg` (лицензия — `V6-3_REPORT.md` §D).
Прод-CLI: PHP 5.3 (PHP-скрипты не запускаются), `sqlite3` 3.26 — скрипт использует только `sqlite3` CLI и SQL, доступный в 3.26.
Команды ниже — с плейсхолдерами; пароли в них нет и не вводятся (SSH-пароль владелец передаёт сам в сессии).

Плейсхолдеры: `<SSH_USER>`, `<HOST>`, `$WWW` = `~/host1882970.hostland.pro/htdocs/www` (как в `DEPLOY_HOSTLAND.md`), `<BASE>` = `http://host1882970.hostland.pro`.

## Что делает шаг

| Что | Значение |
|---|---|
| Кто | ровно один сотрудник с `full_name = 'Костецкий Андрей Николаевич'` (id в БД сохраняется) |
| ФИО | → `Игнатенко Павел Валерьевич` |
| Фото | `photo_url = 'images/photo_1794600000_d1ec7040.jpg'` (формат `api/upload.php`: `images/photo_<unix>_<8 hex>.<ext>`) |
| Группа | `group_id = 'g3'` (плитка «Директор СЦ») |
| Служебное | `updated_at`; `task_assignees.full_name_snapshot` освежён; `audit_log` (`employee.update`, `{"changes":{…}}`, актор `sql:v6-3`); `sync_log` (`employee`/`upsert`) — открытые окна подтянут изменение дельта-синхронизацией |
| НЕ трогается | история отпусков (`schedule_entries`), `vacation_balances`, `trip_participants`, задачи, должность (`position_id`) |

Условия внутри SQL (при невыполнении — **ничего не меняется**, итог `NO-OP`): ровно 1 «Костецкий…»; «Игнатенко…» ещё нет (защита от дубля); группа `g3` есть; `schema_version >= 10`. Повторный запуск = `NO-OP` (после первого применения «Костецкий…» уже не находится).

## Порядок

### 0. Предусловия
- Команда владельца «Деплой»; код V6-3 слит и собран в пакет по `DEPLOY_HOSTLAND.md` §4; `bash scripts/verify_all.sh` → `GATE: PASS`.
- Файлы, которые понадобятся на хостинге: `scripts/v6_director_data.sql` (в прод-пакет код-выкладки не входит — копируется отдельно, например в `~/v6-3/`), фото `director_avatar.jpg`.

### 1. Бэкап и снимок ACL (до любых изменений)
```bash
WWW=~/host1882970.hostland.pro/htdocs/www
getfacl -p $WWW/data $WWW/images | tee ~/acl-before.txt
mkdir -p /home/host1882970/backups
sqlite3 $WWW/data/app.db ".backup '/home/host1882970/backups/app-v6-3-$(date +%F-%H%M).db'"
ls -l /home/host1882970/backups | tail -3                         # копия создана и не пуста
sqlite3 /home/host1882970/backups/app-v6-3-<DATE>.db "PRAGMA integrity_check;"   # ok
```

### 2. Выкладка кода V6-3 (`DEPLOY_HOSTLAND.md` §4) и миграция v11
После выкладки сделать любой запрос к API с логином (миграция `v10 → v11` выполняется кодом при первом обращении), затем:
```bash
sqlite3 $WWW/data/app.db "SELECT value FROM meta WHERE key='schema_version'; SELECT id, name FROM groups WHERE id='g3';"
# ожидается: 11  и  g3|Директор СЦ
```
Если `schema_version` < 10 — шаг APPLY ниже сам откажется (`NO-OP`), сначала довести миграцию.

### 3. Фото — на сервер (до APPLY: путь в БД не должен указывать в пустоту)
```bash
# с рабочей машины, из корня репозитория (пароль вводит владелец/сессия, не в команде):
scp reports/V6/assets/director_avatar.jpg <SSH_USER>@<HOST>:$WWW/images/photo_1794600000_d1ec7040.jpg
# на сервере: права как у загрузок (api/upload.php делает chmod 0644) — ТОЛЬКО этот файл; каталог images/ и ACL не трогать
chmod 644 $WWW/images/photo_1794600000_d1ec7040.jpg
curl -sI <BASE>/images/photo_1794600000_d1ec7040.jpg | head -3        # 200, Content-Type: image/jpeg
getfacl -p $WWW/data $WWW/images > ~/acl-after.txt; diff ~/acl-before.txt ~/acl-after.txt && echo "ACL не изменились"
```
`images/.htaccess` на прод не копируется (`DEPLOY_HOSTLAND.md` §4, R1-02) — это не меняется.

### 4. DRY-RUN → показать владельцу счётчики (СТОП до ответа)
```bash
cd ~/v6-3
sed '/^-- @@APPLY/,$d' v6_director_data.sql | sqlite3 -readonly $WWW/data/app.db
```
Вывод — копия в чат владельцу целиком. Ожидается: `matches = 1`, `target already exists = 0`, карточка (id, group_id, должность, photo_url) и счётчики `schedule_entries` (по статусам и диапазон дат), `vacation_balances`, `trip_participants`, `task_assignees` open / closed.
Владелец решает: (а) устраивает ли, что **вся история Костецкого (отпуска, командировки, задачи) остаётся у этой же строки сотрудника**, т.е. переходит к «Игнатенко Павел Валерьевич» (скрипт её не удаляет и не переносит — если нужна чистая история, это отдельное решение до APPLY); (б) должность (`position`) под именем на карточке — скрипт её не меняет; если нужна «Директор СЦ» / иная — сообщить, это отдельное изменение справочника/записи.
Если `matches` ≠ 1 или `target already exists` ≠ 0 — APPLY не запускать (он и сам ничего не изменит), разобраться.

### 5. APPLY (только после «да» владельца)
```bash
sqlite3 $WWW/data/app.db < ~/v6-3/v6_director_data.sql
# в конце вывода: «APPLIED: 1 сотрудник обновлён»; «остаток Костецкий… = 0»; foreign_key_check пуст; integrity_check = ok
```
Один запуск = одна транзакция (`BEGIN IMMEDIATE … COMMIT`, `.bail on`: при любой ошибке транзакция откатывается, БД не меняется).

### 6. Проверки после
```bash
sqlite3 $WWW/data/app.db "SELECT id, full_name, group_id, photo_url FROM employees WHERE full_name='Игнатенко Павел Валерьевич';"   # 1 строка
sqlite3 $WWW/data/app.db < ~/v6-3/v6_director_data.sql | grep -A1 result                                                           # NO-OP (повтор — 0 изменений)
sqlite3 $WWW/data/app.db "PRAGMA integrity_check; PRAGMA foreign_key_check;"                                                      # ok, пусто
curl -sI <BASE>/images/photo_1794600000_d1ec7040.jpg | head -1                                                                    # 200
```
В браузере (admin): **жёсткая перезагрузка (Ctrl+F5)** — главная схема: золотая плитка «Директор СЦ», карточка «Игнатенко Павел Валерьевич» с фото; матрица отпусков: верхняя группа «Директор СЦ» со строкой директора.
Важно: окна, открытые ДО выкладки (старый JS в кэше), после Ctrl+F5 обновляются; не оставлять у admin старую вкладку — старый `index.html` при сохранении пишет в `groups` имя «В2С» (`save.php`: upsert групп из `ZONES` клиента). Проверка: `sqlite3 … "SELECT name FROM groups WHERE id='g3'"` → `Директор СЦ`; если вернулось «В2С» — повторить `UPDATE groups SET name='Директор СЦ' WHERE id='g3';` после закрытия старых вкладок.
Ещё раз — веб-проверки `DEPLOY_HOSTLAND.md` §10 (анонимные коды) и ACL (шаг 3).

### 7. Откат (если что-то пошло не так)
```bash
# данные: вернуть БД из бэкапа ВНУТРЬ существующего файла (сохраняет владельца/ACL data/app.db)
sqlite3 $WWW/data/app.db ".restore '/home/host1882970/backups/app-v6-3-<DATE>.db'"
rm -f $WWW/images/photo_1794600000_d1ec7040.jpg      # фото можно оставить — на БД не влияет
```
(`cp` поверх `app.db` не использовать — может сменить владельца/ACL и отнять запись у веб-пользователя.) Код откатывается по `DEPLOY_HOSTLAND.md` (прежний пакет); откат БД до v10 не нужен: приложение без v11-кода работает на БД v11 (переименована только `groups.name`).

## Как проверено локально (не на проде)
Копия dev-БД во временном файле, схема мигрирована штатным кодом до v11, добавлены вымышленный «Костецкий Андрей Николаевич» в `g3` (2 дня отпуска + 1 больничный, баланс, участие в командировке, 2 назначения задач — открытая и закрытая). Результаты (DRY-RUN, APPLY, повтор, негативные случаи 0/2 совпадения, существующий «Игнатенко…», `schema_version` 9) — в `V6-3_REPORT.md` §E и в сьюте `director` (`scripts/test_v6_director.js`, раздел E).
