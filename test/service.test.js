import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createService } from '../server.js';

async function fixture(t, options = {}) {
    const service = createService(options);
    await new Promise(done => service.server.listen(0, '127.0.0.1', done));
    t.after(() => service.close());
    const url = `http://127.0.0.1:${service.server.address().port}`;
    async function client(role, token = '') {
        const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws');
        const messages = [], waiters = [];
        ws.on('message', raw => { const m = JSON.parse(raw); messages.push(m); for (const wake of [...waiters]) wake(); });
        const next = (predicate = () => true) => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error('Expected message timed out')); }, 1500);
            function check() {
                const index = messages.findIndex(predicate);
                if (index >= 0) { clearTimeout(timeout); waiters.splice(waiters.indexOf(check), 1); resolve(messages.splice(index, 1)[0]); }
            }
            waiters.push(check); check();
        });
        await once(ws, 'open');
        ws.send(JSON.stringify({ type: 'hello', protocol: 1, role, token }));
        return { ws, next, send: message => ws.send(JSON.stringify(message)) };
    }
    return { url, client };
}
const cmd = (requestId, commandType = 'runner.pace', payload = { paceMinutesPerKilometre: 6.5 }) => ({ type: 'command', requestId, commandType, payload });
async function connected(t, options) {
    const f = await fixture(t, options), dashboard = await f.client('dashboard'), headset = await f.client('headset');
    await headset.next(m => m.type === 'welcome');
    headset.send({ type: 'state', state: { paceMinutesPerKilometre: 6, runnerControlVersion: 1, runState: 'Ready', canRun: true } });
    await dashboard.next(m => m.type === 'status' && m.state);
    return { ...f, dashboard, headset };
}
test('serves dashboard, blocks unknown paths and unsafe methods', async t => {
    const { url } = await fixture(t);
    const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /PaceScape/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal((await fetch(url + '/server.js')).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});
test('rejects commands offline and validates values without forwarding', async t => {
    const { client } = await fixture(t), d = await client('dashboard');
    d.send(cmd('offline')); assert.equal((await d.next(m => m.requestId === 'offline')).success, false);
    for (const [id, type, payload] of [['nan', 'runner.pace', { paceMinutesPerKilometre: null }], ['lane', 'runner.spawn', { spawnLane: 9, distanceBehindStartLine: 0 }], ['missing', 'runner.spawn', { spawnLane: 1 }], ['unknown', 'avatar.spawn', {}], ['capacity', 'tracking.configure', { markerLength: 0.1, startupTimeoutSeconds: 15, maxTrackedMarkers: 65 }]]) {
        d.send(cmd(id, type, payload)); assert.equal((await d.next(m => m.requestId === id)).success, false);
    }
});
test('relays every supported command and waits for headset acknowledgement', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    const cases = [['runner.configure', { paceMinutesPerKilometre: 6, spawnLane: 2, distanceBehindStartLine: 1 }], ['run.start', { paceMinutesPerKilometre: 5.5, spawnLane: 3, distanceBehindStartLine: 0.75 }], ['run.pause', {}], ['run.resume', {}], ['run.reset', {}], ['runner.pace', { paceMinutesPerKilometre: 5.5 }], ['runner.spawn', { spawnLane: 8, distanceBehindStartLine: 0 }], ['tracking.configure', { markerLength: 0.2, startupTimeoutSeconds: 20, maxTrackedMarkers: 32 }], ['placement.configure', { placeOnFloor: false, queryPadding: 2, maxMarkerPlaneDistance: 0.1, minimumNormalAlignment: 0.8 }], ['tracking.stop', {}], ['tracking.start', {}], ['tracking.retry', {}]];
    for (const [type, payload] of cases) {
        d.send(cmd(type, type, payload)); const forwarded = await h.next(m => m.type === 'command');
        assert.equal(forwarded.commandType, type); assert.deepEqual(forwarded.payload, payload);
        h.send({ type: 'ack', commandId: forwarded.commandId, success: true });
        assert.equal((await d.next(m => m.requestId === type)).success, true);
    }
});
test('serializes commands across dashboards and accepts acknowledgements only from headset', async t => {
    const { dashboard: d, headset: h, client } = await connected(t), other = await client('dashboard');
    d.send(cmd('one')); const forwarded = await h.next(m => m.type === 'command');
    other.send({ type: 'ack', commandId: forwarded.commandId, success: true });
    assert.equal((await other.next(m => m.type === 'error')).type, 'error');
    other.send(cmd('two')); assert.equal((await other.next(m => m.requestId === 'two')).success, false);
    h.send({ type: 'ack', commandId: forwarded.commandId, success: false, error: 'Device validation failed' });
    assert.equal((await d.next(m => m.requestId === 'one')).error, 'Device validation failed');
});
test('timeout fails pending commands without replay; stale state blocks new commands', async t => {
    const { dashboard: d, headset: h } = await connected(t, { commandTimeout: 30, staleTimeout: 60 });
    d.send(cmd('timeout')); await h.next(m => m.type === 'command');
    assert.equal((await d.next(m => m.requestId === 'timeout')).success, false);
    await new Promise(done => setTimeout(done, 80));
    d.send(cmd('stale')); assert.match((await d.next(m => m.requestId === 'stale')).error, /veraltet/);
});
test('disconnect clears state and fails pending command; reconnect has no replay', async t => {
    const { dashboard: d, headset: h, client } = await connected(t);
    d.send(cmd('disconnect')); await h.next(m => m.type === 'command'); h.ws.close();
    assert.equal((await d.next(m => m.requestId === 'disconnect')).success, false);
    assert.equal((await d.next(m => m.type === 'status' && !m.headsetConnected)).state, null);
    const replacement = await client('headset'); await replacement.next(m => m.type === 'welcome');
    d.send(cmd('no-state')); assert.equal((await d.next(m => m.requestId === 'no-state')).success, false);
});
test('accepts token-free clients and rejects a second headset', async t => {
    const { client } = await fixture(t, { token: 'example-shared-token' });
    const dashboard = await client('dashboard'); await dashboard.next(m => m.type === 'welcome');
    const first = await client('headset', 'example-shared-token'); await first.next(m => m.type === 'welcome');
    const second = await client('headset', 'example-shared-token'); assert.equal((await once(second.ws, 'close'))[0], 1008);
});
test('rejects a foreign browser origin and malformed messages do not crash relay', async t => {
    const { url, client } = await fixture(t);
    const foreign = new WebSocket(url.replace('http:', 'ws:') + '/ws', { origin: 'http://evil.example' });
    await once(foreign, 'error');
    const d = await client('dashboard'); d.ws.send('{invalid'); assert.equal((await d.next(m => m.type === 'error')).type, 'error');
    d.send(cmd('alive')); assert.equal((await d.next(m => m.requestId === 'alive')).success, false);
});

test('requires updated headset capability for run control and validates complete settings', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    for (const [id, type, payload] of [
        ['missing-run-settings', 'run.start', {}],
        ['incomplete-config', 'runner.configure', { paceMinutesPerKilometre: 6, spawnLane: 1 }],
        ['invalid-run-pace', 'run.start', { paceMinutesPerKilometre: 0, spawnLane: 1, distanceBehindStartLine: 0.5 }],
        ['pause-payload', 'run.pause', { start: true }]
    ]) {
        d.send(cmd(id, type, payload));
        assert.equal((await d.next(m => m.requestId === id)).success, false);
    }
    h.send({ type: 'state', state: { paceMinutesPerKilometre: 6 } });
    await d.next(m => m.type === 'status' && m.state && !m.state.runnerControlVersion);
    d.send(cmd('old-app', 'run.start', { paceMinutesPerKilometre: 6, spawnLane: 1, distanceBehindStartLine: 0.5 }));
    assert.match((await d.next(m => m.requestId === 'old-app')).error, /neu bauen/);
});

test('sends application liveness to the headset', async t => {
    const { headset: h } = await connected(t);
    const heartbeat = await h.next(m => m.type === 'control');
    assert.equal(heartbeat.protocol, 1);
});
