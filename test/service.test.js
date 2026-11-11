import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import WebSocket from 'ws';
import { createService } from '../server.js';

async function fixture(t, options = {}) {
    const service = createService(options);
    await new Promise(done => service.server.listen(0, options.allowLanMotorControl ? '0.0.0.0' : '127.0.0.1', done));
    t.after(() => service.close());
    const url = `http://127.0.0.1:${service.server.address().port}`;
    async function client(role, token = '', origin, address = url) {
        const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws', { origin });
        const messages = [], waiters = [];
        ws.on('message', (raw, binary) => { const m = binary ? { type: 'camera-frame', data: raw } : JSON.parse(raw); messages.push(m); for (const wake of [...waiters]) wake(); });
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

test('requires treadmill capability and relays explicit read-only BLE actions', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    d.send(cmd('old-ble-app', 'treadmill.scan', {}));
    assert.match((await d.next(m => m.requestId === 'old-ble-app')).error, /neu bauen/);
    h.send({ type: 'state', state: { treadmillControlVersion: 1, treadmill: { supported: true } } });
    await d.next(m => m.type === 'status' && m.state?.treadmillControlVersion === 1);
    for (const [type, payload] of [
        ['treadmill.scan', {}], ['treadmill.scan.stop', {}],
        ['treadmill.connect', { deviceId: 'AA:BB:CC:DD:EE:FF' }],
        ['treadmill.disconnect', {}]
    ]) {
        d.send(cmd(type, type, payload));
        const forwarded = await h.next(m => m.type === 'command');
        assert.equal(forwarded.commandType, type);
        assert.deepEqual(forwarded.payload, payload);
        h.send({ type: 'ack', commandId: forwarded.commandId, success: true });
        assert.equal((await d.next(m => m.requestId === type)).success, true);
    }
    for (const [id, type, payload] of [
        ['no-id', 'treadmill.connect', {}], ['empty-id', 'treadmill.connect', { deviceId: ' ' }],
        ['long-id', 'treadmill.connect', { deviceId: 'x'.repeat(257) }],
        ['unexpected-write', 'treadmill.connect', { deviceId: 'abc', speed: 12 }],
        ['motor-speed', 'treadmill.speed', { speedKmh: 12 }],
        ['extra-scan', 'treadmill.scan', { autoConnect: true }]
    ]) {
        d.send(cmd(id, type, payload));
        assert.equal((await d.next(m => m.requestId === id)).success, false);
    }
});

test('preserves zero-speed treadmill telemetry and raw distance through relay', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    const treadmill = { supported: true, followTreadmill: true, hasSpeed: true, speedKmh: 0, hasDistance: true, totalDistanceMetres: 66000, devices: [{ id: 'abc', name: '<device>' }] };
    h.send({ type: 'state', state: { treadmillControlVersion: 1, canRun: true, runState: 'Ready', treadmill } });
    const status = await d.next(m => m.type === 'status' && m.state?.treadmill);
    assert.deepEqual(status.state.treadmill, treadmill);
});

test('runner mode requires capability, strict mode names and headset acknowledgement', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    d.send(cmd('old-mode-app', 'runner.mode', { runnerMode: 'FixedPace' }));
    assert.match((await d.next(m => m.requestId === 'old-mode-app')).error, /neu bauen/);
    h.send({ type: 'state', state: { runnerModeControlVersion: 1, ghostControlVersion: 1, comparisonControlVersion: 1, runnerMode: 'FixedPace' } });
    await d.next(m => m.type === 'status' && m.state?.runnerModeControlVersion === 1);
    for (const mode of ['FixedPace', 'AllTimePersonalBest']) {
        d.send(cmd(mode, 'runner.mode', { runnerMode: mode }));
        const forwarded = await h.next(m => m.type === 'command');
        assert.equal(forwarded.commandType, 'runner.mode');
        assert.deepEqual(forwarded.payload, { runnerMode: mode });
        h.send({ type: 'ack', commandId: forwarded.commandId, success: true });
        assert.equal((await d.next(m => m.requestId === mode)).success, true);
    }
    for (const [index, payload] of [{}, { runnerMode: 'GhostRunner' }, { runnerMode: '1' }, { runnerMode: null }, { runnerMode: 'FixedPace', speed: 12 }].entries()) {
        const id = `bad-mode-${index}`;
        d.send(cmd(id, 'runner.mode', payload));
        assert.equal((await d.next(m => m.requestId === id)).success, false);
    }
});

