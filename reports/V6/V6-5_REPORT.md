# V6-5 — Исправления по приёмке V6-4 (P2-1, P2-2, P2-3, P3-1, P3-2, P3-3, P3-5)

Исполнитель: sd_worker_03, ветка `main`, 2026-11-13. Источник: `reports/V6/V6-4_ACCEPTANCE.md` §6. Без push и deploy. Вкусовые замечания §9 (бриллианты, полоса группы в матрице, штриховка, цвета) не трогались. P3-4 (сканирование `scripts/*` сьютом `director`) — «принять к сведению», в объём не входило.

## Что сделано

| № | Что изменено (`файл:строка`) | Доказательство |
|---|---|---|
| **P2-1 (R-14)** ФИО в плитке Доски — ссылка → Список с одним фильтром | `js/tasks.js:363-371` `nameStrike`: действующий исполнитель → `<span role="button" tabindex="0" class="tk-name tk-namebtn" data-tk-act="filterEmp" data-emp=…>` (тот же `ACTIONS.filterEmp`, что у Списка/карточки); удалённый исполнитель открытой задачи — по-прежнему `<s class="tk-gone">`, у закрытой — обычный текст. Клавиатура: `js/tasks.js:1244` (`onKeyTag` теперь знает и `.tk-namebtn`). CSS `.tk-namebtn{cursor:pointer}` — `js/tasks.js:1696` | Это `span[role=button]`, а не `<a>`: ссылка/кнопка внутри `draggable`-карточки перехватывает перетаскивание (тот же приём, что `tagBtn`). `onClick` берёт ближайший `[data-tk-act]` → это `filterEmp`, а не `openTask`: карточка не открывается. Роли: `filterEmp` не пишет, работает у supervisor/viewer. Тесты и Chromium — ниже |
| **P2-2 (R-11)** узкие плитки «Недели» | `js/tasks.js:1755`: `.tk-ev.tk-ev-n{padding:1px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` вместо `word-break:break-word`. Класс `tk-ev-n` ставится как раньше (`js/tasks.js:637`: `cols>=3` и режим «Неделя»); полная тема уже в `title` | В Chromium (4 задачи 09:00–11:00): `white-space:nowrap`, `overflow:hidden`, `text-overflow:ellipsis`, `word-break:normal`, текст в 1 строку, у 4/4 плиток; `title` = полная тема. Обычные плитки (1–2 дорожки) и «День» — без изменений (проверено: `white-space:normal`, `tk-ev-n` нет) |
| **P2-3** `scp` в шаге данных | `reports/V6/V6-3_DATA_STEP.md:49-52`: `scp -P 1024 reports/V6/assets/director_avatar.jpg host1882970@serv18.hostland.ru:/home/host1882970/host1882970.hostland.pro/htdocs/www/images/photo_1794600000_d1ec7040.jpg` (порт, хост, путь — из `DEPLOY_HOSTLAND.md:16,17,103-104`); комментарий, что переменных нет, пароль вводит владелец в сессии | Команда целиком, без `$WWW` и плейсхолдеров; пароля нет. Не выполнялась (прод не трогали) |
| **P3-1** `.timeout 5000` | `scripts/v6_director_data.sql:89`, прямо перед `.bail on` (строка 90). Описание добавлено в `V6-3_DATA_STEP.md:74` | Сьют `director` (70/70) прогоняет скрипт APPLY на копии БД — зелёный |
| **P3-2** «Ctrl+F5» после APPLY | `reports/V6/V6-3_DATA_STEP.md:76`: «**После APPLY: Ctrl+F5 во всех открытых окнах**» + причина | — |
| **P3-3** CODEMAP | `CODEMAP.md` перегенерирован командой из `AGENTS.md`: `rg --json -n --sort path "function \|const .*=.*=>" index.html js/storage.js js/tasks.js js/tasks_matrix.js js/trips.js` (`--sort path` — детерминированный порядок; файла `js/vacations.js` из текста AGENTS.md в репозитории нет — заменён реальными `js/storage.js`, `js/tasks.js`, `js/tasks_matrix.js`; прежний CODEMAP тоже не содержал `tasks_matrix.js`) | 579 записей (было 483): `js/tasks.js` 282, `index.html` 139, `js/trips.js` 78, `js/tasks_matrix.js` 47, `js/storage.js` 32. `function nameStrike` в CODEMAP на `js/tasks.js:363` — совпадает с файлом |
| **P3-5** отчёт V6-1 | `reports/V6/V6-1_REPORT.md` §R-14 (строка 17): «в плитке Доски ФИО не было ссылкой … исправлено в V6-5»; §6 (строка 88): sync двух окон проверен в реальных окнах приёмкой V6-4 §4; §7: CODEMAP перегенерирован в V6-5 | — |

## Тесты (BASELINE поднят в том же коммите)

