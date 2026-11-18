#!/usr/bin/env node
// V9-T2 (Задачи: связанные задачи — UI): сьют `tasklinksui`.
//
// Реальный headless Chromium по CDP + `php -S` на КОПИИ data/app.db (SC_APP_DB; data/app.db не меняется,
// проверяется sha1). Каркас — scripts/v6_accept_lib.js (как у tripsstatus / tripsform). Пароли в браузер
// не вводятся: cookie берётся запросом к api/login.php (dev-учётки, стартовый пароль — только dev-БД).
//
// Что проверяется (в браузере, на настоящем api/tasks.php):
//   форма        — «Связанные задачи» (textarea data-tk-field=linksText) стоит ПОСЛЕ «Вложений», есть подсказка, у supervisor/viewer
//                  формы записи нет; состояние поля в черновике/payload (links_text); ошибки сервера (link_self / link_unknown /
//                  link_target_archived) — рядом с полем, текст не теряется;
//   окно (())    — открывается, когда курсор между «((» и «))» (ввод, стрелки/keyup, клик, selectionchange); не открывается, когда
//                  курсор вне скобок / на токене; поиск без учёта регистра; открытые и закрытые видны, сама задача и архивные — нет;
//                  выбор (мышь, ↑/↓/Enter) подставляет токен ((ID|название)), курсор после токена, фокус в textarea; Esc / «Отмена» /
//                  клик вне окна оставляют «(())» и повторно не открывают, пока курсор не покинет скобки и не вернётся; кэш списка;
//   карточка     — блок «Связанные задачи» под «Описанием», чипы вместо токенов, «Также связана с:» для входящих, экранирование,
//                  перечёркнутая ссылка архивной задачи (клик не ведёт), токен без записи — «задача не найдена»;
//   клик по чипу — «Список» с S.filters.rel: цепочка 1–2–3(–5) из любой точки, исходная задача первой строкой без выделения,
//                  открытые и закрытые вместе, плашка «Связанные задачи: …» и «×»; «показаны первые 200»; supervisor/viewer — тоже;
//   сохранение   — связь в БД и у второй стороны (чип «Также связана с» в её карточке); закрытие/переоткрытие связей не меняет;
//   sync         — render()/reload()/onRemoteChange не сбрасывают набираемый текст и курсор; в открытой карточке связи обновляются;
//   вёрстка      — 375 и 1280 без горизонтального скролла панели (карточка, форма, окно, Список).
// Итоговая строка: «RESULT: N passed, M failed».
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const L = require('./v6_accept_lib.js');
const sleep = L.sleep;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const REAL_DB = path.join(L.ROOT, 'data/app.db');
const SHOTS = process.env.TASKLINKSUI_SHOTS || '';          // каталог для скриншотов (по умолчанию не снимаются)

const VK = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Backspace: 8, End: 35, Home: 36 };