test('comparison settings require updated capability and exact distance/demo fields', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    d.send(cmd('old-comparison', 'runner.comparison', { comparisonDistanceMetres: 400, useDemoRecords: false }));
    assert.match((await d.next(m => m.requestId === 'old-comparison')).error, /aktualisierte App/);
    d.send(cmd('old-alltime', 'runner.mode', { runnerMode: 'AllTimePersonalBest' }));
    assert.equal((await d.next(m => m.requestId === 'old-alltime')).success, false);
    h.send({ type: 'state', state: { runnerModeControlVersion: 1, ghostControlVersion: 1, comparisonControlVersion: 1 } });
    await d.next(m => m.type === 'status' && m.state?.comparisonControlVersion === 1);
    for (const [type, payload] of [['runner.comparison', { comparisonDistanceMetres: 5000, useDemoRecords: true }], ['runner.mode', { runnerMode: 'AllTimePersonalBest' }]]) {
        d.send(cmd(type, type, payload)); const forwarded = await h.next(m => m.type === 'command');
        assert.deepEqual(forwarded.payload, payload);
        h.send({ type: 'ack', commandId: forwarded.commandId, success: true });
        assert.equal((await d.next(m => m.requestId === type)).success, true);
    }
    for (const [i, payload] of [{ comparisonDistanceMetres: 0, useDemoRecords: false }, { comparisonDistanceMetres: 400.5, useDemoRecords: false }, { comparisonDistanceMetres: 400 }, { comparisonDistanceMetres: 400, useDemoRecords: 'true' }, { comparisonDistanceMetres: 1000001, useDemoRecords: false }].entries()) {
        d.send(cmd(`bad-comparison-${i}`, 'runner.comparison', payload));
        assert.equal((await d.next(m => m.requestId === `bad-comparison-${i}`)).success, false);
    }
});

test('ghost mode exposes only fixed pace and all-time PR references', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    h.send({ type: 'state', state: { ghostControlVersion: 1, runnerModeControlVersion: 1, comparisonControlVersion: 1 } });
    await d.next(m => m.type === 'status' && m.state?.ghostControlVersion === 1);
    for (const retired of ['FollowInput', 'TempoRunner', 'SideBySide', 'SessionBest']) {
        d.send(cmd(retired, 'runner.mode', { runnerMode: retired }));
        assert.equal((await d.next(m => m.requestId === retired)).success, false);
    }
    d.send(cmd('retired-input-selector', 'treadmill.manual', {}));
    assert.equal((await d.next(m => m.requestId === 'retired-input-selector')).success, false);
});


test('camera commands require capability and application acknowledgement', async t => {
    const { dashboard: d, headset: h } = await connected(t);
    d.send(cmd('camera-old', 'camera.start', {}));
    assert.equal((await d.next(m => m.requestId === 'camera-old')).success, false);
    h.send({ type: 'state', state: { cameraControlVersion: 1, camera: { enabled: false } } });
    await d.next(m => m.state?.cameraControlVersion === 1);
    for (const type of ['camera.start', 'camera.stop']) {
        d.send(cmd(type, type, {}));
        const forwarded = await h.next(m => m.type === 'command');
        assert.equal(forwarded.commandType, type);
        h.send({ type: 'ack', commandId: forwarded.commandId, success: true });
        assert.equal((await d.next(m => m.requestId === type)).success, true);
    }
});

test('JPEG frames relay only from the active enabled headset and do not change state freshness', async t => {
    const { dashboard: d, headset: h, client } = await connected(t);
    const frame = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    h.ws.send(frame);
    assert.match((await h.next(m => m.type === 'error')).error, /not enabled/);
    h.send({ type: 'state', state: { cameraControlVersion: 1, camera: { enabled: true } } });
    const status = await d.next(m => m.state?.camera?.enabled);
    d.ws.send(frame);
    assert.match((await d.next(m => m.type === 'error')).error, /not enabled/);
    h.ws.send(Buffer.from('not jpeg'));
    assert.match((await h.next(m => m.type === 'error')).error, /JPEG/);
    const largeFrame = Buffer.alloc(600 * 1024);
    frame.copy(largeFrame);
    frame.copy(largeFrame, largeFrame.length - frame.length);
    h.ws.send(largeFrame);
    assert.deepEqual((await d.next(m => m.type === 'camera-frame')).data, largeFrame);
    // A subsequent status still carries only telemetry, not an image or a new timestamp.
    const observer = await client('dashboard');
    const observed = await observer.next(m => m.state?.camera?.enabled);
    assert.equal(observed.updatedAt, status.updatedAt);
    assert.equal(Object.hasOwn(observed.state.camera, 'frame'), false);
    h.send({ type: 'state', state: { cameraControlVersion: 1, camera: { enabled: false } } });
    await d.next(m => m.state?.camera?.enabled === false);
    h.ws.send(frame);
    assert.match((await h.next(m => m.type === 'error')).error, /not enabled/);
});