- `scripts/test_tasks_frontend.js` (**tasksui 187 → 194**, +7): `V6-5 P2-1` ×5 (разметка плитки: span/role/data-emp/title, нет `<a>`, `draggable` — на корне карточки; CSS-указатель; клик → «Список», ровно один фильтр `emp`, `selectedId` пуст; Enter с клавиатуры) и `R-supervisor-7`/`R-viewer-7` (у ролей без записи ФИО в плитке работает, плитки без `draggable`). Старая проверка `P3-3` (зачёркивание удалённого на Доске, `:727`) обновлена под новую разметку и по-прежнему требует `<s class="tk-gone">` у удалённого.
- `scripts/test_tasks_calendar.js` (**taskscal 110 → 112**, +2): `R11-7` (CSS узкой плитки: nowrap + overflow:hidden + ellipsis, нет word-break; полная тема в `title`) и `R11-8` (правило только для `.tk-ev-n`; обычные плитки и «День» не затронуты).
- `scripts/verify_all.sh:18` — `[tasksui]=194`, `[taskscal]=112`.

## Реальный Chromium (1280 и 375)

Скрипт `scripts/v6_accept_v65.js` (каркас V6-4: `php -S` на копии `data/app.db`, headless Chromium по CDP, реальные мышиные события; перетаскивание — `Input.dispatchDragEvent`). Итог: **`RESULT: 17 passed, 0 failed`**, исключений на странице нет (`reports/V6/V6-5_screens/V65_results.json`).

| Проверка | 1280 | 375 |
|---|---|---|
| ФИО в плитке Доски — кнопка (синий, пунктир, курсор-указатель) | PASS | PASS |
| Реальный клик по ФИО → «Список», фильтры: только `emp=emp_101`, строки только этого сотрудника, карточка не открыта | PASS | PASS |
| Клик по самой плитке (не по ФИО) по-прежнему открывает карточку | PASS | PASS |
| Drag&drop, **начатый прямо с ФИО**: «Открыта» → «Закрыта» (на сервере `status=closed`), «Список» не открылся | PASS | PASS |
| Drag&drop обратно (с заголовка плитки) «Закрыта» → «Открыта» | PASS | PASS |
| «Неделя», 4 пересекающиеся задачи 09:00–11:00: у всех 4 плиток nowrap/hidden/ellipsis, 1 строка, `title` = полная тема | PASS | PASS |
| Обычные плитки недели — стиль прежний; «День» без `tk-ev-n` | PASS | PASS |

Скриншоты: `reports/V6/V6-5_screens/` — `V65_01_board_names_*` (ФИО-ссылки в плитках), `V65_02_name_click_list_*` (Список после клика), `V65_03_board_after_drag_*` (Доска после drag&drop с ФИО), `V65_04_week_narrow_*`/`V65_05_week_0900_*` (неделя), `V65_06_day_*` («День»).

Наблюдение (не дефект исполнения, на решение владельца): при 4 дорожках плитка шириной ~20 px показывает только 1–2 символа и «…» (скрин `V65_05_week_0900_1280.png`) — переноса по буквам больше нет, как и требовалось; полная тема — в подсказке (`title`) и в карточке по клику. Если владелец хочет читаемость в такой ширине — нужна отдельная доработка (например, вертикальный текст или разворачивание при наведении).

## Gate (`bash scripts/verify_all.sh`, целиком)

```
verify_all: 8ff13b2 2026-11-13 04:03:51 suites: smoke tasks tasksn8n tasksui tasksmx taskscal director e51 e52 hygiene trips syntax phplint pii

SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     2s  
tasks    PASS     47     47     2s  
tasksn8n PASS     25     25    26s  
tasksui  PASS    194    194    12s  
tasksmx  PASS     71     71     5s  
taskscal PASS    112    112     3s  
director PASS     70     70     7s  
e51      PASS     23     23     0s  
e52      PASS     41     41     0s  
hygiene  PASS     19     19     0s  
trips    PASS      7      7     3s  
syntax   PASS      -      -     0s  
phplint  PASS     33      -     2s  
pii      PASS      -      -     0s  
clean    PASS

GATE: PASS (14 suites)
```

`data/app.db` не менялась (`git diff --quiet data/app.db`).

## Отклонения / открытые вопросы

1. **`AGENTS.md:33` (строка эталона) не обновлена** — запись в `AGENTS.md` заблокирована политикой защиты файлов инструкций (запрос подтверждения без ответа; повторно не обходилась). Единственный источник эталона — `BASELINE` в `scripts/verify_all.sh` (обновлён). В `AGENTS.md:33` остаются `tasksui 187`, `taskscal 110`: нужно поправить на `tasksui 194`, `taskscal 112` (дата «2026-11-13 (V6-5)») — координатору/владельцу.
2. Пункт AGENTS.md о CODEMAP называет `js/vacations.js`, которого нет; текст в `AGENTS.md` не менялся (см. п.1).
3. Не делалось и не входило в объём: P3-4, вкусовые замечания §9, push, deploy; Роадмап не трогался (нет одобрения владельца).
