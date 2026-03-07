# ⛽ FuelBunk Pro — Alpha PWA

Complete Petrol Station Management System — built as a PWA with REST API + SQLite backend.

---

## 🚀 Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values

# 3. Start server
npm start        # production
npm run dev      # development (nodemon)
```

Open http://localhost:3000  
**Default login:** `admin` / `Admin@12345`

---

## ☁️ Deploy to Render.com (Cloud with Persistent Disk)

1. Push this repo to GitHub
2. Go to https://render.com → **New → Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml`
5. Set `ADMIN_PASSWORD` manually in Environment settings
6. Deploy — SQLite DB persists on `/data` disk

---

## 🏗️ Architecture

```
Browser (PWA)
    │  HTTPS / REST API
    ▼
Express Server (Node.js)
    │  better-sqlite3
    ▼
SQLite DB (/data/fuelbunk.db)
    (persisted on Render disk)
```

**Security Stack:**
- `helmet` — HTTP security headers
- `express-rate-limit` — Rate limiting (120 req/min, 10 auth/15min)
- `express-slow-down` — Speed limiting
- `bcryptjs` — Password hashing (cost factor 12)
- `jsonwebtoken` — JWT auth (15min expiry) + refresh tokens
- `express-validator` — Input validation + sanitization
- Parameterized queries — SQL injection prevention
- Circuit breaker — Fault tolerance
- Idle timeout — Auto-logout on inactivity
- `beforeunload` — Logout on browser close

---

## 🔐 Security Features

| Feature | Implementation |
|---|---|
| SQL Injection | Parameterized queries (better-sqlite3) |
| XSS | Input sanitization + CSP headers |
| CSRF | JWT Bearer tokens (not cookies) |
| Brute Force | Account lockout after 5 failures (15 min) |
| Rate Limiting | 120 req/min general, 10/15min for auth |
| Idle Timeout | Configurable (default 15 min) |
| Browser Close | beforeunload → logout API call |
| Audit Trail | Every action logged with IP + user |
| RBAC | Owner/Manager/Cashier/Attendant roles |
| Token Security | Short JWT (15m) + httpOnly refresh |

---

## 🧪 Run Tests

```bash
# Security + API tests
npm test

# Security tests only (verbose)
npm run test:security

# Load test (DDoS simulation) — server must be running
npm run test:load
# Or with params: concurrent=100 total=1000
node tests/load.test.js 100 1000 localhost 3000
```

---

## 📦 Database Schema

| Table | Purpose |
|---|---|
| `users` | Auth + role management |
| `refresh_tokens` | JWT refresh token store |
| `audit_log` | Complete activity log |
| `station_config` | Fuel prices, settings |
| `tanks` | Fuel tanks (MS/HSD/CNG) |
| `nozzles` | Dispenser nozzles |
| `shifts` | Shift open/close records |
| `sales` | All fuel + product sales |
| `credit_customers` | Fleet / corporate accounts |
| `credit_payments` | Payment collections |
| `purchases` | Fuel delivery records |
| `suppliers` | Supplier master |
| `employees` | Staff management |
| `products` | Lubes & accessories |
| `dip_readings` | Tank dip measurements |
| `rate_limit_log` | Rate limit tracking |

---

## 🛡️ Security Testing Checklist

### SQL Injection
- [ ] Run test suite: `npm run test:security`
- [ ] Manual: try `' OR '1'='1` in login form → should fail
- [ ] Automated: SQLMap against staging instance

### DDoS / Load
- [ ] Load test: `node tests/load.test.js 200 2000`
- [ ] Check 429 responses appear in results
- [ ] Verify server stays responsive

### General
- [ ] HTTPS enforced in production (Render provides free SSL)
- [ ] `JWT_SECRET` is 32+ random characters
- [ ] `ADMIN_PASSWORD` changed from default
- [ ] Audit log reviewed regularly

---

## 📱 PWA Features

- ✅ Install on Android/iOS home screen
- ✅ Offline error handling (Service Worker)
- ✅ Background sync for offline sales
- ✅ Responsive — works on 320px to 1440px screens
- ✅ Session restored on same tab (sessionStorage)
- ✅ Logout on tab/browser close

---

## 🗺️ Roadmap

- [ ] GST e-Invoice (IRN) integration
- [ ] GSTR-1/3B JSON export
- [ ] Tally XML export
- [ ] WhatsApp daily summary (Twilio)
- [ ] SMS alerts for low stock (MSG91)
- [ ] Multi-station support
- [ ] IoT dispenser integration
- [ ] Customer mobile app
