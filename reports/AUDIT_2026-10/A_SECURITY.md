# AUDIT 2026-10 — Блок A: Безопасность (OWASP, ПДн 152-ФЗ)

Автор: software-development-coordinator. Коммит `101c846`. Дата 2026-10-25.
Режим: ревью + план, ничего не правилось. Динамические проверки — только на локальном dev (`127.0.0.1:8095`, отдельный worktree; dev-БД после прогона возвращена `git checkout -- data/app.db`). Прод — только анонимные GET/HEAD.
Скрипт атак: `~/.hermes/profiles/software_development_coordinator/cache/scratch/a_attack.sh` (воспроизводим).

## 1. Резюме блока

Найдено 21 находка: P0 — 1, P1 — 7, P2 — 9, P3 — 4.
- **P0 (A-01):** на проде без авторизации раздаются ФИО (38 уникальных полных ФИО с отчеством), должности и снимок графика отпусков: они вшиты в статический `index.html`. Подтверждено сравнением sha1 прод-файла и файла в репозитории. Это утечка ПДн анониму, и она лежит в git-истории с базового коммита `aa16c93`.
- **P1:**
  - хранимый XSS в карточке сотрудника и матрице: supervisor может выполнить JS в сессии admin (A-02);
  - обход ролей и зон через «непубличные» REST-эндпоинты: supervisor правит и удаляет чужих сотрудников, группы, должности, сам себе утверждает записи; viewer удаляет записи через `PUT sync.php` (A-03, A-04);
  - CSRF с любого сайта `*.hostland.pro`: домен не входит в Public Suffix List, поэтому SameSite=Lax не защищает, а API принимает `text/plain`. Для жертвы-admin это вплоть до полного стирания данных через `import.php` (A-05);
  - `api/holidays.php` вообще без авторизации — анонимная запись на проде (A-06);
  - служебные файлы на проде: `smoke_test.php` (анонимный запуск процесса), `debug_token.php` (оракул токена и частичное раскрытие токена) (A-07);
  - токен RPA-робота может раскрыть любой supervisor. С токеном можно опустошить очередь HelpMe и подделать callback'и (A-08).
- **P2:** CSV-инъекция в выгрузку аудита (анонимно через логин), нет защиты от перебора паролей и перечисление логинов по таймингу, сессии не инвалидируются при смене пароля, раскрытие ошибок и путей, нет заголовков безопасности, открытые токены в БД и dev-БД в git, полная выгрузка ПДн viewer'у без аудита, удержание ПДн.
- SQL-инъекций нет. Опасных конструкций (XXE, unserialize, eval, shell, SSRF, open redirect, include с переменной) в рабочем коде нет.

## 2. Таблица находок

| ID | P | CVSS 3.1 | Категория / CWE | Место | Заголовок | Уверенность | Статус риска |
|---|---|---|---|---|---|---|---|
| A-01 | P0 | 7.5 | A / CWE-200, CWE-540 | index.html:1994, 2105-2419 | ПДн 38 сотрудников (ФИО, должности, график) в статическом index.html — анониму на проде | подтверждено (код + прод GET, sha1) | — |
| A-02 | P1 | 8.7 | A / CWE-79 | index.html:4647-4654, 3605-3608; api/employees.php:137-139; api/positions.php:57-59 | Хранимый XSS (ФИО/должность/локация/photoUrl/группа) → действия от имени admin | подтверждено (dev: payload сохранён и отдан) | — |
| A-03 | P1 | 7.1 | A / CWE-863, CWE-639 | api/employees.php:89-91,137-139,239-241; api/groups.php:57-59,83-85,132-134; api/positions.php:57-59,83-85,132-134; api/entries.php:118-158,237-266; api/save.php:504-506,582,734-796 | Supervisor обходит зону и approved-guard через REST-эндпоинты и save.php | подтверждено (dev) | — |
| A-04 | P1 | 6.5 | A / CWE-862 | api/sync.php:95-101 | Viewer удаляет записи через PUT/DELETE sync.php (require_edit только для POST) | подтверждено (dev: 200) | — |
| A-05 | P1 | 6.8 | A / CWE-352 | api/helpers.php:65-78; api/auth.php:314-319 | CSRF с same-site `*.hostland.pro` (не в PSL) + приём text/plain | подтверждено (dev: text/plain → 201; PSL проверен) | — |
| A-06 | P1 | 6.5 | A / CWE-306 | api/holidays.php:20-23, 59-150 | holidays.php без аутентификации: анонимная запись/удаление на проде | подтверждено (dev: POST 201/PUT 200/DELETE 200; прод GET 200) | — |
| A-07 | P1 | 6.5 | A+F / CWE-489, CWE-200 | api/smoke_test.php:200-224; api/debug_token.php:11-67; api/init_db.php:17-22 | Служебные скрипты на проде: анонимный proc_open, оракул/фрагмент токена, Fatal с путём | подтверждено (прод GET, код) | — |
| A-08 | P1 | 7.6 | A / CWE-269, CWE-522 | api/trip_relay.php:103-110, 115-209 | Токен робота раскрывается supervisor'у; с ним — опустошение очереди и подделка callback | подтверждено (dev: reveal supervisor → 200) | — |
| A-09 | P2 | 6.1 | A / CWE-1236 | api/audit_export.php:123-139; api/login.php:45 | CSV/формульная инъекция в аудит, источник — анонимный логин | подтверждено (dev) | — |
| A-10 | P2 | 6.5 | A / CWE-307, CWE-204, CWE-521 | api/login.php:38-47; api/change_password.php:53 | Нет rate limit/блокировки, перечисление логинов по таймингу, минимум 8 символов | подтверждено (dev: 30 попыток/2,4 с; 81 мс vs 32 мс) | — |
| A-11 | P2 | 4.8 | A / CWE-613 | api/change_password.php:49-73; api/auth.php:314-320 | Смена пароля не завершает другие сессии; нет idle/absolute тайм-аута | подтверждено (dev) | — |
| A-12 | P2 | 5.3 | A / CWE-209 | api/helpers.php:124-127 + 19 catch (G-10); прод display_errors | Детали исключений и пути клиенту/анониму | подтверждено (прод GET, код) | — |
| A-13 | P2 | 4.2 | A / CWE-1021, CWE-693 | api/helpers.php:37-46; прод-заголовки | Нет CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy | подтверждено (прод HEAD) | — |
| A-14 | P2 | 4.8 | A / CWE-312, CWE-540 | api/trip_relay.php:50-64; api/init_db.php:180-185; data/app.db (git, 14 коммитов) | Токены открытым текстом, без ротации; dev-БД с хешами/токеном в git | подтверждено по коду; совпадение с продом — требует проверки | — |
| A-15 | P2 | 6.5 | A / CWE-359, CWE-778 | api/export.php:27; api/load.php; api/reset.php | Полный дамп ПДн любой роли (включая viewer) без аудита выгрузок | подтверждено (dev: viewer export 200) | видимость — проектное решение E8-4; отсутствие аудита — дефект |
| A-16 | P2 | — | A / 152-ФЗ | api/schema.sql:202-214; api/helpers.php:242-245; DEPLOY_HOSTLAND.md §6 | Удержание ПДн: trip_requests.payload бессрочно, 30 открытых бэкапов, 7 дней аудита | подтверждено по коду/документу | — |
| A-17 | P2 | 6.4 | A / CWE-319 | вся система (HTTP) | Отсутствие TLS: пароли, cookie, токены, ПДн, JS открытым текстом | подтверждено (прод) | **риск принят владельцем** |
| A-18 | P3 | 4.3 | A / CWE-400, CWE-778 | api/upload.php:78-80, 156-170 | Upload: нет лимита пикселей; аудит photo.upload — мёртвый код | подтверждено (код; DoS — D-01) | — |
| A-19 | P3 | 0.0 | A / CWE-942 | api/helpers.php:23-29 | CORS `*` без credentials: риска чтения с cookie нет, но политика избыточна | подтверждено | — |
| A-20 | P3 | — | A / 152-ФЗ, CWE-829 | index.html:5 | Google Fonts: IP сотрудников уходит третьей стороне, без SRI | подтверждено | — |
| A-21 | P3 | — | A / CWE-524 | index.html:2661-2666; js/storage.js:486-490; api/logout.php:20-22 | Остаточные ПДн в localStorage/DOM после выхода; logout пишет actor='api' | подтверждено (код; детали E-03) | — |