test('camera frames are rejected when headset telemetry is stale', async t => {
    const { dashboard: d, headset: h } = await connected(t, { staleTimeout: 20 });
    h.send({ type: 'state', state: { cameraControlVersion: 1, camera: { enabled: true } } });
    await d.next(m => m.state?.camera?.enabled);
    await new Promise(resolve => setTimeout(resolve, 40));
    h.ws.send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.match((await h.next(m => m.type === 'error')).error, /not enabled/);
});

test('motor start requires an opted-in local dashboard, a current headset build and a stopped belt', async t => {
    const { client, url } = await fixture(t, { allowMotorStart: true });
    const dashboard = await client('dashboard', '', url);
    const withoutOrigin = await client('dashboard');
    const headset = await client('headset');
    const belt = { motorStartVersion: 3, minSpeedUnits: 100, maxSpeedUnits: 1600, speedStepUnits: 10, connected: true, hasFtmsControlPoint: true, hasSpeed: true, speedKmh: 0, deviceId: 'test-device' };
    const report = (headset, treadmill) => headset.send({ type: 'state', state: { treadmillControlVersion: 1, canRun: true, runState: 'Ready', treadmill } });
    const start = (dashboard, id) => dashboard.send(cmd(id, 'treadmill.startRun', { deviceId: belt.deviceId, paceMinutesPerKilometre: 6, spawnLane: 1, distanceBehindStartLine: 0.5 }));
    report(headset, { ...belt, motorStartVersion: 1 });
    await dashboard.next(m => m.type === 'status' && m.state);
    start(dashboard, 'old-build');
    assert.equal((await dashboard.next(m => m.requestId === 'old-build')).success, false);
    report(headset, { ...belt, speedKmh: 2 });
    await dashboard.next(m => m.type === 'status' && m.state?.treadmill.speedKmh === 2);
    start(dashboard, 'moving');
    assert.equal((await dashboard.next(m => m.requestId === 'moving')).success, false);
    report(headset, belt);
    await dashboard.next(m => m.type === 'status' && m.state?.treadmill.speedKmh === 0 && m.motorStartEnabled);
    start(withoutOrigin, 'no-origin');
    assert.equal((await withoutOrigin.next(m => m.requestId === 'no-origin')).success, false);
    start(dashboard, 'start');
    const forwarded = await headset.next(m => m.type === 'command');
    assert.equal(forwarded.commandType, 'treadmill.startRun');
    assert.equal(forwarded.token, undefined);
    headset.send({ type: 'ack', commandId: forwarded.commandId, success: true });
    assert.equal((await dashboard.next(m => m.requestId === 'start')).success, true);

    const speed = (id, targetSpeedUnits) => dashboard.send(cmd(id, 'treadmill.speed', { deviceId: belt.deviceId, targetSpeedUnits }));
    speed('stopped-speed', 220);
    assert.equal((await dashboard.next(m => m.requestId === 'stopped-speed')).success, false);
    report(headset, { ...belt, speedKmh: 3 });
    await dashboard.next(m => m.type === 'status' && m.state?.treadmill.speedKmh === 3);
    for (const [id, target] of [['above-max', 1610], ['off-step', 225]]) {
        speed(id, target);
        assert.equal((await dashboard.next(m => m.requestId === id)).success, false);
    }
    speed('set-speed', 220);
    const speedCommand = await headset.next(m => m.type === 'command');
    assert.equal(speedCommand.commandType, 'treadmill.speed');
    assert.equal(speedCommand.payload.targetSpeedUnits, 220);
    headset.send({ type: 'ack', commandId: speedCommand.commandId, success: true });
    assert.equal((await dashboard.next(m => m.requestId === 'set-speed')).success, true);

    const sessionCommand = (id, type) => dashboard.send(cmd(id, type, { deviceId: belt.deviceId }));
    sessionCommand('old-pause', 'treadmill.pauseRun');
    assert.equal((await dashboard.next(m => m.requestId === 'old-pause')).success, false);
    headset.send({ type: 'state', state: { treadmillControlVersion: 1, canRun: true, runState: 'Paused',
        treadmill: { ...belt, motorStartVersion: 4, hasSpeed: false } } });
    await dashboard.next(m => m.type === 'status' && m.motorPauseStopEnabled && m.state?.treadmill.motorStartVersion === 4);
    sessionCommand('stale-resume', 'treadmill.resumeRun');
    assert.equal((await dashboard.next(m => m.requestId === 'stale-resume')).success, false);
    for (const type of ['treadmill.pauseRun', 'treadmill.stopRun']) {
        sessionCommand(type, type);
        const forwarded = await headset.next(m => m.type === 'command');
        assert.equal(forwarded.commandType, type);
        headset.send({ type: 'ack', commandId: forwarded.commandId, success: true });
        assert.equal((await dashboard.next(m => m.requestId === type)).success, true);
    }
    headset.send({ type: 'state', state: { treadmillControlVersion: 1, canRun: true, runState: 'Paused',
        treadmill: { ...belt, motorStartVersion: 4 } } });
    await dashboard.next(m => m.type === 'status' && m.state?.treadmill.motorStartVersion === 4 && m.state.treadmill.hasSpeed);
    sessionCommand('resume', 'treadmill.resumeRun');
    const resume = await headset.next(m => m.type === 'command');
    assert.equal(resume.commandType, 'treadmill.resumeRun');
    headset.send({ type: 'ack', commandId: resume.commandId, success: true });
    assert.equal((await dashboard.next(m => m.requestId === 'resume')).success, true);
});

