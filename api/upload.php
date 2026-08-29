<?php

declare(strict_types=1);

/**
 * api/upload.php — POST: загрузка и серверная обработка фото сотрудника.
 *
 * Фаза 5 (часть A): серверная фотообработка.
 *
 * Защищена авторизацией: требуется залогиненный пользователь с правами
 * редактирования (admin или supervisor).
 *
 * Принимает multipart/form-data: поле "photo".
 * Разрешённые форматы: jpg, jpeg, png, webp.
 * Максимальный размер: 2 МБ.
 *
 * Обработка:
 *   1. center-crop в квадрат (по центру).
 *   2. resize до 512×512.
 *   3. конвертация в WebP (quality 85).
 *   4. strip EXIF/metadata.
 *
 * Imagick предпочтителен, GD как fallback.
 *
 * Возвращает:
 *   { success: true, path: "images/<filename>", size, dimensions, format }
 *   или { error: "..." }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('POST');

// --- Авторизация: только залогиненные с правами редактирования ---
require_auth();
require_edit();

try {
    // 1. Проверка наличия файла.
    if (!isset($_FILES['photo']) || $_FILES['photo']['error'] !== UPLOAD_ERR_OK) {
        error('no_file', 400);
    }

    $file = $_FILES['photo'];

    // 2. Проверка размера (максимум 2 МБ).
    $maxSize = 2 * 1024 * 1024;
    if ($file['size'] > $maxSize) {
        error('file_too_large (max 2MB)', 400);
    }

    // 3. Проверка MIME-типа по сигнатуре (finfo — содержимое, а не имя).
    $allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime  = $finfo->file($file['tmp_name']);
    if ($mime === false || !in_array($mime, $allowedMimes, true)) {
        error('unsupported_format (jpg, png, webp only)', 400);
    }

    // 4. Папка назначения (вне api/).
    $outputDir = dirname(__DIR__) . '/images/';
    if (!is_dir($outputDir)) {
        mkdir($outputDir, 0775, true);
    }

    // Генерация безопасного имени: photo_<timestamp>_<random>.webp
    $filename    = 'photo_' . time() . '_' . bin2hex(random_bytes(4)) . '.webp';
    $outputPath  = $outputDir . $filename;

    $targetSize = 512;
    $quality    = 85;

    // 5. Обработка: crop → resize → WebP → strip EXIF.
    if (extension_loaded('imagick')) {
        // --- Путь Imagick (предпочтителен) ---
        $image = new Imagick($file['tmp_name']);

        // Удалить EXIF/metadata ДО любых операций.
        $image->stripImage();

        // center-crop в квадрат.
        $w    = $image->getImageWidth();
        $h    = $image->getImageHeight();
        $size = min($w, $h);
        $x    = (int) (($w - $size) / 2);
        $y    = (int) (($h - $size) / 2);
        $image->cropImage($size, $size, $x, $y);

        // resize до 512×512 (Lanczos для качества).
        $image->resizeImage($targetSize, $targetSize, Imagick::FILTER_LANCZOS, 1);

        // Конвертация в WebP.
        $image->setImageFormat('webp');
        $image->setImageCompressionQuality($quality);
        // WebP-specific: дополнительно подстраховаться по метаданным.
        $image->stripImage();

        $image->writeImage($outputPath);
        $image->clear();
        $image->destroy();
    } else {
        // --- Путь GD (fallback) ---
        // GD требует включённого буфера вывода для imagewebp.
        $src = match ($mime) {
            'image/jpeg' => @imagecreatefromjpeg($file['tmp_name']),
            'image/png'  => @imagecreatefrompng($file['tmp_name']),
            'image/webp' => @imagecreatefromwebp($file['tmp_name']),
            default      => false,
        };

        if ($src === false) {
            error('processing_failed (cannot decode image)', 500);
        }

        $w = imagesx($src);
        $h = imagesy($src);

        // center-crop в квадрат.
        $size = min($w, $h);
        $sx   = (int) (($w - $size) / 2);
        $sy   = (int) (($h - $size) / 2);

        // resize до 512×512 с помощью imagecopyresampled (качество).
        $dst = imagecreatetruecolor($targetSize, $targetSize);
        imagealphablending($dst, true);
        imagesavealpha($dst, true);
        // Прозрачный фон на случай PNG с альфа-каналом.
        $transparent = imagecolorallocatealpha($dst, 255, 255, 255, 127);
        imagefilledrectangle($dst, 0, 0, $targetSize, $targetSize, $transparent);

        imagecopyresampled(
            $dst,
            $src,
            0,
            0,
            $sx,
            $sy,
            $targetSize,
            $targetSize,
            $size,
            $size
        );

        // WebP не сохраняет EXIF — strip выполнен автоматически при пересохранении.
        imagewebp($dst, $outputPath, $quality);

        imagedestroy($src);
        imagedestroy($dst);
    }

    // Права доступа.
    chmod($outputPath, 0644);

    // Проверка, что файл реально создан.
    if (!file_exists($outputPath)) {
        error('processing_failed', 500);
    }

    // 6. Ответ.
    sendJson([
        'success'    => true,
        'path'       => 'images/' . $filename,
        'size'       => filesize($outputPath),
        'dimensions' => $targetSize . 'x' . $targetSize,
        'format'     => 'webp',
    ]);

    // E5: audit photo upload
    try {
        if (!empty($_SESSION['user_id'])) {
            require_once __DIR__ . '/db.php';
            $pdoDb = Database::getInstance()->getPDO();
            audit($pdoDb, 'photo.upload', null, null, 'system', null, ['filename' => $filename]);
        }
    } catch (Throwable $_e) { /* non-critical */ }
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