## 3. Детальные находки

### A-01 · P0 · ПДн сотрудников в статическом index.html раздаются анониму
- **CVSS:** AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N = 7.5. Категория A (+F), CWE-200/540. Совпадает с F-01 (воркер 03), здесь — оценка безопасности.
- **Место:** `index.html:1994` — пререндер матрицы, 933 716 байт в одной строке, 42 `title` с должностями. `index.html:2105-2419` — `defaultData` с карточками сотрудников. Всего 77 строк файла содержат ФИО.
- **Доказательство:**
  - `curl --compressed http://host1882970.hostland.pro/` → 200, анонимно; sha1 = `8922c3a6…` — совпадает с `index.html@101c846`;
  - в прод-файле 38 уникальных полных ФИО с отчеством (маскировано: `А*** С. С.`, `Б*** Н. Г.`, …), там же должности и снимок отпусков;
  - те же 38 ФИО есть в `aa16c93:index.html` (базовый коммит) — они в git-истории и на GitHub.
- **Сценарий:** любой человек в сети (или поисковый робот) открывает `http://host1882970.hostland.pro/` и до логина получает «view-source» со списком сотрудников, должностей, населённых пунктов и периодов отсутствия.
- **Последствия:** незаконное раскрытие ПДн неограниченному кругу лиц (ст. 7, 19 152-ФЗ). Это материал для социальной инженерии (кто в отпуске, кто замещает), утечка уже состоялась. Глобальная видимость (E8-4) касается только залогиненных, поэтому проектным решением это не является.
- **Исправление (не применено):**
  1. В `index.html` заменить строку 1994 пустым контейнером: `<tbody id="matrixBody"></tbody>`. Матрица и так строится `renderMatrix()` (index.html:3596/3650) из данных `load.php` после логина.
  2. `defaultData` (2105-2419) заменить пустой структурой `{employees: [], groups: [...справочник групп без ПДн]}`.
  3. Проверка перед выкладкой: `grep -cP '[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+(вич|вна)' index.html` должен вернуть `0`.
  4. Решение владельца: переписать ли историю git (`git filter-repo`) и сделать ли репозиторий GitHub приватным (проверить, публичный ли он).
  5. Деплой — по команде «Деплой».
- **Уверенность:** подтверждено (код + анонимный GET прода, sha1).

### A-02 · P1 · Хранимый XSS через данные сотрудника, должности, группы
- **CVSS:** AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:H/A:N = 8.7. CWE-79.
- **Место:**
  - карточка — `index.html:4647-4654`:
    ```js
    el.innerHTML = `… ${emp.photo ? `<img src="${emp.photo}" alt="">` : ''} … <div class="name">${emp.name || 'Без имени'}</div>
      <div class="role">${emp.role || ''}</div><div class="location">${emp.location || ''}</div>`;
    ```
  - матрица — `index.html:3608`:
    ```js
    '<td class="name-col" data-emp-id="' + emp.id + '" title="' + (emp.role || '') + '">' + emp.name + '</td>'
    ```
    и `3605` — название группы (`ZONES[...]`);
  - в `js/trips.js` экранирование есть (`escapeHtml`, 1965), в `index.html` его нет вовсе.
- **Источник данных:** `PUT api/employees.php?id=` проверяет только `require_edit()` (employees.php:137-139), без зоны. Добавляем `positions.php` POST/PUT (57-59), `save.php`, `import.php` (admin).
- **Доказательство (dev):** `supervisor_zone1` → `PUT /api/employees.php?id=emp_3` (сотрудник зоны g0) с телом `{"fullName":"Тест<img src=x onerror=alert(document.domain)>","photoUrl":"x\" onerror=\"alert(2)"}` → **200**. В БД сохранено как есть, `load.php` отдаёт без изменений, карточка рендерит через `innerHTML`.
- **Сценарий:** злонамеренный supervisor (или viewer в связке с A-05) кладёт payload в ФИО. При открытии справочника admin'ом JS выполняется в его сессии: `fetch('api/trip_relay.php?action=reveal')`, `fetch('api/export.php')` с отправкой наружу, `POST api/import.php` с пустым backup (полное стирание). HttpOnly защищает cookie, но не действия.
- **Последствия:** эскалация supervisor → admin, кража всех ПДн, уничтожение данных.
- **Исправление:** добавить в `index.html` единый хелпер и применить его во всех сборках HTML:
  ```js
  function escHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  // 4649: ${emp.photo ? `<img src="${escHtml(safeImg(emp.photo))}" alt="">` : ''}
  // 4651-4653: ${escHtml(emp.name || 'Без имени')} / ${escHtml(emp.role)} / ${escHtml(emp.location)}
  // 3605: escHtml(ZONES[currentDept] || 'Без подразделения'); 3608: escHtml(emp.id), escHtml(emp.role), escHtml(emp.name)
  function safeImg(u){return /^images\/photo_[0-9]+_[0-9a-f]{8}\.webp$/.test(u)?u:'';}
  ```
  На сервере (защита в глубину), в employees.php/save.php/import.php:
  ```php
  if ($photo !== null && $photo !== '' && !preg_match('#^images/photo_\d+_[0-9a-f]{8}\.webp$#', $photo)) error('invalid_photo_url', 400);
  ```
  Плюс CSP из A-13.
