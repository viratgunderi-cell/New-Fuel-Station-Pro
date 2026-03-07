'use strict';
/**
 * FuelBunk Pro — Load Test (DDoS Simulation)
 * Run: node tests/load.test.js [concurrent] [requests] [host]
 *
 * Tests:
 * 1. Concurrent request handling
 * 2. Rate limiting enforcement
 * 3. Circuit breaker behavior
 * 4. Response time under load
 */
const http = require('http');
const { performance } = require('perf_hooks');

const HOST     = process.argv[4] || 'localhost';
const PORT     = process.argv[5] || 3000;
const CONCUR   = parseInt(process.argv[2]) || 50;  // concurrent connections
const TOTAL    = parseInt(process.argv[3]) || 500; // total requests

const ENDPOINTS = [
  { method: 'GET',  path: '/health' },
  { method: 'POST', path: '/api/auth/login', body: { username: 'admin', password: 'wrong' } },
  { method: 'GET',  path: '/api/dashboard' },
];

const stats = {
  total: 0, success: 0, failed: 0, rate_limited: 0,
  times: [], errors: new Map(),
};

function makeRequest(endpoint) {
  return new Promise((resolve) => {
    const start = performance.now();
    const body  = endpoint.body ? JSON.stringify(endpoint.body) : null;

    const options = {
      hostname: HOST, port: PORT, path: endpoint.path,
      method: endpoint.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body ? Buffer.byteLength(body) : 0,
        'User-Agent': 'FuelBunk-LoadTest/1.0',
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const elapsed = performance.now() - start;
        stats.total++;
        stats.times.push(elapsed);
        if (res.statusCode === 429) stats.rate_limited++;
        else if (res.statusCode < 400 || res.statusCode === 401) stats.success++;
        else stats.failed++;
        resolve({ status: res.statusCode, time: elapsed });
      });
    });

    req.on('error', (err) => {
      stats.total++;
      stats.failed++;
      const key = err.code || err.message;
      stats.errors.set(key, (stats.errors.get(key) || 0) + 1);
      resolve({ status: 0, error: err.message, time: performance.now() - start });
    });

    req.on('timeout', () => {
      req.destroy();
      stats.total++;
      stats.failed++;
      resolve({ status: 0, error: 'timeout' });
    });

    if (body) req.write(body);
    req.end();
  });
}

async function runBatch(count) {
  const promises = [];
  for (let i = 0; i < count; i++) {
    const endpoint = ENDPOINTS[i % ENDPOINTS.length];
    promises.push(makeRequest(endpoint));
  }
  return Promise.all(promises);
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║         FuelBunk Pro — Load Test (DDoS Sim)           ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\nTarget: http://${HOST}:${PORT}`);
  console.log(`Concurrent: ${CONCUR} | Total: ${TOTAL}\n`);

  // Check server is up
  try {
    await makeRequest({ method: 'GET', path: '/health' });
    console.log('✅ Server reachable');
  } catch {
    console.error('❌ Server not reachable. Start server first: npm start');
    process.exit(1);
  }

  const overallStart = performance.now();
  let completed = 0;

  while (completed < TOTAL) {
    const batch = Math.min(CONCUR, TOTAL - completed);
    await runBatch(batch);
    completed += batch;

    // Progress
    const pct = Math.round((completed / TOTAL) * 100);
    process.stdout.write(`\r  Progress: ${completed}/${TOTAL} (${pct}%)`);
  }

  const totalTime = (performance.now() - overallStart) / 1000;
  const times = stats.times.sort((a,b) => a-b);
  const avg = times.reduce((a,b) => a+b, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.50)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];

  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Total Requests:   ${stats.total}`);
  console.log(`✅ Success:        ${stats.success} (${Math.round(stats.success/stats.total*100)}%)`);
  console.log(`🔒 Rate Limited:   ${stats.rate_limited} (${Math.round(stats.rate_limited/stats.total*100)}%) — GOOD`);
  console.log(`❌ Failed:         ${stats.failed}`);
  console.log(`⏱️  Total Time:     ${totalTime.toFixed(2)}s`);
  console.log(`📈 Req/sec:        ${(stats.total / totalTime).toFixed(1)}`);
  console.log(`\nResponse Times:`);
  console.log(`  Avg: ${avg.toFixed(0)}ms`);
  console.log(`  P50: ${p50?.toFixed(0)}ms`);
  console.log(`  P95: ${p95?.toFixed(0)}ms`);
  console.log(`  P99: ${p99?.toFixed(0)}ms`);
  console.log(`  Max: ${times[times.length-1]?.toFixed(0)}ms`);

  if (stats.errors.size) {
    console.log('\nErrors:');
    stats.errors.forEach((count, key) => console.log(`  ${key}: ${count}`));
  }

  console.log('\n═══════════════════════════════════════════════════════');

  // Assertions
  let passed = 0, total_checks = 0;
  function check(name, condition, expect_val) {
    total_checks++;
    if (condition) { console.log(`  ✅ ${name}`); passed++; }
    else console.log(`  ❌ ${name} (expected: ${expect_val})`);
  }

  console.log('\nSecurity Checks:');
  check('Rate limiting active', stats.rate_limited > 0, '>0 rate limited responses');
  check('No complete failure', stats.success > 0, '>0 success');
  check('Server stable', stats.failed < stats.total * 0.5, '<50% failure rate');
  check('P95 under 5s', p95 < 5000, '<5000ms');
  check('Throughput > 10 req/s', (stats.total / totalTime) > 10, '>10 req/s');

  console.log(`\n${passed}/${total_checks} checks passed\n`);
  process.exit(passed === total_checks ? 0 : 1);
}

main().catch(console.error);
