<?php

declare(strict_types=1);

/**
 * task_files_lib.php — вложения задач (V7, Ш1): общие правила для api/task_files.php и api/tasks.php.
 *
 * Хранение: таблица task_attachments (v13) + файлы в <каталог БД>/task_files/<stored_name>
 * (на проде data/task_files — закрыт data/.htaccess «Require all denied»; на тестовой копии БД
 * (SC_APP_DB) — рядом с копией). Имя на диске — 32 hex без расширения, исходное имя — только в БД.
 *
 * Лимиты: файл ≤ 5 МБ (или меньше, если меньше upload_max_filesize/post_max_size PHP — берётся
 * минимум, решение владельца Ш0), ≤ 10 файлов и ≤ 50 МБ на задачу.
 * Форматы — белый список по расширению И по содержимому (finfo).
 * Права: см. tf_can_upload()/tf_can_delete().
 */

// Библиотека, не точка входа: прямой веб-запрос → 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath((string) $_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

const TF_MAX_FILE_BYTES = 5 * 1024 * 1024;
const TF_MAX_FILES = 10;
const TF_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const TF_NAME_MAX = 200;

/**
 * Белый список: расширение → [Content-Type для отдачи, допустимые MIME по содержимому (finfo), inline?].
 * inline — можно открыть в браузере (картинки, PDF); остальное только скачивание.
 */
function tf_types(): array
{
    $ole = ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
        'application/vnd.ms-office', 'application/CDFV2', 'application/x-ole-storage', 'application/CDF'];
    $zip = ['application/zip', 'application/x-zip-compressed'];
    $text = ['text/plain', 'text/csv', 'application/csv', 'text/x-csv', 'application/x-empty', 'inode/x-empty'];
    return [
        'pdf'  => ['application/pdf', ['application/pdf'], true],
        'doc'  => ['application/msword', $ole, false],
        'xls'  => ['application/vnd.ms-excel', $ole, false],
        'ppt'  => ['application/vnd.ms-powerpoint', $ole, false],
        'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            array_merge(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], $zip), false],
        'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            array_merge(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], $zip), false],
        'pptx' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation',
            array_merge(['application/vnd.openxmlformats-officedocument.presentationml.presentation'], $zip), false],
        'odt'  => ['application/vnd.oasis.opendocument.text', array_merge(['application/vnd.oasis.opendocument.text'], $zip), false],
        'ods'  => ['application/vnd.oasis.opendocument.spreadsheet', array_merge(['application/vnd.oasis.opendocument.spreadsheet'], $zip), false],
        'odp'  => ['application/vnd.oasis.opendocument.presentation', array_merge(['application/vnd.oasis.opendocument.presentation'], $zip), false],
        'txt'  => ['text/plain; charset=utf-8', $text, false],
        'csv'  => ['text/csv; charset=utf-8', $text, false],
        'rtf'  => ['application/rtf', ['text/rtf', 'application/rtf', 'text/plain'], false],
        'jpg'  => ['image/jpeg', ['image/jpeg'], true],
        'jpeg' => ['image/jpeg', ['image/jpeg'], true],
        'png'  => ['image/png', ['image/png'], true],
        'webp' => ['image/webp', ['image/webp'], true],
        'gif'  => ['image/gif', ['image/gif'], true],
        'heic' => ['image/heic', ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'application/octet-stream'], false],
        'heif' => ['image/heif', ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'application/octet-stream'], false],
        'zip'  => ['application/zip', $zip, false],
        '7z'   => ['application/x-7z-compressed', ['application/x-7z-compressed'], false],
        'rar'  => ['application/vnd.rar', ['application/x-rar', 'application/vnd.rar', 'application/x-rar-compressed'], false],
    ];
}

/** Байты из ini-строки PHP («256M», «2G», «512K», «0» = без ограничения → PHP_INT_MAX). */
function tf_ini_bytes(string $v): int
{
    $v = trim($v);
    if ($v === '' || $v === '0' || $v === '-1') {
        return PHP_INT_MAX;
    }
    $n = (int) $v;
    switch (strtolower(substr($v, -1))) {
        case 'g': $n *= 1024;
        // no break
        case 'm': $n *= 1024;
        // no break
        case 'k': $n *= 1024;
    }
    return $n > 0 ? $n : PHP_INT_MAX;
}

