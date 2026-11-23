import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createService } from '../server.js';
import { parseBodyPose } from '../body-tracking.js';

const identityPose = (bodyId = 1) => ({
    bodyId,
    rotations: Array.from({ length: 128 }, (_, index) => index % 4 === 3 ? 1 : 0),
    confidence: Array(32).fill(2)
});

async function fixture(t) {
    const service = createService();
    await new Promise(done => service.server.listen(0, '127.0.0.1', done));
    t.after(() => service.close());
    const url = `http://127.0.0.1:${service.server.address().port}`;
    async function client(role) {
        const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws');
        const messages = [], waiters = [];
        ws.on('message', raw => { messages.push(JSON.parse(raw)); for (const wake of [...waiters]) wake(); });
        const next = (predicate = () => true, timeoutMs = 1500) => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error('Expected message timed out')); }, timeoutMs);
            function check() {
                const index = messages.findIndex(predicate);
                if (index >= 0) { clearTimeout(timeout); waiters.splice(waiters.indexOf(check), 1); resolve(messages.splice(index, 1)[0]); }
            }
            waiters.push(check); check();
        });
        await once(ws, 'open');
        ws.send(JSON.stringify({ type: 'hello', protocol: 1, role }));
        await next(m => m.type === 'welcome');
        return { next, messages, send: message => ws.send(JSON.stringify(message)) };
    }
    const postPose = (pose, headers = {}) => fetch(url + '/api/body-tracking/pose', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(pose)
    });
    const dashboard = await client('dashboard'), headset = await client('headset');
    const publish = async (bodyMirror, extras = {}) => {
        headset.send({ type: 'state', state: { runnerControlVersion: 1, runState: 'Ready', bodyMirrorVersion: 1, bodyMirror, ...extras } });
        await dashboard.next(m => m.type === 'status' && m.state?.bodyMirror?.status === bodyMirror.status);
    };
    return { url, dashboard, headset, publish, postPose };
}

test('pose parser accepts one complete skeleton and rejects malformed values', () => {
    const pose = parseBodyPose(identityPose(4));
    assert.equal(pose.bodyId, 4);
    assert.equal(pose.rotations.length, 128);
    for (const broken of [
        { ...identityPose(), extra: true },
        { ...identityPose(), bodyId: -1 },
        { ...identityPose(), rotations: identityPose().rotations.slice(4) },
        { ...identityPose(), rotations: identityPose().rotations.map((v, i) => i === 3 ? 0.2 : v) },
        { ...identityPose(), rotations: identityPose().rotations.map((v, i) => i === 0 ? '0' : v) },
        { ...identityPose(), confidence: Array(32).fill(4) }
    ]) assert.equal(parseBodyPose(broken), null);
});

test('mirror commands require capability, Ready state and a startable placement', async t => {
    const { dashboard, headset, publish } = await fixture(t);
    const send = (requestId, commandType) => dashboard.send({ type: 'command', requestId, commandType, payload: {} });

    headset.send({ type: 'state', state: { runnerControlVersion: 1, runState: 'Ready' } });
    await dashboard.next(m => m.type === 'status' && m.state?.runState === 'Ready');
    send('old', 'bodyMirror.start');
    assert.match((await dashboard.next(m => m.requestId === 'old')).error, /unterstützt Body Tracking nicht/);

    await publish({ active: false, canStart: false, status: 'Stopped' });
    send('blocked', 'bodyMirror.start');
    assert.equal((await dashboard.next(m => m.requestId === 'blocked')).success, false);
    send('inactive', 'bodyMirror.stop');
    assert.match((await dashboard.next(m => m.requestId === 'inactive')).error, /nicht aktiv/);

    await publish({ active: false, canStart: true, status: 'Ready' });
    send('start', 'bodyMirror.start');
    const forwarded = await headset.next(m => m.type === 'command');
    assert.equal(forwarded.commandType, 'bodyMirror.start');
    assert.deepEqual(forwarded.payload, {});
    headset.send({ type: 'ack', commandId: forwarded.commandId, success: true });
    assert.equal((await dashboard.next(m => m.requestId === 'start')).success, true);

    await publish({ active: true, canStart: false, status: 'WaitingForPose' });
    dashboard.send({ type: 'command', requestId: 'run', commandType: 'run.start', payload: { paceMinutesPerKilometre: 6, spawnLane: 1, distanceBehindStartLine: 0.5 } });
    assert.match((await dashboard.next(m => m.requestId === 'run')).error, /Body Tracking/);
    dashboard.send({ type: 'command', requestId: 'payload', commandType: 'bodyMirror.stop', payload: { extra: 1 } });
    assert.equal((await dashboard.next(m => m.requestId === 'payload')).success, false);
});

test('poses are relayed only while the headset mirror is active and only from local senders', async t => {
    const { headset, publish, postPose } = await fixture(t);

    await publish({ active: false, canStart: true, status: 'Ready' });
    assert.equal((await postPose(identityPose())).status, 204);
    await new Promise(done => setTimeout(done, 50));
    assert.equal(headset.messages.some(m => m.type === 'bodyPose'), false);

    await publish({ active: true, canStart: false, status: 'WaitingForPose' });
    assert.equal((await postPose(identityPose(7))).status, 204);
    const relayed = await headset.next(m => m.type === 'bodyPose');
    assert.equal(relayed.bodyPose.bodyId, 7);
    assert.equal(relayed.bodyPose.confidence.length, 32);

    assert.equal((await postPose({ ...identityPose(), bodyId: 'x' })).status, 400);
    assert.equal((await postPose(identityPose(), { Origin: 'http://evil.example' })).status, 415);
    assert.equal((await postPose(identityPose(), { 'Content-Type': 'text/plain' })).status, 415);
});

test('the local Editor preview reads only the newest fresh pose, independent of the headset', async t => {
    const { url, postPose } = await fixture(t);
    const latest = (headers = {}) => fetch(url + '/api/body-tracking/pose', { headers });

    assert.equal((await latest()).status, 204);
    assert.equal((await postPose(identityPose(3))).status, 204);
    assert.equal((await postPose(identityPose(4))).status, 204);
    const response = await latest();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bodyId, 4);
    assert.equal((await latest({ Origin: 'http://evil.example' })).status, 403);

    await new Promise(done => setTimeout(done, 550));
    assert.equal((await latest()).status, 204);
});
