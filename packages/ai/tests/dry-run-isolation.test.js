'use strict';

/**
 * Regression tests for the Phase 2 review findings B1-B4: model-written scripts must never run in the
 * server process. Each attack is replayed against the child-process runner WITHOUT the static filter
 * (`runInChild`), then through `dryRunScript` (filter + child).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { dryRunScript, runInChild, startupOptions, liveChildren, buildSandboxResponse, WALL_CLOCK_MS, MAX_CONCURRENT_CHILDREN } = require('../src/dry-run');

const RESPONSE = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
const payload = (code) => ({ code, response: buildSandboxResponse(RESPONSE), variables: {}, timeoutMs: 1000 });

/** Measures how late a 20 ms interval fires: a blocked event loop shows up as a large lag. */
function lagMonitor() {
  let max = 0;
  let last = Date.now();
  const iv = setInterval(() => { const n = Date.now(); max = Math.max(max, n - last - 20); last = n; }, 20);
  return { stop() { clearInterval(iv); return max; } };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitDead(pid) {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise(r => setTimeout(r, 25));
  return !alive(pid);
}

const HOST_PID = String(process.pid);
const noHostData = (verdict) => {
  const s = JSON.stringify(verdict);
  assert.ok(!s.includes(HOST_PID), `host pid leaked: ${s}`);
  assert.ok(!/\/Users\/|\/home\/|PATH=|HOME=/.test(s), `host data leaked: ${s}`);
};

// The four reviewed attacks (identical payloads), plus common variants.
const B1 = `const OP = Object.getOwnPropertyDescriptor((Object), 'proto'+'type').value; const getter = Object.getOwnPropertyDescriptor(OP, '__pro'+'to__').get; const FP = getter.call((Object)); const F = Object.getOwnPropertyDescriptor(FP, 'constr'+'uctor').value; apx.environment.set('E', String(F('return proc'+'ess.pid')()));`;
const B2 = `if (1) /'/.test('a'); ${B1} /'/.test('b')`;
const B3 = `// note const F=Object['constructor']; apx.environment.set('E', String(F('return proc'+'ess.pid')()));`;
const ESCAPES = {
  B1, B2, B3,
  thisConstructor: `apx.environment.set('E', String(this.constructor.constructor('return proc'+'ess.pid')()));`,
  fnConstructor: `apx.environment.set('E', String((function(){}).constructor('return proc'+'ess.pid')()));`,
  apxConstructor: `apx.environment.set('E', String(apx.test.constructor('return proc'+'ess.pid')()));`,
  apxExpectConstructor: `apx.environment.set('E', String(apx.expect(1).equal.constructor('return proc'+'ess.pid')()));`,
  responseJsonConstructor: `apx.environment.set('E', String(apx.response.json.constructor('return proc'+'ess.pid')()));`,
  requireFs: `apx.environment.set('E', require('fs').readFileSync('/etc/hosts', 'utf8'));`,
  processEnv: `apx.environment.set('E', JSON.stringify(process.env));`,
  dynamicImport: `const m = await import('node:fs'); apx.environment.set('E', m.readFileSync('/etc/hosts', 'utf8'));`,
  prepareStackTrace: `Error.prepareStackTrace = (e, s) => s; const st = new Error().stack; apx.environment.set('E', String(st[0].getThis()));`,
  evalCall: `apx.environment.set('E', String(eval('1+1')));`,
};

test('B1-B3 escapes, replayed straight into the child runner (no filter): no host data, no host process', async () => {
  for (const [name, code] of Object.entries(ESCAPES)) {
    const mon = lagMonitor();
    const v = await runInChild(payload(code), undefined);
    const lag = mon.stop();
    noHostData(v);
    assert.ok(lag < 250, `${name}: server event loop lagged ${lag} ms`);
  }
});

test('B1-B3 escapes through dryRunScript: refused or rejected, never validated, never host data', async () => {
  for (const [name, code] of Object.entries(ESCAPES)) {
    const v = await dryRunScript(code, { response: RESPONSE, mode: 'lenient' });
    assert.equal(v.ok, false, `${name} must not validate`);
    noHostData(v);
  }
});

test('B4: loops, promise storms, OOM and ReDoS are cut off in time and never block the server', async () => {
  const attacks = {
    awaitLoop: `while(true){ await null; }`,
    promiseStorm: `Promise.resolve().then(function loop(){ Promise.resolve().then(loop); });`,
    oom: `const keep = []; for (let i = 0; i < 1e9; i++) { keep.push(new Array(2**24).fill(i)); }`,
    busyLoop: `while(true){}`,
    redos: `apx.test('re', () => { /(a+)+$/.test('a'.repeat(60) + '!'); });`,
    neverResolves: `await new Promise(() => {});`,
  };
  for (const [name, code] of Object.entries(attacks)) {
    const mon = lagMonitor();
    const t0 = Date.now();
    let pid = 0;
    const v = await runInChild(payload(code), undefined, { onSpawn: (p) => { pid = p; } });
    const elapsed = Date.now() - t0;
    const lag = mon.stop();
    assert.ok(!(v.ok === true && v.done === true && v.tests.every(t => t.passed)), `${name}: must not look like a success: ${JSON.stringify(v)}`);
    assert.ok(elapsed < WALL_CLOCK_MS + 500, `${name}: took ${elapsed} ms`);
    assert.ok(lag < 250, `${name}: server event loop lagged ${lag} ms`);
    assert.ok(await waitDead(pid), `${name}: child ${pid} is still alive`);
  }
  assert.equal(liveChildren(), 0);
});

test('B4 through dryRunScript: the verdict is a rejection, a concurrent HTTP request stays responsive', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => res.end('pong'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const ping = () => new Promise((resolve, reject) => {
    const t0 = Date.now();
    http.get({ host: '127.0.0.1', port, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(Date.now() - t0)); }).on('error', reject);
  });
  try {
    const running = dryRunScript(`while(true){ await null; }`, { response: RESPONSE, mode: 'lenient' });
    await new Promise(r => setTimeout(r, 150));
    const during = await ping();
    const v = await running;
    const after = await ping();
    assert.equal(v.ok, false);
    assert.ok(during < 200 && after < 200, `latency during=${during}ms after=${after}ms`);
  } finally {
    server.close();
  }
});

