<?php
$dir = __DIR__ . '/images/';
if (!is_dir($dir)) mkdir($dir, 0777, true);

if (isset($_FILES['photo']) && $_FILES['photo']['error'] === UPLOAD_ERR_OK) {
    $name = basename($_FILES['photo']['name']);
    $name = preg_replace('/[^a-zA-Z0-9._-]/', '_', $name);
    $target = $dir . $name;
    
    if (move_uploaded_file($_FILES['photo']['tmp_name'], $target)) {
        chmod($target, 0644);
        echo json_encode(['path' => 'images/' . $name]);
    } else {
        echo json_encode(['error' => 'move_failed']);
    }
} else {
    echo json_encode(['error' => 'no_file']);
}
