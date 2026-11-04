const http = require('http');
const fs = require('fs');
const path = require('path');
const handleContent = require('./api/content');

const PORT = 3000;
const ALT_PORT = 8080;
const ROOT = path.resolve(__dirname);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function handleRequest(req, res) {
  let reqUrl = decodeURI(req.url.split('?')[0]);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Endpoints (/api/content, /api/auth, etc.)
  if (reqUrl.startsWith('/api/')) {
    handleContent(req, res);
    return;
  }

  // Routing shortcuts
  if (reqUrl === '/' || reqUrl === '') {
    reqUrl = '/index.html';
  } else if (reqUrl === '/admin') {
    reqUrl = '/admin.html';
  }

  const safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*'
    };

    if (ext === '.png' || ext === '.jpg' || ext === '.webp') {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

function startServer(port) {
  const server = http.createServer(handleRequest);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, skipping...`);
    } else {
      console.error(`Server error on port ${port}:`, err);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`  - Local:   http://localhost:${port}`);
    console.log(`  - Admin:   http://localhost:${port}/admin`);
  });

  return server;
}

if (require.main === module) {
  console.log('\n  ▲ Gyani Tea Dev Server + Admin API');
  console.log('  -----------------------------------');
  startServer(PORT);
  startServer(ALT_PORT);
  console.log('  -----------------------------------\n');
}

module.exports = handleRequest;
