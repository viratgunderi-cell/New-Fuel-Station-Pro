# FuelBunk Pro — Deployment Guide

## Requirements
- Node.js ≥ 18.0.0
- 512 MB RAM minimum (1 GB recommended)
- 2 GB disk space

---

## Quick Start (Ubuntu/Debian VPS)

### 1. Upload & Extract
```bash
unzip FuelBunkPro-Sprint7-Fixed.zip -d /opt/fuelbunk
cd /opt/fuelbunk/FuelBunkPro-Enhanced
```

### 2. Install Dependencies
```bash
npm install --production
```

### 3. Configure Environment
```bash
cp .env.example .env
nano .env   # Set JWT_SECRET and any WhatsApp credentials
```
Minimum required: set `JWT_SECRET` to a random 64-char string.

### 4. Start (direct)
```bash
npm start
# App runs on http://localhost:3000
```

### 5. Start with PM2 (recommended for production)
```bash
npm install -g pm2
pm2 start server.js --name fuelbunk --env production
pm2 save
pm2 startup   # Run the printed command to auto-start on reboot
```

---

## Nginx Reverse Proxy (optional)
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## First Login
1. Open `http://your-server:3000`
2. Click **"Create New Station"**
3. Register with role: `owner`
4. Log in and complete station setup in **Settings**

---

## Data Backup
```bash
# Backup database
cp /opt/fuelbunk/FuelBunkPro-Enhanced/data/fuelbunk.db ~/backup-$(date +%Y%m%d).db

# Restore
cp ~/backup-20240115.db /opt/fuelbunk/FuelBunkPro-Enhanced/data/fuelbunk.db
```

---

## Navigation Structure (post-consolidation)
| Section | Items |
|---|---|
| **Operations** | Dashboard, Sales, Shifts, Tanks & Inventory |
| **Finance** | Credit Mgmt, Purchases & Suppliers, Staff & Payroll, GST Module, Bank Reconciliation |
| **Reports & Tools** | Reports (hub), WhatsApp Alerts, Settings |

Reports hub contains: Daily Report, Advanced Reports, UPI Reconciliation, Vehicle Report, Density Analysis, Audit Log.

Settings contains tabs: Station Config, Shift Config, Audit Log.

---

## Troubleshooting
| Issue | Fix |
|---|---|
| `Cannot find module 'express'` | Run `npm install` |
| Port 3000 in use | Set `PORT=3001` in `.env` |
| Database locked | Stop all instances: `pm2 stop fuelbunk` |
| JWT errors after restart | Ensure `JWT_SECRET` is set and unchanged |