- **Уверенность:** подтверждено (dev: хранение и отдача payload; sink — по коду). Исполнение в браузере не снималось: браузерный инструмент не имеет доступа к 127.0.0.1 исполнителя.

### A-03 · P1 · Supervisor обходит зону и approved-guard через REST-эндпоинты и save.php
- **CVSS:** AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:L = 7.1. CWE-863. Детали поведения — G-01, B §6, C §6; здесь сводная оценка безопасности.
- **Место и доказательство (dev, supervisor_zone1 = g1):**
  - `employees.php:137-139, 239-241` — только `require_edit()`. Правка `emp_3` (g0) → 200. DELETE доступен supervisor'у любой зоны, каскадно удаляет записи, балансы и участие в командировках (FK CASCADE, schema.sql:69,94,188).
  - `groups.php:57-59/83-85/132-134`, `positions.php:57-59/83-85/132-134` — POST группы и должности supervisor'ом → 201. Удаление группы обнуляет `group_id` у сотрудников (schema.sql:52) и ломает зоны.
  - `entries.php:118-158, 237-266` — supervisor пишет любой статус (vacation/sick) и меняет approved-записи (G-01 A/B, воспроизведено воркером 04).
  - `save.php:504-506, 582`:
    ```php
    $stmtEn->bindValue(':approval_status', $entry['approvalStatus'] ?? $entry['approval_status'] ?? 'draft', …)
    ```
    supervisor создаёт свою запись trip/day_off сразу `approved` («самосогласование», воспроизведено воркером 01).
  - `save.php:734-796` — блоки holidays / vacationBalances / year без проверки admin и зоны: `vacation_balances total_days=999` для чужого сотрудника → 200 (B §6).
- **Сценарий:** supervisor зоны g1 через DevTools/curl с собственной cookie удаляет всех сотрудников зоны g0. Или утверждает себе отпуск, или переименовывает чужих сотрудников (вместе с A-02 — XSS).
- **Последствия:** нарушение модели «зона ограничивает запись», потеря данных (каскад), подлог согласований.
- **Исправление:** единая серверная политика в `auth.php`, вызываемая каждым пишущим эндпоинтом:
  ```php
  function authorize_employee_write(PDO $pdo, string $empId): void {
      $u = current_user(); if (!empty($u['is_admin'])) return;
      $st = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id'); $st->execute([':id'=>$empId]);
      $g = $st->fetchColumn(); if ($g === false) sendJson(['error'=>'not_found'],404);
      require_group_edit($g === null ? null : (string)$g);
  }
  function authorize_entry_write(?array $old, array $new): void {
      $u = current_user(); if (!empty($u['is_admin'])) return;
      if (!in_array($new['status'] ?? '', ['trip','day_off'], true)) sendJson(['error'=>'forbidden_status'],403);
      if ($old && in_array($old['approval_status'] ?? '', ['approved','confirmed'], true)) sendJson(['error'=>'approved_readonly'],403);
      if (in_array($new['approvalStatus'] ?? $new['approval_status'] ?? 'draft', ['approved','confirmed'], true)) sendJson(['error'=>'forbidden_approval'],403);
  }
  ```
  - employees POST/PUT/DELETE: `authorize_employee_write` (для POST — по `groupId` из тела); DELETE и groups/positions POST/PUT/DELETE — `require_admin()`.
  - entries.php POST/PUT/DELETE и save.php цикл entries — `authorize_entry_write`.
  - save.php:734-796 — обернуть в `if (!empty(current_user()['is_admin'])) { … }`.
  - Регрессионные тесты матрицы ролей — см. G-03.
- **Уверенность:** подтверждено (dev; часть пунктов — воркерами 01/04, перепроверено по коду).

### A-04 · P1 · Viewer удаляет записи через PUT/DELETE sync.php
- **CVSS:** AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N = 6.5. CWE-862.
- **Место:** `api/sync.php:95-101`:
  ```php
  if ($method === 'POST') { require_edit(); }
  $body = getJsonBody();
  if (isset($body['deletes']) …)   // выполняется для любого метода, кроме GET-ветки ниже
  ```
- **Доказательство (dev):**
  - `viewer_test` → `PUT /api/sync.php {"deletes":[…]}` → **200** `{"success":true,"deleted":0}` (цель несуществующая — ветка удаления достигнута);
  - `POST` тем же viewer → 403;
  - воркер 04 воспроизвёл фактическое удаление (G-01 п. D); удаление без approved-guard и без audit (G §6).
- **Последствия:** роль «только чтение» стирает календарь, в том числе утверждённые записи. Сработает и «устаревшая вкладка» viewer'а.
- **Исправление:**
  ```php
  if ($method !== 'GET') { require_edit(); }
  if (!in_array($method, ['GET','POST'], true)) sendJson(['error'=>'Method not allowed'],405);
  ```
  В цикле deletes — `authorize_entry_write($old, …)` (A-03) и `audit($pdo,'entry.delete',…)`.
- **Уверенность:** подтверждено (dev).

### A-05 · P1 · CSRF с same-site-доменов `*.hostland.pro` и приём `text/plain`
- **CVSS:** AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:H = 6.8. CWE-352.
- **Место:**
  - `api/helpers.php:65-78` — `getJsonBody()` читает `php://input` без проверки `Content-Type`;
  - `api/auth.php:314-319` — cookie `SameSite=Lax`;
  - нет CSRF-токена и проверки `Origin`.
