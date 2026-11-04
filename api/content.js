const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resolve path to bundled site-content.json in project root
const CONTENT_FILE = path.resolve(__dirname, '..', 'site-content.json');
const REDIS_KEY = 'gyani_site_content';

/**
 * Clean and normalize environment variable string
 */
function cleanEnv(val) {
  if (!val || typeof val !== 'string') return '';
  return val.trim().replace(/^["']|["']$/g, '');
}

/**
 * Resolve Upstash Redis / Vercel KV REST configuration from environment.
 * Supports official Upstash integration, Vercel KV, and Redis connection strings.
 */
function getUpstashConfig() {
  // 1. Direct standard names from Upstash integration or Vercel KV
  const candidateUrls = [
    process.env.UPSTASH_REDIS_REST_URL,
    process.env.KV_REST_API_URL,
    process.env.UPSTASH_REST_API_URL,
    process.env.REDIS_REST_API_URL,
    process.env.REDIS_REST_URL
  ];

  const candidateTokens = [
    process.env.UPSTASH_REDIS_REST_TOKEN,
    process.env.KV_REST_API_TOKEN,
    process.env.UPSTASH_REST_API_TOKEN,
    process.env.REDIS_REST_API_TOKEN,
    process.env.REDIS_REST_TOKEN
  ];

  let rawUrl = candidateUrls.find(u => u && cleanEnv(u).length > 0);
  let rawToken = candidateTokens.find(t => t && cleanEnv(t).length > 0);

  // 2. Scan process.env for prefixed or custom Upstash / KV variables
  if (!rawUrl || !rawToken) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      const upper = key.toUpperCase();
      if (!rawUrl && (
        (upper.includes('UPSTASH') || upper.includes('REDIS') || upper.includes('KV')) &&
        (upper.includes('REST_URL') || upper.includes('REST_API_URL') || (upper.includes('URL') && upper.includes('REST')))
      )) {
        rawUrl = value;
      }
      if (!rawToken && (
        (upper.includes('UPSTASH') || upper.includes('REDIS') || upper.includes('KV')) &&
        (upper.includes('REST_TOKEN') || upper.includes('REST_API_TOKEN') || (upper.includes('TOKEN') && !upper.includes('READ_ONLY')))
      )) {
        rawToken = value;
      }
    }
  }

  // 3. Fallback: Parse redis:// or rediss:// connection string if provided
  if (!rawUrl || !rawToken) {
    const connStrings = [
      process.env.UPSTASH_REDIS_URL,
      process.env.REDIS_URL,
      process.env.KV_URL
    ];
    for (const rawConn of connStrings) {
      const conn = cleanEnv(rawConn);
      if (conn && (conn.startsWith('redis://') || conn.startsWith('rediss://'))) {
        try {
          const parsed = new URL(conn);
          const host = parsed.hostname;
          const pass = parsed.password || parsed.username;
          if (host && pass) {
            rawUrl = `https://${host}`;
            rawToken = decodeURIComponent(pass);
            break;
          }
        } catch {
          // ignore parsing error
        }
      }
    }
  }

  if (rawUrl && rawToken) {
    let url = cleanEnv(rawUrl).replace(/\/$/, '');
    let token = cleanEnv(rawToken);
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    return { url, token };
  }

  return null;
}

/**
 * Optional JSONBin.io fallback configuration
 */
function getJsonBinConfig() {
  const binId = cleanEnv(process.env.JSONBIN_BIN_ID);
  const apiKey = cleanEnv(process.env.JSONBIN_API_KEY || process.env.JSONBIN_ACCESS_KEY);
  if (binId && apiKey) {
    return { binId, apiKey };
  }
  return null;
}

/**
 * Reads local bundled site-content.json (safe on Vercel and local)
 */
