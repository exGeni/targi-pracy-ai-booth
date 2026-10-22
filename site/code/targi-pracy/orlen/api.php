<?php
// AI photo booth API. A job is a few files in a directory outside the web root:
//   <id>.in.b64 (the photo, base64 JPEG) + <id>.meta.json   written here on submit
//   <id>.work                                               the worker claimed it
//   <id>.out.jpg | <id>.err                                 the worker's result
// The worker (site/booth-worker/worker.py) reaches that directory over cPanel UAPI, so this
// endpoint holds no secret and the worker needs no inbound route.
declare(strict_types=1);

const TTL = 86400;          // jobs and results are deleted after 24 h
const IP_WINDOW = 3600;
const PER_IP_HOUR = 60;     // a whole fair Wi-Fi shares one address; QUEUE_CAP is the real brake
const DAY_CAP = 200;
const QUEUE_CAP = 6;        // waiting + rendering; 3 rounds of 2 workers × ≤210 s fit the page's 900 s wait
const QUEUE_EXPIRY = 600;   // worker.py JOB_EXPIRY: an unclaimed photo older than this is dropped
const WORKER_SILENT = 90;   // worker.py writes .alive every 30 s
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 1024;
const JPEG_QUALITY = 88;

$jobs = dirname($_SERVER['DOCUMENT_ROOT']) . '/targi-jobs';
$styles = json_decode(file_get_contents(__DIR__ . '/styles.json'), true);

function out(int $code, array $body): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($body);
  exit;
}

function job_id(): string {
  $id = (string)($_GET['id'] ?? '');
  if (!preg_match('/^[a-f0-9]{16}$/', $id)) out(400, ['error' => 'bad_id']);
  return $id;
}

// The rate-limit key: an IPv6 client owns its whole /64, so that is one visitor.
function client_key(string $day): string {
  $ip = $_SERVER['REMOTE_ADDR'] ?? '';
  $bin = @inet_pton($ip);
  if ($bin !== false && strlen($bin) === 16) $ip = bin2hex(substr($bin, 0, 8)) . '::/64';
  return substr(hash('sha256', $day . $ip), 0, 16);
}

// A finished result counts only once its JPEG end marker is there (uploads are not atomic).
function complete_jpeg(string $p): bool {
  $size = @filesize($p);
  if (!$size || $size < 4) return false;
  $f = fopen($p, 'rb');
  fseek($f, -2, SEEK_END);
  $tail = fread($f, 2);
  fclose($f);
  return $tail === "\xFF\xD9";
}

// Write a whole file or nothing: a temp file of the exact length, then rename.
function write_atomic(string $path, string $data): bool {
  $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.part';
  if (@file_put_contents($tmp, $data) !== strlen($data)) { @unlink($tmp); return false; }
  return @rename($tmp, $path);
}

// Waiting = a photo with no result yet (claimed or not), the same rule worker.py uses.
function waiting(string $jobs, string $id): bool {
  return !is_file("$jobs/$id.out.jpg") && !is_file("$jobs/$id.err");
}

if (!is_dir($jobs) && !mkdir($jobs, 0700, true)) out(500, ['error' => 'storage']);
$now = time();

// At most once a minute: drop everything older than the TTL (the 24 h promise holds without
// traffic) and close unclaimed photos the worker never picked up, so a stopped worker cannot
// leave the queue full.
if ($now - (int)@filemtime("$jobs/.swept") > 60) {
  @touch("$jobs/.swept");
  foreach (glob("$jobs/*") ?: [] as $p) {
    if ($now - (int)@filemtime($p) > TTL) { @unlink($p); continue; }
    // A reservation or temp file a crashed request left behind.
    if ((str_ends_with($p, '.rsv') || str_ends_with($p, '.part')) && $now - (int)@filemtime($p) > 120) { @unlink($p); continue; }
    if (str_ends_with($p, '.in.b64') && $now - (int)@filemtime($p) > QUEUE_EXPIRY) {
      $id = basename($p, '.in.b64');
      if (!is_file("$jobs/$id.work") && waiting($jobs, $id)) { @touch("$jobs/$id.err"); @unlink($p); }
    }
  }
}

$a = $_GET['a'] ?? '';

