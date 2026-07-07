/**
 * file-server.mjs — Lightweight file API for per-user Flutter preview.
 *
 * The designer pushes code changes into the active project via the file API.
 * A reverse proxy on port 8080 strips the ELB basePath and forwards to
 * Flutter's web dev server on port 8081. File API runs on port 9091.
 *
 * Endpoints:
 *   GET  /api/health                              — health + current project + version
 *   GET  /api/projects/current                     — { project, path }
 *   POST /api/projects/switch  { name }            — create/switch project, restart Flutter
 *   POST /api/files/write  { path, content }       — write file (relative to project)
 *   GET  /api/files/read?path=...                  — read file
 *   GET  /api/files/list?dir=...                   — list directory
 *   POST /api/files/mkdir  { path }                — create directory
 *   DELETE /api/files/delete?path=...              — delete file
 *   POST /api/files/write-batch { files }          — batch write multiple files
 *   POST /api/build                                — flutter pub get + restart
 *   POST /api/exec  { script }                     — execute shell script
 *   GET  /api/logs                                  — preview logs
 */

import { createServer } from 'http';
import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, watchFile } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync, spawn } from 'child_process';

const PORT = parseInt(process.env.FILE_API_PORT || '9091', 10);
const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/workspace';
const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT || '8080', 10);
const FLUTTER_INTERNAL_PORT = 8081;

let currentProject = 'my-project';
let WORKSPACE = join(WORKSPACE_BASE, currentProject);
let fileVersion = 0;  // Increments on every file write — used for cache-busting

// Ensure base exists
if (!existsSync(WORKSPACE_BASE)) mkdirSync(WORKSPACE_BASE, { recursive: true });

// ── Security: prevent path traversal ──
function safePath(requestedPath) {
  const resolved = resolve(join(WORKSPACE, requestedPath));
  if (!resolved.startsWith(resolve(WORKSPACE))) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

// ── Create Flutter project skeleton ──
function createProject(name) {
  const projectPath = join(WORKSPACE_BASE, name);

  // Already has pubspec.yaml? Reuse.
  if (existsSync(join(projectPath, 'pubspec.yaml'))) {
    console.log(`[fl-server] Project "${name}" ready (existing pubspec.yaml).`);
    return projectPath;
  }

  console.log(`[fl-server] Setting up project "${name}"...`);
  if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true });

  // Create minimal Flutter project structure
  if (!existsSync(join(projectPath, 'lib'))) mkdirSync(join(projectPath, 'lib'));
  if (!existsSync(join(projectPath, 'web'))) mkdirSync(join(projectPath, 'web'));

  if (!existsSync(join(projectPath, 'pubspec.yaml'))) {
    writeFileSync(join(projectPath, 'pubspec.yaml'), `name: preview_app
description: Flutter preview app
publish_to: 'none'
version: 0.0.1

environment:
  sdk: '>=3.5.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter

flutter:
  uses-material-design: true
`);
  }

  if (!existsSync(join(projectPath, 'analysis_options.yaml'))) {
    writeFileSync(join(projectPath, 'analysis_options.yaml'), `include: package:flutter/analysis_options.yaml
linter:
  rules:
    prefer_const_constructors: false
    prefer_const_literals_to_create_immutables: false
`);
  }

  if (!existsSync(join(projectPath, 'web', 'index.html'))) {
    writeFileSync(join(projectPath, 'web', 'index.html'), `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script src="flutter_bootstrap.js"></script>
</body>
</html>
`);
  }

  if (!existsSync(join(projectPath, 'web', 'manifest.json'))) {
    writeFileSync(join(projectPath, 'web', 'manifest.json'), JSON.stringify({
      name: name,
      short_name: name,
      start_url: '.',
      display: 'standalone',
    }, null, 2));
  }

  if (!existsSync(join(projectPath, 'lib', 'main.dart'))) {
    writeFileSync(join(projectPath, 'lib', 'main.dart'), `import 'package:flutter/material.dart';

void main() {
  runApp(const PreviewApp());
}

class PreviewApp extends StatelessWidget {
  const PreviewApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${name}',
      theme: ThemeData(
        colorSchemeSeed: Colors.blue,
        useMaterial3: true,
      ),
      home: const PreviewHome(),
    );
  }
}

class PreviewHome extends StatelessWidget {
  const PreviewHome({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${name}')),
      body: const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Preview Ready', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
            SizedBox(height: 8),
            Text('Build on the canvas to see your app here.', style: TextStyle(fontSize: 14, color: Colors.grey)),
          ],
        ),
      ),
    );
  }
}
`);
  }

  console.log(`[fl-server] Project "${name}" ready.`);
  return projectPath;
}