function readLocalDefault() {
  try {
    const raw = fs.readFileSync(CONTENT_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading local site-content.json:', err.message);
    return null;
  }
}

/**
 * Fetch data from Upstash Redis REST API
 */
async function fetchFromRedis(config) {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['GET', REDIS_KEY])
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstash Redis GET failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (!data || data.result === null || data.result === undefined) {
    return null; // Key does not exist yet in Redis
  }

  if (typeof data.result === 'string') {
    try {
      return JSON.parse(data.result);
    } catch {
      return data.result;
    }
  }
  return data.result;
}

/**
 * Save data to Upstash Redis REST API
 */
async function saveToRedis(config, contentObj) {
  const jsonString = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj);
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['SET', REDIS_KEY, jsonString])
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstash Redis SET failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Upstash Redis error: ${data.error}`);
  }
  return true;
}

/**
 * Fetch from JSONBin.io fallback
 */
async function fetchFromJsonBin(jsonbin) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${jsonbin.binId}/latest`, {
    headers: {
      'X-Master-Key': jsonbin.apiKey
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.record || null;
}

/**
 * Save to JSONBin.io fallback
 */
async function saveToJsonBin(jsonbin, contentObj) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${jsonbin.binId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': jsonbin.apiKey
    },
    body: JSON.stringify(contentObj)
  });
  if (!res.ok) {
    throw new Error(`JSONBin PUT failed with status ${res.status}`);
  }
  return true;
}

/* ==========================================================================
   AUTHENTICATION, SESSION TOKEN & BRUTE-FORCE SECURITY
   ========================================================================== */

/**
 * Checks if running in Vercel or Production environment
 */
function isProduction() {
  return Boolean(
    process.env.VERCEL ||
    process.env.VERCEL_ENV === 'production' ||
    process.env.NODE_ENV === 'production'
  );
}

/**
 * Resolves admin password from Vercel / local environment.
 * CRITICAL: In Vercel / Production, default 'admin123' is NEVER allowed.
 * If ADMIN_PASSWORD is not set in production, this returns null so all logins fail securely.
 */
function getAdminPassword() {
  const configured = cleanEnv(process.env.ADMIN_PASSWORD);
  if (configured) {
    return configured;
  }

  // On Vercel or in Production: NEVER allow default fallback password
  if (isProduction()) {
    return null;
  }

  // Local development only fallback
  return 'admin123';
}

/**
 * Server-side internal pepper for HMAC token derivation
 */
const SERVER_INTERNAL_PEPPER = 'gyani-tea-sec-pepper-f901c8eb72';

/**
 * Generates/resolves cryptographically secure server-side session secret
 */
function getSessionSecret() {
  const customSecret = cleanEnv(process.env.ADMIN_SESSION_SECRET);
  if (customSecret && customSecret.length >= 16) {
    return customSecret;
  }

  const adminPass = getAdminPassword();
  if (adminPass) {
    return crypto.createHmac('sha256', SERVER_INTERNAL_PEPPER).update(adminPass).digest('hex');
  }

  // In production if ADMIN_PASSWORD is missing, secret cannot exist
  if (isProduction()) {
    return null;
  }

  return crypto.createHmac('sha256', SERVER_INTERNAL_PEPPER).update('admin123-dev-secret').digest('hex');
}

/**
 * Rate-limiting settings (Serverless-compatible with Upstash Redis distributed store)
 */
const loginAttempts = new Map(); // In-memory fallback: ip -> { count, lockedUntil, firstAttempt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_PERIOD_MS = 15 * 60 * 1000; // 15 minutes lockout
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes attempt window

function getClientIp(req) {
  if (req.headers) {
    const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
    if (forwarded) {
      return String(forwarded).split(',')[0].trim();
    }
  }
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return '127.0.0.1';
}

/**
 * Serverless-compatible rate limit check:
 * Checks distributed Upstash Redis if configured, with in-memory fallback.
 */
