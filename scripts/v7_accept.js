// V7 (приёмка, вне gate): вложения задач в РЕАЛЬНОМ Chromium (CDP). php -S на КОПИИ data/app.db с лимитами PHP прода
// (upload_max_filesize/post_max_size = 256M → действующий лимит 5 МБ). Файлы выбираются через настоящий диалог выбора
// (Page.setInterceptFileChooserDialog + DOM.setFileInputFiles) и перетаскиваются настоящими drag-событиями (Input.dispatchDragEvent).
// Запуск: node scripts/v7_accept.js → reports/V7/V7_screens/*.png, V7_results.json. Пароли в браузер не вводятся.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const L0 = require('./v6_accept_lib.js');
const { seed, D } = require('./v6_accept_seed.js');
const sleep = L0.sleep;
const OUT = path.join(L0.ROOT, 'reports/V7/V7_screens');
fs.mkdirSync(OUT, { recursive: true });

async function startEnvProd() {
  const env = await L0.startEnv();
  try { env.srv.kill(); } catch (e) { /* */ }
  await sleep(300);
  const e2 = Object.assign({}, process.env, { SC_APP_DB: env.tmpDb }); delete e2.TASKS_VALIDATE_WEBHOOK_URL;
  env.srv = cp.spawn('php', ['-d', 'upload_max_filesize=256M', '-d', 'post_max_size=256M', '-S', '127.0.0.1:' + env.port, '-t', L0.ROOT], { env: e2, cwd: L0.ROOT, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(env.base + '/api/session.php'); if (r.status < 500) break; } catch (e) { /* */ } await sleep(100); }
  const c0 = env.cleanup;
  env.filesDir = path.join(path.dirname(env.tmpDb), 'task_files');
  env.cleanup = () => { try { env.srv.kill(); } catch (e) { /* */ } c0(); };
  try { fs.rmSync(env.filesDir, { recursive: true, force: true }); } catch (e) { /* */ }   // каталог вложений копии — с нуля
  return env;
}

