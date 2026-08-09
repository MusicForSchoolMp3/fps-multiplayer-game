// ════════════════════════════════════════════════════════════════════════════
//  server/migration-server.js
//
//  Ultra-lightweight "THE GAME HAS MOVED" server for the OLD Render deployment
//  ONLY. Deliberately built with nothing but Node's built-in http module:
//  no Express, no Socket.IO, no MongoDB, no game code, no static asset tree.
//
//  ----------------------------------------------------------------------------
//  HOW IT IS ACTIVATED
//  ----------------------------------------------------------------------------
//  When Render runs with RENDER_MIGRATION_MODE=true, server/index.js and
//  server/test-server.js `await import('./migration-server.js')` FIRST. This
//  module starts its own tiny HTTP listener and then never finishes evaluating
//  (see the never-resolving await at the bottom). Because the import never
//  resolves, the calling entry point never proceeds past the import — so the
//  real game server, the Mongo connection, Socket.IO and every game system
//  below it can never start in migration mode.
//
//  The production VM does NOT set RENDER_MIGRATION_MODE, so it never imports
//  this file and runs the full game exactly as before.
// ════════════════════════════════════════════════════════════════════════════

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// The migration page lives at the repository root. It is a completely static,
// self-contained HTML file (inline CSS, zero JavaScript, zero asset requests).
const PAGE_FILE = join(ROOT, 'migration.html');

// New game server. Defaults to the published VM address; can be overridden via
// RENDER_MIGRATION_URL without touching source code if the address ever
// changes. The same address is baked into migration.html.
const NEW_SERVER_URL = process.env.RENDER_MIGRATION_URL || 'http://202.128.119.42:3001/';

let pageHtml = null;

if (existsSync(PAGE_FILE)) {
  pageHtml = readFileSync(PAGE_FILE, 'utf8');
} else {
  // Absolute last-resort fallback: an inline copy of the notice so the page
  // still renders even if migration.html is missing from the checkout.
  pageHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Game Server Moved</title>
<style>body{background:#020408;color:#fff;font-family:'Segoe UI',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{max-width:440px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:40px 36px;text-align:center}
h1{font-size:26px;letter-spacing:6px;color:#ff8844;margin:0 0 20px}
p{font-size:14px;line-height:1.7;color:rgba(255,255,255,.8);margin:0 0 10px}
a.btn{display:inline-block;margin:18px 0 22px;padding:14px 30px;border-radius:10px;background:linear-gradient(135deg,#ff4444,#ff7722);color:#fff;font-weight:700;letter-spacing:2px;text-decoration:none}
code{display:inline-block;font-size:13px;color:#ff8844;padding:6px 12px;border:1px solid rgba(255,136,68,.3);border-radius:8px}</style>
</head><body><div class="card">
<h1>THE GAME HAS MOVED!</h1>
<p>The FPS game has moved to a new server.</p>
<p>Render is no longer being used to host the game.</p>
<p>Click the button below to continue playing.</p>
<a class="btn" href="${NEW_SERVER_URL}">PLAY ON THE NEW SERVER</a>
<p>New server:</p>
<code>${NEW_SERVER_URL}</code>
</div></body></html>`;
}

// If an override URL is configured, reflect it in the served page too.
if (pageHtml && process.env.RENDER_MIGRATION_URL) {
  pageHtml = pageHtml.split('http://202.128.119.42:3001/').join(NEW_SERVER_URL);
}

const server = createServer((req, res) => {
  const method = req.method || 'GET';
  const pathname = (req.url || '/').split('?')[0];

  // Keep a minimal health endpoint (Render/uptime checks).
  if (method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', migration: true, uri: NEW_SERVER_URL }));
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  // Every page load from the old Render URL shows the migration notice,
  // regardless of the path a returning player had bookmarked.
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(method === 'HEAD' ? undefined : pageHtml);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[Migration] FATAL: port ' + PORT + ' is already in use.');
  } else {
    console.error('[Migration] FATAL: server error:', err.code || err.message || err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('------------------------------------------------------------');
  console.log('  MIGRATION MODE (old Render deployment)');
  console.log('  The game has moved. This server only shows the');
  console.log('  "THE GAME HAS MOVED!" notice pointing to:');
  console.log('  ' + NEW_SERVER_URL);
  console.log('  No game server, Socket.IO, MongoDB or game code loaded.');
  console.log('  Listening on http://' + HOST + ':' + PORT);
  console.log('------------------------------------------------------------');
});

// Never resolve: block the calling entry point (server/index.js or
// server/test-server.js) from starting any game systems in migration mode,
// while the HTTP listener above keeps this process alive.
await new Promise(() => {});