async function checkRateLimit(ip, redisConfig) {
  const now = Date.now();

  // 1. Distributed Redis check (Survives serverless cold starts & multiple lambdas)
  if (redisConfig) {
    try {
      const res = await fetch(redisConfig.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${redisConfig.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['GET', `gyani_rl:${ip}`])
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.result) {
          const record = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
          if (record && record.lockedUntil && now < record.lockedUntil) {
            const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
            return {
              allowed: false,
              locked: true,
              retryAfterSec: remainingSec,
              error: `Too many failed login attempts. Account locked. Please try again in ${Math.ceil(remainingSec / 60)} minute(s).`
            };
          }
          if (record && record.count) {
            return { allowed: true, remaining: Math.max(0, MAX_LOGIN_ATTEMPTS - record.count) };
          }
        }
      }
    } catch (err) {
      // Graceful fallback to memory check below
    }
  }

  // 2. In-memory check (for local development or if Redis is unreachable)
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS };

  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      allowed: false,
      locked: true,
      retryAfterSec: remainingSec,
      error: `Too many failed login attempts. Account locked. Please try again in ${Math.ceil(remainingSec / 60)} minute(s).`
    };
  }

  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS };
  }

  return { allowed: true, remaining: Math.max(0, MAX_LOGIN_ATTEMPTS - record.count) };
}

/**
 * Serverless-compatible failed attempt recorder
 */
async function recordFailedAttempt(ip, redisConfig) {
  const now = Date.now();
  let record = null;

  if (redisConfig) {
    try {
      const res = await fetch(redisConfig.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${redisConfig.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['GET', `gyani_rl:${ip}`])
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.result) {
          record = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
        }
      }
    } catch {}
  }

  if (!record) {
    record = loginAttempts.get(ip);
  }

  if (!record || (now - record.firstAttempt > ATTEMPT_WINDOW_MS)) {
    record = { count: 1, firstAttempt: now, lockedUntil: 0 };
  } else {
    record.count += 1;
  }

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_PERIOD_MS;
  }

  // Persist to Upstash Redis with 15-minute TTL (900 seconds)
  if (redisConfig) {
    try {
      await fetch(redisConfig.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${redisConfig.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', `gyani_rl:${ip}`, JSON.stringify(record), 'EX', 900])
      });
    } catch {}
  }

  // Also persist in local process memory
  loginAttempts.set(ip, record);

  const remaining = Math.max(0, MAX_LOGIN_ATTEMPTS - record.count);
  return { locked: record.count >= MAX_LOGIN_ATTEMPTS, remaining };
}

/**
 * Clears failed attempts upon successful login across Redis and in-memory
 */
async function clearFailedAttempts(ip, redisConfig) {
  loginAttempts.delete(ip);
  if (redisConfig) {
    try {
      await fetch(redisConfig.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${redisConfig.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['DEL', `gyani_rl:${ip}`])
      });
    } catch {}
  }
}

/**
 * Generate cryptographically signed HMAC token with 24-hour expiration
 */
