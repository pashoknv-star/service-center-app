# CGT-1 — CodeGraph trial on a COPY of service-center-app

Task t_941ab009 · worker sd_worker_01 · 2026-11-14 · copy = `/home/hermes/codegraph-trial/copy` (git clone, HEAD `951f61e`, branch `main`)
Tool: `@colbymchenry/codegraph` **1.6.2** (MIT), bundled Node v24.16.0, host Node v22.23.2.
Trust class: 🟡 evaluation. Every claim below carries `file:line` (copy @951f61e) and a source tag: **[graph]** = CodeGraph output, **[rg]** = ripgrep over the whole copy, **[read]** = source read by me, **[run]** = measured command.
Raw outputs: `/home/hermes/codegraph-trial/evidence/` (referenced as `evidence/<file>`). Helper scripts (all in the workspace root): `cg` (sandbox launcher: `env -i`, sandbox HOME, telemetry/update-check switches), `gt.py` (rg ground truth), `compare.py`, `run_graph.sh`, `an_*.py`, `run_*.sh`, `mcp_probe.py`.

> Skill `coordinator-code-index-trust` is **not available** to this worker (skills_list/skill_view: not found). I used the project's own text, `copy/AGENTS.md:68-81` (rules 1-7), as the authoritative statement of the §3 triggers (rule 3 = AGENTS.md:77).

## 0. Executive summary (numbers)

| Question | Measured answer |
|---|---|
| Does it install/run safely in a sandbox? | Yes. No install scripts. 13 s install, 288 MB on disk, index of the copy = 48 s, **416 MB** peak RSS (limit 1.5 GB), `.codegraph/` 13 MB. |
| What is indexed? | 85 files / 1,541 nodes / 10,524 edges (js 44, php 39, py 2). **`index.html` (5,306 lines, 93 named functions + 71 `addEventListener` handlers = 23 % of the named frontend functions) is NOT indexed**, nor `api/schema.sql`, `scripts/*.sh`, `*.sql`, JSON/MD. All 176 PHP functions (rg) are present; 318/318 named JS function declarations in the 4 app JS files are present; ~51 object-literal methods (e.g. `StorageAdapter.save/load`, 35-entry `ACTIONS` table) are NOT nodes. 0 cross-language edges. |
| Correct vs ground truth? (30 symbols) | Caller precision 80 %, **recall 49 %**. "Would a graph-only agent have been wrong?" **14 Y / 16 N.** JS→JS inside indexed files: 17/17 exact. Inline handlers / `window.*` exports / index.html callers: **0 of 8** found. PHP `$db->method()`: recall 23 % (**`Database::migrate` 0 of 19**, `getPDO` 2 of 23). JS→PHP by URL: 0 of 16. |
| "0 callers ⇒ unused" rule | Graph has 24 zero-edge functions: only **10 (42 %)** are really dead; 14 are false-dead (4 real production false-dead incl. `Database::migrate`, `saveDraftTrip`, `toggleTransportSelect`, `maskPhoneField`). |
| Architecture questions (explore/context) | Q1 partial, Q2 partial/weak, Q3 partial/weak. Output 13–16 K chars each — same size as a targeted rg+read (10–16 K chars) but incomplete; plus noise from test scripts. |
| Freshness | CLI `callers/impact/query` return **stale answers silently** until `codegraph sync` (4.8 s for 1 file, 11.8–39 s for a branch switch). Only `status`, `node` and MCP `explore` warn. MCP server (watcher) auto-syncs in ≈3.5 s and prints a staleness banner. |
| Side effects | **Telemetry ON by default** (random machine UUID + languages/size buckets; endpoint `telemetry.getcodegraph.com`). MCP server makes an update-check request to github.com. `codegraph install` writes 11 global + 7 project configs, **appends a section to the project's tracked `AGENTS.md`**, adds a Claude Code auto-allow + `UserPromptSubmit` hook, and its `hermes` target rewrites `$HERMES_HOME/config.yaml` (my shell has `HERMES_HOME` set — I used a scrubbed env). `uninstall` is not clean (leaves `{}` shells and a modified Hermes config). |
| Verdict | **Rating 5/10. Adopt for a subset, as navigation only** (definitions + in-file JS call edges + PHP function defs); never as basis for 🔴 decisions; do **not** run `codegraph install` in the project. |

---

## 1. Safety record / how the sandbox was enforced

* All work inside `/home/hermes/codegraph-trial/`. `HOME=/home/hermes/codegraph-trial/home`, `npm_config_prefix=.../npm-global`, `npm_config_cache=.../home/.npm` (`env.sh`). Every CodeGraph call went through `./cg`, which runs `env -i HOME=… PATH=… TMPDIR=… LANG=…` — i.e. **without** `HERMES_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*` (my shell has `HERMES_HOME` set; the `hermes` installer target resolves its config path from that variable — `installer/targets/hermes.js:124-126` — so an un-scrubbed `codegraph install` would have rewritten a real Hermes profile).
* No MCP registration, no `~/.hermes`, `~/.claude*`, `~/.config`, `~/.npmrc` touched. `codegraph install/uninstall` only with sandbox HOME (Part D).
* `data/app.db` was never opened by me; no SQL against it. (The only SQLite I opened is the CodeGraph index copy `tmp/idx.db`, read-only.)
* Origin repo: `git -C /home/hermes/service-center-app status --porcelain` at start = **empty**, HEAD `951f61e87ff47166b0ffa36d2cef05e4f93f5da9` (`evidence/00_origin_status_start.txt`); the final value is recorded in §8.
* **Incident (copy only, disclosed):** my first `mcp_probe.py` had a bug (`open(file,'w').write(open(file).read()…)`) that truncated `copy/js/tasks.js` to 0 bytes. Detected immediately (`git diff --stat`: 2,914 deletions), restored with `git checkout -- js/tasks.js` (copy only, origin untouched); the probe was fixed and re-run.
* A `codegraph serve --mcp` session spawns a **detached background daemon** that outlives the client (idle timeout 300 s). I found it (pid 324250 + watchdog child 324264, parent pid 948), killed it, and verified none left.

---

## 2. Part A — install & indexing facts

### A.1 Install (`evidence/A01*.txt`, `A02_install.txt`)
| Item | Value |
|---|---|
| `npm view … scripts dependencies` | **No `scripts` (no preinstall/install/postinstall), no `dependencies`.** Only `optionalDependencies`: 6 platform packages `@colbymchenry/codegraph-{linux,win32,darwin}-{x64,arm64}`; `bin: npm-shim.js`; published by GitHub Actions trusted publisher with provenance attestation. Platform package `-linux-x64`: no scripts/deps, `unpackedSize` 296,292,259. |
| Install | `npm install -g @colbymchenry/codegraph` under sandbox vars: **13.1 s wall**, peak RSS 197 MB, "added 2 packages", only an npm "new major version" notice. No warnings. |
| Disk | `npm-global` 288 MB (main package 1.2 MB + platform bundle 169 MB `lib/` + 118 MB vendored `node` v24.16.0); npm cache 63 MB. |
| Shim behaviour | `npm-shim.js` can **download a bundle from GitHub Releases** if the optional dependency is missing (knobs `CODEGRAPH_NO_DOWNLOAD`, `CODEGRAPH_DOWNLOAD_BASE`). Not triggered. |
| CLI commands | `init index sync status query explore context node files daemon unlock callers callees impact affected install uninstall telemetry upgrade` + hidden `serve`, `prompt-hook` (`evidence/A04*.txt`). `init -i` is accepted but deprecated (indexing is the default). |

