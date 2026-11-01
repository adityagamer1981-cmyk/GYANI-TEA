const fs = require('fs');
const path = require('path');

// Resolve path to site-content.json in project root
const CONTENT_FILE = path.resolve(__dirname, '..', 'site-content.json');

/**
 * Handles /api/content requests (GET, POST, OPTIONS)
 * Supports standard Node http (req, res) as well as serverless platforms (Vercel, etc.)
 */
function handleContent(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Pre-flight check
  if (req.method === 'OPTIONS') {
    if (res.writeHead) {
      res.writeHead(204);
    } else {
      res.statusCode = 204;
    }
    res.end();
    return;
  }

  // GET: Read and return site content
  if (req.method === 'GET') {
    fs.readFile(CONTENT_FILE, 'utf8', (err, data) => {
      if (err) {
        if (res.writeHead) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        } else {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
        }
        res.end(JSON.stringify({ error: 'Failed to read content file' }));
        return;
      }

      if (res.writeHead) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
      res.end(data);
    });
    return;
  }

  // POST: Update and save site content
  if (req.method === 'POST') {
    // If body has already been parsed by middleware/serverless framework
    if (req.body && typeof req.body === 'object') {
      try {
        fs.writeFile(CONTENT_FILE, JSON.stringify(req.body, null, 2), 'utf8', (err) => {
          if (err) {
            if (res.writeHead) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
            } else {
              res.statusCode = 500;
            }
            res.end(JSON.stringify({ error: 'Failed to write content file' }));
            return;
          }
          if (res.writeHead) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
          } else {
            res.statusCode = 200;
          }
          res.end(JSON.stringify({ success: true, message: 'Website content updated successfully!' }));
        });
      } catch (e) {
        if (res.writeHead) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
        } else {
          res.statusCode = 400;
        }
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
      return;
    }

    // Raw stream parsing for standard Node http server
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      // Safety limit: 5MB
      if (body.length > 5 * 1024 * 1024) {
        if (req.destroy) {
          req.destroy();
        } else if (req.connection && req.connection.destroy) {
          req.connection.destroy();
        }
      }
    });

    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        fs.writeFile(CONTENT_FILE, JSON.stringify(parsed, null, 2), 'utf8', (err) => {
          if (err) {
            if (res.writeHead) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
            } else {
              res.statusCode = 500;
            }
            res.end(JSON.stringify({ error: 'Failed to write content file' }));
            return;
          }
          if (res.writeHead) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
          } else {
            res.statusCode = 200;
          }
          res.end(JSON.stringify({ success: true, message: 'Website content updated successfully!' }));
        });
      } catch (e) {
        if (res.writeHead) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
        } else {
          res.statusCode = 400;
        }
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // Method not allowed
  if (res.writeHead) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
  } else {
    res.statusCode = 405;
  }
  res.end(JSON.stringify({ error: 'Method Not Allowed' }));
}

module.exports = handleContent;