- **Доказательство:**
  - `hostland.pro` отсутствует в Public Suffix List (проверено по актуальному `public_suffix_list.dat`, 16 563 строки). Значит, все техдомены клиентов `hostNNNN.hostland.pro` для браузера — **один сайт**, и SameSite=Lax отправляет cookie в их cross-origin POST;
  - на dev: `POST /api/employees.php` с `Content-Type: text/plain`, `Origin: http://evil.hostland.pro` и cookie supervisor → **201** (сотрудник создан);
  - preflight для `text/plain` не нужен (simple request).
- **Сценарий:** злоумышленник берёт любой тариф Hostland и получает `hostXXXX.hostland.pro`. На странице размещает:
  ```html
  <form method=POST action="http://host1882970.hostland.pro/api/import.php" enctype="text/plain"><input name='{"groups":[],"employees":[],"x":"' value='"}'></form><script>document.forms[0].submit()</script>
  ```
  Admin открывает ссылку, будучи залогиненным → `import.php` удаляет все данные (`DELETE FROM …`, import.php:53-58). Для supervisor возможны правки и удаление (A-03). Сюда же относятся cookie tossing и login-CSRF (`Set-Cookie: PHPSESSID; Domain=.hostland.pro`). Фиксацию сессии гасит `session_regenerate_id` (login.php:50).
- **Последствия:** полная потеря данных или подлог от имени сотрудника без его ведома.
- **Исправление** (общий bootstrap для всех изменяющих методов, PHP 8.1):
  ```php
  function require_same_origin_json(): void {
      $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
      if (in_array($m, ['GET','HEAD','OPTIONS'], true)) return;
      $ct = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
      $isUpload = $ct === 'multipart/form-data' && basename($_SERVER['SCRIPT_NAME']) === 'upload.php';
      if ($ct !== 'application/json' && !$isUpload) sendJson(['error'=>'unsupported_media_type'], 415);
      $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
      $self = 'http://' . ($_SERVER['HTTP_HOST'] ?? '');
      if ($origin !== '' && $origin !== $self) sendJson(['error'=>'bad_origin'], 403);
      if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') sendJson(['error'=>'csrf'], 403);
  }
  ```
  - Вызывать в `auth.php` после `session_start()`, кроме машинных `vacation_import.php` и `trip_relay.php` (у них токен, не cookie).
  - Фронтенд добавляет `X-Requested-With: XMLHttpRequest` в `fetch` (storage.js, trips.js, index.html). Кастомный заголовок делает запрос «не простым» и требует preflight.
  - Для upload — тот же заголовок.
  - Долгосрочно — собственный домен (тогда SameSite=Lax снова работает) и `SameSite=Strict`.
- **Уверенность:** подтверждено (dev + PSL). Наличие чужих сайтов на `*.hostland.pro` анонимно не проверялось (соседний DNS-запрос не разрешился), но модель хостинга предполагает техдомены у всех клиентов.

### A-06 · P1 · `api/holidays.php` без аутентификации
- **CVSS:** AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L = 6.5. CWE-306.
- **Место:** `api/holidays.php:20-23` — подключены только `helpers.php` и `db.php`, `auth.php` нет. Ни в одной ветке `switch` нет `require_*`.
- **Доказательство:**
  - dev, аноним: `POST {"date":"2027-03-03","label":"<img src=x onerror=alert(1)>"}` → 201, `PUT` → 200, `DELETE {"confirm":true}` → 200;
  - прод, анонимный `GET /api/holidays.php` → 200 `[]` (файл выложен и исполняется). На проде запись не проверялась — запрещено.
- **Сценарий:** аноним в цикле вставляет записи с метками по ~8 МБ (`post_max_size`). Растут `holidays` и `audit_log`, квота диска shared-хостинга исчерпывается, SQLite перестаёт писать — приложение встаёт. Таблица `holidays` в БД UI не рендерится (календарь берётся из `holidays_provider.php`/JSON, storage.js:392), поэтому XSS через label не подтверждён. Но `export.php`/`load.php` отдают эти данные, а save.php их upsert'ит.
- **Последствия:** анонимное изменение БД на проде, DoS по диску, мусор в бэкапах.
- **Исправление:** в `api/holidays.php` после `require_once __DIR__ . '/db.php';`:
  ```php
  require_once __DIR__ . '/auth.php';
  handleOptions();
  $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
  if ($m === 'GET') { require_auth(); } else { require_admin(); }
  ```
  Плюс ограничить `label` (`mb_substr($label, 0, 200)`) и проверять дату по `DateTime::createFromFormat('!Y-m-d')`.
- **Уверенность:** подтверждено (dev + прод GET).

### A-07 · P1 · Служебные и диагностические скрипты доступны анониму на проде
- **CVSS:** AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:L = 6.5. CWE-489/200. Инфраструктурная сторона (состав пакета) — F-02.
- **Место и доказательство:**
  - `api/smoke_test.php:200-224` — при **веб-вызове** выполняет `proc_open('php -S 127.0.0.1:<rnd> -t <root>')` и до 10 с ждёт порт. Прод: `GET /api/smoke_test.php` → 200 и Fatal с полным путём, процесс запускался. Воркер 04 (G-07) показал, что порождённый сервер не завершается `proc_terminate` и остаётся сиротой. Если CLI-PHP хостинга станет ≥5.4, smoke отработает целиком и запишет фикстуры в **боевую** `data/app.db`: сменит `group_id` у `emp_1..emp_18` (smoke_test.php:282-298, C-06).
  - `api/debug_token.php:11-67` — без авторизации. Отражает `Authorization` (`auth_header_raw`, `provided_token`) и при любом Bearer отдаёт `stored_token_preview` = первые 8 + последние 8 hex реального `external_api_token` (стр. 48), плюс неограниченный оракул проверки токена. Прод: файл исполняется (401 без заголовка). Запрос с Bearer на прод не делался — запрещено. На dev: 401 + `stored_token_preview` (замаскировано в отчёте).
  - `api/init_db.php:17-22` — CLI-guard опирается на `STDERR`, под Apache даёт Fatal с путём `/home/host…/htdocs/www/api/init_db.php` (прод 200).
  - `api/schema.sql`, `api/E8_SYNC.md`, `docs/API_DOCUMENTATION.json` — 200 анониму (раскрытие схемы и протоколов).