function makeFixtures(dir) {
  const php = `
    $d = $argv[1];
    file_put_contents("$d/Акт приёмки.pdf", "%PDF-1.4\\n1 0 obj<<>>endobj\\ntrailer<<>>\\n%%EOF\\n");
    $ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
    foreach (['Договор поставки.docx' => 'word/document.xml', 'График смен.xlsx' => 'xl/workbook.xml'] as $n => $inner) {
      $z = new ZipArchive(); $z->open("$d/$n", ZipArchive::CREATE | ZipArchive::OVERWRITE); $z->addFromString('[Content_Types].xml', $ct); $z->addFromString($inner, '<x/>'); $z->close();
    }
    $im = imagecreatetruecolor(320, 200); imagefill($im, 0, 0, imagecolorallocate($im, 119, 0, 255)); imagepng($im, "$d/Фото стенда.png");
    file_put_contents("$d/табель.csv", "ФИО;часы\\nИванов;8\\n");
    file_put_contents("$d/большой 4 МБ.txt", str_repeat("строка\\n", (int) (4 * 1048576 / 13)));
    file_put_contents("$d/слишком большой.txt", str_repeat("a", 5 * 1048576 + 1));
    file_put_contents("$d/setup.exe", "MZ" . str_repeat("\\0", 64));
    file_put_contents("$d/руководитель.txt", "заметка руководителя");
  `;
  const r = cp.spawnSync('php', ['-r', php, dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('fixtures: ' + r.stderr);
  const f = (n) => path.join(dir, n);
  return {
    pdf: f('Акт приёмки.pdf'), docx: f('Договор поставки.docx'), xlsx: f('График смен.xlsx'), png: f('Фото стенда.png'), csv: f('табель.csv'),
    big4: f('большой 4 МБ.txt'), over: f('слишком большой.txt'), exe: f('setup.exe'), sup: f('руководитель.txt'),
  };
}

function kit(cdp, env) {
  const k = L0.pageKit(cdp, env.base, OUT);
  k.ev = (x) => cdp.ev(x);
  // реальный диалог выбора файлов: клик по «Выбрать файлы» → Page.fileChooserOpened → DOM.setFileInputFiles
  k.chooseFiles = async (btnSel, files) => {
    const opened = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('диалог выбора файлов не открылся')), 8000);
      const h = (m) => { const d = JSON.parse(m.data); if (d.method === 'Page.fileChooserOpened') { clearTimeout(t); cdp.ws.removeEventListener('message', h); res(d.params); } };
      cdp.ws.addEventListener('message', h);
    });
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await k.click(btnSel);
    const p = await opened;
    await cdp.send('DOM.setFileInputFiles', { files, backendNodeId: p.backendNodeId });
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false });
  };
  // реальное перетаскивание файлов из ОС: dragEnter → dragOver (×n) → [beforeDrop] → drop
  k.dropFiles = async (sel, files, o) => {
    o = o || {};
    const r = await k.rect(sel);
    if (!r) throw new Error('нет зоны ' + sel);
    const data = { items: [], files, dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: r.x - 40, y: r.y, data });
    for (let i = 0; i < 4; i++) { await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: r.x - 40 + i * 10, y: r.y, data }); await sleep(40); }
    if (o.beforeDrop) await o.beforeDrop();
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: r.x, y: r.y, data });
    await sleep(o.after || 300);
  };
  k.gotoTasks = async () => {
    await cdp.ev('document.getElementById("vacationTrigger").click()'); await sleep(700);
    const shown = await cdp.ev(`(() => { const w = document.querySelector('#tasksView .tk-wrap'); return !!w && w.getBoundingClientRect().width > 50; })()`);
    if (!shown) { await k.click('#tabTasks'); await sleep(1200); }
    await k.waitFor('!window.Tasks.__t.S.loading', 20000);
  };
  k.openTask = async (id, view) => {
    await cdp.ev('window.Tasks.open(' + JSON.stringify({ view: view || 'list', taskId: id }) + ')');
    await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(500);
  };
  // клик с проверкой результата: при перерисовке панели между mousePressed и mouseReleased браузер не порождает click —
  // повторяем (до 4 раз), число повторов пишем в отчёт
  k.retries = 0;
  k.clickUntil = async (sel, cond, ms) => {
    for (let i = 0; i < 4; i++) {
      await k.click(sel);
      if (await k.waitFor(cond, ms || 2500)) return true;
      k.retries++;
      console.log('  retry click ' + sel);
    }
    return false;
  };
  k.attN = () => cdp.ev('document.querySelectorAll("#tasksAttModal .tk-att-list li[data-tk-att-id]").length');
  k.waitAtt = (n, ms) => k.waitFor('document.querySelectorAll("#tasksAttModal .tk-att-list li[data-tk-att-id]").length === ' + n + ' && !document.querySelector("#tasksAttModal .tk-att-q-up, #tasksAttModal .tk-att-q-wait")', ms || 20000);
  return k;
}

const files = (env, id) => L0.http(env.base, env.adminCk, 'GET', 'api/task_files.php?task_id=' + encodeURIComponent(id)).then((r) => r.json.attachments || []);
const disk = (env) => (fs.existsSync(env.filesDir) ? fs.readdirSync(env.filesDir).filter((f) => /^[0-9a-f]{32}$/.test(f)).length : 0);

