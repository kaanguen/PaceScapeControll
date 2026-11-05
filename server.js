import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const root = dirname(fileURLToPath(import.meta.url));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const range = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const runnerSettings = p => range(p.paceMinutesPerKilometre, 0.1, 60) && Number.isInteger(p.spawnLane) && range(p.spawnLane, 1, 8) && range(p.distanceBehindStartLine, 0, 1000);
export const commands = {
    'runner.comparison': p => Number.isInteger(p.comparisonDistanceMetres) && range(p.comparisonDistanceMetres, 1, 1000000) && typeof p.useDemoRecords === 'boolean' && Object.keys(p).length === 2,
    'runner.mode': p => ['FixedPace', 'AllTimePersonalBest'].includes(p.runnerMode) && Object.keys(p).length === 1,
    'treadmill.scan': p => Object.keys(p).length === 0,
    'treadmill.scan.stop': p => Object.keys(p).length === 0,
    'treadmill.connect': p => typeof p.deviceId === 'string' && p.deviceId.trim().length > 0 && p.deviceId.length <= 256 && Object.keys(p).length === 1,
    'treadmill.disconnect': p => Object.keys(p).length === 0,
    'runner.create': runnerSettings,
    'runner.remove': p => Object.keys(p).length === 0,
    'runner.configure': runnerSettings,
    'run.start': runnerSettings,
    'run.pause': p => Object.keys(p).length === 0,
    'run.resume': p => Object.keys(p).length === 0,
    'run.reset': p => Object.keys(p).length === 0,
    'runner.pace': p => range(p.paceMinutesPerKilometre, 0.1, 60),
    'runner.spawn': p => Number.isInteger(p.spawnLane) && range(p.spawnLane, 1, 8) && range(p.distanceBehindStartLine, 0, 1000),
    'tracking.configure': p => range(p.markerLength, 0.001, 10) && range(p.startupTimeoutSeconds, 1, 300) && Number.isInteger(p.maxTrackedMarkers) && range(p.maxTrackedMarkers, 1, 64),
    'placement.configure': p => typeof p.placeOnFloor === 'boolean' && range(p.queryPadding, 0.1, 100) && range(p.maxMarkerPlaneDistance, 0.001, 10) && range(p.minimumNormalAlignment, 0, 1),
    'tracking.start': p => Object.keys(p).length === 0,
    'tracking.stop': p => Object.keys(p).length === 0,
    'tracking.retry': p => Object.keys(p).length === 0
};