test('routes ghost presentation and calibration only to a supported tracking session', async t => {
    const { dashboard, headset } = await connected(t);
    const presentation = { presentationMode: 'TreadmillRelative', sideOffsetMetres: 1.5, visibilityDistanceMetres: 10 };
    dashboard.send(cmd('unsupported-presentation', 'runner.presentation', presentation));
    assert.equal((await dashboard.next(m => m.requestId === 'unsupported-presentation')).success, false);
    const state = { ghostPresentationVersion: 1, runState: 'Ready', placedMarkers: 1, runnableMarkers: 1,
        ghostPresentation: { mode: 'Track' } };
    headset.send({ type: 'state', state });
    const status = await dashboard.next(m => m.type === 'status' && m.state?.ghostPresentationVersion === 1);
    assert.equal(status.ghostPresentationControlVersion, 1);
    dashboard.send(cmd('wrong-mode', 'runner.calibrate', {}));
    assert.equal((await dashboard.next(m => m.requestId === 'wrong-mode')).success, false);
    dashboard.send(cmd('bad-offset', 'runner.presentation', { ...presentation, sideOffsetMetres: 0 }));
    assert.equal((await dashboard.next(m => m.requestId === 'bad-offset')).success, false);
    dashboard.send(cmd('presentation', 'runner.presentation', presentation));
    const select = await headset.next(m => m.type === 'command');
    assert.equal(select.commandType, 'runner.presentation');
    assert.deepEqual(select.payload, presentation);
    headset.send({ type: 'ack', commandId: select.commandId, success: true });
    assert.equal((await dashboard.next(m => m.requestId === 'presentation')).success, true);
    headset.send({ type: 'state', state: { ...state, ghostPresentation: { mode: 'TreadmillRelative' } } });
    await dashboard.next(m => m.type === 'status' && m.state?.ghostPresentation?.mode === 'TreadmillRelative');
    dashboard.send(cmd('calibrate', 'runner.calibrate', {}));
    const calibrate = await headset.next(m => m.type === 'command');
    assert.equal(calibrate.commandType, 'runner.calibrate');
    headset.send({ type: 'ack', commandId: calibrate.commandId, success: true });
    assert.equal((await dashboard.next(m => m.requestId === 'calibrate')).success, true);
});