/** Действующий лимит одного файла: минимум из 5 МБ и лимитов PHP (решение владельца, Ш0). */
function tf_max_file_bytes(): int
{
    $up = tf_ini_bytes((string) ini_get('upload_max_filesize'));
    // запас на multipart-обёртку поля
    $post = tf_ini_bytes((string) ini_get('post_max_size'));
    $postFile = $post === PHP_INT_MAX ? PHP_INT_MAX : max(0, $post - 64 * 1024);
    return max(1, min(TF_MAX_FILE_BYTES, $up, $postFile));
}

function tf_limits(): array
{
    return [
        'max_file_bytes'  => tf_max_file_bytes(),
        'max_files'       => TF_MAX_FILES,
        'max_total_bytes' => TF_MAX_TOTAL_BYTES,
        'extensions'      => array_keys(tf_types()),
    ];
}

/** Каталог файлов: рядом с БД (data/task_files или каталог тестовой копии). Создаётся с .htaccess-запретом. */
function tf_dir(): string
{
    $db = getenv('SC_APP_DB');
    $base = (is_string($db) && $db !== '') ? dirname($db) : dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data';
    $dir = $base . DIRECTORY_SEPARATOR . 'task_files';
    if (!is_dir($dir)) {
        if (!@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('task_files dir not writable');
        }
    }
    $ht = $dir . DIRECTORY_SEPARATOR . '.htaccess';
    if (!is_file($ht)) {
        @file_put_contents($ht, "# Вложения задач: прямой доступ запрещён, отдача только через api/task_files.php\nRequire all denied\n");
    }
    return $dir;
}

function tf_path(string $stored): string
{
    if (!preg_match('/^[0-9a-f]{32}$/', $stored)) {
        throw new RuntimeException('bad stored name');
    }
    return tf_dir() . DIRECTORY_SEPARATOR . $stored;
}

/** Безопасное отображаемое имя: без пути, без управляющих символов, ≤ 200 символов, расширение сохраняется. */
function tf_clean_name(string $name): string
{
    $name = str_replace("\\", '/', $name);
    $name = basename($name);
    $name = preg_replace('/[\x00-\x1F\x7F]+/u', '', $name) ?? '';
    $name = trim(preg_replace('/\s+/u', ' ', $name) ?? '');
    $name = ltrim($name, '.');
    if ($name === '' || !mb_check_encoding($name, 'UTF-8')) {
        $name = 'file';
    }
    if (mb_strlen($name) > TF_NAME_MAX) {
        $dot = strrpos($name, '.');
        $ext = $dot !== false ? substr($name, $dot) : '';
        if (mb_strlen($ext) > 10) {
            $ext = '';
        }
        $name = mb_substr($name, 0, TF_NAME_MAX - mb_strlen($ext)) . $ext;
    }
    return $name;
}

function tf_ext(string $name): string
{
    $dot = strrpos($name, '.');
    return $dot === false ? '' : strtolower(substr($name, $dot + 1));
}

/**
 * Проверка формата: расширение в белом списке и содержимое (finfo) ему соответствует.
 * @return array{0: ?string, 1: string} [ошибка|null, Content-Type для отдачи]
 */
function tf_check_type(string $name, string $tmpPath): array
{
    $types = tf_types();
    $ext = tf_ext($name);
    if (!isset($types[$ext])) {
        return ['unsupported_format', ''];
    }
    [$serve, $allowed] = $types[$ext];
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = (string) $finfo->file($tmpPath);
    if (!in_array($mime, $allowed, true)) {
        return ['content_mismatch', ''];
    }
    $head = (string) file_get_contents($tmpPath, false, null, 0, 8);
    // ZIP-контейнеры (OOXML/ODF/ZIP) — обязана быть сигнатура PK
    if (in_array($mime, ['application/zip', 'application/x-zip-compressed'], true) && strncmp($head, "PK", 2) !== 0) {
        return ['content_mismatch', ''];
    }
    // HEIC при старой базе libmagic приходит как octet-stream — тогда проверяем бокс ftyp
    if ($mime === 'application/octet-stream' && substr($head, 4, 4) !== 'ftyp') {
        return ['content_mismatch', ''];
    }
    return [null, $serve];
}