### A.2 Indexing the copy (`A05_init_output.txt`, `A07_status.*`)
Command: `/usr/bin/time -v codegraph init -i -y -v` in `copy/` (telemetry off):

| Metric | Value |
|---|---|
| Wall time | **48.0 s** (parse phase ≈4 s; "resolving" phase 4.3 → 45.4 s = 41 s for 21,560 references; linking 0.7 s). A second full `codegraph index` took 49.3 s. |
| CPU | 37.7 s user + 10.7 s sys |
| **Peak RSS** | **416,424 KB (≈407 MB)** — under the 1.5 GB limit; `sync` 192–378 MB; `explore` ≈206 MB. |
| `.codegraph/` | 13 MB (`codegraph.db` 12.85 MB; WAL +4.5 MB after an MCP session). It carries its own `.gitignore` (`*` + `!.gitignore`) so **`git status` shows `?? .codegraph/`** (rule 6 pollution; `scripts/verify_all.sh:36,102` compares status before/after, so it is stable, but `git add -A` would stage `.codegraph/.gitignore`). |

`codegraph status` (verbatim, `evidence/A07_status.txt`): Files **85**, Nodes **1,541**, Edges **10,524**; nodes by kind: function 981, constant 367, file 85, variable 52, method 32, import 17, class 4, field 2, property 1; by language: javascript 44, php 39, python 2. Edge kinds (DB, `A09`): calls 8,608 · contains 1,456 · references 401 · imports 45 · instantiates 14. Unresolved refs kept in the DB: ≈12.7 K with status `failed` (mostly built-ins/DOM/PDO calls; `unresolved_refs` table).
Per language/kind (DB): JS function 802 / constant 341 / variable 37 / method 19 / class 3 / property 1; PHP function 163 / constant 26 / method 13 / import 6 / field 2 / class 1.

### A.3 COVERAGE (what is indexed, with what node kinds, what is not)
(`A08_files_flat.txt`, `A09_coverage_analysis.txt`, `A11_coverage_rg_counts.txt`, `B_cross_language_edges.txt`)

| Artifact | Indexed? | Node kinds / evidence |
|---|---|---|
| **`index.html`** (inline `<script>` at :2281 → :5306; `onclick=""` attributes) | **NO** — 0 nodes, not even a file node (language `html` unsupported). [rg]: 93 named `function` declarations, 71 `addEventListener(` sites, 0 `on*="…"` HTML attributes (the two matches of a loose `onchange =` regex are `const onChange = function` JS). All of `save()` :4728, `render()`, `loadDefault()` :4751, the `#deleteEmp` handler :4534, `SyncClient` :4822 live here and are invisible to the graph. |
| `js/storage.js`, `js/tasks.js`, `js/tasks_matrix.js`, `js/trips.js` | Yes (12 / 209 / 25 / 86 symbols + file node). Named function declarations: rg 12+207+25+74 = **318**, in graph **318** (0 missing; `A09`). Kinds: `function`, `constant` (top-level `var X = …`), `variable`, `class`. |
| Object-literal / property-assigned functions (`name: function(){}`) | **NOT nodes.** [rg] counts: storage.js 4, tasks.js 40 (incl. 35-entry `ACTIONS` table, :1894), tasks_matrix.js 1, trips.js 6. Verified: `codegraph query StorageAdapter` → no result; `query filterBy` (ACTIONS entry tasks.js:1923) → only unrelated `tagBtn`; `query getSelectedEmployeeIds` (window.Trips property fn) → no result. Calls made inside such functions are attributed to the **file node** ("file tasks.js" appears as caller of `render`/`load`). |
| `js/test_trips_overlay.js`, `scripts/*.js` (36 files), `n8n/code/*.js` (3) | Yes (all 44 JS files). |
| `api/*.php` (31 files) + root/`scripts`/`staff_project` PHP (39 total) | Yes. **rg: 176 `function` declarations in all `*.php`; graph: 176; missing names: none** (`A09`). Kinds: `function` 163, `method` 13 (class `Database`, `api/db.php`), `constant` 26 (`define`/`const`), `import` 6 (`require_once`), `field` 2, `class` 1. Top-level script code (the real endpoint bodies in `tasks.php`, `save.php`, `load.php` …) is represented only by the **file node** as caller. |
| `api/schema.sql`, `scripts/v6_director_data.sql` | **NO** (17 `CREATE TABLE` in schema.sql invisible). |
| `scripts/*.sh` (6) + root `test_*.sh` (3), `reports/**/*.html`, `staff_project/index.html` | **NO.** Inline `php -r '…Database::getInstance()->getPDO()…'` in shell scripts (and one JS test) is invisible (10 `getInstance` and 7 `getPDO` call sites, 5 files). |
| `scripts/*.py` (2) | Yes (python, 31 symbols). |
| Docs/JSON/xlsx/images | Not indexed (by design). |
| **Cross-language edges** | **0** in the whole graph (`B_cross_language_edges.txt`): no JS→PHP, no PHP→JS, no HTML→JS. |

**Exactly NOT covered:** `index.html` as a whole (93 of 411 named frontend functions ≈ 23 %, plus 71 `addEventListener` handlers, ≈5.3 K lines — the core save/render/sync glue); inline-handler strings (they are inside template literals in `js/trips.js`: 23 `onclick=` lines, 26 with other `on*=` events, e.g. :1210, :1388); `window.X = {…}` export consumers; object-literal methods; JS↔PHP URL links (URLs are held in constants `API`, `EMP_API`, `SAVE_URL`, `API_BASE`); SQL/shell/JSON config; PHP instance-method calls on untyped variables (`$db->getPDO()`, `$db->migrate()`).

### A.4 Compare with `CODEMAP.md` (`A10_codemap_comparison.txt`)
CODEMAP = 166,940 chars / 704 lines: `rg --json` dump, **692 match lines** (index.html 137, tasks.js 399, trips.js 76, tasks_matrix.js 50, storage.js 30), no PHP, no call edges, no kinds; header commit `356dd51` (2026-11-14) but `js/tasks.js` was changed afterwards (`f84860c`, +63/−4): **287 of 399 (72 %) CODEMAP tasks.js entries no longer match the current line/text**; other 4 files 100 % current. It also contains non-function matches (`rows.forEach(function (t) {`, string fragments).

