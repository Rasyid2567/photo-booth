/**
 * 📸 Photo Booth Perpisahan - Laptop Server
 *
 * Cara pakai:
 * 1. npm install express ws node-fetch
 * 2. node server.js
 * 3. Buka http://localhost:3000 di laptop
 * 4. Tablet buka URL yang muncul di terminal
 */

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const os      = require('os');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store ───────────────────────────────────────────────
const photos = [];            // { id, dataUrl, filename, category, uploadedToDrive, driveFileId, thumbnailLink }
const categoryCounters = {};  // { 'Kelas A': 3, 'Kelas B': 1 }
const serverInstanceId = Date.now().toString();
let globalAccessToken = null;

function incrementCategoryCounter(cat) {
  categoryCounters[cat] = (categoryCounters[cat] || 0) + 1;
  return categoryCounters[cat];
}

// ── WebSocket ─────────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.send(JSON.stringify({
    type: 'init',
    serverInstanceId,
    photos: photos.map(p => ({
      id: p.id,
      filename: p.filename,
      category: p.category,
      uploadedToDrive: p.uploadedToDrive
    }))
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'frame') {
        // Forward frame ke semua client kecuali pengirim
        const json = JSON.stringify({ type: 'frame', data: msg.data });
        clients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN) c.send(json);
        });
        return;
      }

      broadcast(msg);
      console.log(`[WS] ${msg.type}`);
    } catch (e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const json = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(json); });
}

// ── API: Simpan foto ──────────────────────────────────────────────
app.post('/api/photo', async (req, res) => {
  const { dataUrl, accessToken, mainFolder, category } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'No photo data' });
  if (accessToken) globalAccessToken = accessToken;

  const cat      = category || 'Umum';
  const id       = Date.now();
  const num      = incrementCategoryCounter(cat);
  const filename = `foto ${num}.jpg`;
  const photo    = { id, dataUrl, filename, category: cat, uploadedToDrive: false, driveFileId: null };

  photos.unshift(photo);
  if (photos.length > 200) photos.splice(200);

  broadcast({ type: 'new_photo', id, filename, category: cat, uploadedToDrive: false });
  res.json({ success: true, id, filename, categoryCount: categoryCounters[cat] });

  if (accessToken) {
    uploadToDrive(photo, accessToken, mainFolder || 'Photo Booth Perpisahan', cat)
      .then(fileId => {
        photo.uploadedToDrive = true;
        photo.driveFileId = fileId;
        broadcast({ type: 'photo_uploaded', id, fileId, filename: photo.filename });
      })
      .catch(e => {
        console.error('Drive upload error:', e.message);
        broadcast({ type: 'photo_upload_error', id, error: e.message });
      });
  }
});

// ── API: Download foto ────────────────────────────────────────────
app.get('/api/photo/:id', async (req, res) => {
  const photo = photos.find(p => p.id == req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  
  if (!photo.dataUrl && photo.driveFileId) {
    if (!globalAccessToken) return res.status(401).json({ error: 'No access token on server' });
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${photo.driveFileId}?alt=media`, {
        headers: { Authorization: `Bearer ${globalAccessToken}` }
      });
      if (!response.ok) throw new Error('Drive fetch failed');
      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Disposition', `attachment; filename="${photo.filename}"`);
      response.body.pipe(res);
      return;
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const buf = Buffer.from(photo.dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Content-Disposition', `attachment; filename="${photo.filename}"`);
  res.send(buf);
});

// ── API: Daftar foto (filter opsional by category) ────────────────
app.get('/api/photos', (req, res) => {
  const cat  = req.query.category;
  const list = cat ? photos.filter(p => p.category === cat) : photos;
  res.json(list.map(p => ({
    id: p.id,
    filename: p.filename,
    category: p.category,
    uploadedToDrive: p.uploadedToDrive,
    driveFileId: p.driveFileId,
    thumbnailLink: p.thumbnailLink
  })));
});

// ── API: Counter per kategori ─────────────────────────────────────
app.get('/api/category-count', (req, res) => {
  const cat = req.query.category;
  res.json({ count: categoryCounters[cat] || 0 });
});

// ── API: Thumbnail ────────────────────────────────────────────────
app.get('/api/photo/:id/thumb', (req, res) => {
  const photo = photos.find(p => p.id == req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  if (photo.thumbnailLink) {
    return res.json({ dataUrl: photo.thumbnailLink });
  }
  res.json({ dataUrl: photo.dataUrl });
});

// ── API: Hapus foto ───────────────────────────────────────────────
app.delete('/api/photo/:id', async (req, res) => {
  const index = photos.findIndex(p => p.id == req.params.id);
  if (index !== -1) {
    const photo = photos[index];
    photos.splice(index, 1);
    broadcast({ type: 'photo_deleted', id: req.params.id, filename: photo.filename });
    
    // Hapus dari Google Drive jika ada
    if (photo.driveFileId && globalAccessToken) {
      try {
        const fetch = (await import('node-fetch')).default;
        await fetch(`https://www.googleapis.com/drive/v3/files/${photo.driveFileId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${globalAccessToken}` }
        });
        console.log(`🗑️ Deleted from Drive: ${photo.filename}`);
      } catch (e) {
        console.error('Failed to delete from Drive:', e.message);
      }
    }
    
    // Reset counter jika sudah tidak ada foto sama sekali di kategori ini (opsional, untuk kenyamanan user)
    const remainingInCategory = photos.some(p => p.category === photo.category);
    if (!remainingInCategory) {
      categoryCounters[photo.category] = 0;
      console.log(`[Counter] Reset ${photo.category} to 0 because gallery is empty`);
    }

    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── API: Sync counter dari Drive ──────────────────────────────────