- **Сценарий:** аноним циклом дёргает `smoke_test.php` — каждый запрос держит воркер Apache до 10 с и порождает процессы. Это DoS shared-аккаунта (лимит процессов Hostland). `debug_token.php` сужает перебор токена импорта до 48 hex и подтверждает гипотезы без лимита.
- **Исправление:**
  1. Удалить с прода `api/smoke_test.php`, `api/debug_token.php`, `api/init_db.php`, `api/seed_positions.php`, `api/schema.sql`, `api/E8_SYNC.md`, `docs/` (по команде «Деплой»).
  2. В репозитории вынести их в `tools/` вне веб-корня; сборку перевести на allowlist, `DEPLOY_HOSTLAND.md` §2/§4 обновить.
  3. Защита в глубину — `api/.htaccess` (Apache 2.4, без `php_flag`):
     ```apache
     <FilesMatch "^(smoke_test|debug_token|init_db|seed_positions)\.php$|\.(sql|md)$">
       Require all denied
     </FilesMatch>
     ```
  4. В начале каждого CLI-скрипта: `if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }` — до любых `require`.
- **Уверенность:** подтверждено (прод GET + код; утечка фрагмента токена на проде не проверялась — запрещено, по коду однозначна).

### A-08 · P1 · Токен RPA-робота раскрывается supervisor'у; с токеном — опустошение очереди и подделка callback
- **CVSS:** AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:H/A:L = 7.6. CWE-269/522.
- **Место:**
  - `api/trip_relay.php:103-110` — `reveal` защищён `require_auth(); require_edit();`, то есть доступен любому supervisor. Аудита раскрытия нет (F-05);
  - poll 115-155 выдаёт заявку ровно один раз (`delivered`);
  - callback 160-209 — last-write-wins по `requestId`. `requestId` предсказуем: `SC-trip-<N>-<unixtime>`, helpers.php:113-116.
- **Доказательство (dev):** `supervisor_zone0` → `GET /api/trip_relay.php?action=reveal` → **200** `{"success":true,"token":"<64 hex, MASKED>"}`; viewer → 403.
- **Сценарий:** supervisor раскрывает токен, затем:
  - (а) поллит `GET trip_relay.php` с `X-Auth-Token` — каждая заявка помечается `delivered` и больше **никогда** не уходит настоящему роботу (B-11): командировки не оформляются в HelpMe;
  - (б) шлёт `POST {"requestId":…,"status":"created","ticketId":"FAKE"}` — UI показывает «заявка создана» при отсутствии тикета;
  - (в) читает payload всех командировок (телефон, аванс, маршрут).
- **Последствия:** срыв оформления командировок (выплаты аванса, билеты), подлог статусов, утечка ПДн за пределы зоны записи.
- **Исправление:** в trip_relay.php:104-105 `require_admin();` вместо `require_auth(); require_edit();`, плюс `audit($pdo,'relay.token_reveal',null,null,'system',null,['ip'=>$_SERVER['REMOTE_ADDR']??'']);`. Добавить `?action=rotate` (admin) с `UPDATE meta SET value=:new WHERE key='rpa_relay_token'`. В callback принимать переход только из `delivered` (`… WHERE request_id=:rid AND status='delivered'`) и не затирать `ticket_id` значением null. Повторная выдача и TTL — B-11.
- **Уверенность:** подтверждено (dev: reveal; последствия — по коду + B-11).

### A-09 · P2 · CSV/формульная инъекция в выгрузке аудита
- **CVSS:** AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N = 6.1. CWE-1236.
- **Место:** `api/audit_export.php:123-139` (`buildCsv`) — экранирует только `; " \r \n`. Ведущие `= + - @ \t \r` не нейтрализуются. Источник — `api/login.php:45`: `audit(…,'auth.login_failed',…,'user',$username,…)` — логин произвольного анонима.
- **Доказательство (dev):** анонимный логин с `username = =HYPERLINK("http://evil/","click")` → admin `GET audit_export.php?format=csv&days=1`. В файле: `…;auth.login_failed;user;"=HYPERLINK(""http://evil/"",""click"")";…`. Excel исполняет формулу и в кавычках CSV.
- **Последствия:** при открытии выгрузки admin'ом — фишинговые ссылки, `WEBSERVICE`/DDE-эксфильтрация соседних ячеек (ПДн из details) в зависимости от настроек Excel. XLSX-путь безопасен (`t="inlineStr"`, audit_export.php:256). MD-путь допускает только инъекцию `|` в разметку (косметика).
- **Исправление:**
  ```php
  $v = (string) ($row[$c] ?? '');
  if ($v !== '' && strpbrk($v[0], "=+-@\t\r") !== false) { $v = "'" . $v; }
  if (preg_match('/[;"\r\n]/', $v)) { $v = '"' . str_replace('"', '""', $v) . '"'; }
  ```
  И в login.php писать в аудит `mb_substr($username, 0, 64)`.
- **Уверенность:** подтверждено (dev).

### A-10 · P2 · Нет защиты от перебора паролей, перечисление логинов, слабая парольная политика
- **CVSS:** AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N = 6.5. CWE-307/204/521.
- **Место:** `api/login.php:38-47` — нет счётчика и задержки. `password_verify` выполняется только для существующего пользователя (стр. 43), отсюда разница во времени ответа. `api/change_password.php:53` — минимум 8 символов, тогда как DEPLOY_HOSTLAND §7/§9 требует «12+». Стартовые `changeme` (init_db.php) — смена на проде подтверждена только документом.
- **Доказательство (dev):** 30 неудачных логинов admin — все 401 за 2,4 с, без блокировки. Среднее время: существующий `admin` — 81 мс, несуществующий — 32 мс (по 5 замеров). Логины ролей предсказуемы (`admin`, `supervisor_zone0/1`).
- **Последствия:** онлайн-перебор паролей с любой точки интернета; на HTTP без TLS — в сочетании с A-17.
- **Исправление:**
  ```php
  // login.php, до SELECT:
  $ip = $_SERVER['REMOTE_ADDR'] ?? '';
  $st = $pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE action='auth.login_failed' AND ts >= :t AND (entity_id = :u OR details LIKE :ip)");
  $st->execute([':t'=>date('c', time()-900), ':u'=>$username, ':ip'=>'%"ip":"'.$ip.'"%']);
  if ((int)$st->fetchColumn() >= 10) sendJson(['success'=>false,'error'=>'too_many_attempts'], 429);
  // выравнивание тайминга:
  $hash = $row['password_hash'] ?? '$2y$10$abcdefghijklmnopqrstuuJ2bMZ4w4fX1e2F7wqzIUxcGzpZJHUe6';
  $ok = password_verify($password, $hash) && $row;
  ```
  - В change_password.php — `mb_strlen($newPassword) < 12`.
  - Нужен индекс `audit_log(action, ts)` (C-блок). Аудит хранится 7 дней, поэтому окно 15 мин помещается.