function tf_inline(string $ext): bool
{
    $t = tf_types();
    return isset($t[$ext]) && $t[$ext][2] === true;
}

function tf_public(array $r): array
{
    return [
        'id'          => (int) $r['id'],
        'task_id'     => (string) $r['task_id'],
        'name'        => (string) $r['orig_name'],
        'ext'         => tf_ext((string) $r['orig_name']),
        'size'        => (int) $r['size'],
        'uploaded_by' => $r['uploaded_by'],
        'uploaded_at' => $r['uploaded_at'],
        'inline'      => tf_inline(tf_ext((string) $r['orig_name'])),
    ];
}

/** @return array<string, array> task_id => [вложения] (по времени загрузки). */
function tf_load(PDO $pdo, array $taskIds): array
{
    $out = [];
    if ($taskIds === []) {
        return $out;
    }
    foreach (array_chunk(array_values(array_unique($taskIds)), 500) as $chunk) {
        $ph = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT * FROM task_attachments WHERE task_id IN ($ph) ORDER BY uploaded_at, id");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $out[(string) $r['task_id']][] = tf_public($r);
        }
    }
    return $out;
}

/** Роль текущего пользователя: admin|supervisor|viewer|'' (аноним). */
function tf_role(?array $user): string
{
    if ($user === null) {
        return '';
    }
    return user_role($user);
}

/**
 * Прикреплять: admin — к любой неархивной задаче; supervisor — только к задаче, которую создал сам
 * (tasks.created_by = его логин); viewer — нет. Архивные — никто.
 */
function tf_can_upload(?array $user, array $task): bool
{
    if ($user === null || (int) $task['archived'] === 1) {
        return false;
    }
    $role = tf_role($user);
    if ($role === 'admin') {
        return true;
    }
    return $role === 'supervisor' && (string) ($task['created_by'] ?? '') !== ''
        && (string) $task['created_by'] === (string) ($user['username'] ?? '');
}

/** Удалять: admin — любое; supervisor — только своё вложение в своей задаче; viewer — нет. */
function tf_can_delete(?array $user, array $task, array $att): bool
{
    if (!tf_can_upload($user, $task)) {
        return false;
    }
    if (tf_role($user) === 'admin') {
        return true;
    }
    return (string) ($att['uploaded_by'] ?? '') === (string) ($user['username'] ?? '');
}

/**
 * Удаляет записи вложений задачи (внутри транзакции вызывающего) и возвращает имена файлов на диске —
 * удалить их вызывающий должен ПОСЛЕ commit (tf_unlink_all), чтобы откат транзакции не терял файлы.
 *
 * @return array{stored: string[], names: string[]}
 */
function tf_delete_rows_for_task(PDO $pdo, string $taskId): array
{
    $st = $pdo->prepare('SELECT stored_name, orig_name FROM task_attachments WHERE task_id = :t');
    $st->execute([':t' => $taskId]);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    if ($rows !== []) {
        $pdo->prepare('DELETE FROM task_attachments WHERE task_id = :t')->execute([':t' => $taskId]);
    }
    return ['stored' => array_column($rows, 'stored_name'), 'names' => array_column($rows, 'orig_name')];
}

function tf_unlink_all(array $stored): int
{
    $n = 0;
    foreach ($stored as $s) {
        try {
            $p = tf_path((string) $s);
        } catch (Throwable $e) {
            continue;
        }
        if (is_file($p) && @unlink($p)) {
            $n++;
        } elseif (is_file($p)) {
            error_log('[task_files] cannot unlink ' . $s);
        }
    }
    return $n;
}