// Dipanggil setelah login Google supaya nomor foto lanjut dari Drive
app.post('/api/sync-counter', async (req, res) => {
  const { accessToken, mainFolder, category } = req.body;
  if (!accessToken) return res.json({ error: 'No token' });
  globalAccessToken = accessToken;

  const cat = category || 'Umum';

  try {
    const fetch = (await import('node-fetch')).default;

    // Cari main folder
    const mainQuery = `name='${mainFolder.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    let r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(mainQuery)}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    let d = await r.json();
    if (!d.files || d.files.length === 0) return res.json({ counter: categoryCounters[cat] || 0 });
    const mainFolderId = d.files[0].id;

    // Cari subfolder kategori
    const subQuery = `name='${cat.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${mainFolderId}' in parents and trashed=false`;
    r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(subQuery)}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    d = await r.json();
    if (!d.files || d.files.length === 0) return res.json({ counter: categoryCounters[cat] || 0 });
    const subFolderId = d.files[0].id;

    // Hitung file terbanyak di subfolder
    const fileQuery = `'${subFolderId}' in parents and mimeType='image/jpeg' and trashed=false`;
    r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(fileQuery)}&fields=files(id,name,thumbnailLink)&pageSize=1000`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    d = await r.json();

    let maxNum = 0;
    let addedNewPhotos = false;
    
    if (d.files) {
      d.files.forEach(f => {
        const match = f.name.match(/foto\s*(\d+)\.jpg/i);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxNum) maxNum = n;
        }
        
        // Add to photos array if not exists
        const existing = photos.find(p => p.driveFileId === f.id || (p.filename === f.name && p.category === cat));
        if (!existing) {
          photos.push({
            id: f.id,
            filename: f.name,
            category: cat,
            uploadedToDrive: true,
            driveFileId: f.id,
            thumbnailLink: f.thumbnailLink
          });
          addedNewPhotos = true;
        }
      });
    }

    // Update counter berdasarkan apa yang ada di Drive secara mutlak
    // Jika Drive kosong, maxNum akan 0, sehingga counter kembali ke awal
    categoryCounters[cat] = maxNum;
    
    if (addedNewPhotos) {
      // Sort descending
      photos.sort((a, b) => {
        const matchA = a.filename.match(/foto\s*(\d+)/i);
        const matchB = b.filename.match(/foto\s*(\d+)/i);
        const numA = matchA ? parseInt(matchA[1], 10) : 0;
        const numB = matchB ? parseInt(matchB[1], 10) : 0;
        return numB - numA; // higher number first
      });
      broadcast({ type: 'sync_photos_done' });
    }

    console.log(`[Sync] Kategori "${cat}" counter: ${categoryCounters[cat]}`);
    res.json({ counter: categoryCounters[cat] });
  } catch (e) {
    console.error('Sync error:', e.message);
    res.json({ error: e.message, counter: categoryCounters[cat] || 0 });
  }
});

// ── Google Drive: Upload ──────────────────────────────────────────
async function uploadToDrive(photo, accessToken, mainFolderName, subFolderName) {
  const fetch = (await import('node-fetch')).default;

  const mainFolderId = await getOrCreateFolder(fetch, accessToken, mainFolderName);
  const folderId     = await getOrCreateFolder(fetch, accessToken, subFolderName, mainFolderId);

  const imageBuffer = Buffer.from(
    photo.dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'
  );
  const metadata = JSON.stringify({
    name: photo.filename,
    mimeType: 'image/jpeg',
    parents: [folderId]
  });

  const boundary   = '-------314159265358979323846';
  const delimiter  = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(
      delimiter + 'Content-Type: application/json\r\n\r\n' + metadata +
      delimiter + 'Content-Type: image/jpeg\r\n\r\n'
    ),
    imageBuffer,
    Buffer.from(closeDelim)
  ]);

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length
      },
      body
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.json();
    throw new Error(err.error?.message || 'Upload failed');
  }

  const data = await uploadRes.json();
  console.log(`✅ Uploaded: ${photo.filename} [${photo.category}] → ${data.id}`);
  return data.id;
}

// ── Google Drive: Get or Create Folder ───────────────────────────
async function getOrCreateFolder(fetch, accessToken, name, parentId = null) {
  let query = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;

  const searchRes  = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const searchData = await searchRes.json();
  if (searchData.files?.length > 0) return searchData.files[0].id;

  const createRes  = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : []
    })
  });
  const createData = await createRes.json();
  return createData.id;
}

// ── Serve Pages ───────────────────────────────────────────────────
app.get('/',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'laptop.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tablet.html')));

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter(n => n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  console.log('');
  console.log('╔═════════════════════════════════════════════════╗');
  console.log('║               📸  Photo Booth  📸               ║');
  console.log('╠═════════════════════════════════════════════════╣');
  console.log(`║  [Laptop] http://localhost:${PORT}                 ║`);
  console.log('╠═════════════════════════════════════════════════╣');
  if (ips.length === 0) {
    console.log('║  ⚠️  IP tidak terdeteksi, cek koneksi WiFi      ║');
  } else {
    ips.forEach(ip => {
      const url = `http://${ip}:${PORT}/remote`;
      console.log(`║  [Tablet] ${url.padEnd(38)}║`);
    });
  }
  console.log('╚═════════════════════════════════════════════════╝');
  console.log('');
});