export function createService({ commandTimeout = 8000, staleTimeout = 5000 } = {}) {
    let headset = null, state = null, updatedAt = 0;
    const dashboards = new Set(), pending = new Map();
    const send = (ws, message) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    const snapshot = () => ({ type: 'status', headsetConnected: headset?.readyState === WebSocket.OPEN, state, updatedAt: updatedAt || null, pending: pending.size });
    const broadcast = () => { for (const ws of dashboards) send(ws, snapshot()); };
    const finish = (id, success, error = '') => {
        const item = pending.get(id);
        if (!item) return;
        clearTimeout(item.timer); pending.delete(id);
        send(item.ws, { type: 'ack', requestId: item.requestId, commandId: id, success, error });
        broadcast();
    };
    const server = http.createServer(async (req, res) => {
        const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'" };
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers); res.end(); return; }
        const path = new URL(req.url, 'http://localhost').pathname;
        const asset = assets[path];
        if (!asset && path !== '/health') { res.writeHead(404, headers); res.end('Not found'); return; }
        try {
            const body = asset ? await readFile(resolve(root, 'public', asset[0])) : '{"ok":true}';
            res.writeHead(200, { ...headers, 'Content-Type': `${asset?.[1] || 'application/json'}; charset=utf-8` });
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch { res.writeHead(500, headers); res.end('Could not load dashboard'); }
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
    server.on('upgrade', (req, socket, head) => {
        try {
            const host = new URL(`http://${req.headers.host}`).hostname;

            if (new URL(req.url, 'http://localhost').pathname !== '/ws') return socket.destroy();
            if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return socket.destroy();
            wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
        } catch { socket.destroy(); }
    });
    wss.on('connection', ws => {
        let role = null, count = 0, windowStart = Date.now();
        ws.alive = true;
        ws.on('error', () => {});
        ws.on('pong', () => { ws.alive = true; });
        const helloTimer = setTimeout(() => ws.close(1008, 'Hello required'), 5000);
        helloTimer.unref();
        ws.on('message', (raw, binary) => {
            try {
                if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
                if (++count > 30) { ws.close(1008, 'Message rate exceeded'); return; }
                if (binary) throw new Error('Text JSON required');
                const m = JSON.parse(raw.toString());
                if (!object(m)) throw new Error('JSON object required');
                if (!role) {
                    if (m.type !== 'hello' || m.protocol !== 1 || !['headset', 'dashboard'].includes(m.role)) throw new Error('Protocol 1 hello required');
                    if (m.role === 'headset' && headset?.readyState === WebSocket.OPEN) { ws.close(1008, 'A headset is already connected'); return; }
                    clearTimeout(helloTimer); role = m.role;
                    if (role === 'headset') { headset = ws; state = null; updatedAt = 0; }
                    else dashboards.add(ws);
                    send(ws, { type: 'welcome', protocol: 1 }); broadcast(); return;
                }
                if (role === 'headset') {
                    if (m.type === 'state' && object(m.state)) { state = m.state; updatedAt = Date.now(); broadcast(); return; }
                    if (m.type === 'ack' && typeof m.commandId === 'string' && typeof m.success === 'boolean') { finish(m.commandId, m.success, String(m.error || '').slice(0, 1000)); return; }
                    throw new Error('Unsupported headset message');
                }
                if (m.type !== 'command' || typeof m.requestId !== 'string' || !m.requestId.length || m.requestId.length > 128) throw new Error('Command and requestId required');
                const reject = error => send(ws, { type: 'ack', requestId: m.requestId, success: false, error });
                if (!Object.hasOwn(commands, m.commandType) || !object(m.payload) || !commands[m.commandType](m.payload)) return reject('Ungültiger Befehl oder Wert.');
                if (headset?.readyState !== WebSocket.OPEN) return reject('Keine Brille verbunden.');
                if (!updatedAt || Date.now() - updatedAt > staleTimeout) return reject('App-Status veraltet.');
                if ((m.commandType.startsWith('run.') || m.commandType === 'runner.configure') && state.runnerControlVersion !== 1) return reject('Die App unterstützt die neue Laufsteuerung noch nicht. Bitte neu bauen und installieren.');
                if (['runner.create', 'runner.remove'].includes(m.commandType) && (state.spawnControlVersion !== 1 || state.testScene !== true)) return reject('Spawnen ist nur in der verbundenen Unity-Testszene verfügbar.');
                if (m.commandType.startsWith('treadmill.') && state.treadmillControlVersion !== 1) return reject('Für die Laufband-Verbindung die aktualisierte App neu bauen und installieren.');
                if (m.commandType === 'runner.mode' && state.ghostControlVersion !== 1) return reject('Für die Ghost-Steuerung die aktualisierte App neu bauen und installieren.');
                if ((m.commandType === 'runner.comparison' || (m.commandType === 'runner.mode' && m.payload.runnerMode === 'AllTimePersonalBest')) && state.comparisonControlVersion !== 1) return reject('Für Runden und All-time PRs die aktualisierte App installieren.');
                if (pending.size) return reject('Ein Befehl wartet auf Bestätigung.');
                const commandId = randomUUID();
                const timer = setTimeout(() => finish(commandId, false, 'Keine Bestätigung. Zustand prüfen; Befehl wird nicht wiederholt.'), commandTimeout);
                timer.unref(); pending.set(commandId, { ws, requestId: m.requestId, timer });
                send(headset, { type: 'command', commandId, commandType: m.commandType, payload: m.payload }); broadcast();
            } catch (error) { send(ws, { type: 'error', error: error.message }); }
        });
        ws.on('close', () => {
            clearTimeout(helloTimer); dashboards.delete(ws);
            if (headset === ws) {
                headset = null; state = null; updatedAt = 0;
                for (const id of [...pending.keys()]) finish(id, false, 'Brille getrennt; Ausführung unklar.');
                broadcast();
            }
        });
    });
    // Application-level liveness lets Unity pause a run even when a broken link stays half-open.
    const controlHeartbeat = setInterval(() => send(headset, { type: 'control', protocol: 1 }), 1000);
    controlHeartbeat.unref();
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    }, 10000);
    heartbeat.unref();
    return { server, close: async () => {
        clearInterval(heartbeat);
        clearInterval(controlHeartbeat);
        for (const item of pending.values()) clearTimeout(item.timer);
        pending.clear();
        for (const ws of wss.clients) ws.terminate();
        await new Promise(done => wss.close(done));
        if (server.listening) await new Promise(done => server.close(done));
    } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const host = process.env.HOST || '0.0.0.0', port = Number(process.env.PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
    const service = createService();
    service.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    service.server.listen(port, host, () => console.log(`PaceScape: http://localhost:${port}\nWebSocket: ws://localhost:${port}/ws\nUSB: adb reverse tcp:${port} tcp:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); });
}