- **Уверенность:** подтверждено (dev).

### A-11 · P2 · Смена пароля не завершает другие сессии; нет тайм-аутов сессии
- **CVSS:** AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:N = 4.8. CWE-613.
- **Место:** `api/change_password.php:49-73` — только `UPDATE users SET password_hash`, без `session_regenerate_id` и без отзыва других сессий. `api/auth.php:314-320` — время жизни задаётся только `session.gc_maxlifetime` хостинга; idle/absolute тайм-аутов в коде нет.
- **Доказательство (dev):** два логина `supervisor_zone1` (сессии A и B), смена пароля в A → 200, сессия B → `load.php` **200**. Logout корректен: старый SID после выхода → 401.
- **Сценарий:** сотрудник замечает перехват пароля или cookie (A-17) и меняет пароль, но атакующий с украденной cookie сохраняет доступ.
- **Исправление:**
  - добавить в `users` колонку `session_epoch INTEGER DEFAULT 0` (миграция v9);
  - в login сохранять `$_SESSION['epoch'] = $row['session_epoch']`;
  - в `current_user()` при `$row['session_epoch'] != ($_SESSION['epoch'] ?? -1)` → `return null`;
  - в change_password выполнять `UPDATE users SET password_hash=:h, session_epoch=session_epoch+1`, затем `session_regenerate_id(true); $_SESSION['epoch']=…`;
  - тайм-ауты: `$_SESSION['last'] ??= time(); if (time()-$_SESSION['last'] > 8*3600) { session_destroy(); return null; } $_SESSION['last']=time();`.
- **Уверенность:** подтверждено (dev).

### A-12 · P2 · Раскрытие деталей ошибок и путей
- **CVSS:** AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N = 5.3. CWE-209.
- **Место:**
  - `api/helpers.php:124-127` и 19 блоков `error('Server error: ' . $e->getMessage(), 500)` — полный список в G-10, например login.php:61, trip_relay.php:213, holidays.php:156 (анонимно);
  - `vacation_import.php:398` — `db_error: …` в теле 200;
  - прод: `display_errors=On` — Fatal с полным путём `/home/host…/htdocs/www/api/init_db.php` анониму (00_MAP §3);
  - заголовок `X-Powered-By: PHP/8.1.34`.
- **Последствия:** раскрытие путей хостинга, имён таблиц и колонок (`SQLSTATE…`), версий — облегчает остальные атаки.
- **Исправление:**
  ```php
  // helpers.php (подключается всеми api/*.php) — в начале файла:
  ini_set('display_errors', '0'); ini_set('log_errors', '1'); header_remove('X-Powered-By');
  function server_error(Throwable $e): void {
      $ref = bin2hex(random_bytes(4)); error_log("[$ref] " . $e);
      sendJson(['error' => 'server_error', 'ref' => $ref], 500);
  }
  ```
  - все `error('Server error: ' . $e->getMessage(), 500)` заменить на `server_error($e)`;
  - дополнительно `.user.ini` в корне сайта: `display_errors=Off`, `expose_php=Off` — проверить поддержку панелью Hostland (F-03).
- **Уверенность:** подтверждено (прод GET + код).

