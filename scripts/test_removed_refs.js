#!/usr/bin/env node
'use strict';
/*
 * test_removed_refs.js — самотесты scripts/check_removed_refs.js (IE-1, сьют `refs` gate).
 *
 * Работают на ВРЕМЕННОЙ копии дерева: `git archive HEAD` -> $TMPDIR/refs_selftest.XXXX -> отдельный
 * `git init` + базовый коммит (общая база объектов с рабочим репозиторием не используется, поэтому
 * `git worktree` не нужен и `git worktree prune` не требуется). Рабочее дерево и data/app.db не
 * трогаются (проверяется в конце: git status и sha1 data/app.db до/после); копия удаляется всегда.
 *
 * Итог: строка `RESULT: N passed, M failed` (формат остальных JS-сьютов gate).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CHECK = path.join(REPO, 'scripts', 'check_removed_refs.js');
const sh = (cmd, cwd) => { const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error('sh failed: ' + cmd + '\n' + r.stderr); return r.stdout; };
const gitR = (args, cwd) => execFileSync('git', args, { cwd: cwd || REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');

// ------------------------------------------------------------------ состояние «до»
const STATUS_BEFORE = gitR(['status', '--porcelain', '--untracked-files=all']);
const DB_BEFORE = sha1(path.join(REPO, 'data', 'app.db'));

const TMP_PARENT = process.env.TMPDIR || os.tmpdir();
const T = fs.mkdtempSync(path.join(TMP_PARENT, 'refs_selftest.'));
let BASE = '';

function setup() {
  // reports/ и staff_project/ в проверке ссылок не участвуют — в копию не берём (быстрее и меньше диска)
  sh('git archive HEAD | tar -x -C ' + JSON.stringify(T) + ' --exclude=./reports --exclude=./staff_project --exclude=reports --exclude=staff_project', REPO);
  const w = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(T, rel)), { recursive: true }); fs.writeFileSync(path.join(T, rel), txt); };
  w('js/zz_fixture.js',
    "window.Fx = {\n" +
    "  fxMethodA: function () { return 1; },\n" +
    "  fxArrowB: (a) => a + 1,\n" +
    "  fxShort(a) {\n    return a;\n  }\n};\n" +
    "const fxConst = (x) => x;\n" +
    "let fxAsync = async (y) => y;\n" +
    "function fxNamed() { return 2; }\n" +
    "function fxKeep() { return 3; }\n");
  w('js/zz_fixture_user.js',
    "Fx.fxMethodA();\n" +
    "Fx.fxArrowB(1);\n" +
    "Fx.fxShort(1);\n" +
    "fxConst(1);\n" +
    "fxAsync(1);\n" +
    "fxNamed();\n" +
    "fxKeep();\n");
  w('api/zz_fixture.php',
    "<?php\nclass ZzFx {\n  public function zzMethod() { return 1; }\n  public static function zzStatic() { return 2; }\n}\nfunction zz_helper() { return 3; }\n");
  w('api/zz_fixture_user.php',
    "<?php\n$x = new ZzFx();\n$x->zzMethod();\nZzFx::zzStatic();\nzz_helper();\n");
  w('scripts/removed_refs_allow.txt', '# пустой список исключений (самотест)\n');
  sh('git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false && git add -A && git commit -q -m base', T);
  BASE = sh('git rev-parse HEAD', T).trim();
}
function reset() { sh('git reset -q --hard ' + BASE + ' && git clean -fdxq', T); }

// ------------------------------------------------------------------ помощники правок
const P = (rel) => path.join(T, rel);
const rd = (rel) => fs.readFileSync(P(rel), 'utf8');
const wr = (rel, txt) => { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), txt); };
function lineOf(rel, needle) { const ls = rd(rel).split('\n'); const i = ls.findIndex((l) => l.includes(needle)); return i < 0 ? -1 : i + 1; }
// Удаляет определение: строку с needle и всё до баланса фигурных скобок.
function removeDef(rel, needle) {
  const ls = rd(rel).split('\n');
  const i = ls.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error('нет ' + needle + ' в ' + rel);
  let depth = 0, seen = false, j = i;
  for (; j < ls.length; j++) {
    for (const ch of ls[j].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
    if (seen && depth <= 0) break;
  }
  ls.splice(i, j - i + 1);
  wr(rel, ls.join('\n'));
}
function renameAll(oldN, newN) {
  const files = sh('git ls-files -z', T).split('\0').filter(Boolean).filter((f) => /^(index\.html|js\/.*\.js|api\/.*\.php|scripts\/.*\.(js|sh))$/.test(f));
  const rx = new RegExp('(?<![\\w$])' + oldN + '(?![\\w$])', 'g');
  for (const f of files) { const t = rd(f); if (rx.test(t)) { rx.lastIndex = 0; wr(f, t.replace(rx, newN)); } rx.lastIndex = 0; }
}
function run(extraEnv, args) {
  const env = Object.assign({}, process.env, { VERIFY_BASE: BASE }, extraEnv || {});
  Object.keys(env).forEach((k) => env[k] === undefined && delete env[k]);
  const r = spawnSync('node', [CHECK, '--root', T].concat(args || []), { encoding: 'utf8', env, maxBuffer: 1 << 28 });
  const res = { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
  if (process.env.REFS_TEST_VERBOSE) {   // REFS_TEST_VERBOSE=1 — показывать вывод проверки в каждом тесте (для отчёта)
    const lines = res.out.split('\n');
    console.log('    $ VERIFY_BASE=' + env.VERIFY_BASE + ' node scripts/check_removed_refs.js  -> rc=' + res.rc);
    lines.slice(0, 14).forEach((l) => console.log('    | ' + l));
    if (lines.length > 14) console.log('    | … (' + (lines.length - 14) + ' строк опущено)');
  }
  return res;
}
const summ = (out) => { const m = /REFS_SUMMARY removed=(\d+) withrefs=(\d+) allow=(\d+) fail=(\d+) status=(\w+)/.exec(out); return m ? { removed: +m[1], withrefs: +m[2], allow: +m[3], fail: +m[4], status: m[5] } : null; };

// ------------------------------------------------------------------ тесты
let passed = 0, failed = 0;
function t(name, fn) {
  try { reset(); fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.log('FAIL: ' + name + ' — ' + e.message); }
}
function ok(c, m) { if (!c) throw new Error(m); }
function expectFail(r, m) { ok(r.rc === 1 && summ(r.out) && summ(r.out).status === 'FAIL', (m || 'ожидался FAIL') + '; rc=' + r.rc + '\n' + r.out.slice(0, 600)); }
function expectPass(r, m) { ok(r.rc === 0 && summ(r.out) && summ(r.out).status === 'PASS', (m || 'ожидался PASS') + '; rc=' + r.rc + '\n' + r.out.slice(0, 600)); }

try {
  setup();

  // --- обязательные случаи 1–10 ---
  t('1. удалён maskPhoneField -> FAIL, есть js/trips.js:<строка oninput>', () => {
    const ln = lineOf('js/trips.js', 'window.Trips.maskPhoneField(this)'); ok(ln > 0, 'нет oninput-ссылки');
    removeDef('js/trips.js', 'function maskPhoneField(');
    const lnAfter = lineOf('js/trips.js', 'window.Trips.maskPhoneField(this)'); // определение ниже ссылки -> номер тот же
    const r = run(); expectFail(r);
    ok(lnAfter === ln, 'номер строки ссылки сместился');
    ok(r.out.includes('js/trips.js:' + ln + ':'), 'в выводе нет js/trips.js:' + ln);
    ok(summ(r.out).removed === 1, 'удалённых имён ' + summ(r.out).removed + ', ожидалось 1');
  });
  t('2. удалён Database::migrate -> FAIL, >=19 мест в api/ (в т.ч. load.php и save.php)', () => {
    removeDef('api/db.php', 'public function migrate()');
    const r = run(); expectFail(r);
    const locs = r.out.split('\n').map((l) => /^ {2}(api\/[^:]+):(\d+):/.exec(l)).filter(Boolean);
    const files = new Set(locs.map((m) => m[1]));
    ok(files.size >= 19, 'файлов api/ со ссылками ' + files.size + ' < 19');
    ok(files.has('api/load.php') && files.has('api/save.php'), 'нет api/load.php или api/save.php');
    ok(summ(r.out).removed === 1, 'удалённых имён ' + summ(r.out).removed + ', ожидалось 1 (migrate)');
  });
  t('3. удалён createTripModal (ссылок нет) -> PASS', () => {
    removeDef('js/trips.js', 'function createTripModal(');
    const r = run(); expectPass(r);
    ok(summ(r.out).removed === 1 && summ(r.out).withrefs === 0, 'ожидалось removed=1 withrefs=0: ' + JSON.stringify(summ(r.out)));
  });
  t('4. переименование с обновлением всех ссылок -> PASS', () => {
    renameAll('maskPhoneField', 'maskPhoneFieldRenamed');
    const r = run(); expectPass(r);
    ok(summ(r.out).removed === 1 && summ(r.out).withrefs === 0, 'ожидалось removed=1 withrefs=0');
  });
  t('5. переименование, одна ссылка осталась в index.html -> FAIL с index.html:<строка>', () => {
    renameAll('maskPhoneField', 'maskPhoneFieldRenamed');
    const html = rd('index.html'); wr('index.html', html.replace(/\n?$/, '\n') + '<input oninput="window.Trips.maskPhoneField(this)">\n');
    const ln = lineOf('index.html', 'window.Trips.maskPhoneField(this)');
    const r = run(); expectFail(r);
    ok(r.out.includes('index.html:' + ln + ':'), 'нет index.html:' + ln);
  });
  t('6. удалён метод объектного литерала (name: function) со ссылкой -> FAIL', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('  fxMethodA: function () { return 1; },\n', ''));
    const r = run(); expectFail(r);
    ok(r.out.includes('js/zz_fixture_user.js:1:'), 'нет js/zz_fixture_user.js:1');
  });
  t('7a. имя осталось только в строке-комментарии // -> PASS', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    wr('js/zz_fixture_user.js', rd('js/zz_fixture_user.js').replace('fxNamed();', '// fxNamed удалена'));
    const r = run(); expectPass(r); ok(summ(r.out).removed === 1 && summ(r.out).withrefs === 0, 'removed=1 withrefs=0');
  });
  t('7b. имя только в многострочном блочном комментарии и в PHP # -> PASS', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    wr('js/zz_fixture_user.js', rd('js/zz_fixture_user.js').replace('fxNamed();', '/*\n * раньше звали fxNamed();\n */'));
    wr('api/zz_fixture.php', rd('api/zz_fixture.php').replace('function zz_helper() { return 3; }\n', ''));
    wr('api/zz_fixture_user.php', rd('api/zz_fixture_user.php').replace('zz_helper();', '# zz_helper() удалён'));
    const r = run(); expectPass(r); ok(summ(r.out).removed === 2 && summ(r.out).withrefs === 0, 'removed=2 withrefs=0: ' + JSON.stringify(summ(r.out)));
  });
  t('8. имя в removed_refs_allow.txt с причиной -> PASS, исключений: 1', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    wr('scripts/removed_refs_allow.txt', '# шапка\nfxNamed  # осталась только строка в тестовом стенде\n');
    const r = run(); expectPass(r);
    const s = summ(r.out); ok(s.allow === 1 && s.removed === 1 && s.withrefs === 1 && s.fail === 0, 'summary ' + JSON.stringify(s));
    ok(r.out.includes('исключение применено'), 'нет сообщения о применённом исключении');
  });
  t('8b. та же строка без причины -> FAIL (формат)', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    wr('scripts/removed_refs_allow.txt', 'fxNamed\n');
    expectFail(run());
    wr('scripts/removed_refs_allow.txt', 'fxNamed  #   \n');
    const r = run(); expectFail(r, 'пустая причина после # должна быть FAIL'); ok(r.out.includes('нет причины'), 'нет сообщения про причину');
  });
  t('9. дифф без удалений -> PASS, «удалённых функций: 0»', () => {
    const r = run(); expectPass(r); ok(r.out.includes('удалённых функций: 0'), 'нет «удалённых функций: 0»');
  });
  t('10. VERIFY_BASE на несуществующий коммит -> FAIL с понятным сообщением', () => {
    const r = run({ VERIFY_BASE: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }); expectFail(r);
    ok(r.out.includes('VERIFY_BASE') && r.out.includes('не найден') && r.out.includes('Что делать'), 'сообщение непонятное: ' + r.out.slice(0, 300));
    const r2 = run({ VERIFY_BASE: 'no-such-branch' }); expectFail(r2);
  });

  // --- дополнительные ---
  t('11. удалена стрелочная функция (const/let/async) со ссылкой -> FAIL', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('const fxConst = (x) => x;\n', '').replace('let fxAsync = async (y) => y;\n', ''));
    const r = run(); expectFail(r); ok(summ(r.out).removed === 2 && summ(r.out).withrefs === 2, JSON.stringify(summ(r.out)));
  });
  t('12. удалён name: (a) => ... и shorthand-метод name(a) { -> FAIL', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('  fxArrowB: (a) => a + 1,\n', '').replace('  fxShort(a) {\n    return a;\n  }\n', ''));
    const r = run(); expectFail(r); ok(summ(r.out).removed === 2 && summ(r.out).withrefs === 2, JSON.stringify(summ(r.out)));
  });
  t('13. PHP: удалён метод (->name) и static (::name) со ссылками -> FAIL', () => {
    wr('api/zz_fixture.php', '<?php\nclass ZzFx {\n}\nfunction zz_helper() { return 3; }\n');
    const r = run(); expectFail(r);
    ok(r.out.includes('api/zz_fixture_user.php:3:') && r.out.includes('api/zz_fixture_user.php:4:'), 'нет ссылок ->zzMethod / ::zzStatic');
  });
  t('14. PHP: переименование метода с обновлением ссылок -> PASS', () => {
    renameAll('zzMethod', 'zzMethodNew');
    const r = run(); expectPass(r); ok(summ(r.out).removed === 1, 'removed=1');
  });
  t('15. удалён целый файл с определениями, ссылки остались -> FAIL', () => {
    fs.unlinkSync(P('js/zz_fixture.js'));
    const r = run(); expectFail(r); ok(summ(r.out).removed >= 6, 'removed ' + summ(r.out).removed);
  });
  t('16. изменения уже закоммичены в копии (база = старый коммит) -> тоже FAIL', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    sh('git add -A && git commit -q -m rm', T);
    expectFail(run());                       // VERIFY_BASE = BASE, текущее дерево = новый HEAD
    expectPass(run({ VERIFY_BASE: 'HEAD' }), 'база = HEAD и чистое дерево -> PASS');
  });
  t('17. ссылка в НЕотслеживаемом новом файле и в scripts/ учитывается -> FAIL', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    wr('js/zz_fixture_user.js', rd('js/zz_fixture_user.js').replace('fxNamed();\n', ''));
    expectPass(run(), 'без ссылок PASS');
    wr('js/zz_untracked.js', 'fxNamed();\n');
    let r = run(); expectFail(r); ok(r.out.includes('js/zz_untracked.js:1:'), 'нет untracked');
    fs.unlinkSync(P('js/zz_untracked.js'));
    wr('scripts/zz_helper_test.js', 'run("fxNamed");\n');
    r = run(); expectFail(r); ok(r.out.includes('scripts/zz_helper_test.js:1:'), 'нет scripts/');
  });
  t('18. ссылка в строковом литерале и в *.json учитывается; в *.md и reports/ — нет', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    wr('js/zz_fixture_user.js', rd('js/zz_fixture_user.js').replace('fxNamed();\n', ''));
    wr('notes.md', 'fxNamed\n'); wr('reports/x.txt', 'fxNamed\n'); wr('CODEMAP.md', 'fxNamed\n');
    expectPass(run(), '*.md/reports/CODEMAP не должны считаться');
    wr('n8n_zz.json', '{"fn":"fxNamed"}\n');
    const r = run(); expectFail(r); ok(r.out.includes('n8n_zz.json:1:'), 'нет n8n_zz.json');
  });
  t('19. определение только в js/test_* / *_test.php не считается продакшен-определением', () => {
    wr('js/test_zz.js', 'function onlyInTestFn() { return 1; }\n');
    sh('git add -A && git commit -q -m t', T);
    const base2 = sh('git rev-parse HEAD', T).trim();
    fs.unlinkSync(P('js/test_zz.js'));
    wr('js/zz_user3.js', 'onlyInTestFn();\n');
    const r = run({ VERIFY_BASE: base2 }); expectPass(r); ok(summ(r.out).removed === 0, 'removed=0');
  });
  t('20. нет origin/main и VERIFY_BASE не задан -> PASS «удалённых функций: 0»', () => {
    wr('js/zz_fixture.js', rd('js/zz_fixture.js').replace('function fxNamed() { return 2; }\n', ''));
    const r = run({ VERIFY_BASE: undefined }); expectPass(r); ok(r.out.includes('удалённых функций: 0'), 'нет пометки');
  });
  t('21. сообщение FAIL — на русском и говорит, что делать (ссылки или исключение с причиной)', () => {
    removeDef('js/trips.js', 'function maskPhoneField(');
    const r = run(); expectFail(r);
    ok(/Что делать: обновите оставшиеся ссылки/.test(r.out) && /removed_refs_allow\.txt/.test(r.out) && /причина обязательна/.test(r.out), 'нет инструкции');
  });
  t('22. неверная строка в allow-файле (не «имя  # причина») -> FAIL', () => {
    wr('scripts/removed_refs_allow.txt', 'два слова # причина\n');
    expectFail(run());
  });
  t('23. неиспользуемая запись исключения не роняет gate, но видна в NOTE (allow=1)', () => {
    wr('scripts/removed_refs_allow.txt', 'neverRemovedName  # на всякий случай\n');
    const r = run(); expectPass(r); ok(summ(r.out).allow === 1 && /неиспользуемые записи/.test(r.out), 'allow=1 и предупреждение');
  });
} finally {
  // уборка: временная копия удаляется всегда (отдельный репозиторий, git worktree не использовался)
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ рабочее дерево не тронуто
const STATUS_AFTER = gitR(['status', '--porcelain', '--untracked-files=all']);
const DB_AFTER = sha1(path.join(REPO, 'data', 'app.db'));
(function () {
  const tests = [
    ['рабочее дерево и git status не изменены самотестами', STATUS_BEFORE === STATUS_AFTER],
    ['data/app.db не изменена самотестами', DB_BEFORE === DB_AFTER],
    ['временная копия удалена', !fs.existsSync(T)],
  ];
  for (const [n, c] of tests) { if (c) { passed++; console.log('PASS: ' + n); } else { failed++; console.log('FAIL: ' + n); } }
})();

console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