test('WLAN motor start requires headset opt-in and a dashboard on the server Mac', async t => {
    const adapter = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal);
    if (!adapter) return t.skip('No LAN interface available');
    const { client, url } = await fixture(t, { allowLanMotorControl: true });
    const lanUrl = url.replace('127.0.0.1', adapter.address);
    const local = await client('dashboard', '', url);
    const remote = await client('dashboard', '', lanUrl, lanUrl);
    const headset = await client('headset', '', undefined, lanUrl);
    const state = { treadmillControlVersion: 1, canRun: true, runState: 'Ready',
        treadmill: { motorStartVersion: 4, connected: true, hasFtmsControlPoint: true, hasSpeed: true, speedKmh: 0, deviceId: 'belt' } };
    const start = (dashboard, id) => dashboard.send(cmd(id, 'treadmill.startRun', {
        deviceId: 'belt', paceMinutesPerKilometre: 6, spawnLane: 1, distanceBehindStartLine: 0.5
    }));
    headset.send({ type: 'state', state });
    await local.next(m => m.type === 'status' && m.state);
    start(local, 'not-enabled');
    assert.equal((await local.next(m => m.requestId === 'not-enabled')).success, false);
    headset.send({ type: 'state', state: { ...state, lanMotorControlEnabled: true } });
    await local.next(m => m.type === 'status' && m.motorStartEnabled);
    await remote.next(m => m.type === 'status' && m.state?.lanMotorControlEnabled);
    start(remote, 'remote');
    assert.equal((await remote.next(m => m.requestId === 'remote')).success, false);
    start(local, 'local');
    const forwarded = await headset.next(m => m.type === 'command');
    assert.equal(forwarded.commandType, 'treadmill.startRun');
    headset.send({ type: 'ack', commandId: forwarded.commandId, success: true });
    assert.equal((await local.next(m => m.requestId === 'local')).success, true);
});

test('validates warm-up steps and relays controls only in the matching app state', async t => {
    const { dashboard, headset } = await connected(t);
    const start = 'exercise.startWarmup';
    const payload = { steps: [
        { animationId: 'Mixamo_StartJumpingJacks', seconds: 4.5 },
        { animationId: 'Mixamo_AirSquat', seconds: 7 }
    ] };
    const publish = async (warmup, extras = {}) => {
        headset.send({ type: 'state', state: { warmupControlVersion: 1, runnerControlVersion: 1, runState: 'Ready', warmup, ...extras } });
        await dashboard.next(m => m.type === 'status' && m.state?.warmup?.status === warmup.status);
    };
    const rejects = async (id, type, data) => {
        dashboard.send(cmd(id, type, data));
        const result = await dashboard.next(m => m.requestId === id);
        assert.equal(result.success, false);
        return result.error;
    };
    const relays = async (type, data) => {
        dashboard.send(cmd(type, type, data));
        const forwarded = await headset.next(m => m.type === 'command');
        assert.equal(forwarded.commandType, type);
        assert.deepEqual(forwarded.payload, data);
        headset.send({ type: 'ack', commandId: forwarded.commandId, success: true });
        assert.equal((await dashboard.next(m => m.requestId === type)).success, true);
    };

    await rejects('legacy', start, payload);
    await publish({ active: false, canStart: false, status: 'TrackingLost' });
    await rejects('untracked', start, payload);
    await publish({ active: false, canStart: true, status: 'Idle' });
    await rejects('empty', start, { steps: [] });
    await rejects('too-many', start, { steps: Array(21).fill(payload.steps[0]) });
    await rejects('invalid-duration', start, { steps: [{ animationId: 'Mixamo_AirSquat', seconds: 0 }] });
    await rejects('unknown-exercise', start, { steps: [{ animationId: 'Other', seconds: 8 }] });
    await rejects('idle-skip', 'exercise.nextWarmup', {});
    await relays(start, payload);
    await publish({ active: true, canStart: false, status: 'Playing' });
    await rejects('already-running', start, payload);
    const settings = { paceMinutesPerKilometre: 6, spawnLane: 1, distanceBehindStartLine: 0.5 };
    assert.match(await rejects('run-while-warming-up', 'run.start', settings), /Beende zuerst das Warm-up/);
    assert.match(await rejects('belt-while-warming-up', 'treadmill.startRun', { ...settings, deviceId: 'belt' }), /Beende zuerst das Warm-up/);
    await relays('exercise.nextWarmup', {});
    await relays('exercise.stopWarmup', {});
    await publish({ active: false, canStart: true, status: 'Stopped' });
    await relays('run.start', settings);
});