function generateToken() {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error('Cannot issue session token: Session secret is not configured.');
  }

  const payload = {
    iat: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours validity
    role: 'admin'
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verify token signature, expiration and payload using timing-safe comparison
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;

  try {
    const secret = getSessionSecret();
    if (!secret) return false;

    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) {
      return false; // Expired
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks Authorization header for valid Bearer token
 */
function isAuthorized(req) {
  if (!req.headers) return false;
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || typeof authHeader !== 'string') return false;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  return verifyToken(match[1].trim());
}

/* ==========================================================================
   REQUEST PARSER & RESPONSE SENDER
   ========================================================================== */

/**
 * Helper to safely parse incoming request body
 * Handles pre-parsed JSON objects (Vercel serverless), buffers, and raw streams (Node http)
 */
async function parseRequestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8'));
      } catch {
        throw new Error('Invalid JSON payload');
      }
    }
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        throw new Error('Invalid JSON payload');
      }
    }
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        if (req.destroy) req.destroy();
        else if (req.connection && req.connection.destroy) req.connection.destroy();
        reject(new Error('Payload too large (limit 5MB)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Unified response sender for Node http & Serverless
 */
function sendResponse(res, statusCode, data, headers = {}) {
  const isJson = typeof data === 'object';
  const payload = isJson ? JSON.stringify(data) : data;
  const defaultHeaders = isJson
    ? { 'Content-Type': 'application/json; charset=utf-8' }
    : { 'Content-Type': 'text/plain; charset=utf-8' };

  const allHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...defaultHeaders,
    ...headers
  };

  if (res.writeHead) {
    res.writeHead(statusCode, allHeaders);
    res.end(payload);
  } else {
    res.statusCode = statusCode;
    for (const [key, val] of Object.entries(allHeaders)) {
      res.setHeader(key, val);
    }
    res.end(payload);
  }
}

/* ==========================================================================
   MAIN REQUEST HANDLER (/api/content & /api/auth)
   ========================================================================== */

async function handleContent(req, res) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    sendResponse(res, 204, '');
    return;
  }

  const rawUrl = req.url || '';
  const pathname = decodeURI(rawUrl.split('?')[0]);
  const isAuthRoute = pathname === '/api/auth' || pathname === '/api/auth/login' || pathname === '/api/login';

  // -------------------------------------------------------------
  // 1. AUTH ROUTE: GET /api/auth (Verify session status)
  // -------------------------------------------------------------
  if (isAuthRoute && req.method === 'GET') {
    if (isAuthorized(req)) {
      sendResponse(res, 200, { authenticated: true, message: 'Session is valid' });
    } else {
      sendResponse(res, 401, { authenticated: false, error: 'Session expired or invalid' });
    }
    return;
  }

  // -------------------------------------------------------------
  // 2. AUTH ROUTE: POST /api/auth (Login with rate-limiting)
  // -------------------------------------------------------------
  if (isAuthRoute && req.method === 'POST') {
    const clientIp = getClientIp(req);
    const redis = getUpstashConfig();
    const rateStatus = await checkRateLimit(clientIp, redis);

    if (!rateStatus.allowed) {
      sendResponse(res, 429, {
        error: rateStatus.error
      }, {
        'Retry-After': String(rateStatus.retryAfterSec || 900)
      });
      return;
    }

    // Critical Production Guard: If ADMIN_PASSWORD is missing in production, deny all logins securely!
    const actualPassword = getAdminPassword();
    if (!actualPassword) {
      sendResponse(res, 500, {
        error: 'Security Error: ADMIN_PASSWORD is not configured in Vercel Environment Variables. Logins are disabled until an administrator password is set in Project Settings.'
      });
      return;
    }

    let parsed;
    try {
      parsed = await parseRequestBody(req);
    } catch (err) {
      sendResponse(res, 400, { error: err.message || 'Invalid JSON payload' });
      return;
    }

    const inputPassword = parsed && parsed.password ? String(parsed.password) : '';

    // Constant-time password comparison
    let isMatch = false;
    if (inputPassword.length > 0) {
      const inputHash = crypto.createHash('sha256').update(inputPassword).digest();
      const actualHash = crypto.createHash('sha256').update(actualPassword).digest();
      isMatch = crypto.timingSafeEqual(inputHash, actualHash);
    }

    if (!isMatch) {
      // Artificial delay to prevent timing and automated script attacks
      await new Promise(r => setTimeout(r, 400));
      const failRecord = await recordFailedAttempt(clientIp, redis);

      if (failRecord.locked) {
        sendResponse(res, 429, {
          error: 'Too many incorrect attempts. Account locked for 15 minutes.'
        }, { 'Retry-After': '900' });
      } else {
        sendResponse(res, 401, {
          error: `Incorrect password. ${failRecord.remaining} attempt(s) remaining.`
        });
      }
      return;
    }

    // Success: Clear failed attempts in both Redis and memory, then generate signed token
    await clearFailedAttempts(clientIp, redis);
    const token = generateToken();
    sendResponse(res, 200, {
      success: true,
      token,
      message: 'Login successful! Session valid for 24 hours.',
      expiresIn: 86400
    });
    return;
  }

  // -------------------------------------------------------------
  // 3. CONTENT ROUTE: GET /api/content (Publicly accessible)
  // -------------------------------------------------------------
  if (req.method === 'GET') {
    try {
      // 1. Try Upstash Redis / Vercel KV
      const redis = getUpstashConfig();
      if (redis) {
        const stored = await fetchFromRedis(redis);
        if (stored) {
          sendResponse(res, 200, stored, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
          return;
        }
        // Auto-seed Redis with bundled site-content.json on first visit
        const defaultContent = readLocalDefault();
        if (defaultContent) {
          try {
            await saveToRedis(redis, defaultContent);
          } catch (seedErr) {
            console.error('Failed to auto-seed Redis:', seedErr.message);
          }
          sendResponse(res, 200, defaultContent, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
          return;
        }
      }

      // 2. Try JSONBin fallback
      const jsonbin = getJsonBinConfig();
      if (jsonbin) {
        const stored = await fetchFromJsonBin(jsonbin);
        if (stored) {
          sendResponse(res, 200, stored, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
          return;
        }
      }

      // 3. Fallback to bundled local site-content.json
      const local = readLocalDefault();
      if (local) {
        sendResponse(res, 200, local, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      } else {
        sendResponse(res, 500, { error: 'Failed to read content file' });
      }
    } catch (err) {
      console.error('GET /api/content error:', err);
      const local = readLocalDefault();
      if (local) {
        sendResponse(res, 200, local, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      } else {
        sendResponse(res, 500, { error: 'Failed to read content: ' + err.message });
      }
    }
    return;
  }

  // -------------------------------------------------------------
  // 4. CONTENT ROUTE: POST /api/content (Strictly Authenticated)
  // -------------------------------------------------------------
  if (req.method === 'POST') {
    // SECURITY GUARD: Verify signed session token before processing
    if (!isAuthorized(req)) {
      sendResponse(res, 401, {
        error: 'Unauthorized: Admin authentication required to save changes. Please log in.'
      });
      return;
    }

    let parsed;
    try {
      parsed = await parseRequestBody(req);
    } catch (err) {
      sendResponse(res, 400, { error: err.message || 'Invalid JSON payload' });
      return;
    }

    try {
      // 1. If Upstash Redis / Vercel KV configured
      const redis = getUpstashConfig();
      if (redis) {
        await saveToRedis(redis, parsed);
        // Best-effort local file write (only on writable local filesystems, not on Vercel)
        if (!process.env.VERCEL) {
          try {
            fs.writeFileSync(CONTENT_FILE, JSON.stringify(parsed, null, 2), 'utf8');
          } catch {}
        }
        sendResponse(res, 200, { success: true, message: 'Website content updated in Upstash Redis!' });
        return;
      }

      // 2. If JSONBin fallback configured
      const jsonbin = getJsonBinConfig();
      if (jsonbin) {
        await saveToJsonBin(jsonbin, parsed);
        try {
          fs.writeFileSync(CONTENT_FILE, JSON.stringify(parsed, null, 2), 'utf8');
        } catch {}
        sendResponse(res, 200, { success: true, message: 'Website content updated in persistent storage!' });
        return;
      }

      // 3. If running on Vercel without persistent storage configured
      if (process.env.VERCEL) {
        sendResponse(res, 503, {
          error: 'Upstash Redis persistent storage is not connected. In your Vercel Project Settings -> Environment Variables, ensure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set and redeploy.'
        });
        return;
      }

      // 4. Local development: write to site-content.json
      fs.writeFileSync(CONTENT_FILE, JSON.stringify(parsed, null, 2), 'utf8');
      sendResponse(res, 200, { success: true, message: 'Website content updated successfully!' });
    } catch (err) {
      console.error('POST /api/content error:', err);
      sendResponse(res, 500, { error: 'Failed to write content: ' + err.message });
    }
    return;
  }

  sendResponse(res, 405, { error: 'Method Not Allowed' });
}

module.exports = handleContent;
module.exports.default = handleContent;
module.exports.generateToken = generateToken;
module.exports.verifyToken = verifyToken;
module.exports.isAuthorized = isAuthorized;
module.exports.checkRateLimit = checkRateLimit;
module.exports.getAdminPassword = getAdminPassword;
module.exports.getSessionSecret = getSessionSecret;
