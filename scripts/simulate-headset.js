import WebSocket from 'ws';
const ws = new WebSocket(process.env.SERVER_URL || 'ws://127.0.0.1:8787/ws');
const state = { deviceName: 'PaceScape Simulator', isSimulation: true, isEditor: false, trackingEnabled: true, phase: 'Ready', startupStatus: 'Simulation – keine echte Marker- oder Bodenprüfung.', startupError: '', placedMarkers: 0, pendingMarkers: 0, paceMinutesPerKilometre: 6, spawnLane: 1, distanceBehindStartLine: 0.5, markerLength: 0.1, startupTimeoutSeconds: 15, maxTrackedMarkers: 64, placeOnFloor: true, queryPadding: 1, maxMarkerPlaneDistance: 0.15, minimumNormalAlignment: 0.9 };
const send = m => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const publish = () => send({ type: 'state', state });
ws.on('open', () => send({ type: 'hello', role: 'headset', protocol: 1, token: process.env.ACCESS_TOKEN || '' }));
ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') { console.log('SIMULATION connected. This does not control a headset.'); publish(); }
    if (m.type !== 'command') return;
    Object.assign(state, m.payload);
    if (m.commandType === 'tracking.stop') { state.trackingEnabled = false; state.phase = 'Stopped'; }
    if (m.commandType === 'tracking.start' || m.commandType === 'tracking.retry') { state.trackingEnabled = true; state.phase = 'Ready'; }
    publish(); send({ type: 'ack', commandId: m.commandId, success: true });
});
const timer = setInterval(publish, 1000);
ws.on('error', error => console.error(error.message));
ws.on('close', () => { clearInterval(timer); console.log('Simulation disconnected.'); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => ws.close());
