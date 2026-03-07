'use strict';
const rateLimit = require('express-rate-limit');
const slowDown  = require('express-slow-down');

// ── Rate Limiter Factory ──────────────────────────────────────────────────
function createLimiter(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: message || 'Too many requests. Please try again later.' },
    skip: (req) => process.env.NODE_ENV === 'test',
    handler: (req, res, next, options) => {
      res.set('Retry-After', Math.ceil(options.windowMs / 1000));
      res.status(429).json(options.message);
    }
  });
}

// General API limiter: 120 req/min per IP
const apiLimiter = createLimiter(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 120,
  'API rate limit exceeded. Max 120 requests per minute.'
);

// Auth limiter: 10 attempts/15min per IP (prevents brute force)
const authLimiter = createLimiter(
  15 * 60_000,
  parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  'Too many login attempts. Please wait 15 minutes.'
);

// Heavy operations limiter (reports, exports)
const heavyLimiter = createLimiter(60_000, 20, 'Report generation limited to 20/min.');

// Speed limiter — slows responses after 80 requests
const speedLimiter = slowDown({
  windowMs: 60_000,
  delayAfter: 80,
  delayMs: (hits) => (hits - 80) * 100, // +100ms per request over limit
  skip: () => process.env.NODE_ENV === 'test'
});

// ── Circuit Breaker ───────────────────────────────────────────────────────
class CircuitBreaker {
  constructor(options = {}) {
    this.threshold  = options.threshold  || parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5;
    this.timeout    = options.timeout    || parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT_MS) || 30_000;
    this.resetAfter = options.resetAfter || 60_000;
    this.failures   = 0;
    this.state      = 'closed'; // closed | open | half-open
    this.nextAttempt = Date.now();
    this.successCount = 0;
  }

  call(fn) {
    if (this.state === 'open') {
      if (Date.now() < this.nextAttempt) {
        return Promise.reject(new Error('CIRCUIT_OPEN: Service temporarily unavailable'));
      }
      this.state = 'half-open';
    }

    return Promise.resolve()
      .then(() => fn())
      .then((result) => {
        this.onSuccess();
        return result;
      })
      .catch((err) => {
        this.onFailure();
        throw err;
      });
  }

  onSuccess() {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= 2) { // 2 successes needed to close
        this.state = 'closed';
        this.successCount = 0;
      }
    }
  }

  onFailure() {
    this.failures++;
    this.successCount = 0;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.timeout;
      console.warn(`[CircuitBreaker] OPENED after ${this.failures} failures. Resets at ${new Date(this.nextAttempt).toISOString()}`);
    }
  }

  getState() {
    return { state: this.state, failures: this.failures, nextAttempt: this.nextAttempt };
  }
}

// ── Retry with Exponential Backoff ────────────────────────────────────────
async function retryWithBackoff(fn, retries = 3, baseDelay = 500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Request Timeout Middleware ────────────────────────────────────────────
function requestTimeout(ms = 30_000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(503).json({ success: false, error: 'Request timeout. Please try again.' });
      }
    }, ms);
    res.on('finish', () => clearTimeout(timer));
    res.on('close',  () => clearTimeout(timer));
    next();
  };
}

// ── Security Headers & Input Sanitizer ───────────────────────────────────
function sanitizeInputs(req, res, next) {
  // Strip null bytes (common in injection attacks)
  const clean = (obj) => {
    if (typeof obj !== 'object' || obj === null) return;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key].replace(/\0/g, '').trim();
      } else if (typeof obj[key] === 'object') {
        clean(obj[key]);
      }
    }
  };
  clean(req.body);
  clean(req.query);
  clean(req.params);
  next();
}

// ── Suspicious Request Detector ───────────────────────────────────────────
const SUSPICIOUS_PATTERNS = [
  /(\bOR\b|\bAND\b|\bUNION\b|\bSELECT\b|\bDROP\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bEXEC\b)/i,
  /('|"|;|--|\/\*|\*\/|xp_)/,
  /<script[\s\S]*?>[\s\S]*?<\/script>/i,
  /javascript:/i,
  /on\w+\s*=/i,
];

function detectSuspicious(req, res, next) {
  const checkStr = JSON.stringify({
    body: req.body,
    query: req.query,
    params: req.params
  });

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(checkStr)) {
      // Log but don't block (parameterized queries handle injection)
      // In production: log to SIEM/WAF
      console.warn(`[Security] Suspicious input from ${req.ip}: ${pattern}`);
      req.suspiciousInput = true;
      break;
    }
  }
  next();
}

// ── IP Blocklist (in-memory for POC, use Redis in production) ─────────────
const blocklist = new Set();
const blockCount = new Map();
const BLOCK_THRESHOLD = 500; // requests in 1 min to auto-block

function ipGuard(req, res, next) {
  const ip = req.ip;
  if (blocklist.has(ip)) {
    return res.status(403).json({ success: false, error: 'Access denied.' });
  }

  const count = (blockCount.get(ip) || 0) + 1;
  blockCount.set(ip, count);

  setTimeout(() => {
    const c = blockCount.get(ip) || 0;
    if (c > 0) blockCount.set(ip, c - 1);
  }, 60_000);

  if (count > BLOCK_THRESHOLD) {
    blocklist.add(ip);
    console.warn(`[Security] Auto-blocked IP: ${ip} (${count} req/min)`);
    return res.status(429).json({ success: false, error: 'Rate limit exceeded. IP blocked temporarily.' });
  }

  next();
}

const dbCircuitBreaker = new CircuitBreaker();

module.exports = {
  apiLimiter,
  authLimiter,
  heavyLimiter,
  speedLimiter,
  requestTimeout,
  sanitizeInputs,
  detectSuspicious,
  ipGuard,
  CircuitBreaker,
  dbCircuitBreaker,
  retryWithBackoff,
};