test('an aborted request kills its child immediately', async () => {
  const ac = new AbortController();
  let pid = 0;
  const running = dryRunScript(`while(true){}`, { response: RESPONSE, signal: ac.signal, onSpawn: (p) => { pid = p; } });
  await new Promise(r => setTimeout(r, 200));
  assert.ok(pid > 0 && alive(pid), 'child should be running');
  const t0 = Date.now();
  ac.abort();
  const v = await running;
  assert.equal(v.ok, false);
  assert.match(v.reason, /cancelled/);
  assert.ok(Date.now() - t0 < 300);
  assert.ok(await waitDead(pid), 'child is still alive after abort');
  assert.equal(liveChildren(), 0);
});

test('a child that dies (OOM / crash) means a rejected script, not a server error', async () => {
  const v = await dryRunScript(`const keep = []; while (true) keep.push(new Array(2**22).fill(1));`, { response: RESPONSE });
  assert.equal(v.ok, false);
  assert.match(v.reason, /could not be run|did not finish/);
});

test('at most MAX_CONCURRENT_CHILDREN children live at once; extra runs queue', async () => {
  let live = 0;
  let peak = 0;
  const pids = new Set();
  const one = () => runInChild(payload(`apx.test('ok', () => { apx.expect(1).to.equal(1); });`), undefined, {
    onSpawn: (p) => { pids.add(p); live = [...pids].filter(alive).length; peak = Math.max(peak, live); },
  });
  const results = await Promise.all([one(), one(), one(), one(), one()]);
  assert.ok(results.every(r => r.ok && r.done));
  assert.ok(peak <= MAX_CONCURRENT_CHILDREN, `peak ${peak}`);
  assert.equal(liveChildren(), 0);
});

test('a refused script is never sent to the child (canary: a valid script does spawn one)', async () => {
  const spawned = [];
  const onSpawn = (pid) => spawned.push(pid);
  const ok = await dryRunScript(`apx.test('x', () => { apx.expect(1).to.equal(1); });`, { response: RESPONSE, onSpawn });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(spawned.length, 1, 'canary: a valid script must spawn exactly one child');
  const refused = await dryRunScript(`apx.test('x', () => { Object['constructor']('return 1')(); });`, { response: RESPONSE, onSpawn });
  assert.equal(refused.ok, false);
  assert.equal(refused.screened, false);
  assert.equal(spawned.length, 1, 'a refused script must not spawn a child');
});

test('the child gets an empty environment and a heap cap; the permission model is on when Node has it', async () => {
  process.env.APILIX_TEST_SECRET = 'must-not-reach-the-child';
  try {
    const { env, execArgv, permission } = startupOptions();
    assert.ok(!('APILIX_TEST_SECRET' in env));
    assert.ok(!('PATH' in env) && !('HOME' in env));
    assert.ok(execArgv.some(a => a.startsWith('--max-old-space-size=')));
    if (process.versions.electron) return;
    const supported = process.allowedNodeEnvironmentFlags.has('--permission') || process.allowedNodeEnvironmentFlags.has('--experimental-permission');
    assert.equal(permission !== 'none', supported);
    if (permission === 'none') return;
    // Real check: the same flags really deny fs / child_process / worker in a probe process.
    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apilix-probe-')), 'probe.js');
    fs.writeFileSync(probe, `
      const r = {};
      try { require('fs').readFileSync(${JSON.stringify(__filename)}); r.fs = 'allowed'; } catch (e) { r.fs = e.code; }
      try { require('child_process').execSync('id'); r.cp = 'allowed'; } catch (e) { r.cp = e.code; }
      try { new (require('worker_threads').Worker)('1', { eval: true }); r.worker = 'allowed'; } catch (e) { r.worker = e.code; }
      r.env = Object.keys(process.env).filter(k => /SECRET/.test(k));
      process.stdout.write(JSON.stringify(r));`);
    const out = await new Promise((resolve) => {
      let s = '';
      const c = fork(fs.realpathSync(probe), [], { env, execArgv: [...execArgv, `--allow-fs-read=${fs.realpathSync(probe)}`], stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
      c.stdout.on('data', d => { s += d; });
      c.on('exit', () => resolve(s));
    });
    assert.deepEqual(JSON.parse(out), { fs: 'ERR_ACCESS_DENIED', cp: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED', env: [] });
  } finally {
    delete process.env.APILIX_TEST_SECRET;
  }
});

test('the async loop `while(true){ await null }` is bounded by the child, not by the filter alone', async () => {
  const v = await runInChild(payload(`while(true){ await null; }`));
  assert.equal(v.ok, false);
  assert.equal(v.error, 'timeout', 'the vm timeout interrupts the microtask loop inside the child');
});
