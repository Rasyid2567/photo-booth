/**
 * 📸 Photo Booth Perpisahan - Laptop Server
 * 
 * Cara pakai:
 * 1. npm install express ws node-fetch multer
 * 2. Isi GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di bawah
 * 3. node server.js
 * 4. Buka http://localhost:3000 di laptop (untuk live view kamera)
 * 5. Tablet buka URL yang muncul di terminal
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory photo store ──────────────────────────────────────────
const photos = []; // { id, dataUrl, filename, category, uploadedToDrive, driveFileId }
const categoryCounters = {}; // counter per kategori
const serverInstanceId = Date.now().toString();

function incrementCategoryCounter(cat) {
  categoryCounters[cat] = (categoryCounters[cat] || 0) + 1;
  return categoryCounters[cat];
}

// ── WebSocket broadcast ────────────────────────────────────────────
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send existing photos to new client
  ws.send(JSON.stringify({ type: 'init', serverInstanceId, photos: photos.map(p => ({ id: p.id, filename: p.filename, category: p.category, uploadedToDrive: p.uploadedToDrive })) }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());



      // Rebroadcast everything to all clients
      broadcast(msg);
      console.log(`[WS] Message received: ${msg.type}`);
    } catch (e) {
      console.error('[WS] Error parsing message:', e.message);
    }
  });

  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const json = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(json); });
}

// ── Photo upload from laptop ───────────────────────────────────────
app.post('/api/photo', async (req, res) => {
  const { dataUrl, frame, clientId, accessToken, mainFolder, category } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'No photo data' });

  const id = Date.now();
  const cat = category || 'Umum';
  const num = incrementCategoryCounter(cat);
  const filename = `foto ${num}.jpg`;
  const photo = { id, dataUrl, filename, category: cat, uploadedToDrive: false, driveFileId: null };
  photos.unshift(photo);
  if (photos.length > 100) photos.splice(100);

  // Broadcast new photo (without dataUrl for performance)
  broadcast({ type: 'new_photo', id, filename, category: cat, uploadedToDrive: false });

  res.json({ success: true, id, filename });

  // Upload to Drive if token provided
  if (accessToken) {
    uploadToDrive(photo, accessToken, mainFolder || 'Photo Booth Perpisahan', category || 'Umum')
      .then(fileId => {
        photo.uploadedToDrive = true;
        photo.driveFileId = fileId;
        broadcast({ type: 'photo_uploaded', id, fileId });
      })
      .catch(e => {
        console.error('Drive upload error:', e.message);
        broadcast({ type: 'photo_upload_error', id, error: e.message });
      });
  }
});

// ── Get photo by ID (for download) ────────────────────────────────
app.get('/api/photo/:id', (req, res) => {
  const photo = photos.find(p => p.id == req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });

  const base64 = photo.dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Content-Disposition', `attachment; filename="${photo.filename}"`);
  res.send(buf);
});

// ── Get photo list (optional filter by category) ─────────────────
app.get('/api/photos', (req, res) => {
  const cat = req.query.category;
  const list = cat ? photos.filter(p => p.category === cat) : photos;
  res.json(list.map(p => ({ id: p.id, filename: p.filename, category: p.category, uploadedToDrive: p.uploadedToDrive, driveFileId: p.driveFileId })));
});

// ── Get photo thumbnail (base64) ──────────────────────────────────
app.get('/api/photo/:id/thumb', (req, res) => {
  const photo = photos.find(p => p.id == req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  res.json({ dataUrl: photo.dataUrl });
});

// ── Delete photo ──────────────────────────────────────────────────
app.delete('/api/photo/:id', (req, res) => {
  const id = req.params.id;
  const index = photos.findIndex(p => p.id == id);
  if (index !== -1) {
    photos.splice(index, 1);
    broadcast({ type: 'photo_deleted', id });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── Sync Counter with Drive ───────────────────────────────────────
app.post('/api/sync-counter', async (req, res) => {
  const { accessToken, mainFolder, category } = req.body;
  if (!accessToken) return res.json({ error: 'No token' });

  try {
    const fetch = (await import('node-fetch')).default;
    
    // Find main folder
    let query = `name='${mainFolder.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    let resDrive = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`, { headers: { Authorization: `Bearer ${accessToken}` } });
    let data = await resDrive.json();
    
    if (!data.files || data.files.length === 0) return res.json({ counter: photoCounter });
    const mainFolderId = data.files[0].id;

    // Find subfolder
    const subQuery = `name='${category.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${mainFolderId}' in parents and trashed=false`;
    resDrive = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(subQuery)}&fields=files(id)`, { headers: { Authorization: `Bearer ${accessToken}` } });
    data = await resDrive.json();

    if (!data.files || data.files.length === 0) return res.json({ counter: photoCounter });
    const subFolderId = data.files[0].id;

    // Get files
    const fileQuery = `'${subFolderId}' in parents and mimeType='image/jpeg' and trashed=false`;
    resDrive = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(fileQuery)}&fields=files(name)&pageSize=1000`, { headers: { Authorization: `Bearer ${accessToken}` } });
    data = await resDrive.json();

    let maxCounter = 0;
    if (data.files) {
      data.files.forEach(f => {
        const match = f.name.match(/foto\s*(\d+)\.jpg/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxCounter) maxCounter = num;
        }
      });
    }

    if (maxCounter > (categoryCounters[category] || 0)) {
      categoryCounters[category] = maxCounter;
    }

    res.json({ counter: categoryCounters[category] || 0 });
  } catch (e) {
    console.error('Sync error:', e.message);
    res.json({ error: e.message });
  }
});

// ── Google Drive upload ───────────────────────────────────────────
async function uploadToDrive(photo, accessToken, mainFolderName, subFolderName) {
  const fetch = (await import('node-fetch')).default;

  const mainFolderId = await getOrCreateFolder(fetch, accessToken, mainFolderName);
  const folderId = await getOrCreateFolder(fetch, accessToken, subFolderName, mainFolderId);

  const base64 = photo.dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(base64, 'base64');

  const metadata = JSON.stringify({
    name: photo.filename,
    mimeType: 'image/jpeg',
    parents: [folderId]
  });

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(delimiter + 'Content-Type: application/json\r\n\r\n' + metadata + delimiter + 'Content-Type: image/jpeg\r\n\r\n'),
    imageBuffer,
    Buffer.from(closeDelim)
  ]);

  const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': body.length
    },
    body
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.json();
    throw new Error(err.error?.message || 'Upload failed');
  }

  const data = await uploadRes.json();
  console.log(`✅ Uploaded: ${photo.filename} → Drive ID: ${data.id}`);
  return data.id;
}

async function getOrCreateFolder(fetch, accessToken, name, parentId = null) {
  let query = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;

  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const searchData = await searchRes.json();
  if (searchData.files?.length > 0) return searchData.files[0].id;

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
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

// ── Serve HTML pages ──────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'laptop.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tablet.html')));

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  // Deteksi semua IP lokal
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter(n => n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  console.log('');
  console.log('╔═════════════════════════════════════════════════╗');
  console.log('║               📸  Photo Booth  📸               ║');
  console.log('╠═════════════════════════════════════════════════╣');
  console.log(`║  💻 Laptop → http://localhost:${PORT}              ║`);
  console.log('╠═════════════════════════════════════════════════╣');
  ips.forEach(ip => {
    const url = `http://${ip}:${PORT}/remote`;
    const line = `║  📱 Tablet → ${url}`;
    const pad = 46 - [...line].filter((_,i) => i > 0).length;
    console.log(line.padEnd(50) + '║');
  });
  console.log('╚═════════════════════════════════════════════════╝');
  console.log('');
});
