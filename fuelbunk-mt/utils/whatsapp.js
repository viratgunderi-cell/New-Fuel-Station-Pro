'use strict';
/**
 * FuelBunk Pro — WhatsApp Notification Utility
 * Supports: Twilio | Meta Cloud API | UltraMsg | Custom Webhook | Simulate
 *
 * Set WHATSAPP_PROVIDER env var to: twilio | meta | ultramsg | webhook | simulate
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const PROVIDER = (process.env.WHATSAPP_PROVIDER || 'simulate').toLowerCase();

function httpPostForm(urlStr, headers, formData) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formData).toString();
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function httpPostJSON(urlStr, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function normalizePhone(num) {
  let n = String(num).replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;    // Indian mobile
  if (n.length === 11 && n.startsWith('0')) n = '91' + n.slice(1);
  return n;
}

// ── Providers ─────────────────────────────────────────────────────────────

async function sendTwilio(toNumber, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WA_FROM || 'whatsapp:+14155238886';
  if (!sid || !auth) throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  const cred = Buffer.from(`${sid}:${auth}`).toString('base64');
  const r = await httpPostForm(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    { Authorization: 'Basic ' + cred },
    { From: from, To: 'whatsapp:+' + normalizePhone(toNumber), Body: message }
  );
  if (r.status >= 400) throw new Error(`Twilio ${r.status}: ${JSON.stringify(r.body).slice(0,150)}`);
  return { provider: 'twilio', sid: r.body.sid };
}

async function sendMeta(toNumber, message) {
  const token = process.env.META_WA_TOKEN;
  const phoneId = process.env.META_PHONE_ID;
  if (!token || !phoneId) throw new Error('Missing META_WA_TOKEN / META_PHONE_ID');
  const r = await httpPostJSON(
    `https://graph.facebook.com/v19.0/${phoneId}/messages`,
    { Authorization: 'Bearer ' + token },
    { messaging_product: 'whatsapp', to: normalizePhone(toNumber), type: 'text', text: { body: message } }
  );
  if (r.status >= 400) throw new Error(`Meta API ${r.status}: ${JSON.stringify(r.body).slice(0,150)}`);
  return { provider: 'meta', messageId: r.body.messages?.[0]?.id };
}

async function sendUltraMsg(toNumber, message) {
  const instance = process.env.ULTRAMSG_INSTANCE;
  const token = process.env.ULTRAMSG_TOKEN;
  if (!instance || !token) throw new Error('Missing ULTRAMSG_INSTANCE / ULTRAMSG_TOKEN');
  const r = await httpPostJSON(
    `https://api.ultramsg.com/${instance}/messages/chat`,
    {},
    { token, to: '+' + normalizePhone(toNumber), body: message, priority: 1 }
  );
  if (r.body?.error) throw new Error('UltraMsg: ' + r.body.error);
  return { provider: 'ultramsg', id: r.body.id };
}

async function sendWebhook(toNumber, message) {
  const url = process.env.WA_WEBHOOK_URL;
  const key = process.env.WA_WEBHOOK_API_KEY || '';
  if (!url) throw new Error('WA_WEBHOOK_URL required');
  const r = await httpPostJSON(url, { 'x-api-key': key }, { phone: normalizePhone(toNumber), message });
  return { provider: 'webhook', status: r.status };
}

async function sendSimulate(toNumber, message) {
  console.log(`\n[WA-SIMULATE] ─────────────────────────────────`);
  console.log(`[WA-SIMULATE] To: +${normalizePhone(toNumber)}`);
  console.log(`[WA-SIMULATE] Message:\n${message}`);
  console.log(`[WA-SIMULATE] ─────────────────────────────────\n`);
  return { provider: 'simulate', status: 'logged' };
}

async function sendWhatsApp(toNumber, message) {
  if (!toNumber) throw new Error('WhatsApp number not configured for this station');
  const fn = { twilio: sendTwilio, meta: sendMeta, ultramsg: sendUltraMsg, webhook: sendWebhook }[PROVIDER] || sendSimulate;
  return fn(toNumber, message);
}

// ── Message Templates ─────────────────────────────────────────────────────

const templates = {
  lowStock(stationName, tankName, fuelType, stockL, thresholdL) {
    return `⚠️ *LOW FUEL ALERT*\n\n🏪 ${stationName}\n⛽ *${tankName}* (${fuelType})\n📉 Stock: *${Math.round(stockL).toLocaleString('en-IN')}L*\n🚨 Threshold: ${Math.round(thresholdL).toLocaleString('en-IN')}L\n\nPlease arrange refill immediately.\n\n_— FuelBunk Pro_`;
  },
  dayClose(stationName, date, t) {
    const fmtR = v => '₹' + (v||0).toLocaleString('en-IN', {maximumFractionDigits:0});
    const fmtL = v => (v||0).toFixed(1) + 'L';
    return `📊 *DAILY SUMMARY — ${date}*\n\n🏪 ${stationName}\n\n💰 Revenue: *${fmtR(t.revenue)}*\n⛽ Litres: *${fmtL(t.litres)}*\n🔢 Transactions: *${t.txns||0}*\n\n💵 Cash: ${fmtR(t.cash)}\n📱 UPI: ${fmtR(t.upi)}\n💳 Card: ${fmtR(t.card)}\n🏢 Credit: ${fmtR(t.credit)}\n\n_— FuelBunk Pro_`;
  },
  creditReminder(stationName, companyName, outstanding, daysOverdue, stationMobile) {
    return `💳 *PAYMENT REMINDER*\n\n🏪 ${stationName}\n🏢 Dear *${companyName}*,\n\nYour fuel credit outstanding:\n*₹${outstanding.toLocaleString('en-IN')}*\nOverdue by *${daysOverdue} day${daysOverdue===1?'':'s'}*\n\nPlease settle your dues to continue availing credit.\n\n📞 ${stationMobile||'Contact station'}\n\n_— FuelBunk Pro_`;
  },
  testMessage(stationName) {
    return `✅ *WhatsApp Test — FuelBunk Pro*\n\n🏪 Station: ${stationName}\n⏰ ${new Date().toLocaleString('en-IN', {dateStyle:'medium', timeStyle:'short'})}\n\nYour WhatsApp notifications are configured correctly! 🎉\n\n_— FuelBunk Pro_`;
  },
  lowStockMultiple(stationName, items) {
    const lines = items.map(i => `  • ${i.tankName} (${i.fuelType}): *${Math.round(i.stock).toLocaleString('en-IN')}L*`).join('\n');
    return `⚠️ *MULTIPLE LOW FUEL ALERTS*\n\n🏪 ${stationName}\n\n${lines}\n\nPlease arrange refills immediately.\n\n_— FuelBunk Pro_`;
  },

  // Sprint 6: Meter mismatch alert
  meterMismatch(stationName, shiftName, alerts) {
    const lines = alerts.map(a =>
      `  • *${a.nozzleName}* (${a.fuelType})\n    Meter: ${a.meterSold}L | System: ${a.systemSold}L | Gap: *${a.diff}L (${a.pct}%)*`
    ).join('\n');
    return `🚨 *METER MISMATCH ALERT*\n\n🏪 ${stationName}\n📋 Shift: ${shiftName}\n\n${lines}\n\n⚠️ Please verify dispenser readings and investigate the variance.\n\n_— FuelBunk Pro_`;
  },

  // Sprint 6: WhatsApp bill for credit customer after sale
  creditSaleBill(stationName, companyName, invoiceNo, fuelType, qty, rate, amount, outstanding, stationMobile) {
    const fmt = v => '₹' + (v||0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    return `🧾 *FUEL CREDIT BILL*\n\n🏪 ${stationName}\n📄 Invoice: *${invoiceNo}*\n🏢 Customer: ${companyName}\n\n⛽ ${fuelType} × ${qty}L @ ${fmt(rate)}/L\n💰 Bill Amount: *${fmt(amount)}*\n📊 Total Outstanding: *${fmt(outstanding)}*\n\nKindly settle dues at earliest.\n📞 ${stationMobile||'Contact station'}\n\n_— FuelBunk Pro_`;
  },

  // Sprint 7: Product expiry alert
  expiryAlert(stationName, expiredItems, expiringItems) {
    let msg = `⚠️ *PRODUCT EXPIRY ALERT*\n\n🏪 ${stationName}\n`;
    if (expiredItems.length > 0) {
      msg += `\n🔴 *EXPIRED (${expiredItems.length} products):*\n`;
      expiredItems.forEach(p => { msg += `  • ${p.product_name} — *${p.stock_qty} ${p.unit}* in stock\n`; });
    }
    if (expiringItems.length > 0) {
      msg += `\n🟡 *EXPIRING SOON:*\n`;
      expiringItems.forEach(p => { msg += `  • ${p.product_name} — expires in *${p.days_to_expiry} days* (${p.expiry_date})\n`; });
    }
    msg += `\nPlease take action to avoid stock loss.\n\n_— FuelBunk Pro_`;
    return msg;
  }
};

module.exports = { sendWhatsApp, templates, normalizePhone, PROVIDER };