| | CODEMAP.md | CodeGraph |
|---|---|---|
| `index.html` functions | **yes** (137 lines, regex) | **no** |
| PHP (176 functions) | no | **yes**, with kinds |
| Call edges / callers / impact | no | yes (8,608 `calls`) for statically resolvable calls |
| Line-number freshness | stale after every merge (tasks.js 72 % stale now) | exact at last sync; staleness detectable (`status`), re-sync 5 s |
| Object-literal methods | partly (regex catches `name: function`) | no |
| Size to load | 167 K chars | queries on demand (0.8–2 s) |
**What the graph adds:** PHP defs, kinds, qualified names (`saveTrip::norm`), caller/callee edges, on-demand slicing. **What it lacks vs CODEMAP:** every `index.html` symbol, and the regex-visible object-literal methods.

---

## 3. Part B — correctness vs ground truth

### B.1 Method
* 30 symbols (≥ required strata). For each: graph `callers` / `callees` / `impact -d 2` (+JSON) → `evidence/B_<ID>_graph*.txt/json`; ground truth = `rg -n -w -F <name>` over the **whole copy** + reading each hit → `evidence/B_<ID>_rg.txt` (raw rg + heuristic annotation; final verdicts by reading, overrides in `overrides.json`, comparison output `B_<ID>_compare.{txt,json}`).
* Unit of comparison: **distinct enclosing caller** (function, or file node for top-level code), production code. Test/acceptance callers counted separately. Export-object references (`window.Tasks = {x: x}`) are neither TP nor FP (column "export-ref").
* IDs: S1 = JS→JS, S2 = inline/export/index.html, S3 = PHP, S4 = JS→PHP by URL, S5 = common/duplicate names, S6 = dead.
* Full per-symbol table: `evidence/B_summary.md` (also pasted here).

### B.2 Per-symbol results

