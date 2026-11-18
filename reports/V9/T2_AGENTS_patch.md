# V9-T2 — патч для AGENTS.md (применяет координатор)

1. В разделе «Verification», в перечне эталона `BASELINE` добавить `tasklinksui 211` (после `tasklinks 37`); дату эталона обновить.
2. В таблицу сьютов добавить строку после `tasklinks (V9-T1)`:

| tasklinksui (V9-T2) | `bash scripts/verify_all.sh tasklinksui` (= `node scripts/test_tasks_links_ui.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~2 мин; скриншоты — `TASKLINKSUI_SHOTS=<каталог>`) | `RESULT: 211 passed, 0 failed`; поле «Связанные задачи» (только admin), окно выбора по ключу `(())`, чипы в карточке (перечёркнутая — удалённая задача), «Также связана с:», клик → «Список» связанных (`S.filters.rel`, плашка и «×»), supervisor/viewer — ссылки без записи, 375/1280 без горизонтального скролла; без Chromium падает, а не пропускается |