// ── Switch to a different project ──
function switchProject(name) {
  const safeName = (name || 'my-project')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'my-project';

  const projectPath = createProject(safeName);
  const changed = (safeName !== currentProject);
  currentProject = safeName;
  WORKSPACE = projectPath;
  console.log(`[fl-server] Active project: "${currentProject}"${changed ? ' (changed)' : ' (unchanged)'}`);

  if (changed) {
    if (flutterProcess) {
      try { flutterProcess.kill('SIGTERM'); } catch {}
      flutterProcess = null;
    }
    setTimeout(startFlutter, 4000);
    try { watchFile(join(WORKSPACE, 'pubspec.yaml'), watchPkgHandler); } catch {}
  }
}

// ── Start Flutter web dev server ──
let flutterProcess = null;
let flutterStarting = false;
let flutterRetries = 0;

function startFlutter() {
  if (flutterStarting) {
    console.log('[fl-server] Flutter start already in progress, skipping.');
    return;
  }
  flutterStarting = true;

  if (flutterProcess) {
    const old = flutterProcess;
    flutterProcess = null;
    try { old.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { old.kill('SIGKILL'); } catch {} }, 3000);
  }

  console.log(`[fl-server] Starting Flutter in ${WORKSPACE}...`);

  // Run flutter pub get first
  try {
    execSync('flutter pub get', { cwd: WORKSPACE, stdio: 'pipe', timeout: 60000 });
    console.log('[fl-server] flutter pub get complete.');
  } catch (err) {
    console.error('[fl-server] flutter pub get failed:', err.message);
  }

  // Build web first (needed for flutter run to pick up changes)
  try {
    execSync('flutter build web --no-pub', { cwd: WORKSPACE, stdio: 'pipe', timeout: 120000 });
    console.log('[fl-server] flutter build web complete.');
  } catch (err) {
    console.error('[fl-server] flutter build web failed:', err.message);
  }

  // Start Flutter web dev server
  flutterProcess = spawn('flutter', [
    'run', '-d', 'web-server',
    '--web-port', String(FLUTTER_INTERNAL_PORT),
    '--web-hostname', '0.0.0.0',
    '--no-pub',
  ], {
    cwd: WORKSPACE,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  if (flutterProcess.stdout) {
    flutterProcess.stdout.on('data', (data) => {
      process.stdout.write(data);
    });
  }
  if (flutterProcess.stderr) {
    flutterProcess.stderr.on('data', (data) => {
      process.stderr.write(data);
    });
  }

  flutterProcess.on('exit', (code) => {
    console.log(`[fl-server] Flutter exited with code ${code}.`);
    flutterProcess = null;
    flutterStarting = false;
    if (code !== 0 && flutterRetries < 3) {
      flutterRetries++;
      console.log(`[fl-server] Flutter restarting in 5s (retry ${flutterRetries}/3)...`);
      setTimeout(startFlutter, 5000);
    } else if (code === 0) {
      flutterRetries = 0;
    } else {
      console.log(`[fl-server] Flutter failed after ${flutterRetries} retries. Giving up.`);
      flutterRetries = 0;
    }
  });

  setTimeout(() => { flutterStarting = false; }, 8000);
}

// ── Request parsing ──
function parseBody(req) {
  return new Promise((resolve) => {
    if (req._body !== undefined) return resolve(JSON.parse(req._body || '{}'));
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function bufferBody(req) {
  return new Promise((resolve) => {
    if (req._body !== undefined) return resolve();
    req.pause();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { req._body = Buffer.concat(chunks).toString(); resolve(); });
    req.on('error', () => { req._body = ''; resolve(); });
    req.resume();
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── File API Server (port 9091) ──
const server = createServer(async (req, res) => {
  await bufferBody(req);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();

  try {
    if (method === 'GET' && url.pathname === '/api/health') {
      return json(res, { ok: true, project: currentProject, workspace: WORKSPACE, version: fileVersion });
    }

    if (method === 'GET' && url.pathname === '/api/projects/current') {
      return json(res, { project: currentProject, path: WORKSPACE });
    }

    if (method === 'POST' && url.pathname === '/api/projects/switch') {
      const body = await parseBody(req);
      const { name } = body;
      if (!name) return json(res, { error: 'name required' }, 400);
      const safeName = (name || 'my-project')
        .replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'my-project';
      json(res, { ok: true, project: safeName, switching: safeName !== currentProject });
      setImmediate(() => switchProject(safeName));
    }

    if (method === 'GET' && url.pathname === '/api/files/list') {
      const dir = url.searchParams.get('dir') || '.';
      const fullPath = safePath(dir);
      if (!existsSync(fullPath)) return json(res, { error: 'Not found' }, 404);
      const entries = readdirSync(fullPath).map(name => {
        const full = join(fullPath, name);
        const stat = statSync(full);
        return { name, type: stat.isDirectory() ? 'dir' : 'file', size: stat.size };
      });
      return json(res, { entries });
    }

    if (method === 'GET' && url.pathname === '/api/files/read') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return json(res, { error: 'path required' }, 400);
      const fullPath = safePath(filePath);
      if (!existsSync(fullPath)) return json(res, { error: 'Not found' }, 404);
      return json(res, { content: readFileSync(fullPath, 'utf-8'), path: filePath });
    }

    if (method === 'POST' && url.pathname === '/api/files/write') {
      const body = await parseBody(req);
      const { path: filePath, content, encoding } = body;
      if (!filePath || content === undefined) return json(res, { error: 'path and content required' }, 400);
      const fullPath = safePath(filePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let decoded = content;
      if (encoding === 'base64') {
        try { decoded = Buffer.from(content, 'base64').toString('utf-8'); }
        catch (err) { return json(res, { error: `base64 decode failed: ${err.message}` }, 400); }
      }
      writeFileSync(fullPath, decoded);
      fileVersion++;

      // Flutter watches files and hot-reloads automatically — no stdin trigger needed.
      // But we touch a marker so the polling script can detect changes.
      return json(res, { ok: true, path: filePath, bytes: decoded.length });
    }

    if (method === 'POST' && url.pathname === '/api/files/write-batch') {
      const body = await parseBody(req);
      const { files } = body;
      if (!files || !Array.isArray(files)) return json(res, { error: 'files array required' }, 400);

      const results = [];
      for (const f of files) {
        const { path: fp, content, encoding } = f;
        if (!fp || content === undefined) { results.push({ path: fp, error: 'path and content required' }); continue; }
        try {
          const fullPath = safePath(fp);
          const dir = dirname(fullPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          let decoded = content;
          if (encoding === 'base64') decoded = Buffer.from(content, 'base64').toString('utf-8');
          writeFileSync(fullPath, decoded);
          results.push({ path: fp, ok: true, bytes: decoded.length });
        } catch (err) { results.push({ path: fp, error: err.message }); }
      }

      fileVersion++;
      return json(res, { ok: true, results });
    }

    if (method === 'POST' && url.pathname === '/api/files/mkdir') {
      const body = await parseBody(req);
      const { path: dirPath } = body;
      if (!dirPath) return json(res, { error: 'path required' }, 400);
      const fullPath = safePath(dirPath);
      if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
      return json(res, { ok: true, path: dirPath });
    }

    if (method === 'DELETE' && url.pathname === '/api/files/delete') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return json(res, { error: 'path required' }, 400);
      const fullPath = safePath(filePath);
      if (!existsSync(fullPath)) return json(res, { error: 'Not found' }, 404);
      unlinkSync(fullPath);
      return json(res, { ok: true });
    }

    if (method === 'POST' && url.pathname === '/api/build') {
      console.log('[fl-server] Build triggered — running flutter pub get...');
      try {
        const output = execSync('flutter pub get', { cwd: WORKSPACE, stdio: 'pipe', timeout: 60000 });
        console.log('[fl-server] flutter pub get complete.');
        if (flutterProcess) { flutterProcess.kill(); flutterProcess = null; }
        setTimeout(startFlutter, 2000);
        return json(res, { ok: true, message: 'flutter pub get + restart triggered', output: output.toString() });
      } catch (err) {
        console.error('[fl-server] flutter pub get failed:', err.message);
        return json(res, { ok: false, error: err.stderr?.toString() || err.message });
      }
    }

    if (method === 'POST' && url.pathname === '/api/exec') {
      const body = await parseBody(req);
      const { script } = body;
      if (!script) return json(res, { error: 'script filename required' }, 400);
      const scriptPath = safePath(`commands/${script}`);
      if (!existsSync(scriptPath)) return json(res, { error: 'Script not found' }, 404);
      console.log(`[fl-server] Executing: ${script}`);
      try {
        const output = execSync(`bash ${scriptPath}`, { cwd: WORKSPACE, stdio: 'pipe', timeout: 60000 });
        return json(res, { ok: true, output: output.toString() });
      } catch (err) {
        return json(res, { ok: false, output: err.stdout?.toString() || '', error: err.stderr?.toString() || err.message });
      }
    }

    if (method === 'GET' && url.pathname === '/api/logs') {
      const logPath = join(dirname(WORKSPACE), 'logs', 'preview.log');
      if (existsSync(logPath)) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(readFileSync(logPath, 'utf-8'));
      }
      return json(res, { logs: '' });
    }

    json(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error('[fl-server] Error:', err.message);
    json(res, { error: err.message }, 500);
  }
});

// ── Watch pubspec.yaml for dependency changes ──
let pubGetRunning = false;
async function watchPkgHandler(curr, prev) {
  if (curr.mtimeMs === prev.mtimeMs) return;
  if (pubGetRunning) return;
  pubGetRunning = true;
  console.log('[fl-server] pubspec.yaml changed — running flutter pub get...');
  try {
    execSync('flutter pub get', { cwd: WORKSPACE, stdio: 'pipe', timeout: 60000 });
    console.log('[fl-server] flutter pub get complete. Restarting Flutter...');
    if (flutterProcess) { flutterProcess.kill(); flutterProcess = null; }
    setTimeout(startFlutter, 2000);
  } catch (err) {
    console.error('[fl-server] flutter pub get failed:', err.message);
  } finally {
    pubGetRunning = false;
  }
}

function watchPubspec() {
  watchFile(join(WORKSPACE, 'pubspec.yaml'), watchPkgHandler);
  console.log('[fl-server] Watching pubspec.yaml for changes');
}

// ── Startup ──
console.log('[fl-server] Creating default project "my-project"...');
createProject('my-project');
console.log(`[fl-server] Workspace: ${WORKSPACE}`);
watchPubspec();
startFlutter();

server.listen(PORT, () => {
  console.log(`[fl-server] File API listening on port ${PORT}`);
});

// ═══════════════════════════════════════════════════════════════
// ── Reverse proxy on port 8080 → Flutter on 8081 ──────────────
// Also handles /api/* routes directly for ELB accessibility
// ═══════════════════════════════════════════════════════════════

const userHash = process.env.PREVIEW_USER_HASH || 'default';
const basePath = `/webapp/fl-pv-${userHash}`;

// Simplified API handler — takes pre-buffered body
function handleApiInProxySync(req, res, rawBody) {
  const url = new URL(req.url, `http://localhost:${PREVIEW_PORT}`);
  const method = req.method.toUpperCase();
  let body = {};
  try { body = JSON.parse(rawBody || '{}'); } catch {}

  if (method === 'GET' && url.pathname === '/api/health') { json(res, { ok: true, project: currentProject, workspace: WORKSPACE, version: fileVersion }); return true; }
  if (method === 'GET' && url.pathname === '/api/projects/current') { json(res, { project: currentProject, path: WORKSPACE }); return true; }
  if (method === 'POST' && url.pathname === '/api/projects/switch') {
    const name = body.name;
    if (!name) { json(res, { error: 'name required' }, 400); return true; }
    const safeName = (name || 'my-project').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'my-project';
    json(res, { ok: true, project: safeName, switching: safeName !== currentProject });
    setImmediate(() => switchProject(safeName));
    return true;
  }
  if (method === 'GET' && url.pathname === '/api/files/read') {
    const fp = url.searchParams.get('path'); if (!fp) { json(res, { error: 'path required' }, 400); return true; }
    const full = safePath(fp); if (!existsSync(full)) { json(res, { error: 'Not found' }, 404); return true; }
    json(res, { content: readFileSync(full, 'utf-8'), path: fp }); return true;
  }
  if (method === 'GET' && url.pathname === '/api/files/list') {
    const dir = url.searchParams.get('dir') || '.'; const full = safePath(dir);
    if (!existsSync(full)) { json(res, { error: 'Not found' }, 404); return true; }
    const entries = readdirSync(full).map(n => { const s = statSync(join(full, n)); return { name: n, type: s.isDirectory() ? 'dir' : 'file', size: s.size }; });
    json(res, { entries }); return true;
  }
  if (method === 'POST' && url.pathname === '/api/files/write') {
    const { path: fp, content, encoding } = body;
    if (!fp || content === undefined) { json(res, { error: 'path and content required' }, 400); return true; }
    const full = safePath(fp); const d = dirname(full); if (!existsSync(d)) mkdirSync(d, { recursive: true });
    let decoded = content;
    if (encoding === 'base64') { try { decoded = Buffer.from(content, 'base64').toString('utf-8'); } catch (e) { json(res, { error: 'base64 decode failed' }, 400); return true; } }
    writeFileSync(full, decoded);
    fileVersion++;
    json(res, { ok: true, path: fp, bytes: decoded.length }); return true;
  }
  if (method === 'POST' && url.pathname === '/api/files/write-batch') {
    const { files } = body;
    if (!files || !Array.isArray(files)) { json(res, { error: 'files array required' }, 400); return true; }
    const results = [];
    for (const f of files) {
      try { const full = safePath(f.path); const d = dirname(full); if (!existsSync(d)) mkdirSync(d, { recursive: true }); let dec = f.content; if (f.encoding === 'base64') dec = Buffer.from(f.content, 'base64').toString('utf-8'); writeFileSync(full, dec); results.push({ path: f.path, ok: true, bytes: dec.length }); }
      catch (e) { results.push({ path: f.path, error: e.message }); }
    }
    fileVersion++;
    json(res, { ok: true, results }); return true;
  }
  if (method === 'POST' && url.pathname === '/api/files/mkdir') {
    const { path: dp } = body;
    if (!dp) { json(res, { error: 'path required' }, 400); return true; }
    const full = safePath(dp); if (!existsSync(full)) mkdirSync(full, { recursive: true });
    json(res, { ok: true, path: dp }); return true;
  }
  return false;
}

const proxyServer = createServer((req, res) => {
  // WebSocket upgrade — handled by 'upgrade' event below
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    return;
  }

  // Route /api/* — collect body synchronously, then handle
  if (req.url.startsWith('/api/')) {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', () => { handleApiInProxySync(req, res, rawBody); });
    return;
  }

  // Strip basePath before forwarding to Flutter dev server
  let flutterPath = req.url;
  if (flutterPath.startsWith(basePath)) flutterPath = flutterPath.slice(basePath.length) || '/';

  const proxyReq = http.request({
    hostname: 'localhost', port: FLUTTER_INTERNAL_PORT,
    path: flutterPath, method: req.method, headers: req.headers,
  }, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    const isHtml = ct.includes('text/html');
    const isCss = ct.includes('text/css');

    if (isHtml || isCss) {
      let body = '';
      proxyRes.on('data', (chunk) => { body += chunk.toString(); });
      proxyRes.on('end', () => {
        if (isHtml) {
          // Inject base tag + auto-reload polling script
          body = body.replace('<head>', `<head><base href="${basePath}/">
<script>
let __version = 0;
setInterval(function(){
  fetch('${basePath}/api/health').then(r=>r.json()).then(d=>{
    if(d.version && __version===0) __version=d.version;
    if(d.version && d.version!==__version){ console.log('[auto-reload] v'+__version+'→v'+d.version); location.reload(); }
  }).catch(()=>{});
}, 2000);
</script>`);
          body = body.replace(/(src|href)=["']\/((?!(?:webapp|cdn|http|\/\/))[^"']*)["']/g,
            (m, attr, path) => `${attr}="${basePath}/${path}"`);
        }
        if (isCss) {
          body = body.replace(/url\(["']?\/((?!webapp\/|cdn|http)[^"')]+)["']?\)/g,
            (m, path) => `url("${basePath}/${path}")`);
        }
        const headers = { ...proxyRes.headers };
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    } else {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });
  proxyReq.on('error', () => { res.writeHead(502); res.end('Flutter not ready'); });
  if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq);
  else proxyReq.end();
});

proxyServer.listen(PREVIEW_PORT, () => {
  console.log(`[fl-server] Flutter proxy listening on port ${PREVIEW_PORT} → ${FLUTTER_INTERNAL_PORT}`);
});

// ── WebSocket upgrade proxying (for Flutter HMR live reload at /ws) ──
proxyServer.on('upgrade', (req, socket, head) => {
  // Strip basePath prefix — Flutter dev server expects bare paths like /ws
  let wsPath = req.url;
  if (wsPath.startsWith(basePath)) wsPath = wsPath.slice(basePath.length) || '/';
  console.log(`[fl-server] WebSocket upgrade: ${req.url} → ${wsPath}`);

  const options = {
    hostname: 'localhost', port: FLUTTER_INTERNAL_PORT,
    path: wsPath, method: 'GET',
    headers: { ...req.headers, connection: 'Upgrade', upgrade: req.headers.upgrade },
  };
  const wsProxy = http.request(options);
  wsProxy.on('upgrade', (proxyRes, proxySocket) => {
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      `Upgrade: ${proxyRes.headers.upgrade || 'websocket'}`,
      `Connection: ${proxyRes.headers.connection || 'Upgrade'}`,
    ];
    if (proxyRes.headers['sec-websocket-accept']) {
      headers.push(`Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept']}`);
    }
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  wsProxy.on('error', (e) => { console.error('[fl-server] WS proxy error:', e.message); socket.destroy(); });
  wsProxy.end();
});
