import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { collectSystemSnapshot } from './lib/collector.mjs';
import { SpikeAttributionEngine } from './lib/attribution.mjs';
import { AlertManager } from './lib/alerts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT || 3888;
const HOST = '127.0.0.1';

const attributionEngine = new SpikeAttributionEngine(60);
const alertManager = new AlertManager();

let currentSnapshot = null;
let currentAnalysis = null;
let clients = new Set();

/**
 * MIME type resolver
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.webmanifest': return 'application/manifest+json';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    default: return 'text/plain; charset=utf-8';
  }
}

/**
 * Periodically gather telemetry and broadcast to SSE clients
 */
async function startMonitoringLoop() {
  // Initial priming
  try {
    currentSnapshot = await collectSystemSnapshot();
    currentAnalysis = attributionEngine.analyze(currentSnapshot);
  } catch (err) {
    console.error('Initial snapshot error:', err);
  }

  setInterval(async () => {
    try {
      currentSnapshot = await collectSystemSnapshot();
      currentAnalysis = attributionEngine.analyze(currentSnapshot);
      const { newAlert, persistence } = alertManager.processAnalysis(currentAnalysis, currentSnapshot);

      if (clients.size > 0) {
        const payload = JSON.stringify({
          snapshot: currentSnapshot,
          analysis: currentAnalysis,
          persistence,
          newAlert,
          settings: alertManager.getSettings()
        });
        const msg = `data: ${payload}\n\n`;
        for (const client of clients) {
          client.write(msg);
        }
      }
    } catch (err) {
      console.error('Monitoring loop error:', err);
    }
  }, 1000);
}

/**
 * HTTP Server Handler
 */
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS headers for local versatility
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Stream
  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');

    clients.add(res);

    if (currentSnapshot && currentAnalysis) {
      const { persistence } = alertManager.processAnalysis(currentAnalysis, currentSnapshot);
      const initialPayload = JSON.stringify({
        snapshot: currentSnapshot,
        analysis: currentAnalysis,
        persistence,
        history: alertManager.getAlertHistory(),
        settings: alertManager.getSettings()
      });
      res.write(`data: ${initialPayload}\n\n`);
    }

    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  // REST API: Current status
  if (pathname === '/api/status' && req.method === 'GET') {
    const { persistence } = alertManager.processAnalysis(currentAnalysis, currentSnapshot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      snapshot: currentSnapshot,
      analysis: currentAnalysis,
      persistence,
      settings: alertManager.getSettings()
    }));
    return;
  }

  // REST API: Alerts history
  if (pathname === '/api/alerts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(alertManager.getAlertHistory()));
    return;
  }

  // REST API: Dismiss active alert and reset time calculations
  if (pathname === '/api/alerts/dismiss' && req.method === 'POST') {
    const resPayload = alertManager.dismissAlert();
    const { persistence } = alertManager.processAnalysis(currentAnalysis, currentSnapshot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...resPayload, persistence }));
    return;
  }

  // REST API: Settings GET & POST
  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(alertManager.getSettings()));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const updated = alertManager.updateSettings(parsed);
          attributionEngine.setThresholds(updated.tempWarning, updated.tempCritical);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, settings: updated }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }
  }

  // REST API: Kill process
  if (pathname === '/api/kill' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { pid, force } = JSON.parse(body);
        const numPid = parseInt(pid, 10);
        if (!numPid || numPid <= 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or protected PID' }));
          return;
        }

        const signal = force ? 'SIGKILL' : 'SIGTERM';
        process.kill(numPid, signal);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Signal ${signal} sent to PID ${numPid}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static files
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    res.end(data);
  });
});

/**
 * Launch Server
 */
export function startServer(port = PORT, openBrowser = false) {
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`\n======================================================`);
    console.log(`🚀 PulseMac PWA Dashboard running at: ${url}`);
    console.log(`   - Real-time CPU, GPU, NPU & Thermal Telemetry`);
    console.log(`   - Foreground vs Background Culprit Attribution`);
    console.log(`   - Installable PWA: Click 'Install App' or 'Add to Dock'`);
    console.log(`   - Press Ctrl+C to stop`);
    console.log(`======================================================\n`);

    if (openBrowser || process.argv.includes('--open')) {
      exec(`open "${url}"`);
    }
  });

  startMonitoringLoop();
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer(PORT);
}