async function main() {
  if (!fs.existsSync(process.env.CHROME_BIN || path.join(require('os').homedir(), '.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell'))) {
    check('Chromium найден (CHROME_BIN / ~/.cache/ms-playwright)', false, 'нет браузера — сьют не может выполняться');
    return;
  }
  const dbBefore = sha1(REAL_DB);
  const env = await L.startEnv();
  try {
    const admin = (await L.login(env.base, 'admin')).join('; ');
    const sup = (await L.login(env.base, 'supervisor_zone0')).join('; ');
    const viewer = (await L.login(env.base, 'viewer_test')).join('; ');
    const api = (ck, method, url, body) => L.http(env.base, ck, method, url, body);

    const { cdp } = await env.openBrowser();
    const k = L.pageKit(cdp, env.base, SHOTS || process.env.TMPDIR || '/tmp');
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const shot = async (n) => { if (SHOTS) await k.shot(n); };
    const ev = (x) => cdp.ev(x);
    const q = (s) => JSON.stringify(s);
    const guard = async (label, fn) => { try { await fn(); } catch (e) { check('Сценарий «' + label + '» выполнен без сбоя теста', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); } };

    // ----------------------------------------------------------------------------------------------
    // данные (через настоящий API админа)
    // ----------------------------------------------------------------------------------------------
    const mk = async (title, start, extra) => {
      const r = await api(admin, 'POST', 'api/tasks.php', Object.assign({ title, start_at: start || '2031-06-01', assignees: ['emp_2'] }, extra || {}));
      if (r.status !== 201 || !r.json.task) throw new Error('POST task «' + title + '» → ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      return r.json.task;
    };
    const getT = async (id, ck) => (await api(ck || admin, 'GET', 'api/tasks.php?id=' + encodeURIComponent(id))).json.task;
    const setLinks = async (id, text) => {
      const t = await getT(id);
      const r = await api(admin, 'PUT', 'api/tasks.php?id=' + encodeURIComponent(id), { version: t.version, links_text: text });
      if (r.status !== 200) throw new Error('PUT links_text → ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      return r.json.task;
    };
    const archive = async (id) => { const t = await getT(id); return api(admin, 'DELETE', 'api/tasks.php?id=' + encodeURIComponent(id), { version: t.version }); };
    const closeT = async (id) => { const t = await getT(id); return api(admin, 'POST', 'api/tasks.php?id=' + encodeURIComponent(id) + '&action=close', { version: t.version }); };
    const dbLinks = () => L.sql(env.tmpDb, "select task_a || '|' || task_b from task_links order by 1;").trim().split('\n').filter(Boolean);
    const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    const tok = (t, name) => '((' + t.id + '|' + (name || t.title) + '))';

    const T1 = await mk('Заказ клиента', '2031-06-01');
    const T2 = await mk('Закрытие заказа', '2031-06-02');
    const T3 = await mk('Отгрузка заказа', '2031-06-03');
    const T4 = await mk('Изолированная задача', '2031-06-10');
    const T5 = await mk('Закрытая старая', '2031-06-04');
    const T6 = await mk('Удалённая задача', '2031-06-05');
    await closeT(T5.id);
    await archive(T6.id);
    const LONGW = 'Длинн' + 'о'.repeat(150);
    const TL = await mk(LONGW, '2031-06-12');
    const TX = await mk('Опасное <b>X</b> "кав" \'ап\' &amp; <i>', '2031-06-11');

    // ----------------------------------------------------------------------------------------------
    // помощники браузера
    // ----------------------------------------------------------------------------------------------
    const TA = '#tasksView [data-tk-field="linksText"]';
    const LP = '#tasksLinkPick';
    const exists = (sel) => ev('!!document.querySelector(' + q(sel) + ')');
    const count = (sel) => ev('document.querySelectorAll(' + q(sel) + ').length');
    const textOf = (sel) => ev('(() => { const e = document.querySelector(' + q(sel) + '); return e ? e.textContent : null; })()');
    const attrOf = (sel, a) => ev('(() => { const e = document.querySelector(' + q(sel) + '); return e ? e.getAttribute(' + q(a) + ') : null; })()');
    const taVal = () => ev('(() => { const t = document.querySelector(' + q(TA) + '); return t ? t.value : null; })()');
    const taCaret = () => ev('(() => { const t = document.querySelector(' + q(TA) + '); return t ? [t.selectionStart, t.selectionEnd] : null; })()');
    const activeIsTa = () => ev('(() => { const a = document.activeElement; return !!(a && a.dataset && a.dataset.tkField === "linksText"); })()');
    const activeIsSearch = () => ev('(() => { const a = document.activeElement; return !!(a && a.hasAttribute && a.hasAttribute("data-tk-lp-search")); })()');
    const pickOpen = () => exists(LP);
    const pickIds = () => ev('[...document.querySelectorAll("#tasksLinkPick .tk-lp-it")].map(e => e.getAttribute("data-tk-lp-id"))');
    const pickText = () => ev('(() => { const e = document.querySelector("#tasksLinkPick"); return e ? e.textContent : ""; })()');
    const pickReqs = () => ev('performance.getEntriesByType("resource").filter(r => /[?&]pick=1/.test(r.name)).length');
    const sleepS = () => sleep(350);
    const waitFor = (expr, ms) => k.waitFor(expr, ms || 8000);

    async function press(key, mod) {
      const o = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key] };
      if (mod) o.modifiers = mod;
      if (key === 'Enter') await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text: '\r' }, o));
      else await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, o));
      await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, o));
      await sleep(120);
    }
    async function typeTa(text) {
      await ev('document.querySelector(' + q(TA) + ').focus()');
      await cdp.send('Input.insertText', { text });
      await sleep(120);
    }
    async function typeSearch(text) {
      await ev('document.querySelector("#tasksLinkPick [data-tk-lp-search]").focus()');
      await cdp.send('Input.insertText', { text });
      await sleep(150);
    }
    // программно: значение + курсор БЕЗ событий ввода (дальше — click / input / selectionchange / keyup по сценарию)
    const setTa = (v, c, c2) => ev('(() => { const t = document.querySelector(' + q(TA) + '); t.focus(); t.value = ' + q(v) + '; t.setSelectionRange(' + c + ',' + (c2 === undefined ? c : c2) + '); return true; })()');
    const fireTa = (type) => ev('document.querySelector(' + q(TA) + ').dispatchEvent(new Event(' + q(type) + ', { bubbles: true }))');
    const stateTa = () => ev('(() => { const s = Tasks.__t.S; return { form: !!s.form, draft: s.form ? s.form.draft.linksText : null }; })()');
    // ввод в draft как у пользователя: значение + событие input. Сначала — курсор ВНЕ скобок (в конец), чтобы сбросить «отмену»
    // предыдущего «(())» (в реальности курсор покидает скобки по дороге), затем нужная позиция.
    async function replaceTa(v, caret) {
      await setTa(v, v.length); await fireTa('input');
      await setTa(v, caret); await fireTa('input');
      await sleep(200);
    }
    // курсор уходит за скобки и возвращается назад (между «((» и «))» у текста вида «a (()) b», курсор 4)
    async function leaveAndReturn() {
      await press('ArrowRight'); await press('ArrowRight'); await sleep(150);
      await press('ArrowLeft'); await press('ArrowLeft');
    }

    async function openTasks(ck, view, taskId, w, h) {
      await k.size(w || 1280, h || 900, (w || 1280) < 500);
      await k.load(ck.split('; '));
      await ev('Tasks.open(' + JSON.stringify({ view: view || 'list', taskId: taskId || null }) + ')');
      const ok = await waitFor('!!(Tasks.isActive() && document.querySelector("#tasksView .tk-wrap") && !Tasks.__t.S.loading && Tasks.__t.S.tasks.length > 0)', 20000);
      if (!ok) throw new Error('панель задач не открылась');
      await sleep(250);
    }
    async function openCard(id, ck) {
      await ev('Tasks.open({ view: "board", taskId: ' + q(id) + ' })');
      await waitFor('!!document.querySelector("#tasksView .tk-detail .tk-dtitle")', 10000);
      await sleep(250);
    }
    async function openEdit(id) {
      await ev('Tasks.open({ view: "list" })');
      await waitFor('!!document.querySelector("#tasksView table.tk-table")', 10000);
      await k.click('#tasksView [data-tk-act="editTask"][data-id="' + id + '"]');
      const ok = await waitFor('!!document.querySelector(' + q(TA) + ')', 8000);
      await sleep(200);
      return ok;
    }
    const cardChips = () => ev('[...document.querySelectorAll("#tasksView .tk-detail .tk-links .tk-lk")].map(e => ({ text: e.textContent, tag: e.tagName, act: e.getAttribute("data-tk-act"), link: e.getAttribute("data-link"), id: e.getAttribute("data-id"), title: e.getAttribute("title"), cls: e.className }))');
    const alsoChips = () => ev('[...document.querySelectorAll("#tasksView .tk-detail .tk-links-also .tk-lk")].map(e => ({ text: e.textContent, tag: e.tagName, link: e.getAttribute("data-link"), cls: e.className, act: e.getAttribute("data-tk-act") }))');
    const listRows = () => ev('[...document.querySelectorAll("#tasksView table.tk-table tbody tr.tk-row")].map(r => ({ id: r.getAttribute("data-id"), cls: r.className, title: r.querySelector(".tk-c-task b") ? r.querySelector(".tk-c-task b").textContent : "" }))');
    const relBar = () => ev('(() => { const e = document.querySelector("#tasksView [data-tk-relbar]"); return e ? e.textContent.replace(/\\s+/g, " ").trim() : null; })()');
    const sS = () => ev('(() => { const s = Tasks.__t.S; return { rel: s.filters.rel || "", view: s.view, sel: s.selectedId, msg: s.msg ? s.msg.text : "" }; })()');
    const overflowX = () => ev('(() => { const r = document.getElementById("tasksView"), p = document.getElementById("vacationPanel"); const w = document.querySelector("#tasksView .tk-wrap"); return { view: r.scrollWidth - r.clientWidth, panel: p ? p.scrollWidth - p.clientWidth : 0, wrap: w ? w.scrollWidth - w.clientWidth : 0, doc: document.documentElement.scrollWidth - window.innerWidth }; })()');
    const noHScroll = (o) => o.view <= 1 && o.panel <= 1 && o.wrap <= 1 && o.doc <= 1;

    // ==============================================================================================
    // 1. ФОРМА: поле, порядок, права, подсказка
    // ==============================================================================================
    console.log('--- форма: поле «Связанные задачи» ---');
    await guard('форма', async () => {
      await openTasks(admin, 'list');
      await k.click('[data-tk-act="newTask"]');
      await waitFor('!!document.querySelector("#tasksView form.tk-form")', 8000);
      check('форма «Новая задача»: есть textarea «Связанные задачи» (data-tk-field=linksText)', await exists('#tasksView form.tk-form textarea[data-tk-field="linksText"]'));
      const order = await ev('(() => { const t = document.querySelector("#tasksView form.tk-form textarea[data-tk-field=linksText]"), a = document.querySelector("#tasksView .tk-attformbtn"); if (!t || !a) return null; return !!(a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); })()');
      check('поле стоит ПОСЛЕ строки «Вложения» (порядок в DOM)', order === true, String(order));
      const lbl = await ev('(() => { const t = document.querySelector("#tasksView textarea[data-tk-field=linksText]"); const f = t && t.closest(".tk-f"); return f ? f.querySelector("label").textContent : null; })()');
      check('подпись строки — «Связанные задачи»', lbl === 'Связанные задачи', lbl);
      const hint = await ev('(() => { const t = document.querySelector("#tasksView textarea[data-tk-field=linksText]"); const f = t && t.closest(".tk-f"); const h = f && f.querySelector(".tk-hint"); return h ? h.textContent : null; })()');
      check('подсказка под полем: «Введите (()) и поставьте курсор между скобками — откроется список задач»', hint === 'Введите (()) и поставьте курсор между скобками — откроется список задач', hint);
      const prevSib = await ev('(() => { const t = document.querySelector("#tasksView textarea[data-tk-field=linksText]"); const f = t.closest(".tk-f").previousElementSibling; return f ? f.querySelector("label").textContent : null; })()');
      check('строка «Связанные задачи» идёт сразу за строкой «Вложения»', prevSib === 'Вложения', prevSib);
      await k.click('[data-tk-act="cancelForm"]');
    });

    await guard('права', async () => {
      for (const [name, ck] of [['supervisor', sup], ['viewer', viewer]]) {
        await openTasks(ck, 'list');
        check(name + ': в «Списке» нет «+ Новая задача» и ✎', !(await exists('[data-tk-act="newTask"]')) && !(await exists('[data-tk-act="editTask"]')));
        await ev('Tasks.__t.ACTIONS.newTask()');
        await ev('Tasks.__t.ACTIONS.editTask({ dataset: { id: ' + q(T1.id) + ' } }, null)');
        await sleep(250);
        check(name + ': форма записи не открывается (поля «Связанные задачи» нет)', !(await exists(TA)) && !(await exists('#tasksView form.tk-form')) && (await stateTa()).form === false);
      }
    });

    // ==============================================================================================
    // 2. ОКНО (()) : открытие по положению курсора
    // ==============================================================================================
    console.log('--- окно (()): когда открывается / не открывается ---');
    await guard('окно: открытие', async () => {
      await openTasks(admin, 'list');
      check('форма правки T2 открылась по ✎ в Списке', await openEdit(T2.id));
      check('у T2 без связей поле пустое', (await taVal()) === '', await taVal());
      await typeTa('(())');
      await sleepS();
      check('ввод «(())»: курсор ПОСЛЕ скобок — окна нет', !(await pickOpen()) && (await taVal()) === '(())');
      await press('ArrowLeft');
      await sleepS();
      check('ввод «(())»: курсор в конце, одно ← (между «(()» и «)») — окна нет', !(await pickOpen()), JSON.stringify(await taCaret()));
      await press('ArrowLeft');
      await waitFor('!!document.querySelector("#tasksLinkPick")', 4000);
      check('← ←: курсор между «((» и «))» (keyup) — окно открылось', await pickOpen(), JSON.stringify(await taCaret()));
      check('... курсор стоит ровно между скобками (2,2)', JSON.stringify(await taCaret()) === '[2,2]', JSON.stringify(await taCaret()));
      check('... фокус в строке поиска окна', await activeIsSearch());
      check('... окно модальное: role=dialog, aria-modal', (await attrOf('#tasksLinkPick .tk-modal', 'role')) === 'dialog' && (await attrOf('#tasksLinkPick .tk-modal', 'aria-modal')) === 'true');
      check('... один запрос ?pick=1', (await pickReqs()) === 1, await pickReqs());
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      const ids = await pickIds();
      check('список: открытые и закрытые видны (T1, T3, T5 закрытая, T4, TX, TL)', [T1, T3, T4, T5, TX, TL].every((t) => ids.indexOf(t.id) >= 0), JSON.stringify(ids));
      check('список: сама редактируемая задача (T2) исключена', ids.indexOf(T2.id) < 0, JSON.stringify(ids));
      check('список: архивная задача (T6) не показана', ids.indexOf(T6.id) < 0, JSON.stringify(ids));
      const itT5 = await ev('(() => { const e = document.querySelector("#tasksLinkPick .tk-lp-it[data-tk-lp-id=" + JSON.stringify(' + q(T5.id) + ') + "]"); return e ? e.textContent : null; })()');
      check('строка закрытой задачи: название, статус «Закрыта», дата', itT5 && itT5.indexOf('Закрытая старая') >= 0 && itT5.indexOf('Закрыта') >= 0 && /04\.06\.2031/.test(itT5), itT5);
      const itT1 = await ev('(() => { const e = document.querySelector("#tasksLinkPick .tk-lp-it[data-tk-lp-id=" + JSON.stringify(' + q(T1.id) + ') + "]"); return e ? e.textContent : null; })()');
      check('строка открытой задачи: название, статус «Открыта», дата', itT1 && itT1.indexOf('Заказ клиента') >= 0 && itT1.indexOf('Открыта') >= 0 && /01\.06\.2031/.test(itT1), itT1);
      const doubleOpen = await count('#tasksLinkPick');
      await fireTa('input'); await fireTa('click'); await sleep(200);
      check('повторные события при открытом окне не плодят окна', doubleOpen === 1 && (await count('#tasksLinkPick')) === 1, await count('#tasksLinkPick'));
      await press('Escape');
      check('Esc закрывает окно', !(await pickOpen()));
    });

    await guard('окно: поиск', async () => {
      await replaceTa('(())', 2);
      await waitFor('!!document.querySelector("#tasksLinkPick")', 4000);
      check('программный ввод (input-событие) с курсором в скобках открывает окно', await pickOpen());
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      await typeSearch('заказ');
      let ids = await pickIds();
      check('поиск «заказ»: T1 «Заказ клиента» и T3 «Отгрузка заказа»; T2 (сама) не показана', ids.indexOf(T1.id) >= 0 && ids.indexOf(T3.id) >= 0 && ids.indexOf(T2.id) < 0 && ids.indexOf(T4.id) < 0, JSON.stringify(ids));
      await ev('(() => { const i = document.querySelector("#tasksLinkPick [data-tk-lp-search]"); i.select(); })()');
      await cdp.send('Input.insertText', { text: 'ЗАКАЗ' });
      await sleep(150);
      const ids2 = await pickIds();
      check('поиск без учёта регистра: «ЗАКАЗ» даёт тот же результат', JSON.stringify(ids2) === JSON.stringify(ids), JSON.stringify(ids2));
      await ev('document.querySelector("#tasksLinkPick [data-tk-lp-search]").select()');
      await cdp.send('Input.insertText', { text: 'ЗАКРЫТАЯ' });
      await sleep(150);
      ids = await pickIds();
      check('поиск «ЗАКРЫТАЯ»: находит закрытую задачу', ids.length === 1 && ids[0] === T5.id, JSON.stringify(ids));
      await ev('document.querySelector("#tasksLinkPick [data-tk-lp-search]").select()');
      await cdp.send('Input.insertText', { text: 'удалённая' });
      await sleep(150);
      check('поиск «удалённая»: архивная задача не находится', (await pickIds()).length === 0 && /не найден|ничего/i.test(await pickText()), await pickText());
      await ev('document.querySelector("#tasksLinkPick [data-tk-lp-search]").select()');
      await cdp.send('Input.insertText', { text: '<b>' });
      await sleep(150);
      const ids3 = await pickIds();
      check('поиск «<b>» (спецсимволы): находит TX, разметка не ломается', ids3.length === 1 && ids3[0] === TX.id && !(await exists('#tasksLinkPick .tk-lp-it b')), JSON.stringify(ids3));
      await press('Escape');
    });

    await guard('окно: клавиатура и выбор', async () => {
      await replaceTa('(())', 2);
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      const first = (await pickIds())[0];
      const act0 = await ev('(() => { const a = document.querySelector("#tasksLinkPick .tk-lp-act"); return a ? a.getAttribute("data-tk-lp-id") : null; })()');
      check('активная строка по умолчанию — первая', act0 === first, act0 + ' / ' + first);
      await press('ArrowDown');
      const act1 = await ev('(() => { const a = document.querySelector("#tasksLinkPick .tk-lp-act"); return a ? a.getAttribute("data-tk-lp-id") : null; })()');
      const ids = await pickIds();
      check('↓ — активна вторая строка', act1 === ids[1], act1 + ' / ' + ids[1]);
      await press('ArrowUp');
      const act2 = await ev('(() => { const a = document.querySelector("#tasksLinkPick .tk-lp-act"); return a ? a.getAttribute("data-tk-lp-id") : null; })()');
      check('↑ — снова первая', act2 === first, act2);
      await typeSearch('клиента');
      check('поиск «клиента» оставляет одну строку (T1)', JSON.stringify(await pickIds()) === JSON.stringify([T1.id]), JSON.stringify(await pickIds()));
      await press('Enter');
      const want = '((' + T1.id + '|Заказ клиента))';
      check('Enter подставляет вместо «(())» токен «((ID|название))»', (await taVal()) === want, await taVal());
      check('... окно закрыто, фокус вернулся в textarea', !(await pickOpen()) && (await activeIsTa()));
      check('... курсор стоит сразу после токена', JSON.stringify(await taCaret()) === JSON.stringify([want.length, want.length]), JSON.stringify(await taCaret()));
      const st = await stateTa();
      check('... текст попал в черновик формы (S.form.draft.linksText)', st.draft === want, st.draft);
      await sleepS();
      check('... курсор после токена не открывает окно повторно', !(await pickOpen()));
      check('кэш списка: за всю сессию формы был один ?pick=1', (await pickReqs()) === 1, await pickReqs());
    });

    await guard('окно: токен и курсор', async () => {
      const id1 = T1.id;
      const text = 'см. ((' + id1 + '|Заказ клиента)) и далее';
      const start = text.indexOf('((');
      const end = start + ('((' + id1 + '|Заказ клиента))').length;
      const probes = [['перед токеном', start], ['после «((»', start + 2], ['внутри названия', start + 10 + id1.length], ['перед «))»', end - 2], ['после токена', end], ['в конце', text.length]];
      for (const [name, pos] of probes) {
        await setTa(text, pos);
        await fireTa('click');
        await sleep(200);
        check('курсор ' + name + ' (токен ((ID|название))) — окна нет', !(await pickOpen()), 'pos=' + pos);
      }
      await setTa('(( ))', 2); await fireTa('click'); await sleep(200);
      check('«(( ))» (пробел между скобками) — окна нет', !(await pickOpen()));
      await setTa('(()', 2); await fireTa('click'); await sleep(200);
      check('«(()» (нет закрывающих) — окна нет', !(await pickOpen()));
      await setTa('abc', 1); await fireTa('click'); await sleep(200);
      check('обычный текст — окна нет', !(await pickOpen()));
      await setTa('', 0); await fireTa('click'); await sleep(200);
      check('пустое поле, курсор в начале — окна нет (нет выхода за границы строки)', !(await pickOpen()));
      // три пути открытия: click, selectionchange (programmatic), keyup
      await setTa('a (()) b', 4); await fireTa('click');
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      check('«a (()) b», курсор между скобками: click открывает окно', await pickOpen());
      await press('Escape');
      await setTa('a (()) b', 0); await fireTa('click'); await sleep(150);
      await ev('document.querySelector(' + q(TA) + ').setSelectionRange(4, 4)');
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      check('курсор перенесён в скобки программно (selectionchange) — окно открылось', await pickOpen());
      await press('Escape');
      await setTa('x ((())) y', 5); await fireTa('click'); await sleep(250);
      check('«((()))» с курсором в центре: «((» перед и «))» после — окно открылось (центральная пара)', await pickOpen());
      await press('Escape');
      await setTa('', 0); await fireTa('input'); await sleep(100);
    });

    await guard('окно: отмена', async () => {
      // Esc
      await replaceTa('a (()) b', 4);
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      await press('Escape');
      check('Esc: «(())» остаётся в тексте как есть', (await taVal()) === 'a (()) b', await taVal());
      check('Esc: окно закрыто, фокус вернулся в textarea, курсор между скобками', !(await pickOpen()) && (await activeIsTa()) && JSON.stringify(await taCaret()) === '[4,4]', JSON.stringify(await taCaret()));
      await fireTa('click'); await fireTa('keyup'); await sleep(250);
      check('после отмены окно НЕ открывается, пока курсор не покинул скобки (события click/keyup/input/selectionchange)', !(await pickOpen()), 'окно открыто');
      await fireTa('input'); await ev('document.dispatchEvent(new Event("selectionchange"))'); await sleep(250);
      check('... и от input / selectionchange тоже', !(await pickOpen()));
      // курсор ушёл из скобок и вернулся → открывается снова
      await press('ArrowRight'); await press('ArrowRight');           // за скобки
      await sleepS();
      check('курсор покинул скобки — окна нет', !(await pickOpen()) && JSON.stringify(await taCaret()) === '[6,6]', JSON.stringify(await taCaret()));
      await press('ArrowLeft'); await press('ArrowLeft');             // обратно между скобками
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      check('курсор вернулся между скобками — окно открывается снова', await pickOpen(), JSON.stringify(await taCaret()));
      // кнопка «Отмена»
      await k.click('#tasksLinkPick [data-tk-act="lpClose"]:not(.tk-x)');
      check('«Отмена»: «(())» остаётся, окно закрыто, фокус в textarea', !(await pickOpen()) && (await taVal()) === 'a (()) b' && (await activeIsTa()), await taVal());
      await sleepS();
      check('«Отмена»: повторно не открывается', !(await pickOpen()));
      // клик вне окна
      await leaveAndReturn();
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      check('снова открыто (курсор ушёл и вернулся)', await pickOpen());
      await k.clickXY(5, 5);
      await sleep(250);
      check('клик вне окна (по подложке) закрывает окно, текст не меняется', !(await pickOpen()) && (await taVal()) === 'a (()) b', await taVal());
      // ×
      await leaveAndReturn();
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      await k.click('#tasksLinkPick .tk-x[data-tk-act="lpClose"]');
      check('кнопка «×» окна закрывает его, «(())» остаётся', !(await pickOpen()) && (await taVal()) === 'a (()) b');
      // выбор мышью
      await leaveAndReturn();
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 3000);
      await k.click('#tasksLinkPick .tk-lp-it[data-tk-lp-id="' + T3.id + '"]');
      const want = 'a ((' + T3.id + '|Отгрузка заказа)) b';
      check('выбор мышью: токен подставлен вместо «(())», остальной текст цел', (await taVal()) === want, await taVal());
      const c = (await taCaret())[0];
      check('... курсор сразу после токена (перед « b»)', c === want.indexOf(' b'), c + ' / ' + want.indexOf(' b'));
      // название с ( ) | и переводами строк очищается; лимит 80 символов
      await ev('Tasks.__t.S.pickCache = null; void 0');
      await cancelForm();
    });

    async function cancelForm() { await k.click('[data-tk-act="cancelForm"]'); await sleep(200); }

    // ==============================================================================================
    // 3. СОХРАНЕНИЕ: связь в БД и у второй стороны; карточка; чипы
    // ==============================================================================================
    console.log('--- сохранение, карточка, чипы ---');
    await guard('сохранение T2 → T1', async () => {
      await openTasks(admin, 'list');
      await openEdit(T2.id);
      await replaceTa('Смотри ещё: (()) — конец.\nВторая строка', 14);
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      await typeSearch('клиента');
      await press('Enter');
      const want = 'Смотри ещё: ((' + T1.id + '|Заказ клиента)) — конец.\nВторая строка';
      check('в тексте: токен посреди свободного текста, перевод строки сохранён', (await taVal()) === want, await taVal());
      const before = dbLinks();
      check('до сохранения связей в БД нет', before.length === 0, JSON.stringify(before));
      await k.click('[data-tk-act="saveForm"]');
      await waitFor('!document.querySelector("#tasksView form.tk-form")', 8000);
      await sleep(400);
      const links = dbLinks();
      check('сохранение: в БД появилась связь T1—T2 (каноническая пара)', links.length === 1 && links[0] === pairKey(T1.id, T2.id), JSON.stringify(links));
      const t2 = await getT(T2.id), t1 = await getT(T1.id);
      check('API: у T2 links_text сохранён как набрано', t2.links_text === want, t2.links_text);
      check('API: у T2 связь out → T1, у T1 связь in → T2 (вторая сторона)', t2.links.length === 1 && t2.links[0].id === T1.id && t2.links[0].direction === 'out' && t1.links.length === 1 && t1.links[0].id === T2.id && t1.links[0].direction === 'in', JSON.stringify([t2.links, t1.links]));
      check('кэш окна сброшен при сохранении (после сохранения форма закрыта)', (await ev('Tasks.__t.S.pickCache')) === null);
    });

    await guard('карточка: чипы', async () => {
      await openCard(T2.id);
      check('карточка T2: блок «Связанные задачи» показан', await exists('#tasksView .tk-detail .tk-links'));
      const order = await ev('(() => { const d = document.querySelector("#tasksView .tk-detail"); const kvs = [...d.querySelectorAll(".tk-kv")]; const idxD = kvs.findIndex(e => e.querySelector("span") && e.querySelector("span").textContent === "Описание"); const idxL = kvs.findIndex(e => e.classList.contains("tk-links")); return [idxD, idxL]; })()');
      check('блок связей стоит сразу ПОД «Описанием»', order[0] >= 0 && order[1] === order[0] + 1, JSON.stringify(order));
      const chips = await cardChips();
      check('в карточке T2 — один чип-ссылка (<a>) «Заказ клиента», активный (data-tk-act=openRel)', chips.length === 1 && chips[0].tag === 'A' && chips[0].text === 'Заказ клиента' && chips[0].act === 'openRel' && chips[0].link === T1.id, JSON.stringify(chips));
      const txt = await textOf('#tasksView .tk-detail .tk-links .tk-links-text');
      check('текст вокруг чипа показан как есть: «Смотри ещё: Заказ клиента — конец.» + вторая строка', txt === 'Смотри ещё: Заказ клиента — конец.\nВторая строка', JSON.stringify(txt));
      check('переводы строк сохранены (white-space: pre-wrap)', (await ev('getComputedStyle(document.querySelector("#tasksView .tk-links-text")).whiteSpace')) === 'pre-wrap');
      check('«Также связана с:» у T2 нет (входящих нет)', !(await exists('#tasksView .tk-detail .tk-links-also')));
      await openCard(T1.id);
      check('карточка T1 (без своего текста связей): блок показан', await exists('#tasksView .tk-detail .tk-links'));
      check('у T1 нет блока собственного текста, только «Также связана с:»', !(await exists('#tasksView .tk-detail .tk-links .tk-links-text')) && (await exists('#tasksView .tk-detail .tk-links-also')));
      const al = await alsoChips();
      check('у T1 «Также связана с:» чип «Закрытие заказа» (T2), активный', al.length === 1 && al[0].text === 'Закрытие заказа' && al[0].link === T2.id && al[0].act === 'openRel' && al[0].tag === 'A', JSON.stringify(al));
      check('подпись «Также связана с:»', (await textOf('#tasksView .tk-links-also')).indexOf('Также связана с:') === 0, await textOf('#tasksView .tk-links-also'));
      await openCard(T4.id);
      check('карточка T4 (нет ни связей, ни текста): блока «Связанные задачи» нет', !(await exists('#tasksView .tk-detail .tk-links')));
    });

    // ==============================================================================================
    // 4. ЦЕПОЧКА 1–2–3(–5): клик → Список
    // ==============================================================================================
    console.log('--- клик по ссылке → Список, цепочка ---');
    await guard('цепочка', async () => {
      await setLinks(T3.id, 'после: ' + tok(T2) + ' и закрытая ' + tok(T5));
      check('цепочка T1—T2, T3—T2, T3—T5 в БД', JSON.stringify(dbLinks()) === JSON.stringify([pairKey(T1.id, T2.id), pairKey(T2.id, T3.id), pairKey(T3.id, T5.id)].sort()), JSON.stringify(dbLinks()));
      // из карточки T1 (первая в цепочке) — все четыре
      await openCard(T1.id);
      await ev('Tasks.reload()'); await sleep(600);
      await k.click('#tasksView .tk-detail .tk-links-also a.tk-lk');
      await waitFor('!!document.querySelector("#tasksView table.tk-table") && !!document.querySelector("#tasksView [data-tk-relbar]")', 8000);
      const s = await sS();
      check('клик по чипу: вид «Список», S.filters.rel = id задачи, из чьей карточки кликнули (T1)', s.view === 'list' && s.rel === T1.id && s.sel === null, JSON.stringify(s));
      let rows = await listRows();
      const ids = rows.map((r) => r.id);
      check('Список из T1: все 4 связанные задачи (T1, T2, T3, T5) — цепочка 1–2–3–5', rows.length === 4 && [T1, T2, T3, T5].every((t) => ids.indexOf(t.id) >= 0), JSON.stringify(ids));
      check('исходная задача (T1) — первая строка', ids[0] === T1.id, JSON.stringify(ids));
      check('в списке нет посторонних (T4, T6, TX, TL)', [T4, T6, TX, TL].every((t) => ids.indexOf(t.id) < 0), JSON.stringify(ids));
      check('открытые и закрытые вместе (T5 закрыта и в списке)', ids.indexOf(T5.id) >= 0 && /tk-dim/.test(rows.find((r) => r.id === T5.id).cls));
      check('первая строка — без выделения (те же классы, что у обычной открытой строки)', rows[0].cls === 'tk-row' && rows[1].cls === 'tk-row', JSON.stringify(rows.map((r) => r.cls)));
      check('остальные — по сроку: T2 (02.06), T3 (03.06), T5 (04.06)', JSON.stringify(ids.slice(1)) === JSON.stringify([T2.id, T3.id, T5.id]), JSON.stringify(ids));
      check('плашка: «Связанные задачи: Заказ клиента» и «×»', (await relBar()) && (await relBar()).indexOf('Связанные задачи: Заказ клиента') === 0 && await exists('#tasksView [data-tk-relbar] [data-tk-act="clearRel"]'), await relBar());
      check('при rel другие фильтры (Сотрудник/Срок/…) скрыты и не применяются', !(await exists('#tasksView [data-tk-filter]')), '');
      // клик по строке открывает карточку как раньше (Доска)
      await k.click('#tasksView tr.tk-row[data-id="' + T3.id + '"] .tk-c-task b');
      await waitFor('!!document.querySelector("#tasksView .tk-detail .tk-dtitle")', 6000);
      check('клик по строке связанного Списка открывает карточку (как раньше)', (await textOf('#tasksView .tk-detail .tk-dtitle')) === 'Отгрузка заказа' && (await sS()).view === 'board', JSON.stringify([await textOf('#tasksView .tk-detail .tk-dtitle'), await sS()]));
      // из карточки T3 (в середине цепочки)
      await k.click('#tasksView .tk-detail .tk-links .tk-links-text a.tk-lk');
      await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 6000);
      rows = await listRows();
      check('из T3 (середина цепочки): те же 4 задачи, первая — T3', rows.length === 4 && rows[0].id === T3.id && [T1, T2, T5].every((t) => rows.some((r) => r.id === t.id)), JSON.stringify(rows.map((r) => r.id)));
      check('... остальные по сроку: T1, T2, T5', JSON.stringify(rows.slice(1).map((r) => r.id)) === JSON.stringify([T1.id, T2.id, T5.id]), JSON.stringify(rows.map((r) => r.id)));
      // из закрытой T5
      await openCard(T5.id);
      await k.click('#tasksView .tk-detail .tk-links-also a.tk-lk');
      await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 6000);
      rows = await listRows();
      check('из закрытой T5: те же 4 задачи, первая — T5 (закрытая, без выделения кроме обычного затемнения)', rows.length === 4 && rows[0].id === T5.id && rows[0].cls === 'tk-row tk-dim', JSON.stringify(rows.map((r) => r.id + ':' + r.cls)));
      // «×» — обычный Список
      await k.click('#tasksView [data-tk-relbar] [data-tk-act="clearRel"]');
      await waitFor('!document.querySelector("#tasksView [data-tk-relbar]") && document.querySelectorAll("#tasksView tr.tk-row").length > 4', 8000);
      rows = await listRows();
      check('«×»: плашки нет, rel сброшен, обычный Список (все задачи, не только связанные)', (await sS()).rel === '' && rows.length >= 7 && rows.some((r) => r.id === T4.id), JSON.stringify(rows.map((r) => r.id)));
      check('«×»: фильтры вернулись', await exists('#tasksView [data-tk-filter="status"]'));
      // другие фильтры при rel не применяются: выставим фильтр «Статус = Закрыта» → открыть карточку → чип → список содержит открытые
      await ev('Tasks.__t.S.filters.status = "closed"; Tasks.__t.render()');
      await openCard(T2.id);
      await k.click('#tasksView .tk-detail .tk-links a.tk-lk');
      await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 6000);
      rows = await listRows();
      check('фильтр «Статус=Закрыта» при rel не применяется (в Списке и открытые, и закрытые)', rows.length === 4 && rows.some((r) => !/tk-dim/.test(r.cls)), JSON.stringify(rows.map((r) => r.id + ':' + r.cls)));
      await k.click('#tasksView [data-tk-relbar] [data-tk-act="clearRel"]');
      await sleep(500);
      await ev('Tasks.__t.S.filters.status = ""; Tasks.__t.render()');
      // изолированная задача
      await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: ' + q(T4.id) + ' } }, null)');
      await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 6000);
      rows = await listRows();
      check('openRel для задачи без связей: в Списке одна строка (исходная)', rows.length === 1 && rows[0].id === T4.id, JSON.stringify(rows));
      await ev('Tasks.__t.ACTIONS.clearRel({}, null)'); await sleep(500);
    });

    await guard('rel: ошибки', async () => {
      await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: ' + q(T6.id) + ' } }, { preventDefault() {} })');
      await sleep(500);
      let s = await sS();
      check('openRel архивной (409 task_archived): фильтр не включён, Список прежний, есть сообщение', s.rel === '' && /удал|архив/i.test(s.msg) && !(await exists('#tasksView [data-tk-relbar]')), JSON.stringify(s));
      await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: "task_net.1" } }, { preventDefault() {} })');
      await sleep(500);
      s = await sS();
      check('openRel неизвестной (404): фильтр не включён, сообщение «не найдена»', s.rel === '' && /не найден/i.test(s.msg), JSON.stringify(s));
    });

    // ==============================================================================================
    // 5. ЭКРАНИРОВАНИЕ, «задача не найдена», свободный текст
    // ==============================================================================================
    console.log('--- экранирование ---');
    await guard('экранирование', async () => {
      const A = await mk('Носитель <u>разметки</u> & "кавычки"', '2031-07-01');
      const P = await mk('Срочно (важно) | отчёт ((x))', '2031-07-02');
      const LNG = await mk('Ж'.repeat(200), '2031-07-03');
      await setLinks(A.id, 'до <b>жирный</b> & "q" \'a\'\n' + tok(TX, 'не важно') + ' <img src=x onerror=alert(1)> после');
      // «задача не найдена»: токен без записи в links[] (в БД токен остался, строки task_links нет) — правим напрямую в КОПИИ БД
      L.sql(env.tmpDb, "update tasks set links_text = links_text || ' ((task_net.404|мёртвая))' where id = '" + A.id + "';");
      await openTasks(admin, 'board', A.id);
      const chips = await cardChips();
      check('чип TX показывает АКТУАЛЬНОЕ название с сервера (не снимок из токена): «' + TX.title + '»', chips.length >= 1 && chips[0].text === TX.title, JSON.stringify(chips[0]));
      check('в блоке связей нет живых <b>/<i>/<img>/<u> (всё экранировано)', (await count('#tasksView .tk-detail .tk-links b, #tasksView .tk-detail .tk-links i, #tasksView .tk-detail .tk-links img, #tasksView .tk-detail .tk-links u')) === 0);
      const txt = await textOf('#tasksView .tk-detail .tk-links .tk-links-text');
      check('текст показан буквально: «<b>жирный</b> & "q" \'a\'» и «<img src=x onerror=alert(1)>»', txt.indexOf('до <b>жирный</b> & "q" \'a\'') === 0 && txt.indexOf('<img src=x onerror=alert(1)>') > 0, JSON.stringify(txt));
      check('атрибут title чипа не «ломается» кавычками (значение целиком)', chips[0].title.indexOf(TX.title) === 0, chips[0].title);
      const miss = await ev('(() => { const e = document.querySelector("#tasksView .tk-links .tk-lk-miss"); return e ? { t: e.textContent, tag: e.tagName, act: e.getAttribute("data-tk-act") } : null; })()');
      check('токен без записи в links[] — не ссылка, текст «задача не найдена» (не undefined)', miss && miss.t === 'задача не найдена' && miss.act === null && miss.tag !== 'A', JSON.stringify(miss));
      check('в карточке нет «undefined»/«null»', (await textOf('#tasksView .tk-detail')).indexOf('undefined') < 0 && (await textOf('#tasksView .tk-detail')).indexOf('null') < 0);
      // название TX в окне выбора и в заголовке плашки
      await openCard(TX.id);
      await openEdit(A.id);
      await replaceTa('(())', 2);
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      const lpTitle = await ev('(() => { const e = document.querySelector("#tasksLinkPick .tk-lp-it[data-tk-lp-id=" + JSON.stringify(' + q(TX.id) + ') + "]"); return e ? { t: e.textContent, b: e.querySelectorAll("b,i,img").length } : null; })()');
      check('окно выбора: название TX показано буквально, без живой разметки', lpTitle && lpTitle.t.indexOf('<b>X</b> "кав"') >= 0 && lpTitle.b === 0, JSON.stringify(lpTitle));
      await ev('document.querySelector("#tasksLinkPick .tk-lp-it[data-tk-lp-id=" + JSON.stringify(' + q(TX.id) + ') + "]").click()');
      await sleep(200);
      const tv = await taVal();
      const clean = 'Опасное <b>X</b> "кав" \'ап\' &amp; <i>';
      check('токен из названия с ( ) | очищается; название без «))» и переводов строк; ≤80', tv === '((' + TX.id + '|' + clean + '))' && tv.indexOf('\n') < 0, tv);
      // название со скобками/вертикальной чертой: чистка
      await replaceTa('(())', 2);
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      await typeSearch('отчёт');
      const pid = (await pickIds())[0];
      check('поиск «отчёт» находит задачу со скобками в названии', pid === P.id, pid);
      await press('Enter');
      check('скобки/«|» в названии заменены: «((ID|Срочно важно отчёт x))»', (await taVal()) === '((' + P.id + '|Срочно важно отчёт x))', await taVal());
      await replaceTa('(())', 2);
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      await typeSearch('жжжжж');
      await press('Enter');
      const lv = await taVal();
      const lm = /^\(\(([^|]+)\|([^)]*)\)\)$/.exec(lv);
      check('название длиннее 80 символов обрезается до 80 в токене', lm && lm[1] === LNG.id && lm[2].length === 80, lv.length + ' ' + (lm ? lm[2].length : ''));
      await cancelForm();
    });

    // ==============================================================================================
    // 6. ОШИБКИ СЕРВЕРА рядом с полем
    // ==============================================================================================
    console.log('--- ошибки записи рядом с полем ---');
    await guard('ошибки link_*', async () => {
      await openTasks(admin, 'list');
      await openEdit(T4.id);
      const bad = [
        ['link_self', '((' + T4.id + '|сам)) хвост', /саму с собой/i],
        ['link_unknown', 'до ((task_net.404|нет такой)) после', /не найден|несуществ/i],
        ['link_target_archived', 'о ((' + T6.id + '|удалённая)) о', /удал|архив/i]
      ];
      for (const [code, text, re] of bad) {
        await replaceTa(text, 0);
        await k.click('[data-tk-act="saveForm"]');
        await waitFor('!!document.querySelector("[data-tk-links-err]")', 6000);
        const err = await textOf('#tasksView [data-tk-links-err]');
        check(code + ': ошибка показана рядом с полем (role=alert), понятный текст', err && re.test(err) && (await attrOf('#tasksView [data-tk-links-err]', 'role')) === 'alert', err);
        check(code + ': форма осталась открытой, набранный текст не потерян', (await exists(TA)) && (await taVal()) === text, await taVal());
        const nearField = await ev('(() => { const e = document.querySelector("[data-tk-links-err]"); return !!(e && e.closest(".tk-f") && e.closest(".tk-f").querySelector("textarea[data-tk-field=linksText]")); })()');
        check(code + ': сообщение внутри строки поля «Связанные задачи»', nearField === true);
        if (code === 'link_self') await shot('T2_form_error_1280');
        check(code + ': в БД ничего не записано', dbLinks().indexOf(pairKey(T4.id, T6.id)) < 0 && (await getT(T4.id)).links_text === null, JSON.stringify(await getT(T4.id)));
      }
      // исправил → сохранилось, ошибка ушла
      await replaceTa('нормально ' + tok(T1), 0);
      await k.click('[data-tk-act="saveForm"]');
      await waitFor('!document.querySelector("#tasksView form.tk-form")', 8000);
      check('после исправления сохранение проходит, форма закрыта', !(await exists(TA)) && dbLinks().indexOf(pairKey(T1.id, T4.id)) >= 0, JSON.stringify(dbLinks()));
      // убрал токен у T4 (без встречного) → связь исчезла с обеих сторон
      await openEdit(T4.id);
      check('при повторной правке в поле уже сохранённый токен', (await taVal()) === 'нормально ' + tok(T1), await taVal());
      await replaceTa('', 0);
      await k.click('[data-tk-act="saveForm"]');
      await waitFor('!document.querySelector("#tasksView form.tk-form")', 8000);
      await sleep(300);
      check('удалил токен у T4 (встречного нет): связь T1—T4 исчезла (у обеих сторон)', dbLinks().indexOf(pairKey(T1.id, T4.id)) < 0 && (await getT(T1.id)).links.every((l) => l.id !== T4.id), JSON.stringify(dbLinks()));
      // VERSION_CONFLICT остаётся обычной ошибкой версии, а не ошибкой поля
      await openEdit(T4.id);
      // другой клиент меняет задачу (версия растёт; одинаковый links_text версию бы не менял)
      await api(admin, 'PUT', 'api/tasks.php?id=' + T4.id, { version: (await getT(T4.id)).version, description: 'правка другим клиентом' });
      await replaceTa('x ' + tok(T3), 0);
      await k.click('[data-tk-act="saveForm"]');
      await waitFor('!document.querySelector("#tasksView form.tk-form")', 8000);
      await sleep(300);
      check('VERSION_CONFLICT: показано обычное «Задача уже изменена…», это не ошибка поля связей', /уже изменена/.test((await sS()).msg) && !(await exists('[data-tk-links-err]')), JSON.stringify(await sS()));
    });

    // ==============================================================================================
    // 7. НОВАЯ ЗАДАЧА С ТОКЕНОМ
    // ==============================================================================================
    console.log('--- новая задача с токеном ---');
    await guard('новая задача', async () => {
      await openTasks(admin, 'list');
      await k.click('[data-tk-act="newTask"]');
      await waitFor('!!document.querySelector(' + q(TA) + ')', 6000);
      await ev('(() => { const t = document.querySelector("#tasksView [data-tk-field=title]"); t.focus(); return true; })()');
      await cdp.send('Input.insertText', { text: 'Новая со связью' });
      await ev('(() => { const s = document.querySelector("#tasksView [data-tk-field=assigneePick]"); s.value = "emp_2"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
      await sleep(200);
      await ev('(() => { const d = document.querySelector("#tasksView [data-tk-field=startDate]"); d.value = "2031-08-01"; d.dispatchEvent(new Event("change", { bubbles: true })); })()');
      await sleep(200);
      await replaceTa('Из (())', 5);
      await waitFor('!!document.querySelector("#tasksLinkPick")', 4000);
      check('новая задача (id нет): окно открывается, список запрошен (?pick=1)', await pickOpen() && (await pickReqs()) >= 1, await pickReqs());
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      const ids = await pickIds();
      check('новая задача: в списке выбора есть все неархивные задачи (исключать нечего)', [T1, T2, T3, T4, T5].every((t) => ids.indexOf(t.id) >= 0) && ids.indexOf(T6.id) < 0, JSON.stringify(ids));
      await typeSearch('изолиров');
      await press('Enter');
      check('в тексте «Из ((ID|Изолированная задача))»', (await taVal()) === 'Из ((' + T4.id + '|Изолированная задача))', await taVal());
      await k.click('[data-tk-act="saveForm"]');
      await waitFor('!document.querySelector("#tasksView form.tk-form")', 8000);
      await sleep(400);
      const created = await ev('(() => { const s = Tasks.__t.S; const t = s.tasks.find(x => x.title === "Новая со связью"); return t ? t.id : null; })()');
      check('задача создана (POST) с links_text', !!created);
      const nt = await getT(created);
      check('связь с T4 есть в БД, у T4 она входящая (вторая сторона)', dbLinks().indexOf(pairKey(created, T4.id)) >= 0 && (await getT(T4.id)).links.some((l) => l.id === created && l.direction === 'in'), JSON.stringify(dbLinks()));
      check('чип «Также связана с» у T4 после перечитывания списка (load после сохранения)', await (async () => { await openCard(T4.id); const al = await alsoChips(); return al.length === 1 && al[0].text === 'Новая со связью'; })());
      check('новая задача: links[] в ответе', nt && nt.links.length === 1 && nt.links[0].id === T4.id);
    });

    // ==============================================================================================
    // 8. ПЕРЕЧЁРКНУТАЯ ССЫЛКА, ARCHIVE ДРУГИМ КЛИЕНТОМ
    // ==============================================================================================
    console.log('--- архив: перечёркнутая ссылка у обеих сторон ---');
    await guard('архив', async () => {
      const A = await mk('Пара А', '2031-09-01'), B = await mk('Пара Б', '2031-09-02');
      await setLinks(A.id, 'связь: ' + tok(B));
      await openTasks(admin, 'board', A.id);
      let chips = await cardChips();
      check('до архива: чип B у A активный (<a>)', chips.length === 1 && chips[0].tag === 'A' && chips[0].text === 'Пара Б', JSON.stringify(chips));
      // «другой клиент» архивирует B
      const r = await archive(B.id);
      check('другой клиент архивировал B (DELETE 200)', r.status === 200, r.status);
      await ev('Tasks.reload()');
      await waitFor('!!document.querySelector("#tasksView .tk-detail .tk-links s.tk-lk-gone")', 8000);
      chips = await cardChips();
      check('у A чип B стал перечёркнутым (<s class=tk-lk-gone>), не ссылка', chips.length === 1 && chips[0].tag === 'S' && /tk-lk-gone/.test(chips[0].cls) && chips[0].act === null && chips[0].text === 'Пара Б', JSON.stringify(chips));
      check('... подсказка «Задача удалена»', chips[0].title === 'Задача удалена', chips[0].title);
      check('... перечёркивание реальное (text-decoration: line-through)', /line-through/.test(await ev('getComputedStyle(document.querySelector("#tasksView .tk-links s.tk-lk-gone")).textDecorationLine')));
      const before = await sS();
      await k.click('#tasksView .tk-links s.tk-lk-gone');
      await sleep(400);
      const after = await sS();
      check('клик по перечёркнутой ссылке ничего не делает (вид, rel, выбранная карточка прежние)', JSON.stringify(before) === JSON.stringify(after) && after.view === 'board' && after.rel === '' && !(await exists('#tasksView [data-tk-relbar]')), JSON.stringify([before, after]));
      // у второй стороны: B в архиве, её карточка читается по id; ссылка на A тоже перечёркнута? A жива → активна; проверка симметрии: архивируем A у C
      const C = await mk('Пара В', '2031-09-03'), D = await mk('Пара Г', '2031-09-04');
      await setLinks(C.id, tok(D));
      await archive(C.id);
      await ev('Tasks.reload()'); await sleep(500);
      await openCard(D.id);
      const dch = await alsoChips();
      check('симметрия: у D (вторая сторона) входящая ссылка на архивную C — перечёркнута', dch.length === 1 && dch[0].tag === 'S' && /tk-lk-gone/.test(dch[0].cls) && dch[0].act === null, JSON.stringify(dch));
      const ap = await getT(C.id);
      check('API: связь сохранена в БД (строки task_links остаются), archived=1', ap && ap.archived === 1 && dbLinks().indexOf(pairKey(C.id, D.id)) >= 0, JSON.stringify(ap && ap.archived));
      // обход графа через архивную не идёт: список из D — только D
      await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: ' + q(D.id) + ' } }, null)');
      await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 6000);
      const rr = await listRows();
      check('Список из D: архивная C в него не попадает (одна строка D)', rr.length === 1 && rr[0].id === D.id, JSON.stringify(rr));
      await ev('Tasks.__t.ACTIONS.clearRel({}, null)'); await sleep(400);
    });

    // ==============================================================================================
    // 9. ЗАКРЫТИЕ / ПЕРЕОТКРЫТИЕ связей не меняют
    // ==============================================================================================
    console.log('--- закрытие/переоткрытие ---');
    await guard('закрытие', async () => {
      const A = await mk('Закрываемая А', '2031-10-01'), B = await mk('Закрываемая Б', '2031-10-02');
      await setLinks(A.id, tok(B));
      const before = JSON.stringify(dbLinks());
      await openTasks(admin, 'board', A.id);
      await k.clickText('#tasksView .tk-detail .tk-actions button', 'Закрыть');
      await waitFor('(Tasks.__t.S.tasks.find(t => t.id === ' + q(A.id) + ') || {}).status === "closed"', 8000);
      await sleep(300);
      check('закрытие задачи: связи (БД) те же, новых не создано', JSON.stringify(dbLinks()) === before, JSON.stringify(dbLinks()));
      check('... закрытая A видна у B как связанная со status=closed', (await getT(B.id)).links.some((l) => l.id === A.id && l.status === 'closed' && !l.archived));
      await openCard(B.id);
      const al = await alsoChips();
      check('... чип «Также связана с: Закрываемая А» у B (закрытая — приглушённый класс)', al.length === 1 && /tk-lk-closed/.test(al[0].cls) && al[0].tag === 'A', JSON.stringify(al));
      await openCard(A.id);
      await k.clickText('#tasksView .tk-detail .tk-actions button', 'Переоткрыть');
      await waitFor('(Tasks.__t.S.tasks.find(t => t.id === ' + q(A.id) + ') || {}).status === "open"', 8000);
      await sleep(300);
      check('переоткрытие: связи прежние', JSON.stringify(dbLinks()) === before, JSON.stringify(dbLinks()));
      check('... текст связей у A не изменился', (await getT(A.id)).links_text === tok(B));
    });

    // ==============================================================================================
    // 10. SYNC / перерисовка: набираемый текст не сбрасывается, карточка обновляется
    // ==============================================================================================
    console.log('--- sync / render ---');
    await guard('sync', async () => {
      await openTasks(admin, 'list');
      await openEdit(T4.id);
      await typeTa('Начало текста');
      await typeTa(' и продолжение');
      await ev('(() => { const t = document.querySelector(' + q(TA) + '); t.setSelectionRange(6, 6); return true; })()');
      const text0 = await taVal();
      await ev('Tasks.onRemoteChange()');
      await sleep(500);
      check('onRemoteChange при открытой форме: текст и курсор на месте, фокус в textarea', (await taVal()) === text0 && JSON.stringify(await taCaret()) === '[6,6]' && (await activeIsTa()), JSON.stringify([await taVal(), await taCaret()]));
      await ev('Tasks.__t.render()');
      check('render() при фокусе в textarea: текст, курсор и фокус сохранены', (await taVal()) === text0 && JSON.stringify(await taCaret()) === '[6,6]' && (await activeIsTa()), JSON.stringify([await taVal(), await taCaret(), await activeIsTa()]));
      await ev('(() => { const t = document.querySelector(' + q(TA) + '); t.setSelectionRange(2, 8); return true; })()');
      await ev('Tasks.reload()');
      await sleep(600);
      check('reload() (load с render): выделение 2…8 сохранено', JSON.stringify(await taCaret()) === '[2,8]' && (await taVal()) === text0 && (await activeIsTa()), JSON.stringify([await taCaret(), await activeIsTa()]));
      check('в draft текст тот же (набор не потерян)', (await stateTa()).draft === text0, JSON.stringify(await stateTa()));
      // render() при фокусе в ДРУГОМ поле не отбирает фокус
      await ev('document.querySelector("#tasksView [data-tk-field=title]").focus()');
      await ev('Tasks.__t.render()');
      check('render() не отбирает фокус у других полей (textarea не в фокусе → фокус не принудительный)', !(await activeIsTa()));
      await cancelForm();
      // открытая карточка: связь, добавленная на стороне, появляется после sync
      const A = await mk('Карточка для sync', '2031-11-01');
      await openTasks(admin, 'board', A.id);
      check('до sync: у A блока связей нет', !(await exists('#tasksView .tk-detail .tk-links')));
      const B = await mk('Новая сторона', '2031-11-02');
      await setLinks(B.id, tok(A));
      await ev('Tasks.onRemoteChange()');
      await waitFor('!!document.querySelector("#tasksView .tk-detail .tk-links-also")', 8000);
      const al = await alsoChips();
      check('sync (onRemoteChange) в открытой карточке: появилась входящая связь «Новая сторона»', al.length === 1 && al[0].text === 'Новая сторона', JSON.stringify(al));
      // кэш окна сбрасывается при sync
      await ev('Tasks.__t.S.pickCache = [{ id: "x", title: "кэш", status: "open", start_at: "2031-01-01" }]; void 0');
      await ev('Tasks.onRemoteChange()');
      await sleep(400);
      check('onRemoteChange сбрасывает кэш окна выбора', (await ev('Tasks.__t.S.pickCache')) === null);
    });

    // ==============================================================================================
    // 11. supervisor / viewer: ссылки и переход есть, записи нет
    // ==============================================================================================
    console.log('--- supervisor / viewer ---');
    for (const [name, ck] of [['supervisor', sup], ['viewer', viewer]]) {
      await guard('роль ' + name, async () => {
        await openTasks(ck, 'board', T2.id);
        if (name === 'supervisor' && SHOTS) await k.shotEl('#tasksView .tk-detail', 'T2_card_supervisor_1280');
        const chips = (await cardChips()).filter((c) => c.link === T1.id);
        check(name + ': в карточке T2 есть блок связей с активным чипом «Заказ клиента»', chips.length === 1 && chips[0].tag === 'A' && chips[0].text === 'Заказ клиента' && chips[0].act === 'openRel', JSON.stringify(chips));
        check(name + ': нет кнопок записи (Править/Закрыть/В архив), нет поля связей', !(await exists('#tasksView .tk-detail [data-tk-act="editTask"]')) && !(await exists(TA)));
        await k.click('#tasksView .tk-detail .tk-links a.tk-lk');
        await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 8000);
        const rows = await listRows();
        check(name + ': клик → «Список» связанных задач (T2 первой; T1, T3, T5 в цепочке)', rows[0].id === T2.id && [T1, T3, T5].every((t) => rows.some((r) => r.id === t.id)), JSON.stringify(rows.map((r) => r.id)));
        check(name + ': плашка «Связанные задачи: Закрытие заказа» и «×»', (await relBar()).indexOf('Связанные задачи: Закрытие заказа') === 0 && await exists('[data-tk-act="clearRel"]'), await relBar());
        check(name + ': в Списке нет ✎ и «+ Новая задача»', !(await exists('#tasksView [data-tk-act="editTask"]')) && !(await exists('[data-tk-act="newTask"]')));
        if (name === 'supervisor') await shot('T2_list_rel_supervisor_1280');
        await k.click('[data-tk-act="clearRel"]');
        await sleep(500);
        check(name + ': «×» возвращает обычный Список', (await sS()).rel === '' && !(await exists('#tasksView [data-tk-relbar]')));
        // «Также связана с» для входящей
        await openCard(T1.id);
        check(name + ': у T1 «Также связана с:» виден (входящая от T2)', (await alsoChips()).some((c) => c.link === T2.id));
        // запись сервером отклоняется
        const r = await api(ck, 'PUT', 'api/tasks.php?id=' + T2.id, { version: (await getT(T2.id)).version, links_text: 'x' });
        check(name + ': запись links_text сервером отклоняется (403)', r.status === 403, r.status);
      });
    }

    // ==============================================================================================
    // 12. ВЁРСТКА 1280 / 375: без горизонтального скролла (обычные данные + длинные названия); скриншоты T2_*
    // ==============================================================================================
    console.log('--- вёрстка 1280 / 375 ---');
    await guard('вёрстка', async () => {
      const SA = await mk('Пара вёрстка А', '2032-04-01'), SB = await mk('Пара вёрстка Б', '2032-04-02');
      await setLinks(SA.id, 'Смотри ' + tok(SB) + ' и ' + tok(T1));
      await archive(SB.id);
      const LA = await mk('Носитель длинных связей', '2032-03-01');
      await setLinks(LA.id, 'Длинная строка без пробелов ' + 'я'.repeat(200) + '\nи ссылка ' + tok(TL) + ' и ещё ' + tok(TX) + ' и ' + tok(T1) + ' и ' + tok(T2) + ' и ' + tok(T3));
      const cardShot = async (name) => { if (SHOTS) await k.shotEl('#tasksView .tk-detail', name); };
      for (const [w, h] of [[1280, 900], [375, 800]]) {
        // --- обычные данные
        await openTasks(admin, 'board', T2.id, w, h);
        let o = await overflowX();
        check(w + ': карточка со ссылками — без горизонтального скролла панели/страницы', noHScroll(o), JSON.stringify(o));
        await cardShot('T2_card_' + w);
        await openCard(SA.id);
        check(w + ': карточка с перечёркнутой ссылкой — без горизонтального скролла', noHScroll(await overflowX()), JSON.stringify(await overflowX()));
        await cardShot('T2_card_struck_' + w);
        await ev('Tasks.open({ view: "list" })');
        await waitFor('!!document.querySelector("#tasksView table.tk-table")', 8000);
        await ev('Tasks.__t.ACTIONS.editTask({ dataset: { id: ' + q(T2.id) + ' } }, null)');
        await waitFor('!!document.querySelector(' + q(TA) + ')', 8000);
        await ev('document.querySelector(' + q(TA) + ').scrollIntoView({ block: "center" })');
        await sleep(250);
        check(w + ': форма со ссылкой — без горизонтального скролла', noHScroll(await overflowX()), JSON.stringify(await overflowX()));
        await shot('T2_form_' + w);
        await replaceTa('Смотри (())', 9);
        await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 8000);
        await shot('T2_picker_' + w);
        await press('Escape');
        await cancelForm();
        await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: ' + q(T2.id) + ' } }, null)');
        await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 8000);
        await sleep(300);
        o = await overflowX();
        check(w + ': «Список» связанных (плашка + таблица) — без горизонтального скролла страницы/панели', o.view <= 1 && o.panel <= 1 && o.doc <= 1, JSON.stringify(o));
        await shot('T2_list_rel_' + w);
        await ev('Tasks.__t.ACTIONS.clearRel({}, null)'); await sleep(400);

        // --- длинные названия / длинный текст без пробелов
        await openTasks(admin, 'board', LA.id, w, h);
        o = await overflowX();
        check(w + ': карточка с длинными чипами — без горизонтального скролла панели/страницы', noHScroll(o), JSON.stringify(o));
        const chipOk = await ev('(() => { const d = document.querySelector("#tasksView .tk-detail"); const dr = d.getBoundingClientRect(); return [...d.querySelectorAll(".tk-lk")].every(e => { const r = e.getBoundingClientRect(); return r.right <= dr.right + 1 && r.left >= dr.left - 1; }); })()');
        check(w + ': все чипы внутри карточки', chipOk === true);
        const ell = await ev('(() => { const e = [...document.querySelectorAll("#tasksView .tk-detail .tk-lk")].find(x => x.textContent.indexOf("Длинн") === 0); if (!e) return null; const cs = getComputedStyle(e); return { ov: cs.overflow, to: cs.textOverflow, title: e.getAttribute("title") }; })()');
        check(w + ': длинное название чипа обрезается многоточием, полный текст — в title', ell && ell.to === 'ellipsis' && ell.title && ell.title.indexOf(LONGW) === 0, JSON.stringify(ell));
        await cardShot('T2_long_card_' + w);
        await ev('Tasks.open({ view: "list" })');
        await waitFor('!!document.querySelector("#tasksView table.tk-table")', 8000);
        await ev('Tasks.__t.ACTIONS.editTask({ dataset: { id: ' + q(LA.id) + ' } }, null)');
        await waitFor('!!document.querySelector(' + q(TA) + ')', 8000);
        await sleep(250);
        const of = await overflowX();
        check(w + ': форма с длинным текстом связей — без горизонтального скролла', noHScroll(of), JSON.stringify(of));
        const taw = await ev('(() => { const t = document.querySelector(' + q(TA) + '); const f = t.closest(".tk-f").getBoundingClientRect(); const r = t.getBoundingClientRect(); return r.width > 150 && r.right <= f.right + 1 && r.left >= f.left - 1; })()');
        check(w + ': textarea помещается в строку формы', taw === true);
        await replaceTa('(())', 2);
        await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 8000);
        const om = await ev('(() => { const m = document.querySelector("#tasksLinkPick .tk-modal"); const r = m.getBoundingClientRect(); const items = [...m.querySelectorAll(".tk-lp-it")]; return { l: r.left, r: r.right, w: window.innerWidth, sw: m.scrollWidth - m.clientWidth, items: items.every(e => e.getBoundingClientRect().right <= r.right + 1) }; })()');
        check(w + ': окно выбора помещается в экран, без горизонтальной прокрутки, длинные названия не вылезают', om.l >= 0 && om.r <= om.w + 1 && om.sw <= 1 && om.items === true, JSON.stringify(om));
        await shot('T2_long_picker_' + w);
        await press('Escape');
        await cancelForm();
        await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: ' + q(LA.id) + ' } }, null)');
        await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 8000);
        await sleep(300);
        const orr = await overflowX();
        const wrapOk = await ev('(() => { const w = document.querySelector("#tasksView .tk-tablewrap"); return w ? w.getBoundingClientRect().right <= window.innerWidth + 1 : true; })()');
        check(w + ': «Список» с длинным названием — страница/панель без горизонтального скролла, таблица внутри экрана', orr.view <= 1 && orr.panel <= 1 && orr.doc <= 1 && wrapOk, JSON.stringify(orr));
        await ev('Tasks.__t.ACTIONS.clearRel({}, null)'); await sleep(400);
      }
      await k.size(1280, 900, false);
    });

    // ==============================================================================================
    // 13. Кэш окна: форма закрыта / открыта заново, архивная в списке выбора
    // ==============================================================================================
    console.log('--- кэш окна выбора ---');
    await guard('кэш', async () => {
      await openTasks(admin, 'list');
      await openEdit(T4.id);
      const n0 = await pickReqs();
      await replaceTa('(())', 2);
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      await press('Escape');
      await press('ArrowRight'); await press('ArrowLeft');
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      const n1 = await pickReqs();
      check('повторное открытие окна в той же форме — без нового запроса (кэш в S)', n1 === n0 + 1, JSON.stringify([n0, n1]));
      await press('Escape');
      await cancelForm();
      await openEdit(T4.id);
      await replaceTa('(())', 2);
      await waitFor('document.querySelectorAll("#tasksLinkPick .tk-lp-it").length > 0', 6000);
      check('новая форма — свежий запрос (кэш сброшен при открытии формы)', (await pickReqs()) === n1 + 1, await pickReqs());
      // сбой запроса — понятная ошибка в окне
      await press('Escape');
      await ev('Tasks.__t.S.pickCache = null; window.__origFetch = window.fetch; window.fetch = (u, o) => /pick=1/.test(String(u)) ? Promise.resolve(new Response("{}", { status: 500 })) : window.__origFetch(u, o); void 0');
      await press('ArrowRight'); await press('ArrowLeft');
      await waitFor('!!document.querySelector("#tasksLinkPick")', 3000);
      await sleep(500);
      check('сбой ?pick=1 — в окне понятная ошибка, а не пустота', /Ошибка|не удалось|Нет связи/i.test(await pickText()), await pickText());
      await ev('window.fetch = window.__origFetch; void 0');
      await press('Escape');
      await cancelForm();
    });

    // ==============================================================================================
    // 14. «показаны первые 200» (в конце: хаб на 200+ задач засоряет данные скриншотов)
    // ==============================================================================================
    console.log('--- лимит 200 ---');
    await guard('лимит 200', async () => {
      const H = await mk('Хаб', '2032-01-01');
      const first = [];
      const N = 204;
      let idx = 0;
      async function worker() { while (idx < N) { const i = idx++; const t = await mk('Спица ' + i, '2032-02-01', { links_text: '((' + H.id + '|Хаб))' }); if (i === 0) first.push(t); } }
      await Promise.all([worker(), worker(), worker(), worker()]);
      const rel = await api(admin, 'GET', 'api/tasks.php?related=' + encodeURIComponent(H.id));
      check('API: компонент хаба усечён до 200 с truncated=true', rel.json.truncated === true && rel.json.ids.length === 200, JSON.stringify([rel.json.truncated, (rel.json.ids || []).length]));
      await openTasks(admin, 'list');
      await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: ' + q(H.id) + ' } }, null)');
      await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 15000);
      await sleep(300);
      const bar = await relBar();
      const rows = await listRows();
      check('плашка: «показаны первые 200»', bar && /показаны первые 200/.test(bar), bar);
      if (SHOTS) await k.shotEl('[data-tk-relbar]', 'T2_rel_truncated_1280');
      check('в Списке 200 строк, исходная (Хаб) первой', rows.length === 200 && rows[0].id === H.id, rows.length + ' ' + (rows[0] && rows[0].id));
      await ev('Tasks.__t.ACTIONS.clearRel({}, null)'); await sleep(600);
      // без усечения «показаны первые 200» нет
      await ev('Tasks.__t.ACTIONS.openRel({ dataset: { id: ' + q(T1.id) + ' } }, null)');
      await waitFor('!!document.querySelector("#tasksView [data-tk-relbar]")', 8000);
      check('без усечения подписи «показаны первые» нет', !/показаны первые/.test(await relBar()), await relBar());
      await ev('Tasks.__t.ACTIONS.clearRel({}, null)'); await sleep(400);
    });

    // ==============================================================================================
    // 15. Прочее: старые поля/потоки не сломаны; ошибок JS нет
    // ==============================================================================================
    console.log('--- прочее ---');
    await guard('прочее', async () => {
      const t = await mk('Без связей payload', '2032-05-01');
      check('новая задача без связей: links_text пуст, links=[]', t.links_text === null && Array.isArray(t.links) && t.links.length === 0, JSON.stringify([t.links_text, t.links]));
      // buildPayload отправляет links_text
      const p = await ev('(() => { const d = Tasks.__t.S.form; return null; })()');
      await openTasks(admin, 'list');
      const payload = await ev('(() => { const d = { title: "x", description: "", assignees: ["emp_2"], kind: "single", startDate: "2031-01-01", startTime: "", endDate: "2031-01-01", endTime: "", priority: 2, labels: [], labelInput: "", checklist: [], occ: [], linksText: "  ((a.b|c))  \\n" }; return Tasks.__t.buildPayload(d, true); })()');
      check('buildPayload: links_text отправляется (обрезанный trim)', payload && payload.links_text === '((a.b|c))', JSON.stringify(payload));
      const payload2 = await ev('(() => { const d = { title: "x", description: "", assignees: ["emp_2"], kind: "single", startDate: "2031-01-01", startTime: "", endDate: "2031-01-01", endTime: "", priority: 2, labels: [], labelInput: "", checklist: [], occ: [] }; return Tasks.__t.buildPayload(d, false); })()');
      check('buildPayload: черновик без linksText → links_text: "" (очистка), не undefined', payload2 && payload2.links_text === '', JSON.stringify(payload2));
      const noExc = cdp.exceptions.filter((e) => /tasks\.js/.test(e));
      check('в браузере нет необработанных исключений из js/tasks.js', noExc.length === 0, noExc.slice(0, 2).join(' | '));
      check('диалогов confirm/alert браузера не появлялось', cdp.dialogs.length === 0, JSON.stringify(cdp.dialogs));
    });

    check('data/app.db не изменена (sha1)', sha1(REAL_DB) === dbBefore);
  } finally {
    env.cleanup();
  }
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.log('  FAIL  необработанная ошибка теста — ' + (e && e.stack || e)); console.log('RESULT: ' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