(async () => {
  const C = L0.makeChecker(path.join(OUT, 'V7_results.json'));
  const env = await startEnvProd();
  const fxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7_fx_'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7_dl_'));
  try {
    const F = makeFixtures(fxDir);
    const s = await seed(env);
    env.adminCk = s.adminCookies.join('; ');
    const mk = async (title, day, extra) => (await L0.http(env.base, env.adminCk, 'POST', 'api/tasks.php', Object.assign({ title, start_at: D(day) + 'T10:00', end_at: D(day) + 'T11:30', assignees: ['emp_105'] }, extra || {}))).json.task;
    const T1 = await mk('Приёмка оборудования', 3, { description: 'Проверить комплектность, подписать акт, приложить фото стенда.', label: 'склад' });
    const lim = (await L0.http(env.base, env.adminCk, 'GET', 'api/task_files.php?limits=1')).json.limits;
    C.check('L1 сервер с лимитами PHP прода (256M): действующий лимит файла 5 МБ, 10 файлов', lim.max_file_bytes === 5242880 && lim.max_files === 10, JSON.stringify(lim));

    // ================= admin, 1280 =================
    const B = await env.openBrowser(); const k = kit(B.cdp, env);
    C.note('browser', B.version);
    await k.size(1280, 900); await k.load(s.adminCookies); await k.gotoTasks();
    await k.ev('(() => { window.__tkRenders = 0; new MutationObserver(() => { window.__tkRenders++; }).observe(document.getElementById("tasksView"), { childList: true }); })()');
    await k.openTask(T1.id, 'board');
    const btn = await k.ev(`(() => { const b = document.querySelector('#tasksView .tk-detail .tk-dhead [data-tk-act="attOpen"]'); return b ? { t: b.title, n: b.querySelector('.tk-attn') ? b.querySelector('.tk-attn').textContent : '' } : null; })()`);
    C.check('A1 карточка: в шапке значок-скрепка «Прикрепить файлы» (без счётчика)', btn && btn.t === 'Прикрепить файлы' && btn.n === '', JSON.stringify(btn));
    await k.shotEl('#tasksView .tk-detail', 'A1_card_clip_empty_1280', { maxH: 420 });
    await k.clickUntil('#tasksView .tk-detail [data-tk-act="attOpen"]', '!!document.querySelector("#tasksAttModal .tk-att-modal") && !window.Tasks.__t.S.att.loading'); await sleep(300);
    const m0 = await k.ev(`(() => { const m = document.querySelector('#tasksAttModal .tk-att-modal'); if (!m) return null; const r = m.getBoundingClientRect(); return { w: Math.round(r.width), txt: m.textContent }; })()`);
    C.check('A2 клик по значку → модальное окно по центру: «Файлов нет», «Перетащите файлы сюда или Выбрать файлы», «До 5 МБ на файл, до 10 файлов»',
      m0 && /Файлов нет/.test(m0.txt) && /Перетащите файлы сюда или/.test(m0.txt) && /Выбрать файлы/.test(m0.txt) && /До 5 МБ на файл, до 10 файлов/.test(m0.txt), m0 && m0.txt.slice(0, 300));
    await k.shot('A2_modal_empty_1280');

    // выбор через настоящий диалог
    await k.chooseFiles('#tasksAttModal [data-tk-act="attPick"]', [F.pdf, F.docx, F.png]);
    const ok3 = await k.waitAtt(3);
    const sv3 = await files(env, T1.id);
    C.check('A3 «Выбрать файлы» (системный диалог, 3 файла): в окне и на сервере 3 файла с исходными именами (кириллица)',
      ok3 && sv3.map((x) => x.name).sort().join('|') === ['Акт приёмки.pdf', 'Договор поставки.docx', 'Фото стенда.png'].sort().join('|'), JSON.stringify(sv3.map((x) => x.name)));
    await k.shot('A3_modal_three_files_1280');
    await k.click('#tasksAttModal .tk-att-task'); await sleep(200);
    C.check('A3b клики внутри окна (кнопка «Выбрать файлы», текст окна) не закрывают панель «Задачи» под ним', await k.ev('document.getElementById("vacationPanel").classList.contains("open") && !!document.getElementById("tasksAttModal")'));

    // перетаскивание: подсветка зоны во время dragOver, затем drop
    let over = false;
    await k.dropFiles('#tasksAttModal [data-tk-att-drop]', [F.xlsx, F.csv], {
      beforeDrop: async () => { over = await k.ev('!!document.querySelector("#tasksAttModal .tk-att-drop.tk-att-over")'); await k.shot('A4_drag_over_highlight_1280'); },
    });
    const ok5 = await k.waitAtt(5);
    C.check('A4 перетаскивание 2 файлов из ОС: зона подсвечена во время перетаскивания, после drop в окне 5 файлов; страница не ушла на файл',
      over && ok5 && (await k.ev('location.pathname.endsWith("/index.html")')), 'over=' + over);
    await k.shot('A5_modal_five_files_1280');

    // полоса загрузки: ограничиваем исходящую скорость, 4 МБ
    await B.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 400 * 1024 });
    await k.dropFiles('#tasksAttModal [data-tk-att-drop]', [F.big4], { after: 50 });
    await k.waitFor('(() => { const i = document.querySelector("#tasksAttModal .tk-att-bar i"); return !!i && parseFloat(i.style.width) >= 15; })()', 15000);
    const bar = await k.ev(`(() => { const i = document.querySelector('#tasksAttModal .tk-att-bar i'), pb = document.querySelector('#tasksAttModal [role="progressbar"]'); return i ? { w: parseFloat(i.style.width), now: pb && pb.getAttribute('aria-valuenow'), txt: document.querySelector('#tasksAttModal .tk-att-q').textContent } : null; })()`);
    C.check('A5 полоса загрузки: во время отправки 4 МБ полоса растёт (' + (bar && bar.w) + '%), aria-valuenow и подпись «N%» совпадают',
      bar && bar.w > 0 && bar.w < 100 && String(Math.floor(bar.w)) === bar.now && bar.txt.indexOf(bar.now + '%') >= 0, JSON.stringify(bar));
    await k.shot('A6_progress_bar_1280');
    await k.shotEl('#tasksAttModal .tk-att-queue', 'A6_progress_bar_zoom_1280', { scale: 2 });
    const ok6 = await k.waitAtt(6, 40000);
    await B.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    C.check('A6 после загрузки 4 МБ: файл в списке (6), очередь пуста', ok6);

    // ошибки: больше 5 МБ и exe — без отправки на сервер
    const d0 = disk(env);
    await k.chooseFiles('#tasksAttModal [data-tk-act="attPick"]', [F.over, F.exe]);
    await sleep(500);
    const errs = await k.ev(`[...document.querySelectorAll('#tasksAttModal .tk-att-q-error')].map((e) => e.textContent)`);
    C.check('A7 «слишком большой» (5 МБ + 1 байт) и setup.exe: понятная ошибка у каждого файла, на сервер не попали',
      errs.length === 2 && errs.some((t) => /слишком большой\.txt.*Файл больше 5 МБ/.test(t)) && errs.some((t) => /setup\.exe.*Формат «\.exe» не поддерживается/.test(t)) && disk(env) === d0, JSON.stringify(errs));
    await k.shot('A7_errors_1280');
    await k.click('#tasksAttModal .tk-att-q-error [data-tk-act="attDismiss"]'); await sleep(200);
    await k.click('#tasksAttModal .tk-att-q-error [data-tk-act="attDismiss"]'); await sleep(200);

    // открыть/скачать
    const sv6 = await files(env, T1.id);
    const pdf = sv6.find((x) => x.ext === 'pdf'), docx = sv6.find((x) => x.ext === 'docx');
    const lnk = await k.ev(`(() => { const a = document.querySelector('#tasksAttModal a.tk-att-name[href*="id=${pdf.id}&inline=1"]'); return a ? { t: a.target, rel: a.rel } : null; })()`);
    const head = await k.ev(`fetch('api/task_files.php?id=${pdf.id}&inline=1').then((r) => ({ s: r.status, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), ns: r.headers.get('x-content-type-options') }))`);
    C.check('A8 PDF: ссылка открывается в новой вкладке (target=_blank, noopener); сервер отдаёт inline, application/pdf, nosniff',
      lnk && lnk.t === '_blank' && /noopener/.test(lnk.rel) && head.s === 200 && head.ct === 'application/pdf' && /^inline/.test(head.cd) && head.ns === 'nosniff', JSON.stringify([lnk, head]));
    await B.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    await k.click('#tasksAttModal a.tk-att-name[href$="id=' + docx.id + '"]');
    await k.waitFor('true', 100);
    let got = null;
    for (let i = 0; i < 60 && !got; i++) { const l = fs.readdirSync(dlDir).filter((f) => !/\.crdownload$/.test(f)); if (l.length) got = l[0]; else await sleep(150); }
    C.check('A9 клик по «Договор поставки.docx» скачивает файл: имя сохранено (UTF-8), содержимое совпадает побайтно',
      got === 'Договор поставки.docx' && fs.readFileSync(path.join(dlDir, got)).equals(fs.readFileSync(F.docx)), String(got));

    // удаление
    B.cdp.dialogs.length = 0;
    await k.click('#tasksAttModal [data-tk-act="attDelete"][data-att="' + sv6.find((x) => x.ext === 'csv').id + '"]');
    await k.waitAtt(5);
    C.check('A10 × у файла: подтверждение «Удалить файл «табель.csv»? Он будет удалён с сервера.» → файл удалён (5 осталось, на диске 5)',
      /Удалить файл «табель\.csv»\? Он будет удалён с сервера\./.test(B.cdp.dialogs[0] || '') && (await files(env, T1.id)).length === 5 && disk(env) === 5, JSON.stringify(B.cdp.dialogs));

    // Esc закрывает; значки в карточке/списке/доске/календаре
    await B.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await B.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300);
    C.check('A11 Esc закрывает окно', !(await k.ev('!!document.getElementById("tasksAttModal")')));
    const cardN = await k.ev(`(() => { const b = document.querySelector('#tasksView .tk-detail [data-tk-act="attOpen"] .tk-attn'); return b ? b.textContent : ''; })()`);
    await k.shotEl('#tasksView .tk-detail', 'A12_card_clip_5_1280', { maxH: 420 });
    await k.openTask(T1.id, 'list');
    const rowTag = await k.ev(`(() => { const r = [...document.querySelectorAll('#tasksView tr.tk-row')].find((x) => x.textContent.indexOf('Приёмка оборудования') >= 0); const t = r && r.querySelector('.tk-att-n'); return t ? t.textContent.trim() : ''; })()`);
    C.check('A12 карточка: счётчик на значке 5; Список: бейдж «скрепка 5» в строке задачи', cardN === '5' && rowTag === '5', JSON.stringify([cardN, rowTag]));
    await k.shot('A12_list_badge_1280');
    await k.openTask(T1.id, 'board');
    C.check('A13 Доска: бейдж «скрепка 5» на плитке', await k.ev(`[...document.querySelectorAll('#tasksView .tk-card')].some((c) => c.textContent.indexOf('Приёмка оборудования') >= 0 && !!c.querySelector('.tk-att-n'))`));
    await k.shot('A13_board_badge_1280');
    await B.cdp.send('Runtime.evaluate', { expression: 'window.Tasks.open(' + JSON.stringify({ view: 'calendar', date: D(3), mode: 'week' }) + ')', awaitPromise: true });
    await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(600);
    C.check('A14 Календарь: значок-скрепка на плитке задачи', await k.ev(`[...document.querySelectorAll('#tasksView .tk-ev')].some((e) => e.textContent.indexOf('Приёмка оборудования') >= 0 && !!e.querySelector('.tk-ev-att'))`));
    await k.shotEl('#tasksView .tk-ev.tk-ev-t[data-id="' + T1.id + '"]', 'A14_calendar_tile_clip_1280', { scale: 2 });

    // форма новой задачи: файл ждёт сохранения
    await k.openTask(null, 'list');
    await k.clickUntil('#tasksView [data-tk-act="newTask"]', '!!window.Tasks.__t.S.form');
    await k.ev(`(() => { const S = window.Tasks.__t.S; S.form.draft.title = 'Задача с файлом из формы'; S.form.draft.assignees = ['emp_106']; S.form.draft.startDate = '${D(4)}'; window.Tasks.__t.render(); })()`);
    await k.clickUntil('#tasksView [data-tk-act="attOpenForm"]', '!!document.querySelector("#tasksAttModal .tk-att-modal") && !window.Tasks.__t.S.att.loading');
    await k.chooseFiles('#tasksAttModal [data-tk-act="attPick"]', [F.pdf]); await sleep(400);
    const pend = await k.ev(`(() => ({ li: document.querySelectorAll('#tasksAttModal [data-tk-att-pend]').length, txt: document.querySelector('#tasksAttModal').textContent }))()`);
    C.check('A15 форма новой задачи → окно: файл в списке «загрузится после сохранения задачи», на сервер ещё не ушёл', pend.li === 1 && /загрузится после сохранения задачи/.test(pend.txt) && disk(env) === 5);
    await k.shot('A15_form_pending_modal_1280');
    await k.click('#tasksAttModal .tk-actions [data-tk-act="attClose"]'); await sleep(300);
    await k.shotEl('#tasksView .tk-form', 'A15_form_field_1280', { maxH: 900 });
    await k.clickUntil('#tasksView [data-tk-act="saveForm"]', '!window.Tasks.__t.S.form && !window.Tasks.__t.S.busy', 8000); await sleep(1500);
    const nt = (await L0.http(env.base, env.adminCk, 'GET', 'api/tasks.php')).json.tasks.find((t) => t.title === 'Задача с файлом из формы');
    C.check('A16 «Сохранить»: задача создана, затем файл загружен к ней', nt && nt.attachments.length === 1 && nt.attachments[0].name === 'Акт приёмки.pdf', String(JSON.stringify(nt && nt.attachments)) + ' ' + (await k.ev('JSON.stringify({ msg: window.Tasks.__t.S.msg, form: window.Tasks.__t.S.form && { e: window.Tasks.__t.S.form.error, b: window.Tasks.__t.S.form.blocked, d: window.Tasks.__t.S.form.draft } })')));

    // архив
    await k.openTask(T1.id, 'board');
    B.cdp.dialogs.length = 0;
    const dBefore = disk(env);
    await k.click('#tasksView .tk-detail [data-tk-act="archiveTask"]');
    await k.waitFor('!window.Tasks.__t.S.busy', 15000); await sleep(800);
    C.check('A17 «В архив»: подтверждение предупреждает «Вложения (5 файлов) будут удалены с сервера…»; файлы удалены с диска (' + dBefore + ' → ' + disk(env) + ')',
      /Вложения \(5 файлов\) будут удалены с сервера без возможности восстановления/.test(B.cdp.dialogs[0] || '') && disk(env) === dBefore - 5, JSON.stringify(B.cdp.dialogs));

    // 375
    const T2 = await mk('Проверка на телефоне', 5);
    for (const f of [F.pdf, F.png]) { const fd = new FormData(); fd.append('file', new File([fs.readFileSync(f)], path.basename(f)), path.basename(f)); await fetch(env.base + '/api/task_files.php?task_id=' + T2.id, { method: 'POST', headers: { Cookie: env.adminCk }, body: fd }); }
    await k.size(375, 760, true); await k.load(s.adminCookies); await k.gotoTasks();
    await k.openTask(T2.id, 'board');
    await k.clickUntil('#tasksView .tk-detail [data-tk-act="attOpen"]', '!!document.querySelector("#tasksAttModal .tk-att-modal") && !window.Tasks.__t.S.att.loading'); await sleep(300);
    const mob = await k.ev(`(() => { const m = document.querySelector('#tasksAttModal .tk-att-modal').getBoundingClientRect(); const dnd = document.querySelector('#tasksAttModal .tk-att-dnd'); return { w: Math.round(m.width), left: Math.round(m.left), right: Math.round(m.right), dnd: dnd ? getComputedStyle(dnd).display : '', pick: !!document.querySelector('#tasksAttModal [data-tk-act="attPick"]'), ov: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    C.check('A18 375 px: окно в пределах экрана (' + mob.left + '…' + mob.right + '), текст «Перетащите…» скрыт, «Выбрать файлы» есть, горизонтальной прокрутки нет',
      mob.left >= 0 && mob.right <= 375 && mob.dnd === 'none' && mob.pick && mob.ov <= 0, JSON.stringify(mob));
    await k.shot('A18_modal_375');
    await k.chooseFiles('#tasksAttModal [data-tk-act="attPick"]', [F.csv]);
    C.check('A19 375 px: выбор файла кнопкой работает', await k.waitAtt(3));

    // ================= supervisor =================
    const supCk = await L0.login(env.base, 'supervisor_zone0');
    const T3 = await mk('Задача руководителя зоны', 6);
    L0.sql(env.tmpDb, "UPDATE tasks SET created_by = 'supervisor_zone0' WHERE id = '" + T3.id + "';");
    { const fd = new FormData(); fd.append('file', new File([fs.readFileSync(F.pdf)], 'от админа.pdf'), 'от админа.pdf'); await fetch(env.base + '/api/task_files.php?task_id=' + T3.id, { method: 'POST', headers: { Cookie: env.adminCk }, body: fd }); }
    const Bs = await env.openBrowser(); const ks = kit(Bs.cdp, env);
    await ks.size(1280, 900); await ks.load(supCk); await ks.gotoTasks();
    await ks.openTask(T2.id, 'board');
    await ks.clickUntil('#tasksView .tk-detail [data-tk-act="attOpen"]', '!!document.querySelector("#tasksAttModal .tk-att-modal") && !window.Tasks.__t.S.att.loading'); await sleep(300);
    const ro = await ks.ev(`(() => { const m = document.querySelector('#tasksAttModal'); return { files: m.querySelectorAll('li[data-tk-att-id]').length, drop: !!m.querySelector('[data-tk-att-drop]'), del: !!m.querySelector('[data-tk-act="attDelete"]'), txt: m.textContent }; })()`);
    C.check('S1 supervisor, задача admin: файлы видны (3), зоны загрузки и × нет, пояснение «только смотреть и скачивать»',
      ro.files === 3 && !ro.drop && !ro.del && /только смотреть и скачивать/.test(ro.txt), JSON.stringify(ro).slice(0, 300));
    await ks.shot('S1_supervisor_foreign_readonly_1280');
    await ks.click('#tasksAttModal .tk-actions [data-tk-act="attClose"]'); await sleep(200);
    await ks.openTask(T3.id, 'board');
    await ks.clickUntil('#tasksView .tk-detail [data-tk-act="attOpen"]', '!!document.querySelector("#tasksAttModal .tk-att-modal") && !window.Tasks.__t.S.att.loading'); await sleep(300);
    await ks.dropFiles('#tasksAttModal [data-tk-att-drop]', [F.sup]);
    await ks.waitAtt(2);
    const sv3s = await files(env, T3.id);
    const mine = sv3s.find((x) => x.uploaded_by === 'supervisor_zone0'), adm = sv3s.find((x) => x.uploaded_by === 'admin');
    const dels = await ks.ev(`[...document.querySelectorAll('#tasksAttModal [data-tk-act="attDelete"]')].map((b) => b.dataset.att)`);
    C.check('S2 supervisor, своя задача: перетаскивание работает, × только у своего файла',
      !!mine && dels.length === 1 && dels[0] === String(mine.id) && !!adm, JSON.stringify([sv3s, dels]));
    await ks.shot('S2_supervisor_own_task_1280');
    Bs.cdp.dialogs.length = 0;
    await ks.click('#tasksAttModal [data-tk-act="attDelete"]');
    await ks.waitAtt(1);
    C.check('S3 supervisor удаляет свой файл; файл admin остаётся', (await files(env, T3.id)).map((x) => x.uploaded_by).join() === 'admin');

    // ================= viewer =================
    const vCk = await L0.login(env.base, 'viewer_test');
    const Bv = await env.openBrowser(); const kv = kit(Bv.cdp, env);
    await kv.size(1280, 900); await kv.load(vCk); await kv.gotoTasks();
    await kv.openTask(T2.id, 'board');
    await kv.clickUntil('#tasksView .tk-detail [data-tk-act="attOpen"]', '!!document.querySelector("#tasksAttModal .tk-att-modal") && !window.Tasks.__t.S.att.loading'); await sleep(300);
    const vro = await kv.ev(`(() => { const m = document.querySelector('#tasksAttModal'); return { files: m.querySelectorAll('li[data-tk-att-id]').length, drop: !!m.querySelector('[data-tk-att-drop]'), pick: !!m.querySelector('[data-tk-act="attPick"]'), del: !!m.querySelector('[data-tk-act="attDelete"]') }; })()`);
    const vdl = await kv.ev(`fetch(document.querySelector('#tasksAttModal a.tk-att-name').href).then((r) => r.status)`);
    C.check('V1 viewer: файлы видны и скачиваются (200), загрузки/«Выбрать файлы»/× нет', vro.files === 3 && !vro.drop && !vro.pick && !vro.del && vdl === 200, JSON.stringify([vro, vdl]));
    await kv.shot('V1_viewer_readonly_1280');

    C.note('renders_admin', await k.ev('window.__tkRenders || 0'));
    C.note('click_retries', { admin: k.retries, supervisor: ks.retries, viewer: kv.retries });
    const ex = [].concat(B.cdp.exceptions, Bs.cdp.exceptions, Bv.cdp.exceptions);
    C.check('Z1 ни одного исключения JS на страницах (admin/supervisor/viewer)', ex.length === 0, ex.join(' | '));
  } catch (e) {
    C.check('FATAL', false, e && e.stack);
  } finally {
    env.cleanup();
    try { fs.rmSync(env.filesDir, { recursive: true, force: true }); } catch (e) { /* */ }
    try { fs.rmSync(fxDir, { recursive: true, force: true }); fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) { /* */ }
  }
  C.save();
  console.log('RESULT: ' + C.passed + ' passed, ' + C.failed + ' failed');
  process.exit(C.failed ? 1 : 0);
})();