if ($a === 'submit' && $_SERVER['REQUEST_METHOD'] === 'POST') {
  $style = (string)($_POST['style'] ?? '');
  if (!isset($styles[$style])) out(400, ['error' => 'bad_style']);
  $f = $_FILES['photo'] ?? null;
  if (!$f || $f['error'] !== UPLOAD_ERR_OK || $f['size'] > MAX_BYTES) out(400, ['error' => 'bad_photo']);
  if ($now - (int)@filemtime("$jobs/.alive") > WORKER_SILENT) out(503, ['error' => 'offline']);

  // Admission before any decoding, under one lock: the queue slot is reserved (<id>.rsv) and the
  // attempt counted against the day and the address, so refused or bad uploads cost nothing.
  $lock = fopen("$jobs/.lock", 'c');
  flock($lock, LOCK_EX);
  $waiting = count(array_filter(glob("$jobs/*.in.b64") ?: [], fn($p) => waiting($jobs, basename($p, '.in.b64'))));
  if ($waiting + count(glob("$jobs/*.rsv") ?: []) >= QUEUE_CAP) out(503, ['error' => 'busy']);
  $statsFile = "$jobs/.stats.json";
  $stats = json_decode((string)@file_get_contents($statsFile), true) ?: [];
  $day = gmdate('Y-m-d');
  if (($stats['day'] ?? '') !== $day) $stats = ['day' => $day, 'count' => 0, 'ip' => []];
  if ($stats['count'] >= DAY_CAP) out(429, ['error' => 'day_cap']);
  $key = client_key($day);
  $recent = array_values(array_filter($stats['ip'][$key] ?? [], fn($t) => $now - $t < IP_WINDOW));
  if (count($recent) >= PER_IP_HOUR) out(429, ['error' => 'ip_cap']);
  $id = bin2hex(random_bytes(8));
  $recent[] = $now;
  $stats['ip'][$key] = $recent;
  $stats['count']++;
  if (!write_atomic("$jobs/$id.rsv", '') || !write_atomic($statsFile, json_encode($stats))) {
    @unlink("$jobs/$id.rsv");
    out(500, ['error' => 'storage']);
  }
  flock($lock, LOCK_UN);

  // Check the declared size before decoding: a small file can expand into a huge bitmap.
  $info = @getimagesize($f['tmp_name']);
  $img = $info && $info[0] >= 1 && $info[1] >= 1 && $info[0] * $info[1] <= MAX_PIXELS
    ? @imagecreatefromstring(file_get_contents($f['tmp_name'])) : false;
  // Re-encode through GD: bounded size, no EXIF, nothing but pixels reaches the worker.
  $jpeg = '';
  if ($img) {
    $w = imagesx($img); $h = imagesy($img);
    $k = min(1, MAX_SIDE / max($w, $h));
    $small = imagescale($img, max(1, (int)round($w * $k)), max(1, (int)round($h * $k)));
    ob_start();
    $encoded = $small && imagejpeg($small, null, JPEG_QUALITY);
    $jpeg = (string)ob_get_clean();
    if (!$encoded) $jpeg = '';
  }
  if ($jpeg === '') { @unlink("$jobs/$id.rsv"); out(400, ['error' => 'bad_photo']); }

  $ok = write_atomic("$jobs/$id.meta.json", json_encode(['style' => $style]))
    && write_atomic("$jobs/$id.in.b64", base64_encode($jpeg));
  @unlink("$jobs/$id.rsv");
  if (!$ok) {
    @unlink("$jobs/$id.meta.json");
    @unlink("$jobs/$id.in.b64");
    out(500, ['error' => 'storage']);
  }
  out(200, ['id' => $id]);
}

// site/deploy.sh checks a deploy with status for id 0000000000000000: it must answer "gone" with
// `rev` equal to the deployed file's md5 prefix, so a stale (OPcache) api.php does not pass.
if ($a === 'status') {
  $id = job_id();
  if (complete_jpeg("$jobs/$id.out.jpg")) out(200, ['state' => 'done', 'img' => "api.php?a=img&id=$id"]);
  if (is_file("$jobs/$id.err")) out(200, ['state' => 'error']);
  if (is_file("$jobs/$id.work") || is_file("$jobs/$id.out.jpg")) out(200, ['state' => 'working']);
  if (is_file("$jobs/$id.in.b64")) {
    // Ahead = unclaimed photos the worker takes first: older, or the same second and a smaller id.
    $mine = [(int)@filemtime("$jobs/$id.in.b64"), $id];
    $ahead = 0;
    foreach (glob("$jobs/*.in.b64") ?: [] as $p) {
      $other = basename($p, '.in.b64');
      if ($other === $id || is_file("$jobs/$other.work") || !waiting($jobs, $other)) continue;
      if ([(int)@filemtime($p), $other] < $mine) $ahead++;
    }
    out(200, ['state' => 'queued', 'ahead' => $ahead]);
  }
  out(200, $id === '0000000000000000' ? ['state' => 'gone', 'rev' => substr(md5_file(__FILE__), 0, 12)] : ['state' => 'gone']);
}

if ($a === 'img') {
  $id = job_id();
  $p = "$jobs/$id.out.jpg";
  if (!complete_jpeg($p)) out(404, ['error' => 'gone']);
  header('Content-Type: image/jpeg');
  header('Content-Length: ' . filesize($p));
  header('Cache-Control: private, max-age=86400');
  if (isset($_GET['dl'])) header('Content-Disposition: attachment; filename="exgenius-portret.jpg"');
  readfile($p);
  exit;
}

out(404, ['error' => 'unknown_action']);