### A-13 · P2 · Нет заголовков безопасности
- **CVSS:** AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N = 4.2. CWE-1021/693.
- **Место:** `api/helpers.php:37-46` (`sendJson`) и статика. Прод: `/api/session.php` и `/` без CSP, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`. Кэш для ответов с ПДн корректен: `session_start()` ставит `Cache-Control: no-store` на всех `api/*` с auth.php; у `holidays*.php` его нет, но там нет ПДн.
- **Последствия:** clickjacking UI (например, кнопок удаления); нет второго рубежа против A-02 и MITM-инъекций.
- **Исправление:**
  - в `sendJson()` и в начале `auth.php`: `header('X-Content-Type-Options: nosniff'); header('X-Frame-Options: DENY'); header('Referrer-Policy: same-origin');`;
  - для `index.html` — `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'">` (frame-ancestors в meta не работает → X-Frame-Options через `.htaccess` в корне без php_flag: `Header always set X-Frame-Options DENY` — проверить mod_headers на Hostland);
  - `'unsafe-inline'` вынужден из-за монолита (G-11). Полноценная CSP — после выноса inline JS.
- **Уверенность:** подтверждено (прод HEAD).

### A-14 · P2 · Токены в открытом виде без ротации; dev-БД с секретами в git
- **CVSS:** AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:N = 4.8. CWE-312/540.
- **Место:**
  - `meta.external_api_token` и `meta.rpa_relay_token` хранятся в открытом виде (trip_relay.php:50-64);
  - `init_db.php:180-185` печатает токен в stdout, DEPLOY_HOSTLAND §8 предлагает читать его `sqlite3`;
  - механизма ротации нет;
  - `data/app.db` в git (14 коммитов с `aa16c93`) содержит dev-токен импорта и bcrypt-хеши 4 учёток с паролем `changeme`.
- **Сценарий:** любой, кто получил копию БД (бэкап из §6, git-клон, A-01-подобная утечка), получает действующие токены. Совпадают ли прод-токены и хеши с dev-БД — **требует проверки**: по DEPLOY §2 прод-БД создаётся свежей в staging, но E10-восстановления могли переносить файл.
- **Исправление:**
  - хранить `hash('sha256', $token)` и сравнивать `hash_equals($storedHash, hash('sha256', $provided))`; reveal заменить на однократную генерацию с показом (`?action=rotate`, admin);
  - убрать `data/app.db` из git (`git rm --cached data/app.db`, `.gitignore`, генерировать фикстуру скриптом);
  - владельцу — сверить, что прод-токены не равны dev (сравнить первые 4 символа на сервере, не выводя значение).
- **Уверенность:** по коду подтверждено; совпадение с продом — требует проверки.

### A-15 · P2 · Полный дамп ПДн любой роли без аудита выгрузок
- **CVSS:** AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N = 6.5. CWE-359/778.
- **Место:** `api/export.php:27` (`require_auth()` — viewer тоже), `load.php`, `reset.php` (мёртвый дубль, G-05). Аудита выгрузки нет (F-05).
- **Доказательство (dev):** `viewer_test` → `GET /api/export.php` → 200: телефоны, локации, все периоды отсутствия, включая `sick`.
- **Статус:** глобальная видимость — **проектное решение E8-4**. Дефекты — массовая выгрузка файлом (`?download=1`) для viewer и отсутствие следа в аудите. Сведения о больничных («здоровье», спецкатегория) видны всем ролям.
- **Исправление:** `export.php` → `require_admin()` + `audit($pdo,'data.export',…)`. В `load.php` для не-admin маскировать причину `sick` как «отсутствует» (`status='absence'`) — **требует решения владельца/юриста**, меняет UX. Удалить `reset.php` (не используется фронтендом, G-05).
- **Уверенность:** подтверждено (dev).

### A-16 · P2 · Удержание ПДн: очередь робота, бэкапы, журналы
- Категория A/152-ФЗ (технические меры).
- **Место:**
  - `trip_requests.payload` (schema.sql:202-214) хранит телефон, маршрут, гостиницу, транспорт, сумму аванса, ФИО — **бессрочно**, очистки нет (C-08); `last_error` от робота — произвольный текст;
  - `audit_log.details` — 7 дней (helpers.php:242-245; F-06 — мало для расследований);
  - `sync_log` — 10 000 строк;
  - бэкапы — 30 полных копий БД в открытом виде в `~/backups` (DEPLOY_HOSTLAND §6);
  - фото удалённых сотрудников остаются в `images/`: удаление сотрудника файл не трогает, `unlink` в коде есть только в audit_export.php.
- **Исправление:**
  - очистка `DELETE FROM trip_requests WHERE status IN ('created','validation_error','failed') AND done_at < :cut` (90 дней) — в том же вероятностном хуке, что `audit_cleanup`;
  - при DELETE сотрудника — `@unlink` его `photo_url` после проверки regexp из A-02;
  - бэкапы шифровать (`gpg --symmetric` в cron-строке) — требует проверки возможностей панели;
  - срок хранения аудита — решение владельца (рекомендация 90 дней).
- **Уверенность:** подтверждено по коду и документу.

### A-17 · P2 · Отсутствие TLS — **риск принят владельцем**
- **CVSS:** AV:A/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:N = 6.4. CWE-319.
- **Последствия (текущие):**
  - пароли при логине и смене пароля — открытым текстом;
  - `PHPSESSID` перехватывается (`secure=false` вынужден);
  - все ответы API с ПДн, включая больничные и авансы, — в открытом виде;
  - `Authorization: Bearer` импорта и `X-Auth-Token` робота перехватываются на любом участке сети между HelpMe/внешней системой и Hostland;
  - MITM может подменить `index.html`/JS — эквивалент A-02 без авторизации.
  - Для 152-ФЗ (ПП №1119, приказ ФСТЭК №21) защита канала — обычно обязательная мера → вопрос юристу.
- **Рекомендация:** Hostland предоставляет бесплатный Let's Encrypt для своих доменов. Для техдомена — проверить в панели. Как только TLS появится: `secure=true`, HSTS, A-05 решается доменом вне hostland.pro.

### A-18 · P3 · Загрузка фото: лимит пикселей и мёртвый аудит
- **CVSS:** AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L = 4.3. CWE-400/778.
- **Проверено, корректно:**
  - `finfo` по содержимому, whitelist jpeg/png/webp (upload.php:56-60);
  - лимит 2 МБ;
  - случайное имя `photo_<time>_<8hex>.webp` (69);
  - перекодирование в WebP и `stripImage()` (EXIF);
  - каталог `images/` с `FilesMatch \.php$ deny` (прод 403 на листинг).
- **Дефекты:**
  - `new Imagick($tmp)` (78) без `Imagick::setResourceLimit` и проверки размеров → «пиксельная бомба» (D-01, воспроизведено воркером 02);
  - `sendJson()` (156) делает `exit`, поэтому блок аудита `photo.upload` (163-170) недостижим.
- **Исправление:**
  - до `new Imagick`: `[$w,$h] = getimagesize($file['tmp_name']) ?: [0,0]; if ($w*$h > 40_000_000 || $w > 10000 || $h > 10000) error('image_too_large',400); Imagick::setResourceLimit(Imagick::RESOURCETYPE_MEMORY, 256*1024*1024);`;
  - аудит перенести **перед** `sendJson`.

### A-19 · P3 · CORS `Access-Control-Allow-Origin: *`
- **Место:** `api/helpers.php:23-29`. Без `Allow-Credentials`, поэтому браузер не даёт чужим origin'ам читать ответы с cookie (проверено: preflight 204, ACAO `*`). Токенные эндпоинты вызываются не из браузера. Реального риска чтения нет; CSRF-запись — отдельно (A-05).
- **Исправление:** убрать `corsHeaders()` из прод-ответов (фронтенд same-origin) или ограничить `Access-Control-Allow-Origin: http://host1882970.hostland.pro`.

### A-20 · P3 · Внешние Google Fonts
- **Место:** `index.html:5` — каждый вход сотрудника передаёт IP и User-Agent Google (трансграничная передача, 152-ФЗ ст. 12 → вопрос юристу); SRI нет.
- **Исправление:** положить шрифт Inter (woff2) в `css/fonts/` и подключить локально.

### A-21 · P3 · Остаточные ПДн на клиенте после выхода; аудит logout
- **Место:**
  - `index.html:2661-2666`, `js/storage.js:486-490`: localStorage-кэш состояния и DOM не очищаются при logout (подробно E-03); на общем ПК следующий пользователь видит данные до логина;
  - `api/logout.php:20-22`: `$_SESSION = []` выполняется **до** `current_user()`, поэтому аудит выхода всегда пишет `actor='api', role='anonymous'`.
- **Исправление:**
  - на клиенте при logout: `localStorage.removeItem(<ключи StorageAdapter>)` и `location.reload()`;
  - в logout.php переставить строки 20 и 22–24 (сначала прочитать пользователя, потом очистить сессию).

## 4. Проверено, проблем не найдено

- **SQL-инъекции:** все запросы с данными идут через `prepare` + `bindValue`/`execute`. Динамические фрагменты — только имена колонок из фиксированных `$map` (employees.php:170-189, groups.php:95-112, positions.php, holidays.php:94-109) и условия entries.php:58-72 с плейсхолдерами. `save.php:59` — конкатенация `(int)`. Миграции `db.php` — константные DDL. Сортировки из ввода нет. Конкатенация с переменными (`'{$fid}'`) есть только в `smoke_test.php` с константами — вне прод-логики, но скрипт на проде (A-07).
- **Хранение паролей:** `password_hash(PASSWORD_DEFAULT)` и `password_verify`; хеши в API не отдаются (`public_user()`, auth.php:389-400), `export.php` таблицу `users` не выгружает, `import.php` пользователей не трогает → эскалации до admin через импорт нет.
- **Фиксация сессии:** `session_regenerate_id(true)` при логине (login.php:50); HttpOnly + SameSite=Lax установлены (прод `Set-Cookie` подтверждён). Logout уничтожает сессию: старый SID → 401 (dev).
- **Сравнение токенов:** `hash_equals` в vacation_import.php:69, trip_relay.php:86, debug_token.php:51. Генерация — `random_bytes(32)` (256 бит).
- **Mass assignment ролей:** API изменения `users` нет; `is_admin`/`can_edit`/`scope_group_id` из тела нигде не читаются.
- **Path traversal / LFI:** `holidays_provider.php:39-56` — `(int)$year` в диапазоне 2000–2100; имя фото генерируется сервером; `photo_url` из тела в ФС не попадает (unlink по нему нет); `audit_export.php` временные файлы — `tempnam` + `unlink`; `Content-Disposition` — имя из `date()` и whitelist формата. `router.php` (`urldecode` + `file_exists`) — только dev, на прод не выкладывается (прод 404).
- **XSS в js/trips.js:** пользовательские поля (title, location, phone, hotel, участники) выводятся через `escapeHtml` (1965); `trip.id` в `onclick` генерируется сервером (`genId('trip_')`, trips.php:473), id из тела не принимается.
- **DOM-based XSS / reflected:** `document.write`, `eval`, `new Function` в index.html/js отсутствуют; параметры URL в DOM не выводятся; API отвечает `application/json`.
- **Защитный пункт OWASP:** `unserialize`, `eval`, `shell_exec/system/passthru/popen`, XML-парсеры, `include`/`require` с переменной, редиректы по вводу, исходящие HTTP в рабочем коде **отсутствуют**. `proc_open` и `curl` — только в `smoke_test.php` (A-07). XLSX генерируется через ZipArchive с `xmlEsc` (audit_export.php:241,256).
- **Доступ к БД по вебу:** `/data/app.db`, `-wal`, `-shm`, `/data/holidays/*.json`, `/.git/HEAD`, `.htaccess` → 403 на проде; листинг каталогов закрыт.
- **vacation_import.php:** аутентификация до разбора тела; ошибка БД при аутентификации не раскрывается (стр. 72-75). Корректность поиска по ФИО — блок B (B-15/B-16).
- **Импорт/восстановление:** `import.php` — `require_admin()`; деструктивность при CSRF — A-05, при частично невалидном backup — B-18/C-03.

## 5. Что не удалось проверить

- Запись на проде (`holidays.php`, CSRF, токены) — запрещено условиями; вывод по коду и dev, код на проде байт-в-байт тот же (sha1 index.html; воркер 03 — sha1 trips.js).
- Исполнение XSS в реальном браузере: payload сохранён и отдан (dev), sink однозначен по коду; браузерный рендер не снимался.
- Наличие чужих сайтов на `*.hostland.pro` (A-05) — проверен только PSL.
- Совпадение прод-токенов и хешей с dev-БД из git (A-14), фактический cron бэкапов и права на `~/backups` — нужен доступ владельца.
- Настройки `session.gc_maxlifetime`, `post_max_size`, политика Imagick на Hostland — нужен `phpinfo()` под авторизацией владельца.
- Сторона HelpMe и внешней системы импорта: хранение токенов, TLS на их стороне, что делает HelpMe с payload.

## 6. Самопроверка

- **A-01:** `/` — само приложение, `.htaccess` не закрывает; E8-4 описывает видимость для залогиненных → не проектное решение. Прод-проверка — анонимный GET, ПДн в отчёте замаскированы.
- **A-02:** защиты выше нет — `require_edit` пропускает supervisor, зоны в employees.php нет, CSP нет, `escapeHtml` в index.html не используется.
- **A-03/A-04:** проверено отсутствие `require_group_edit`/`require_admin` в указанных ветках; guard'ы save.php (E10) эти эндпоинты не покрывают; фронтенд их не вызывает, но они доступны по HTTP (воспроизведено).
- **A-05:** `getJsonBody` не проверяет тип, CSRF-токена нет, проверки Origin нет; SameSite=Lax в same-site-сценарии не действует (PSL). Внешний кросс-сайт (не hostland.pro) — Lax блокирует POST-cookie, поэтому вектор сужен до same-site и MITM → P1, не P0.
- **A-06:** `auth.php` не подключён вовсе — проверено по полному листингу файла.
- **A-07:** документ прод-пакета их не исключает (§4 `cp -a api`), прод отвечает 200/401.
- **A-08:** reveal защищён `require_edit` — supervisor проходит; в шапке trip_relay.php:11-12 это описано как «admin/supervisor». Это сознательное, но не согласованное с моделью ролей решение (supervisor ограничен зоной, а токен даёт доступ ко всей очереди) → оставлено как дефект P1. Если владелец подтвердит, что supervisor должен видеть токен, — понизить до P2 и закрыть только аудит и ротацию.
- **A-17:** помечено «риск принят владельцем»; A-15 — частично «проектное решение».
- **Отклонённые гипотезы:**
  - SQLi через динамические UPDATE — нет (whitelist колонок);
  - XSS через `label` праздников — UI таблицу `holidays` не рендерит;
  - XXE в XLSX — генерация, не парсинг;
  - path traversal через `year` — int-cast.