| ID | Symbol | GT callers (prod) | Graph callers (real) | TP | FP | FN | export-ref | tests GT / missed | Wrong from graph alone? | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| S1a | `mergeTask` js/tasks.js:226 | 7 | 7 | 7 | 0 | 0 | 0 | 0/0 | **N** | exact |
| S1b | `shiftWhen` tasks.js:927 | 2 | 2 | 2 | 0 | 0 | 0 | 0/0 | **N** | exact |
| S1c | `calMove` tasks.js:1003 | 1 | 1 | 1 | 0 | 0 | 1 | 2/2 | **N** | prod exact (`onDragUp` :1365); 2 test callers `scripts/test_tasks_calendar.js:786,992` via `__t` not linked; explore claims "no tests found" |
| S1d | `notifyChanged` tasks.js:1723 | 7 | 7 | 7 | 0 | 0 | 0 | 0/0 | **N** | exact |
| S2a | `Tasks.offerReassign` tasks.js:2548 | 1 | 0 | 0 | 0 | 1 | 1 | 2/2 | **Y** | only real caller `index.html:4564` (#deleteEmp handler :4534) |
| S2b | `Tasks.openTasksFor` tasks.js:2299 | 1 | 0 | 0 | 0 | 1 | 1 | 1/1 | **Y** | real caller `index.html:4544` |
| S2c | `Trips.removeParticipantRow` trips.js:1525 | 1 | 0 | 0 | 0 | 1 | 1 | 0/0 | **Y** | `onclick="window.Trips.removeParticipantRow(${index})"` trips.js:1388 |
| S2d | `Trips.saveTrip` trips.js:1549 | 2 | 0 | 0 | 0 | 2 | 1 | 0/0 | **Y** | onclick strings trips.js:1210 (in `renderTripFormInPanel`), :1336/:1370 (`showTripModal`) |
| S2f | `saveDraftTrip` trips.js:2567 | 1 | 0 | 0 | 0 | 1 | 0 | 0/0 | **Y** | graph: "No callers found"; real ref `onclick="saveDraftTrip(…)"` trips.js:2545 |
| S2g | `toggleTransportSelect` trips.js:1452 | 1 | 0 | 0 | 0 | 1 | 0 | 0/0 | **Y** | "No callers found"; `onchange="window.Trips.toggleTransportSelect(…)"` trips.js:1173,1184 |
| S2h | `maskPhoneField` trips.js:1472 | 1 | 0 | 0 | 0 | 1 | 0 | 0/0 | **Y** | "No callers found"; `oninput="window.Trips.maskPhoneField(this)"` trips.js:1162 |
| S3a | `tasks_when_key` api/tasks_rules.php:161 | 8 | 8 | 8 | 0 | 0 | 0 | 1/0 | **N** | exact (top-level code → file node) |
| S3b | `Database::getPDO` api/db.php:70 | 23 | 2 | 2 | 0 | 21 | 0 | 7/6 | **Y** | `$db->getPDO()` not type-resolved; only `Database::getInstance()->getPDO()` chains found (api/auth.php:65, api/upload.php:174) |
| S3c | `Database::migrate` api/db.php:102 | 19 | 0 | 0 | 0 | 19 | 0 | 6/6 | **Y** | `callers`: "No callers found"; real: `$db->migrate()` in 19 endpoint scripts (e.g. api/load.php:32, api/save.php:67, api/tasks.php:854, api/login.php:36) |
| S3d | `tasks_open_ids_for_employee` api/helpers.php:272 | 2 | 2 | 2 | 0 | 0 | 0 | 0/0 | **N** | exact (api/employees.php:267, api/save.php:388 = file-level) |
| S4a | `api/tasks.php` ← JS | 13 | 0 | 0 | 0 | 13 | 0 | – | **Y** | `node api/tasks.php`: "no other indexed file depends on it"; 13 JS functions in `js/tasks.js` + `js/tasks_matrix.js:66` call it (`B_S4a_tasks_php_gt_units.txt`) |
| S4b | `api/save.php` ← `storage.js` `SAVE_URL` | 2 | 1 | 0 | 1 | 2 | 0 | – | **Y** | graph: "used by 1 file: api/entries.php" = **FP** (`function_exists('sync_actor') ? sync_actor()` api/entries.php:183,364; entries.php does not include save.php); real: `StorageAdapter.save/saveVacation` js/storage.js:516,565 |
| S4c | `api/employees.php` ← `tasks.js` `EMP_API` | 1 | 0 | 0 | 0 | 1 | 0 | – | **Y** | "no other indexed file depends on it"; real `loadEmployees` js/tasks.js:272 |
| S5a | `load` tasks.js:288 | 13 | 13 | 13 | 0 | 0 | 0 | 0/0 | **N** | with `-f`: correct, 3 same-named defs separated |
| S5a2 | `load` tasks_matrix.js:61 | 2 | 2 | 2 | 0 | 0 | 0 | 0/0 | **N** | not conflated with tasks.js `load` |
| S5b | `render` tasks.js:1643 | 14 | 14 | 14 | 0 | 0 | 0 | 30/30 | **N** | prod exact; 30 test/acceptance callers via `Tasks.__t.render` not linked |
| S5c | `isAdmin` tasks.js:166 | 1 | 1 | 1 | 0 | 0 | 0 | 0/0 | **N** | exact; not conflated with trips.js:464 |
| S5c2 | `isAdmin` trips.js:464 | 0 | 0 | 0 | 0 | 0 | 1 | 0/0 | **N** | 0 real callers (export only) — matches rg |
| S5e | `StorageAdapter.save` storage.js:498 | 1 | 0 | 0 | 0 | 1 | 0 | – | **Y** | **no node**; `callers save -f js/storage.js` → "⚠ no definition … matches file … showing all definitions instead" → file node `api/save.php` (0 callers). Real caller `index.html:4733` |
| S5f | `StorageAdapter.load` storage.js:459 | 3 | 15 | 0 | **15** | 3 | 0 | – | **Y** | **no node**; fallback shows callers of `tasks.js:load` (13) + `tasks_matrix.js:load` (2) = 15 unrelated; real callers `index.html:2398` (`showApp`), :4791 (`loadDefault`), :5018 (`SyncClient`) |
| S5g | `dayOfYearToDate` storage.js:73 | 1 | 1 | 1 | 0 | 0 | 1 | 0/0 | **N** | `index.html:2946` has its **own copy**; rg (12 hits in index.html) over-counts, the graph is right |
| S5h | 5 local `norm` closures trips.js:1602/1989/2912/2971/3003 | 5 | 5 | 5 | 0 | 0 | 0 | – | **N** | graph keeps 5 qualified defs (`saveTrip::norm` …), each with its own caller |
| S6a | `createTripModal` trips.js:987 | 0 | 0 | – | – | – | 0 | – | **N** | really dead (rg: 0 code mentions; only reports); graph "No callers" = truth |
| S6b | `positionEmployeePickDock` trips.js:2866 | 0 | 0 | – | – | – | 0 | – | **N** | really dead no-op; graph = truth |
| S6c | `require_group_edit` api/auth.php:194 | 0 | 0 | – | – | – | 0 | – | **N** | really dead (only doc comment api/auth.php:18) |

(S2e in the evidence file names = S5g here; `B_S2e_dayOfYearToDate_*`.)

### B.3 Summary per stratum (`evidence/B_summary.md`)

| Stratum | symbols | GT callers | Graph callers | TP | FP | FN | precision | recall | wrong-from-graph Y / N |
|---|---|---|---|---|---|---|---|---|---|
| S1 JS→JS (tasks.js) | 4 | 17 | 17 | 17 | 0 | 0 | 100 % | 100 % | 0 / 4 |
| S2 inline handlers / window exports / index.html | 7 | 8 | 0 | 0 | 0 | 8 | n/a (graph reports 0) | **0 %** | **7 / 0** |
| S3 PHP→PHP | 4 | 52 | 12 | 12 | 0 | 40 | 100 % | **23 %** | 2 / 2 |
| S4 JS→PHP by URL | 3 | 16 | 1 | 0 | 1 | 16 | 0 % | **0 %** | **3 / 0** |
| S5 common / duplicate names | 9 | 40 | 51 | 36 | 15 | 4 | 71 % | 90 % | 2 / 7 |
| S6 dead | 3 | 0 | 0 | 0 | 0 | 0 | n/a | n/a (all 3 "no callers" are true) | 0 / 3 |
| **ALL** | **30** | 133 | 81 | 65 | 16 | 68 | 80 % | **49 %** | **14 / 16** |

Reading: the graph is **precise but not complete**; when it says "N callers" for statically resolvable JS/PHP calls it is usually right, when it says "few/none" the answer is wrong exactly in the project's risky patterns.

### B.4 FALSE-SAFE examples (graph reports no/few callers, truth says more)

1. **`Database::migrate`** `api/db.php:102` [graph]: `callers` → "ℹ No callers found". [rg+read]: 19 production call sites `$db->migrate();` — `api/load.php:32`, `api/employees.php:34`, `api/save.php:67`, `api/tasks.php:854`, `api/login.php:36`, `api/groups.php:26`, `api/entries.php:40`, … plus 6 test sites (`api/tasks_test.php:111,178,…`, `scripts/n8n_compare.php:71`, `scripts/v63_accept_d_migration.sh:82-83`). 🔴 class symbol (migrations). Evidence `B_S3c_migrate_*`.
2. **`Database::getPDO`** `api/db.php:70`: graph 2 callers (`api/auth.php:65`, `api/upload.php:174`); truth 23 production scripts + 6 test/shell (`api/load.php:29`, `api/save.php:66`, `api/tasks.php:853`, `api/employees.php:33` …). `B_S3b_getPDO_*`.
3. **`Tasks.offerReassign` / `Tasks.openTasksFor`** `js/tasks.js:2548 / :2299`: graph shows only "file tasks.js [references]" (the export object `:2892/:2891`); the only production callers are in `index.html:4564 / :4544` (the `#deleteEmp` handler, T1-8 D-1 data-loss warning path). `impact` radius = the function itself + its file.
4. **`Trips.saveTrip`** `js/trips.js:1549` (trip save path): graph: export-reference only; real callers are three `onclick` strings (trips.js:1210, :1336, :1370). Same for `removeParticipantRow` (:1388).
5. **`maskPhoneField` / `toggleTransportSelect` / `saveDraftTrip`** `js/trips.js:1472 / 1452 / 2567`: graph says "No callers found" → an agent following "unused ⇒ delete" would delete them. Truth: inline handlers reference them (trips.js:1162, 1173/1184, 2545). By reading, none of the three is reachable at runtime as written (`window.Trips` has no such keys, `saveDraftTrip` is IIFE-private) — a defect that is **already documented**: `reports/AUDIT_2026-10/EF_FRONT_INFRA.md:41-75` (E-01) and `reports/BACKLOG.md:12` (S-12: "`maskPhoneField` не экспортирован (1162, 2292)"). The fix is to *export* the function, so graph-driven deletion would erase the fix target. (I did not execute the page in a browser; source reading + the audit report only.)
6. **`legacyToServer`** `js/storage.js:285` (payload builder of the save path): `impact -d 2` and `-d 3` both = **2 symbols** (itself + file `storage.js`). Truth radius ≥ 18 (B.5).
7. **Explore "Blast radius" text**: `calMove (js/tasks.js:1003) — 2 callers in js/tasks.js; no tests found within 3 caller hops` (`B_Q1_explore.txt:9`) while `scripts/test_tasks_calendar.js:786,992` call `Q.U.calMove` (via `window.Tasks.__t`).

### B.5 `codegraph impact` on 3 risky symbols — is the radius a lower bound?

| Symbol | Graph radius (d2 = d3) | Ground truth (rg + read) | Lower bound by how much? |
|---|---|---|---|
| **I1 `legacyToServer`** `js/storage.js:285` (save payload) — `B_I1_legacyToServer_*`, `…_graph_impact_d3.txt` | **2** (itself + `file storage.js`) | depth 1: `StorageAdapter.save` (calls at storage.js:505) and `.saveVacation` (:555) — object-literal methods, not nodes; depth 2: `index.html` `save()` :4728 (call :4733) and `saveVacationData()` :2742 (:2752); depth 3: 11 call sites of `save()` (index.html:4025, 4219, 4251, 4258, 4264, 4271, 4460, 4531, 4560, 4592, 4616 — `B_I1_ext_index_save_callsites.txt`) + `setDayVacationType` :2862, `setRangeVacationType` :2908 → **≥ 18 symbols/sites** | **≥ 9× too small** (16+ affected units invisible; the whole `index.html` side) |
| **I2 `require_edit`** `api/auth.php:133` (🔴 roles) — `B_I2_require_edit_*` | **9** = itself + 8 endpoint file nodes (employees, entries, groups, positions, save, sync, trips, upload) | PHP layer: 8 files / 16 call sites — **identical**. But the radius **stops at the HTTP boundary**: JS consumers of those endpoints (`js/storage.js` → save.php; `js/trips.js` → trips.php/sync.php; `index.html` → upload.php, sync.php, trips.php, positions.php) are missing; groups.php/entries.php have no JS consumer by URL rg | exact inside PHP; lower bound by ≥ 3–4 JS units (cannot be computed by the graph at all) |
| **I3 `Database::getInstance`** `api/db.php:57` — `B_I3_getInstance_*` | **36** (self + 26 endpoint/test file nodes + `sync_actor`, `trips_sync_actor`) | 23 production + 4 test call sites in PHP all found; **missed**: 3 root shell tests (`test_approved_guard.sh:25,63`, `test_supervisor_edit.sh:19,42`, `test_zone_filters.sh:24,51,75`) and `scripts/v63_accept_d_migration.sh:82-83`, `scripts/test_v6_director.js:286` (inline `php -r`) = 5 files | small (tests only) — but the true radius is "the whole backend", so this is not informative |

**Conclusion:** the radius is a **lower bound** and the gap is unbounded exactly where it matters (anything crossing index.html, window exports, inline strings, PHP↔JS).

### B.6 "Dead code" detector measured on the whole graph (`B_scan_graph_zero_callers_vs_rg.txt`, `…rgdead_list.txt`)
Functions/methods with **0 incoming call/reference edges: 24**. Of them rg finds no non-comment mention for **10** (`require_group_edit`, `createTripModal`, `showTripModal`, `validateAdvanceAmount`, `showTripSelectionModal`, `populateEmployeePickList`, `positionEmployeePickDock`, `getEmployeesForPick`, `find_next_workday`, a nested `tz`); the other **14** are false-dead: 4 real production symbols (`Database::migrate`, `saveDraftTrip`, `toggleTransportSelect`, `maskPhoneField`) + 10 duck-typed test-double methods (fake DOM `addEventListener`, `closest`, `className`, `constructor` … in `scripts/test_tasks_matrix.js`, `calendar_browser.js`, `v6_accept_lib.js`). **Precision of "0 callers ⇒ dead" = 10/24 = 42 %.** (S6a-c were confirmed dead by rg + reading, incl. string/dynamic forms; the three `S6` symbols are also listed in `reports/AUDIT_2026-10/G_QUALITY.md:315-317`, consistent.)

### B.7 Architecture questions (CLI `explore` and `context`) — `B_Q{1,2,3}_{explore,context}.txt`, `B_Q_sizes.txt`

| Q | Question | explore / context size | Judgment | What is missing / wrong |
|---|---|---|---|---|
| Q1 | "how does the tasks calendar drag and drop persist a move" | 14,965 / 2,850 chars (1.05–2.2 s) | **explore: partial (client side correct)**; **context: wrong focus** | explore includes `calMove` (tasks.js:1003-1037: optimistic `mergeTask`, `api('PUT', API+'?id=…', {start_at,end_at,version})`, 409 rollback), `calMoveOcc` (occ_move), `onDragUp` (:1354-1366). Missing: server side (`api/tasks.php` PUT/update branch after :1285, `require_admin()` :1026, `tasks_version_conflict`), `calDropCalc` target computation, `onCalPointerDown`. ≈ 1/3 of the output is acceptance scripts (`scripts/v62_1_accept.js`, `v62_accept_c1…`, `v6_accept_b_tasks.js`). `context` entry points = `onDragMove`, a test helper `task`, and `onDrop` (kanban status drop — a different feature); never reaches `calMove`. |
| Q2 | "how does login session role check reach tasks.php" | 13,269 / 3,601 | **partial / weak** | Source shown from `api/tasks.php` is the occurrences code (:614-…), **not** the gating at `tasks.php:898` (`require_auth()` for GET), `:1026` (`require_admin()` for writes), `:1067` (`current_user()`); `auth.php` appears only as a list of names under "Not shown above"; entry points are test helpers (`scripts/calendar_browser.js:23 check`, `login`). Missing: `api/session.php`, `api/auth.php:123-160`, JS side (`refreshUser` js/tasks.js:265 → `S.user` → `canWrite()` :166-167). |
| Q3 | "how does state sync via save.php work" | 15,755 / 4,266 | **partial / weak** | Shows `api/save.php` lines 21-82, 239-245, 303-310 of 828 (header, `sync_actor`, `sync_log`) — **not** the transactional core (`$pdo->beginTransaction()` ~:70, guards, `sync_log()` calls at :289, :394, :596, :718). Missing the client half completely (`StorageAdapter.save` js/storage.js:498, `index.html save()` :4728) — it is not in the graph. Noise: `scripts/n8n_deploy.py STATE`, `js/tasks.js`; `trips_sync_fetch_trip` belongs to the *other* sync (`api/sync.php`). `context` entry points: `sync_log`, `trips_sync_fetch_trip`, n8n `STATE`. |

Size vs the rg+read approach (exact line ranges counted, `B_Q_sizes.txt`): Q1 ≈ **16.4 K chars / 356 lines** (client + server), Q2 ≈ **9.6 K / 329 lines**, Q3 ≈ **12.8 K / 269 lines** targeted (49 K if `save.php` is read whole). So the graph output is the **same order of size as a targeted manual read, but incomplete** — no token saving once the missing pieces have to be read anyway. (Latency: explore 1.7–2.2 s, context ≈1 s.)

---

## 4. Part C — freshness

| Step | Result |
|---|---|
| **C1** rename `shiftWhen`→`shiftWhenRenamed` in `js/tasks.js` (decl :927 + calls :942, :976), **no re-init** (`C01_after_rename_before_sync.txt`) | `callers shiftWhen` → still returns the 2 callers (**stale, no warning**); `callers shiftWhenRenamed` → "Symbol … not found"; `query shiftWhen` → stale; `impact shiftWhen` → stale 6 symbols (no warning). `codegraph status` **does** warn: "Pending Changes: Modified: 1 files — Run codegraph sync". `codegraph node shiftWhen` **does** warn: "⚠ … changed on disk after it was last indexed … body is omitted". |
| `codegraph sync` | **4.77 s wall** (peak RSS 192 MB; "Synced 1 changed files — 210 nodes in 644 ms"). After sync: `callers shiftWhen` → "not found — did you mean: shiftWhenRenamed?"; new name → 2 callers (`C03`). |
| **C2** `git checkout --detach 0776216` (pre-V6; 40 files differ) (`C05…C09`) | `status` → "Pending Changes: Modified 10, Removed 30" (warns). `callers calDropCalc` → **stale answer** (still 2 callers; symbol does not exist at 0776216 — rg: 0 matches); `explore` CLI head shows **no warning**. `sync`: **11.75 s** (378 MB peak), index → 55 files / 761 nodes / 4,214 edges. Back to `main`: stale again until `sync` (**39.3 s**, 30 files re-added); counts return **identical** to the first index (85 / 1,541 / 10,524). |
| **MCP server over stdio** (`serve --mcp`, driven by `mcp_probe.py`, `C10_mcp_session.txt`, `daemon.log`) | Works locally: `initialize` 1.1 s; **one tool only, `codegraph_explore`** (v1.6.2). After editing `js/tasks.js` the next `explore` (80 ms later) carried a banner "⚠️ … js/tasks.js (edited 80ms ago, pending sync) … Read them directly"; watcher auto-sync visible after **≈3.5 s** ("Auto-synced 1 file(s) in 382–404 ms" in `daemon.log`); the revert was synced the same way. So in MCP mode staleness is signalled and short; in CLI mode it is silent for `callers/impact/query/explore`. |
| Revert | `git checkout -- js/tasks.js`, `git checkout main` — copy `git status --porcelain` = only `?? .codegraph/` (before cleanup of Part D leftovers too). |

---

## 5. Part D — side effects of `codegraph install` (observe only)

All in sandbox HOME / the copy, scrubbed env. Runs: `install -y -t all -l global` (`D02`), `install -y -t all -l local` in the copy (`D05`), `uninstall` local then global (`D09`, `D11`). `--print-config <id>` for 11 targets: `D01_print_config_all.txt` (no file writes). Network during install/uninstall: **0 non-loopback `connect()`** (`N04`, `N05`, `N06`).

### D.1 Files created/changed
| Location | Files (content in short) |
|---|---|
| **Sandbox HOME (global)** — 16 files (`D03`) | `~/.claude.json` (mcpServers.codegraph, `alwaysLoad: true`), `~/.claude/settings.json` (**`permissions.allow: ["mcp__codegraph__*"]`** and **`hooks.UserPromptSubmit: codegraph prompt-hook`**), `~/.claude/CLAUDE.md`, `~/.codex/{config.toml,AGENTS.md}`, `~/.config/opencode/{opencode.jsonc,AGENTS.md}`, **`~/.hermes/config.yaml`** (`mcp_servers.codegraph…` + `platform_toolsets.cli: [hermes-cli, mcp-codegraph]`), `~/.gemini/{settings.json,GEMINI.md,antigravity/mcp_config.json}`, `~/.cursor/mcp.json`, `~/.kiro/settings/mcp.json`, `~/.config/Code/User/mcp.json`, `~/.copilot/mcp-config.json`, `~/.config/github-copilot/intellij/mcp.json`. |
| **Copy (local)** (`D06`, `D08`) | modified tracked **`AGENTS.md`** (+11 lines); new `.mcp.json`, `.claude/settings.json` (same allow + hook), `.claude/CLAUDE.md`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.jsonc`, `.gemini/settings.json`, `GEMINI.md`, `.kiro/settings/mcp.json`, `.vscode/mcp.json`. |
| `~/.codegraph/` (runtime) | `telemetry.json` (consent + machine UUID), `telemetry-queue.jsonl`, `update-check.json`, `daemons/`. |

### D.2 AGENTS.md / CLAUDE.md injection (verbatim, `D07_AGENTS_md_diff_full.txt`, `D04_injected_section_global_CLAUDE.md`)
`install` appended to the project's tracked `AGENTS.md` (at the end, after "## Source of truth"), and the same 806-byte block to every agent instruction file (`CLAUDE.md`, codex/opencode `AGENTS.md`, `GEMINI.md`):
```
<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If …
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
```
(the long bullet is truncated by me at "If"; full text in `D07`.) It **contradicts** the project policy: AGENTS.md:68-81 ("index = navigation, not truth", rule 7 "его собственная инструкция «доверяй, не перепроверяй grep» этой политикой отменена"). The MCP `initialize.instructions` (6,718 chars) says the same ("call `codegraph_explore` before you Read … Codegraph IS the pre-built search index — so running your own grep + read loop …"; tool description: "treat the shown source as already Read; do NOT re-open those files"). The `prompt-hook` injects a ≈14 K-char `<codegraph_context … treat returned source as already read>` block into **every user prompt** (tested: `echo '{"prompt":…}' | codegraph prompt-hook`).

### D.3 Global configs
It asks nothing in `-y` mode: defaults `--location=global --target=auto`; with `-t all` it writes **all 11 agent configs including `~/.hermes/config.yaml`** (path = `$HERMES_HOME/config.yaml` if set, else `~/.hermes`). Without `-y` it prompts. It edits the global configs of whatever agents it finds — so on this host an un-scrubbed run would have modified the real Hermes profile.

### D.4 `uninstall` — reverts cleanly? **Partly.**
* Removed: the AGENTS.md block (tracked `AGENTS.md` diff back to 0), created `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` files, MCP entries, the allow-rule and hook.
* **Left behind** (`D10`, `home_after_uninstall_global.txt`): 9 sandbox-HOME files (`~/.claude.json` = `{}`, `~/.claude/settings.json` = `{}`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`, `~/.kiro/settings/mcp.json`, `~/.config/Code/User/mcp.json`, `~/.config/github-copilot/intellij/mcp.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.config/opencode/opencode.jsonc`) and 7 files in the copy (`.mcp.json`, `.claude/settings.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `.kiro/settings/mcp.json`, `.vscode/mcp.json`, `opencode.jsonc`) as empty `{}`/skeleton JSON; **`~/.hermes/config.yaml` stays modified** (`mcp_servers:` null + `platform_toolsets: cli: [hermes-cli]` — a key that did not exist before). The `.codegraph/` index and `~/.codegraph/` remain (`--keep-cli` only concerns the binary).
* Discarded in the copy afterwards (`D12`): targeted `rm`/`rmdir` of the leftovers (the `git clean -fd` command is blocked by the worker sandbox) → copy `git status --porcelain` = `?? .codegraph/` only; tracked files untouched.

---

## 6. Network & telemetry (Rule 7)

Method: (a) `grep` of the installed package (`A03_urls_in_dist.txt`, `A12_network_code_files.txt`); (b) `strace -f -e trace=network` around `codegraph index` (`N01`), 8 query commands (`N07_strace_queries.txt`), `serve --mcp` twice (`N02`, `N03`), `install`/`uninstall` (`N04-N06`); (c) a local capture server (127.0.0.1:18099, killed afterwards) with `CODEGRAPH_TELEMETRY_ENDPOINT` redirected, so the telemetry payload could be read without leaving the host.

| Finding | Evidence |
|---|---|
| **Telemetry is ON by default** (`DO_NOT_TRACK=1` > `CODEGRAPH_TELEMETRY=0|1` > stored config > default on). On first run a stderr notice is printed ("codegraph collects anonymous usage stats … `codegraph telemetry off`"). Endpoint `https://telemetry.getcodegraph.com/v1/events` (`telemetry/index.js`). | `N01_index_output.txt`; `telemetry.json`: `enabled:true, consent_source:"default-notice"` |
| Payload captured locally (`A06_telemetry_capture_server.log`): `machine_id` (random UUID persisted in `~/.codegraph/telemetry.json`), `codegraph_version`, `os`, `arch`, `node_major`, `ci`, and events `index` with `languages:["javascript","php","python"]`, `file_count_bucket:"<100"`, `duration_bucket:"<10s"`. The queue also counts CLI command names and MCP tool/client name (`cli_command`, `mcp_tool codegraph_explore, cn:"cgt1-probe"`); **no paths, symbol names, query text** observed. | `telemetry-queue.jsonl`, capture log |
| Sent at the end of `init`/`index` (bounded await) and opportunistically by long-running processes; counters for completed UTC days only. | code comments + `N01` (single `connect()` to 127.0.0.1:18099) |
| **MCP server/daemon performs an update check:** DNS query `github.com` + TCP 443 (`connect … 20.250.119.67:443`), `GET https://github.com/colbymchenry/codegraph/releases/latest` (UA `codegraph-upgrade`), result cached in `~/.codegraph/update-check.json` (`latest: v1.6.2`). Disabled by `CODEGRAPH_NO_UPDATE_CHECK=1` or `DO_NOT_TRACK`. | `N02_strace_mcp.txt`, `update-check.json` |
| One-shot CLI commands (`index`, `status`, `callers`, `impact`, `explore`, `context`, `node`, `query`, `files`, `install`, `uninstall`): **0 outbound `connect()`** except the telemetry POST of `index`. | `N07`, `N04-N06` |
| Other code that can reach the network (not triggered): `installer/beta-signup.js` (interactive email → `https://getcodegraph.com/api/waitlist`), `upgrade` (GitHub releases/API), npm-shim self-heal download. A UI server (`CODEGRAPH_UI`) exists in the bundle — not exercised. | `A03`, `A12` |
| **Could NOT determine:** what the real `telemetry.getcodegraph.com` does with the data (I deliberately redirected the endpoint, so no real send was made); whether `upgrade`/`beta-signup` behave as the code reads (not run); behaviour of the closed parts of the bundled runtime beyond the JS source read. |

---

## 7. Part E — verdict

### E.1 Table per trust class (this project)

| Class | Verdict | Evidence rows |
|---|---|---|
| 🟢 low (find a function/handler, orient in a module) | **Usable — as navigation, with line numbers re-read** | Definitions: PHP 176/176, JS named functions 318/318 (A.3); S1 17/17 exact; `explore/node` 0.8–2 s. **Caveat:** anything defined in `index.html` is simply absent (93 functions) and the graph never says so; line numbers only valid after the last sync (CLI is silent when stale, C1/C2). |
| 🟡 medium (logic change, multi-module refactor, API change, **rename**) | **Usable with verification** — candidates only; mandatory whole-repo `rg` + reading of each affected symbol + the relevant suite | S2 recall 0/8, S3 recall 23 % (40 FN), S4 0/16, I1 radius ≥9× too small (B.4/B.5); but S1 100 %, S3a/S3d exact, `norm` closures separated (S5h). Rename safe only for statically-resolved, non-exported, non-inline, non-index.html symbols. |
| 🔴 high (auth/roles/visibility, `api/db.php`/migrations, `save.php`/`sync.php`, PII, deploy, n8n, any "unused/dead/safe" conclusion) | **Not usable as a basis** (reading source + config + tests only) | `Database::migrate` 0 of 19 (S3c), `getPDO` 2/23 (S3b), `require_edit` radius stops at HTTP boundary (I2), `StorageAdapter.save/load` not in graph (S5e/f), dead-code precision 42 % (B.6), `legacyToServer` radius 2 vs ≥18, "no tests found" false (S1c). |

### E.2 Which §3 triggers (AGENTS.md:77) were confirmed by measurement

| Trigger (rule) | Measured | Status |
|---|---|---|
| Handlers in HTML strings (`onclick=…`) | S2c/S2d/S2f/S2g/S2h: 0 real callers found, 7/7 wrong | **CONFIRMED** |
| `window.*` exports | S2a/S2b (+S5c2): export object appears only as "file [references]"; real callers in index.html / inline strings / tests invisible | **CONFIRMED** |
| Functions inside `index.html` | file not indexed; 93 functions + 71 handlers absent; `index.html` callers of `StorageAdapter.*`, `Tasks.*` missing | **CONFIRMED** |
| Same-named functions (`save`, `load`, `render`, `get`…) | **Not confirmed for plain duplicate *functions*:** `load` ×3, `render`, `isAdmin` ×2, 5 local `norm` closures, `dayOfYearToDate` (index.html copy) were all separated correctly (S5a, a2, b, c, c2, g, h). **Confirmed for object-literal methods:** `StorageAdapter.save/load` are not nodes; unqualified/`-f` queries fall back to other definitions or to a *file* named `save.php` (S5e/S5f: 15 FP). `get` not sampled. | **PARTLY (confirmed only where the target is not a node)** |
| JS↔PHP links by URL string | 0 cross-language edges; S4 0/16 + 1 FP | **CONFIRMED** |
| SQL, configs, migrations | `.sql`, `.sh`, JSON not indexed; `Database::migrate` shows 0 callers; SQL inside PHP strings invisible | **CONFIRMED** |
| Generated code | the project has none that I identified; the `generated` column was not examined | **NOT TESTED** |
| Rule 2 "empty/small impact is not proof of safety" | `migrate` 0, `getPDO` 2/23, `legacyToServer` 2 vs ≥18 | **CONFIRMED** |
| Rule 2 "not in the index ≠ not in the code" | index.html, schema.sql, object-literal methods | **CONFIRMED** |
| Rule 2 "dead code only by rg + reading" | graph-0-callers precision 42 % | **CONFIRMED** |
| Rule 4 CODEMAP: no PHP, no edges, stale after merges | PHP absent, 0 edges, tasks.js 72 % stale (A.4) | **CONFIRMED** |
| Rule 6 "3 divergences ⇒ stop using the index in that task" | would have triggered many times in this trial (16 symbols wrong from graph alone) | consistent |
| Rule 7 "CodeGraph's own 'trust, don't re-grep' instruction cancelled by policy; install edits agent configs and may append sections to AGENTS.md" | AGENTS.md block appended (D.2), MCP instructions + tool description tell agents not to Read/grep, prompt-hook | **CONFIRMED** |
| Rule 3 on freshness ("после каждого merge устаревает") applied to CodeGraph | CLI silently stale until sync; MCP watcher 3.5 s + banner | partly mitigated (MCP only) |

### E.3 "Never trust here" patterns (concrete)
1. Any callers/impact for a **`window.X`/`StorageAdapter`/`Tasks`/`Trips` exported function** — you only get "file [references]".
2. Anything called from **`index.html`** (all of it: `save()`, `render()`, `#deleteEmp`, `SyncClient`, `loadDefault`, vacation matrix) — callers, callees, impact, "unused".
3. **Inline handler strings** in template literals (`js/trips.js` onclick/onchange/oninput).
4. **PHP `$obj->method()` on a variable** (`$db->getPDO()`, `$db->migrate()`): 0–10 % recall; only `Class::static()` / chained calls resolve.
5. **"No callers found"** — not a dead-code signal (precision 42 %).
6. **JS→PHP via URL constants** (`API`, `EMP_API`, `SAVE_URL`, `API_BASE`): no edge; and the occasional name-based false edge (`api/save.php` "used by" `api/entries.php`).
7. **Object-literal methods** (`StorageAdapter.save/load/saveVacation`, `ACTIONS` table, `Trips` inline helpers): not nodes; calls inside them show up as "file X".
8. **Common names with `-f` that doesn't match a node** — the tool silently widens to other definitions / a file named like the symbol (`save` → `api/save.php`, `load` → 2 unrelated functions).
9. **Tests**: calls through `window.Tasks.__t.*` / `A.T.*` / `Q.U.*` are not linked; `explore`'s "no tests found within 3 hops" is unreliable.
10. **`impact` radius** at PHP endpoint scripts stops at the file node (no HTTP consumer), at any non-node (index.html), and ignores shell/inline-`php -r` callers.
11. **CLI after any edit/checkout**: `callers/impact/query/explore` are stale **without a warning** until `sync` (only `status`/`node`/MCP warn).
12. `explore`/`context` natural-language answers: entry points often tests/acceptance scripts; endpoint top-level code (`tasks.php:898/1026/1067`, `save.php` body) is under-represented.

### E.4 Rating and recommendation
**Rating: 5 / 10 for this project** — 6/10 as a *navigator* (fast, exact static JS/PHP definitions and in-file call edges, qualified names, better PHP coverage than CODEMAP, MCP freshness handling decent), **2/10 as a source of truth** (recall 49 %, 0 % on the project's highest-risk patterns, and the tool's own instructions/hook push agents to skip verification). The blind spots coincide with the project's critical paths (index.html save/sync, inline handlers, exports, URL links, `Database`).

**Recommendation: ADOPT FOR A SUBSET, as navigation only.**
* Allowed: CLI `query` / `node` / `explore` / `callers` on `js/tasks.js`, `js/tasks_matrix.js`, `js/trips.js` and PHP function definitions, as *candidate generators*; always followed by the policy steps (whole-repo `rg`, read the lines, run the suite). Re-run `codegraph sync` (or check `status`) before any query.
* Not allowed: 🔴 decisions; deleting/renaming/"unused" on the strength of the graph; relying on `impact`.
* Operational conditions if the owner later enables it: **do not run `codegraph install` in the project** (it rewrites tracked `AGENTS.md`, adds an allow-rule + prompt hook); register MCP manually from `--print-config` if ever needed; set `CODEGRAPH_TELEMETRY=0` (or `codegraph telemetry off`) and `CODEGRAPH_NO_UPDATE_CHECK=1`; run from a scrubbed environment (the `hermes` installer target follows `HERMES_HOME`); add `.codegraph/` to `.git/info/exclude` to avoid `?? .codegraph/`; never leave the MCP daemon running (detached, 300 s idle timeout).
* **What would be needed to move up to "adopt":** (1) indexing of the `index.html` inline script (93 named functions + 71 handlers, ≈5.3 K lines) — at minimum its 93 functions and `addEventListener` handlers; (2) resolution of `window.X.fn(...)`/export objects to real callers, and of inline `on*=` strings; (3) PHP receiver-type inference for `$db = Database::getInstance(); $db->method()`; (4) object-literal method nodes (`StorageAdapter.*`, `ACTIONS`); (5) URL-string linking JS→PHP (constants `API`/`SAVE_URL`); (6) a staleness warning in all CLI outputs; (7) SQL/shell coverage for migrations.

### E.5 Incidental finding for the project (not acted on)
`js/trips.js:1162,1173,1184,2545` reference `maskPhoneField`, `toggleTransportSelect`, `saveDraftTrip` that are not exported/reachable (by reading; already documented in `reports/AUDIT_2026-10/EF_FRONT_INFRA.md` E-01 and `reports/BACKLOG.md` S-12). Not verified in a browser by me; out of scope for CGT-1.

---

## 8. Receipt facts

* Runs: install (npm, sandbox), `init`, `index`, `status`, `files`, `query`, `callers`, `callees`, `impact` (30 + 3 symbols, d2 and d3), `explore`, `context`, `node`, `sync` ×4, `serve --mcp` ×2 (driven over stdio), `install`/`uninstall` (sandbox), `prompt-hook` (stdin test).
* Evidence index: `evidence/` (A* install/index/coverage, B* per-symbol graph + rg + compare, B_summary.md, B_Q* questions, C* freshness, D/* install files, N* network).
* Final state (`evidence/Z_final_checks.txt`, 2026-11-14T11:45Z): no codegraph/daemon/capture-server process left (`pgrep -af 'codegraph-linux-x64|codegraph (serve|daemon)|capture_server'` → empty; a bare `pgrep -af codegraph` also matches the Hermes shell wrapper whose command line contains the word); origin `git -C /home/hermes/service-center-app status --porcelain` = **empty** (start: empty), HEAD `951f61e87ff47166b0ffa36d2cef05e4f93f5da9` unchanged; copy: HEAD `951f61e`, `git status --porcelain` = `?? .codegraph/` only (kept so the coordinator can re-run queries). Real HOME: none of `~/.codegraph`, `~/.cursor`, `~/.codex`, `~/.gemini`, `~/.kiro`, `~/.copilot`, `~/.config/{opencode,Code,github-copilot}` exist; `~/.claude.json` has a post-start mtime (16:23) but contains no "codegraph" string — it is touched by the Hermes harness itself; all CodeGraph runs used the sandbox HOME (install ran at 16:36).
