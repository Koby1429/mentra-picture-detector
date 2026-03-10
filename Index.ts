import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import sharp from 'sharp';

dotenv.config();

const activeSessions = new Map<string, AppSession>();
let isScanning = false;

class FaceAnalyzerApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();
    app.use(express.json());

    app.get('/health', (_req, res) => res.status(200).send('OK - Face Search running!'));

    // ─── Webview ─────────────────────────────────────────────────────────────
    app.get('/webview', (_req, res) => {
      res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Face Search</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; text-align: center; padding: 16px; background: #1a1a2e; color: #eee; }
    h1 { color: #4CAF50; font-size: 24px; margin-bottom: 6px; }
    #connStatus { font-size: 13px; margin: 6px 0 10px; }
    #feedback { min-height: 18px; font-size: 13px; color: #aaa; margin: 8px 0; }
    #progressBar { width: 100%; max-width: 320px; margin: 6px auto; display: none; background: #333; border-radius: 6px; overflow: hidden; height: 10px; }
    #progressFill { height: 100%; background: #4CAF50; width: 0%; transition: width 0.3s; }
    #btnScan { width: 100%; max-width: 320px; padding: 18px; margin: 10px auto; display: block;
      background: #4CAF50; color: white; border: none; border-radius: 10px;
      cursor: pointer; font-size: 18px; font-weight: bold; }
    #btnScan:disabled { background: #555; cursor: not-allowed; }
    .results { max-width: 360px; margin: 14px auto; text-align: left; }
    .result-card { background: #16213e; border-radius: 10px; padding: 14px; margin: 10px 0; overflow: hidden; }
    .result-title { color: #4CAF50; font-weight: bold; font-size: 15px; margin-bottom: 8px; }
    .row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #2a2a4a; font-size: 13px; }
    .row:last-child { border-bottom: none; }
    .lbl { color: #aaa; min-width: 50px; }
    .val { color: #eee; font-weight: bold; text-align: right; word-break: break-all; }
    .val a { color: #4CAF50; text-decoration: none; }
    .score-bar { height: 6px; border-radius: 3px; background: #4CAF50; margin: 4px 0 8px; }
    .thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; float: right; margin-left: 10px; }
    .no-results { color: #aaa; font-size: 14px; padding: 20px; }
  </style>
</head>
<body>
  <h1>🔍 Face Search</h1>
  <p id="connStatus">Checking...</p>
  <p id="feedback">Press Scan to search the web by face</p>
  <div id="progressBar"><div id="progressFill"></div></div>
  <button id="btnScan" onclick="doScan()">📷 Scan &amp; Search</button>
  <div class="results" id="results"></div>
  <script>
    async function checkConn() {
      try {
        const d = await fetch('/session-status').then(r => r.json());
        const el = document.getElementById('connStatus');
        el.textContent = d.connected ? '🟢 Glasses Connected' : '🔴 Glasses Disconnected';
        el.style.color = d.connected ? '#4CAF50' : '#e53935';
      } catch(e) {}
    }

    async function doScan() {
      const btn = document.getElementById('btnScan');
      const fb = document.getElementById('feedback');
      const bar = document.getElementById('progressBar');
      const fill = document.getElementById('progressFill');
      btn.disabled = true;
      btn.textContent = '⏳ Scanning...';
      fb.textContent = 'Capturing photo...';
      bar.style.display = 'block';
      fill.style.width = '5%';
      document.getElementById('results').innerHTML = '';

      try {
        fb.textContent = 'Searching the web by face... (may take ~30s)';
        fill.style.width = '20%';

        const resp = await fetch('/action/scan', { method: 'POST' });
        const d = await resp.json();

        fill.style.width = '100%';
        setTimeout(() => { bar.style.display = 'none'; fill.style.width = '0%'; }, 600);

        if (d.error) {
          fb.textContent = 'Error: ' + d.error;
        } else if (!d.results || d.results.length === 0) {
          fb.textContent = 'No matches found';
          document.getElementById('results').innerHTML = '<p class="no-results">No matching faces found on the web.</p>';
        } else {
          fb.textContent = d.results.length + ' match' + (d.results.length > 1 ? 'es' : '') + ' found';
          renderResults(d.results);
        }
      } catch(e) {
        fb.textContent = 'Request failed — try again';
        bar.style.display = 'none';
      }

      btn.disabled = false;
      btn.textContent = '📷 Scan & Search';
    }

    function renderResults(results) {
      const c = document.getElementById('results');
      c.innerHTML = '';
      results.forEach((r, i) => {
        const thumb = r.base64
          ? '<img class="thumb" src="data:image/jpeg;base64,' + r.base64 + '" />'
          : '';
        c.innerHTML +=
          '<div class="result-card">' +
            thumb +
            '<div class="result-title">Match #' + (i + 1) + '</div>' +
            '<div class="row"><span class="lbl">Score</span><span class="val">' + r.score + ' / 100</span></div>' +
            '<div class="score-bar" style="width:' + r.score + '%"></div>' +
            '<div class="row"><span class="lbl">URL</span><span class="val"><a href="' + r.url + '" target="_blank">View page ↗</a></span></div>' +
          '</div>';
      });
    }

    setInterval(checkConn, 3000);
    checkConn();
  </script>
</body>
</html>`);
    });

    // ─── Session Status ───────────────────────────────────────────────────────
    app.get('/session-status', (_req, res) => {
      res.json({ connected: activeSessions.size > 0 });
    });

    // ─── Scan Endpoint ────────────────────────────────────────────────────────
    app.post('/action/scan', async (_req, res) => {
      const session = Array.from(activeSessions.values())[0];
      if (!session) return res.status(503).json({ error: 'Glasses not connected' });
      if (isScanning) return res.status(429).json({ error: 'Scan already in progress' });

      isScanning = true;
      console.log('[SCAN] Starting...');

      try {
        const photo = await Promise.race([
          (session.camera as any).requestPhoto(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Photo timeout 15s')), 15000))
        ]);

        const imageBase64 = this.extractBase64(photo);
        if (!imageBase64) {
          isScanning = false;
          return res.status(500).json({ error: 'Could not read photo data' });
        }

        console.log('[SCAN] Photo captured, searching FaceCheck.ID...');

        const results = await this.searchFace(imageBase64);
        console.log(`[SCAN] ${results.length} match(es) found`);

        if (results.length === 0) {
          await this.safeSpeak(session, 'No matching faces found on the web.');
        } else {
          await this.safeSpeak(session, `Found ${results.length} match${results.length > 1 ? 'es' : ''}. Check the app for details.`);
        }

        isScanning = false;
        return res.json({ results });

      } catch (err: any) {
        console.error('[SCAN] Error:', err.message);
        isScanning = false;
        await this.safeSpeak(session, 'Scan failed. Please retry.').catch(() => {});
        return res.status(500).json({ error: err.message });
      }
    });
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Started: ${sessionId}`);
    activeSessions.set(sessionId, session);

    await new Promise(r => setTimeout(r, 2000));
    if (!activeSessions.has(sessionId)) return;

    await this.safeSpeak(session, 'Face search ready. Press scan in the app.');

    const cleanup = () => {
      activeSessions.delete(sessionId);
      console.log(`[SESSION] Ended: ${sessionId}`);
    };

    if (typeof (session as any).onEnd === 'function') {
      (session as any).onEnd(cleanup);
    } else {
      this.addCleanupHandler(cleanup);
    }
  }

  // ─── FaceCheck.ID API ────────────────────────────────────────────────────────

  private async searchFace(imageBase64: string): Promise<any[]> {
    const apiToken = process.env.FACECHECK_API_TOKEN;
    if (!apiToken) throw new Error('FACECHECK_API_TOKEN not set');

    const site = 'https://facecheck.id';
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'Authorization': apiToken,
    };

    // Step 1: Upload image
    console.log('[FACECHECK] Enhancing image...');
    const rawBuffer = Buffer.from(imageBase64, 'base64');

    // Upscale to at least 640px wide, sharpen, and boost contrast for better face detection
    const enhancedBuffer = await sharp(rawBuffer)
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: false })
      .sharpen({ sigma: 1.5 })
      .normalise()
      .jpeg({ quality: 92 })
      .toBuffer();

    console.log('[FACECHECK] Enhanced image size:', enhancedBuffer.length, 'bytes');

    const blob = new Blob([enhancedBuffer], { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('images', blob, 'photo.jpg');
    formData.append('id_search', '');

    const uploadResp = await fetch(`${site}/api/upload_pic`, {
      method: 'POST',
      headers,
      body: formData,
    });

    const uploadData = await uploadResp.json();
    if (uploadData.error) throw new Error(`FaceCheck upload error: ${uploadData.error} (${uploadData.code})`);

    const id_search = uploadData.id_search;
    console.log('[FACECHECK] Uploaded, id_search:', id_search);

    // Step 2: Poll for results (up to 60s)
    const demo = false; // set true to test without spending credits
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      const searchResp = await fetch(`${site}/api/search`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_search,
          with_progress: true,
          status_only: false,
          demo,
        }),
      });

      const searchData = await searchResp.json();
      if (searchData.error) throw new Error(`FaceCheck search error: ${searchData.error}`);

      console.log(`[FACECHECK] Progress: ${searchData.progress ?? 0}%`);

      if (searchData.output?.items) {
        return searchData.output.items.map((item: any) => ({
          score: item.score,
          url: item.url,
          base64: item.base64 ?? null,
        }));
      }
    }

    throw new Error('FaceCheck search timed out after 60 seconds');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private extractBase64(photo: any): string | null {
    if (!photo) return null;
    if (Buffer.isBuffer(photo) || photo instanceof Uint8Array) return Buffer.from(photo).toString('base64');
    if (typeof photo === 'string') return photo.startsWith('data:') ? photo.split(',')[1] : photo;
    for (const k of ['buffer', 'jpegData', 'data', 'bytes', 'base64', 'photoData', 'image']) {
      const val = photo[k];
      if (!val) continue;
      if (Buffer.isBuffer(val) || val instanceof Uint8Array) return Buffer.from(val).toString('base64');
      if (typeof val === 'string') return val.startsWith('data:') ? val.split(',')[1] : val;
    }
    return null;
  }

  private async safeSpeak(session: AppSession, msg: string): Promise<void> {
    try {
      await Promise.race([
        session.audio.speak(msg),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
    } catch (e: any) {
      console.warn('[SPEAK] Failed:', e.message);
    }
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 8080;

const server = new FaceAnalyzerApp({
  packageName: 'com.yakov.picture.detector',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0',
  requiredPermissions: ['camera'],
  webviewURL: 'https://mentra-picture-detector-production.up.railway.app/webview',
});

server.start()
  .then(() => console.log(`✅ Face Search running on port ${port}`))
  .catch(err => { console.error('❌ Failed to start:', err); process.exit(1); });ב
