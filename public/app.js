const $ = id => document.getElementById(id);
let socket, reconnectTimer, snapshot, pending, generation = 0, accessToken = '';
const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
$('siteUrl').textContent = location.origin; $('wsUrl').textContent = wsUrl;
const names = { 'runner.pace': 'Pace ändern', 'runner.spawn': 'Startposition ändern', 'tracking.start': 'Tracking starten', 'tracking.stop': 'Tracking stoppen', 'tracking.retry': 'Tracking neu starten', 'tracking.configure': 'Erkennung konfigurieren', 'placement.configure': 'Platzierung konfigurieren' };
const phases = { Stopped: 'Gestoppt', Ready: 'Bereit', Failed: 'Fehler', UnsupportedPlatform: 'Editor / nicht unterstützt', WaitingForScene: 'Szene laden', CheckingConfiguration: 'Konfiguration prüfen', RequestingPermissions: 'Berechtigungen anfragen', WaitingForOpenXR: 'Warten auf OpenXR', CheckingFeatures: 'XR-Funktionen prüfen', StartingSubsystems: 'Subsysteme starten', StartingMarkerDetector: 'Markererkennung starten', Suspended: 'Unterbrochen', Recovering: 'Wiederherstellung' };
function log(message) {
    const li = document.createElement('li'), time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('de-DE'); li.append(time, document.createTextNode(message)); $('events').prepend(li);
    while ($('events').children.length > 60) $('events').lastElementChild.remove();
}
function notice(message, failure = false) { $('notice').textContent = message; $('notice').classList.toggle('failure', failure); }
function fresh() { return socket?.readyState === WebSocket.OPEN && snapshot?.headsetConnected && snapshot.state && Date.now() - snapshot.updatedAt < 5000; }
function controls() {
    document.querySelectorAll('fieldset').forEach(field => { field.disabled = !fresh() || Boolean(pending) || Boolean(snapshot?.pending); });
    if (fresh() && !pending && !snapshot.pending) {
        $('startTracking').disabled = snapshot.state.trackingEnabled;
        $('stopTracking').disabled = !snapshot.state.trackingEnabled;
        $('retryTracking').disabled = !snapshot.state.trackingEnabled;
    }
    $('lastUpdate').textContent = snapshot?.updatedAt ? `vor ${Math.max(0, Math.floor((Date.now() - snapshot.updatedAt) / 1000))} s` : '—';
    if (snapshot?.headsetConnected && !fresh()) notice('App-Status veraltet. Warte auf ein neues Update.', true);
}
function sync(id, value) {
    const input = $(id);
    if (input.dataset.dirty || document.activeElement === input || value === undefined) return;
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
}
function paceText(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    const seconds = Math.round(value * 60); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function render(message) {
    const wasFresh = fresh(); snapshot = message; const s = message.state;
    $('deviceBadge').textContent = message.headsetConnected ? 'Verbunden' : 'Offline'; $('deviceBadge').classList.toggle('online', message.headsetConnected);
    if (s) {
        $('deviceName').textContent = s.deviceName || 'Magic Leap 2'; $('deviceMode').textContent = s.isSimulation ? 'SIMULATION · keine echte Brille' : s.isEditor ? 'Unity Editor · kein Gerätetracking' : 'PaceScape · Magic Leap 2';
        $('paceValue').textContent = paceText(s.paceMinutesPerKilometre); $('speedValue').textContent = Number.isFinite(s.paceMinutesPerKilometre) && s.paceMinutesPerKilometre > 0 ? (60 / s.paceMinutesPerKilometre).toFixed(1) : '—';
        $('phase').textContent = phases[s.phase] || s.phase || '—'; $('markers').textContent = s.placedMarkers ?? '—'; $('pendingMarkers').textContent = s.pendingMarkers ?? '—';
        $('trackingStatus').textContent = s.startupStatus || 'Keine Trackingmeldung.'; $('trackingError').textContent = s.startupError || ''; $('trackingError').hidden = !s.startupError;
        sync('paceInput', paceText(s.paceMinutesPerKilometre));
        for (const [id, key] of Object.entries({ lane: 'spawnLane', distance: 'distanceBehindStartLine', markerLength: 'markerLength', timeout: 'startupTimeoutSeconds', capacity: 'maxTrackedMarkers', floor: 'placeOnFloor', padding: 'queryPadding', planeDistance: 'maxMarkerPlaneDistance', alignment: 'minimumNormalAlignment' })) sync(id, s[key]);
        if (!wasFresh && fresh()) notice(s.isSimulation ? 'SIMULATION verbunden. Befehle steuern keine echte Brille.' : 'App verbunden. Steuerung bereit.');
    } else {
        for (const id of ['paceValue', 'speedValue', 'phase', 'markers', 'pendingMarkers']) $(id).textContent = '—';
        $('deviceMode').textContent = 'Noch keine App verbunden'; $('trackingStatus').textContent = 'Starte die aktualisierte PaceScape-App.'; $('trackingError').hidden = true;
        notice(message.headsetConnected ? 'Warte auf App-Zustand.' : 'Server bereit. Warte auf die PaceScape-App.');
    }
    const lane = s && Number.isInteger(s.spawnLane) && s.spawnLane >= 1 && s.spawnLane <= 8 ? s.spawnLane : null;
    $('activeLane').textContent = lane ?? '—';
    document.querySelectorAll('[data-lane]').forEach(element => element.classList.toggle('selected', Number(element.dataset.lane) === lane));
    controls();
}
function connect() {
    clearTimeout(reconnectTimer); const current = ++generation;
    if (pending) { clearTimeout(pending.timer); log('Neu verbinden: Ausführung des laufenden Befehls unklar.'); pending = null; }
    socket?.close(); snapshot = null; controls(); socket = new WebSocket(wsUrl);
    $('connection').textContent = 'Server verbinden …'; $('connection').classList.remove('online');
    socket.onopen = () => { if (current === generation) socket.send(JSON.stringify({ type: 'hello', protocol: 1, role: 'dashboard', token: accessToken })); };
    socket.onmessage = event => {
        if (current !== generation) return;
        let m; try { m = JSON.parse(event.data); } catch { return; }
        if (m.type === 'welcome') { $('connection').textContent = 'Server verbunden'; $('connection').classList.add('online'); log('WebSocket zum Server verbunden.'); }
        if (m.type === 'status') render(m);
        if (m.type === 'ack' && pending?.id === m.requestId) {
            clearTimeout(pending.timer);
            const text = m.success ? `${pending.name}: von der App bestätigt.` : `${pending.name}: ${m.error || 'Fehlgeschlagen'}`;
            if (m.success) pending.form?.querySelectorAll('input,select').forEach(input => { delete input.dataset.dirty; });
            pending = null; log(text); notice(text, !m.success); controls();
        }
        if (m.type === 'error') { log(`Server: ${m.error}`); notice(m.error, true); }
    };
    socket.onclose = event => {
        if (current !== generation) return;
        if (pending) { clearTimeout(pending.timer); log(`${pending.name}: Verbindung verloren; Ausführung unklar.`); pending = null; }
        snapshot = null; $('connection').textContent = 'Server getrennt'; $('connection').classList.remove('online'); render({ headsetConnected: false, state: null });
        notice(event.code === 1008 ? `Verbindung abgelehnt: ${event.reason}. Zugriffsschlüssel prüfen und neu verbinden.` : 'Server nicht erreichbar. Verbindung wird erneut versucht.', true);
        if (event.code !== 1008) reconnectTimer = setTimeout(connect, 2500);
    };
    socket.onerror = () => {};
}
function command(commandType, payload, form = null) {
    if (!fresh() || pending || snapshot.pending) return notice('Warte auf eine aktuelle Verbindung oder laufende Bestätigung.', true);
    // Also works on an explicitly enabled HTTP LAN origin without secure-context APIs.
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending = { id, name: names[commandType], form, timer: setTimeout(() => {
        if (pending?.id !== id) return;
        pending = null; const text = 'Keine Bestätigung. Zustand prüfen; Befehl wird nicht wiederholt.'; log(text); notice(text, true); controls();
    }, 10000) };
    socket.send(JSON.stringify({ type: 'command', requestId: id, commandType, payload })); notice(`${names[commandType]} gesendet. Warte auf die App …`); controls();
}
for (const input of document.querySelectorAll('fieldset input,fieldset select')) input.addEventListener('input', () => { input.dataset.dirty = 'true'; });
function bind(id, type, payload, restart = false) {
    $(id).onsubmit = event => {
        event.preventDefault();
        if (restart && !confirm('Tracking neu starten und alle lokalen Platzierungen löschen? Marker müssen erneut gescannt werden.')) return;
        try { command(type, payload(), $(id)); } catch (error) { notice(error.message, true); }
    };
}
bind('paceForm', 'runner.pace', () => {
    const m = /^(\d{1,2}):([0-5]\d)$/.exec($('paceInput').value.trim());
    if (!m) throw new Error('Pace als Minuten:Sekunden eingeben, z. B. 6:30.');
    const value = Number(m[1]) + Number(m[2]) / 60;
    if (value < 0.1 || value > 60) throw new Error('Pace muss zwischen 0:06 und 60:00 liegen.');
    return { paceMinutesPerKilometre: value };
});
bind('spawnForm', 'runner.spawn', () => ({ spawnLane: Number($('lane').value), distanceBehindStartLine: Number($('distance').value) }));
bind('trackingForm', 'tracking.configure', () => ({ markerLength: Number($('markerLength').value), startupTimeoutSeconds: Number($('timeout').value), maxTrackedMarkers: Number($('capacity').value) }), true);
bind('placementForm', 'placement.configure', () => ({ placeOnFloor: $('floor').checked, queryPadding: Number($('padding').value), maxMarkerPlaneDistance: Number($('planeDistance').value), minimumNormalAlignment: Number($('alignment').value) }), true);
$('startTracking').onclick = () => command('tracking.start', {});
$('stopTracking').onclick = () => { if (confirm('Tracking stoppen und alle lokalen Platzierungen löschen?')) command('tracking.stop', {}); };
$('retryTracking').onclick = () => { if (confirm('Tracking neu starten und alle lokalen Platzierungen löschen?')) command('tracking.retry', {}); };
$('connectionForm').onsubmit = event => { event.preventDefault(); accessToken = $('token').value; connect(); };
$('clearLog').onclick = () => $('events').replaceChildren();
setInterval(controls, 1000); connect();
