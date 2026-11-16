<?php

declare(strict_types=1);

/**
 * task_files.php — вложения задач (V7, Ш1). Правила и хранение — api/task_files_lib.php.
 *
 * GET    api/task_files.php?limits=1            — { success, limits }
 * GET    api/task_files.php?task_id=...         — { success, attachments: [...], can_upload, limits }
 * GET    api/task_files.php?id=N[&inline=1]     — сам файл (inline только для картинок/PDF, иначе скачивание)
 * POST   api/task_files.php?task_id=...         — multipart, поле "file" (один файл на запрос)
 *                                                → 201 { success, attachment, attachments }
 * DELETE api/task_files.php?id=N                — { success, attachments }
 *
 * Права: чтение/скачивание — любой авторизованный (аноним → 401). Прикрепить: admin — к любой неархивной
 * задаче; supervisor — только к задаче, которую создал сам; viewer — 403. Удалить: admin — любое;
 * supervisor — только своё вложение в своей задаче. Архивная задача → 409 task_archived (при архивации
 * вложения удаляются с сервера — api/tasks.php, DELETE).
 * Ошибки: 400 no_file|empty_file, 413 file_too_large, 415 unsupported_format|content_mismatch,
 * 422 too_many_files|total_too_large, 404 not_found. Аудит: task.attach / task.detach.
 * Версия задачи НЕ меняется (вложения не конфликтуют с открытой формой правки).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/task_files_lib.php';

handleOptions();

function tf_fail(string $code, int $http, array $extra = []): void
{
    sendJson(array_merge(['error' => $code], $extra), $http);
}

function tf_task_row(PDO $pdo, string $id): ?array
{
    $st = $pdo->prepare('SELECT id, title, created_by, archived FROM tasks WHERE id = :id');
    $st->execute([':id' => $id]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    return $r ?: null;
}

function tf_att_row(PDO $pdo, int $id): ?array
{
    $st = $pdo->prepare('SELECT * FROM task_attachments WHERE id = :id');
    $st->execute([':id' => $id]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    return $r ?: null;
}

function tf_task_list(PDO $pdo, string $taskId): array
{
    return tf_load($pdo, [$taskId])[$taskId] ?? [];
}

/** ASCII-запасное имя для Content-Disposition (полное — в filename*). */
function tf_ascii_name(string $name): string
{
    $a = preg_replace('/[^A-Za-z0-9._-]+/', '_', $name) ?? 'file';
    $a = trim($a, '_');
    return $a === '' || $a[0] === '.' ? 'file' . ($a === '' ? '' : $a) : $a;
}

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['GET', 'POST', 'DELETE'], true)) {
        tf_fail('method_not_allowed', 405);
    }
    require_auth();
    $user = current_user();

    // ---------------------------------------------------------------- GET
    if ($method === 'GET') {
        if (isset($_GET['limits'])) {
            sendJson(['success' => true, 'limits' => tf_limits()]);
        }
        if (isset($_GET['id']) && $_GET['id'] !== '') {
            if (!preg_match('/^\d{1,12}$/', (string) $_GET['id'])) {
                tf_fail('not_found', 404);
            }
            $att = tf_att_row($pdo, (int) $_GET['id']);
            if ($att === null) {
                tf_fail('not_found', 404);
            }
            $path = tf_path((string) $att['stored_name']);
            if (!is_file($path)) {
                tf_fail('not_found', 404);
            }
            session_write_close();
            $name = (string) $att['orig_name'];
            $ext = tf_ext($name);
            $inline = !empty($_GET['inline']) && tf_inline($ext);
            $types = tf_types();
            $ctype = $types[$ext][0] ?? 'application/octet-stream';
            header('Content-Type: ' . $ctype);
            header('Content-Length: ' . (string) filesize($path));
            header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . tf_ascii_name($name)
                . "\"; filename*=UTF-8''" . rawurlencode($name));
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: private, max-age=0, must-revalidate');
            if (strpos($ctype, 'image/') === 0) {
                header("Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
            }
            readfile($path);
            exit;
        }
        $taskId = (string) ($_GET['task_id'] ?? '');
        if ($taskId === '') {
            tf_fail('task_id_required', 400);
        }
        $task = tf_task_row($pdo, $taskId);
        if ($task === null) {
            tf_fail('not_found', 404);
        }
        sendJson([
            'success'     => true,
            'attachments' => tf_task_list($pdo, $taskId),
            'can_upload'  => tf_can_upload($user, $task),
            'limits'      => tf_limits(),
        ]);
    }

    // ---------------------------------------------------------------- POST (загрузка)
    if ($method === 'POST') {
        $taskId = (string) ($_GET['task_id'] ?? '');
        $task = $taskId !== '' ? tf_task_row($pdo, $taskId) : null;
        if ($task === null) {
            tf_fail('not_found', 404);
        }
        if ((int) $task['archived'] === 1) {
            tf_fail('task_archived', 409);
        }
        if (!tf_can_upload($user, $task)) {
            tf_fail('forbidden', 403);
        }
        $max = tf_max_file_bytes();
        $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        $f = $_FILES['file'] ?? null;
        if (!is_array($f) || is_array($f['error'] ?? null)) {
            // тело больше post_max_size → PHP отбрасывает $_FILES целиком
            if ($len > 0 && $len > tf_ini_bytes((string) ini_get('post_max_size'))) {
                tf_fail('file_too_large', 413, ['max_file_bytes' => $max]);
            }
            tf_fail('no_file', 400);
        }
        $err = (int) $f['error'];
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
            tf_fail('file_too_large', 413, ['max_file_bytes' => $max]);
        }
        if ($err === UPLOAD_ERR_NO_FILE) {
            tf_fail('no_file', 400);
        }
        if ($err !== UPLOAD_ERR_OK || !is_uploaded_file((string) $f['tmp_name'])) {
            tf_fail('upload_failed', 400);
        }
        $size = (int) filesize((string) $f['tmp_name']);
        if ($size <= 0) {
            tf_fail('empty_file', 400);
        }
        if ($size > $max) {
            tf_fail('file_too_large', 413, ['max_file_bytes' => $max]);
        }
        $name = tf_clean_name((string) $f['name']);
        [$typeErr, $serve] = tf_check_type($name, (string) $f['tmp_name']);
        if ($typeErr !== null) {
            tf_fail($typeErr, 415);
        }
        // предварительная проверка квоты (окончательная — в транзакции после вставки)
        $q = $pdo->prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM task_attachments WHERE task_id = :t');
        $q->execute([':t' => $taskId]);
        $cur = $q->fetch(PDO::FETCH_ASSOC);
        if ((int) $cur['n'] >= TF_MAX_FILES) {
            tf_fail('too_many_files', 422, ['max_files' => TF_MAX_FILES]);
        }
        if ((int) $cur['s'] + $size > TF_MAX_TOTAL_BYTES) {
            tf_fail('total_too_large', 422, ['max_total_bytes' => TF_MAX_TOTAL_BYTES]);
        }

        $stored = bin2hex(random_bytes(16));
        $dest = tf_path($stored);
        if (!move_uploaded_file((string) $f['tmp_name'], $dest)) {
            throw new RuntimeException('move_uploaded_file failed');
        }
        @chmod($dest, 0640);
        $username = is_array($user) && !empty($user['username']) ? (string) $user['username'] : 'api';
        $pdo->beginTransaction();
        try {
            $ins = $pdo->prepare(
                'INSERT INTO task_attachments (task_id, orig_name, stored_name, mime, size, uploaded_by, uploaded_at)
                 VALUES (:t, :n, :s, :m, :z, :u, :ts)'
            );
            $ins->execute([':t' => $taskId, ':n' => $name, ':s' => $stored, ':m' => $serve, ':z' => $size,
                ':u' => $username, ':ts' => now()]);
            $newId = (int) $pdo->lastInsertId();
            // окончательная проверка (параллельные загрузки): задача не ушла в архив, квота не превышена
            $chk = tf_task_row($pdo, $taskId);
            $q->execute([':t' => $taskId]);
            $cur = $q->fetch(PDO::FETCH_ASSOC);
            $fail = null;
            if ($chk === null || (int) $chk['archived'] === 1) {
                $fail = ['task_archived', 409, []];
            } elseif ((int) $cur['n'] > TF_MAX_FILES) {
                $fail = ['too_many_files', 422, ['max_files' => TF_MAX_FILES]];
            } elseif ((int) $cur['s'] > TF_MAX_TOTAL_BYTES) {
                $fail = ['total_too_large', 422, ['max_total_bytes' => TF_MAX_TOTAL_BYTES]];
            }
            if ($fail !== null) {
                $pdo->rollBack();
                @unlink($dest);
                tf_fail($fail[0], $fail[1], $fail[2]);
            }
            audit($pdo, 'task.attach', null, null, 'task', $taskId, [
                'attachment_id' => $newId, 'name' => $name, 'size' => $size, 'title' => $task['title'],
            ]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            @unlink($dest);
            throw $e;
        }
        sendJson([
            'success'     => true,
            'attachment'  => tf_public(tf_att_row($pdo, $newId) ?? []),
            'attachments' => tf_task_list($pdo, $taskId),
        ], 201);
    }

    // ---------------------------------------------------------------- DELETE
    if (!isset($_GET['id']) || !preg_match('/^\d{1,12}$/', (string) $_GET['id'])) {
        tf_fail('not_found', 404);
    }
    $att = tf_att_row($pdo, (int) $_GET['id']);
    if ($att === null) {
        tf_fail('not_found', 404);
    }
    $task = tf_task_row($pdo, (string) $att['task_id']);
    if ($task === null) {
        tf_fail('not_found', 404);
    }
    if ((int) $task['archived'] === 1) {
        tf_fail('task_archived', 409);
    }
    if (!tf_can_delete($user, $task, $att)) {
        tf_fail('forbidden', 403);
    }
    $pdo->beginTransaction();
    try {
        $del = $pdo->prepare('DELETE FROM task_attachments WHERE id = :id');
        $del->execute([':id' => (int) $att['id']]);
        audit($pdo, 'task.detach', null, null, 'task', (string) $att['task_id'], [
            'attachment_id' => (int) $att['id'], 'name' => $att['orig_name'], 'size' => (int) $att['size'], 'title' => $task['title'],
        ]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    tf_unlink_all([(string) $att['stored_name']]);
    sendJson(['success' => true, 'attachments' => tf_task_list($pdo, (string) $att['task_id'])]);
} catch (Throwable $e) {
    error_log('[task_files] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    sendJson(['error' => 'server_error'], 500);
}
