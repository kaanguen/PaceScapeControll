const $ = id => document.getElementById(id);
let socket, reconnectTimer, snapshot, pending, generation = 0, accessToken = '';
let queuedPace = null, paceTimer, selectedPace = 6;
const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
$('siteUrl').textContent = location.origin; $('wsUrl').textContent = wsUrl;
const names = { 'runner.create': 'Läufer spawnen', 'runner.remove': 'Läufer entfernen', 'runner.configure': 'Läufer einstellen', 'run.start': 'Lauf starten', 'run.pause': 'Lauf pausieren', 'run.resume': 'Weiterlaufen', 'run.reset': 'Lauf zurücksetzen', 'runner.pace': 'Pace ändern', 'runner.spawn': 'Startposition ändern', 'tracking.start': 'Tracking starten', 'tracking.stop': 'Tracking stoppen', 'tracking.retry': 'Tracking neu starten', 'tracking.configure': 'Erkennung konfigurieren', 'placement.configure': 'Platzierung konfigurieren' };
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
        $('startTracking').disabled = snapshot.state.testScene || snapshot.state.trackingEnabled;
        $('stopTracking').disabled = !snapshot.state.trackingEnabled;
        $('retryTracking').disabled = !snapshot.state.trackingEnabled;
        const state = snapshot.state;
        const supported = state.runnerControlVersion === 1;
        const canSpawn = state.testScene === true && state.spawnControlVersion === 1;
        $('spawnControls').disabled = !canSpawn;
        $('spawnRunner').disabled = state.runnerSpawned;
        $('removeRunner').disabled = !state.runnerSpawned;
        for (const id of ['trackingForm', 'placementForm']) $(id).querySelector('fieldset').disabled = state.testScene === true;
        $('runnerForm').querySelector('fieldset').disabled = !supported;
        $('runControls').disabled = !supported;
        $('lane').disabled = state.runState !== 'Ready';
        $('distance').disabled = state.runState !== 'Ready';
        $('startRun').disabled = state.runState !== 'Ready' || !state.canRun;
        $('pauseRun').disabled = state.runState !== 'Running' && !(state.runState === 'Paused' && state.canRun);
        $('resetRun').disabled = state.runState !== 'Running' && state.runState !== 'Paused';
    }
    $('livePaceForm').querySelector('fieldset').disabled = !fresh();
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
        $('deviceName').textContent = s.deviceName || 'Magic Leap 2'; $('deviceMode').textContent = s.testScene ? 'Unity-Testszene · ohne Markertracking' : s.isSimulation ? 'SIMULATION · keine echte Brille' : s.isEditor ? 'Unity Editor · kein Gerätetracking' : 'PaceScape · Magic Leap 2';
        $('paceConfirmed').textContent = paceText(s.paceMinutesPerKilometre) + ' min/km';
        $('paceValue').textContent = paceText(s.paceMinutesPerKilometre); $('speedValue').textContent = Number.isFinite(s.paceMinutesPerKilometre) && s.paceMinutesPerKilometre > 0 ? (60 / s.paceMinutesPerKilometre).toFixed(1) : '—';
        $('phase').textContent = phases[s.phase] || s.phase || '—'; $('markers').textContent = s.testScene ? (s.runnerSpawned ? '1' : '0') : s.placedMarkers ?? '—'; $('pendingMarkers').textContent = s.testScene ? 'Aus' : s.pendingMarkers ?? '—';
        $('trackingStatus').textContent = s.startupStatus || 'Keine Trackingmeldung.'; $('trackingError').textContent = s.startupError || ''; $('trackingError').hidden = !s.startupError;
        if (Number.isFinite(s.paceMinutesPerKilometre) && s.paceMinutesPerKilometre > 0) {
            if (!$('paceInput').dataset.dirty && document.activeElement !== $('paceInput')) {
                setSliderFromPace(s.paceMinutesPerKilometre);
            }
        }
        updateSliderLabel();
        for (const [id, key] of Object.entries({ lane: 'spawnLane', distance: 'distanceBehindStartLine', markerLength: 'markerLength', timeout: 'startupTimeoutSeconds', capacity: 'maxTrackedMarkers', floor: 'placeOnFloor', padding: 'queryPadding', planeDistance: 'maxMarkerPlaneDistance', alignment: 'minimumNormalAlignment' })) sync(id, s[key]);
        if (!wasFresh && fresh()) notice(s.testScene ? 'Unity-Testszene verbunden. Der Server steuert die echte Editor-Szene ohne Markertracking.' : s.isSimulation ? 'SIMULATION verbunden. Befehle steuern keine echte Brille.' : 'App verbunden. Steuerung bereit.');
    } else {
        for (const id of ['paceValue', 'speedValue', 'phase', 'markers', 'pendingMarkers']) $(id).textContent = '—';
        $('deviceMode').textContent = 'Noch keine App verbunden'; $('trackingStatus').textContent = 'Starte die aktualisierte PaceScape-App.'; $('trackingError').hidden = true;
        notice(message.headsetConnected ? 'Warte auf App-Zustand.' : 'Server bereit. Warte auf die PaceScape-App.');
    }
    $('spawnControls').hidden = s?.testScene !== true || s?.spawnControlVersion !== 1;
    $('placementCountLabel').textContent = s?.testScene ? 'Läufer in Testszene' : 'Platzierte Marker';
    $('pendingCountLabel').textContent = s?.testScene ? 'Markertracking' : 'Warten auf Boden';
    const supported = s?.runnerControlVersion === 1;
    const runNames = { Ready: 'Bereit', Running: 'Läuft', Paused: 'Pausiert' };
    $('runState').textContent = supported ? runNames[s.runState] || 'Unbekannt' : s ? 'App aktualisieren' : 'Keine App verbunden';
    $('runState').classList.toggle('online', supported && s.runState === 'Running');
    $('pauseRun').textContent = s?.runState === 'Paused' ? 'Weiterlaufen' : 'Pause';
    $('runHelp').textContent = !s ? 'App verbinden, Läufer einstellen und Marker platzieren. Der Läufer wartet auf deinen Start.'
        : !supported ? 'Für die Laufsteuerung die aktualisierte App neu bauen und auf der Brille installieren.'
        : s.runState === 'Running' ? 'Der Lauf läuft. Pace kannst du live ändern. Pause hält die Position; Zurücksetzen beendet den Lauf.'
        : s.runState === 'Paused' ? (s.canRun ? 'Der Lauf ist pausiert. Weiterlaufen nutzt die bestätigten Einstellungen; Pace vorher mit Läufer einstellen übernehmen.' : 'Der Lauf ist pausiert. Auf wiederhergestellte Verbindung und vollständiges Tracking warten, dann bewusst weiterlaufen.')
        : s.testScene ? (s.runnerSpawned ? 'Läufer gespawnt. Lauf starten übernimmt die Einstellungen und startet die Bewegung.' : 'Unity-Testszene bereit. Läufer einstellen und über Läufer spawnen erzeugen; danach Lauf starten.')
        : s.canRun ? 'Läufer platziert und getrackt. Lauf starten übernimmt Pace, Spur und Startabstand gemeinsam.'
        : 'Läufer bleibt stehen. Marker und Boden erfassen und auf vollständig getrackte Platzierungen warten.';
    const lane = s && Number.isInteger(s.spawnLane) && s.spawnLane >= 1 && s.spawnLane <= 8 ? s.spawnLane : null;
    $('activeLane').textContent = lane ?? '—';
    document.querySelectorAll('[data-lane]').forEach(element => element.classList.toggle('selected', Number(element.dataset.lane) === lane));
    controls();
}
function connect() {
    queuedPace = null; clearTimeout(paceTimer); delete $('paceInput').dataset.dirty;
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
            if (m.success) pending.form?.querySelectorAll('input,select').forEach(input => {
                if (input.id !== 'paceInput' || Math.abs(selectedPace - pending.paceTarget) < 0.0000001) delete input.dataset.dirty;
            });
            if (pending.paceText) $('paceSync').textContent = m.success ? 'Von der App bestätigt.' : 'Übertragung fehlgeschlagen. Eingabe erneut ändern oder Enter drücken.';
            pending = null; log(text); notice(text, !m.success); controls();
        }
        if (m.type === 'error') { log(`Server: ${m.error}`); notice(m.error, true); }
    };
    socket.onclose = event => {
        if (current !== generation) return;
        if (pending) { clearTimeout(pending.timer); log(`${pending.name}: Verbindung verloren; Ausführung unklar.`); pending = null; }
        queuedPace = null; clearTimeout(paceTimer); delete $('paceInput').dataset.dirty;
        $('paceConfirmed').textContent = '—'; $('paceSync').textContent = 'Verbindung getrennt. Keine automatische Wiederholung.';
        snapshot = null; $('connection').textContent = 'Server getrennt'; $('connection').classList.remove('online'); render({ headsetConnected: false, state: null });
        notice(event.code === 1008 ? `Verbindung abgelehnt: ${event.reason}. Verbindung prüfen und neu verbinden.` : 'Server nicht erreichbar. Verbindung wird erneut versucht.', true);
        if (event.code !== 1008) reconnectTimer = setTimeout(connect, 2500);
    };
    socket.onerror = () => {};
}
function command(commandType, payload, form = null) {
    if (!fresh() || pending || snapshot.pending) return notice('Warte auf eine aktuelle Verbindung oder laufende Bestätigung.', true);
    // Also works on an explicitly enabled HTTP LAN origin without secure-context APIs.
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending = { id, name: names[commandType], form, paceTarget: payload.paceMinutesPerKilometre, paceText: commandType === 'runner.pace' ? $('paceInput').value : null, timer: setTimeout(() => {
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
function runnerSettings() {
    const paceMinutesPerKilometre = selectedPace;
    const spawnLane = Number($('lane').value), distanceBehindStartLine = Number($('distance').value);
    if (paceMinutesPerKilometre < 0.1 || paceMinutesPerKilometre > 60) throw new Error('Pace muss zwischen 0:06 und 60:00 liegen.');
    if (!Number.isInteger(spawnLane) || spawnLane < 1 || spawnLane > 8 || !Number.isFinite(distanceBehindStartLine) || distanceBehindStartLine < 0 || distanceBehindStartLine > 1000) throw new Error('Spur oder Startabstand ungültig.');
    return { paceMinutesPerKilometre, spawnLane, distanceBehindStartLine };
}
bind('runnerForm', 'runner.configure', runnerSettings);
$('startRun').onclick = () => {
    if (!$('runnerForm').reportValidity()) return;
    try { command('run.start', runnerSettings(), $('runnerForm')); } catch (error) { notice(error.message, true); }
};
$('spawnRunner').onclick = () => {
    if (!$('runnerForm').reportValidity()) return;
    try { command('runner.create', runnerSettings(), $('runnerForm')); } catch (error) { notice(error.message, true); }
};
$('removeRunner').onclick = () => command('runner.remove', {});
$('pauseRun').onclick = () => command(snapshot?.state?.runState === 'Paused' ? 'run.resume' : 'run.pause', {});
$('resetRun').onclick = () => command('run.reset', {});
bind('trackingForm', 'tracking.configure', () => ({ markerLength: Number($('markerLength').value), startupTimeoutSeconds: Number($('timeout').value), maxTrackedMarkers: Number($('capacity').value) }), true);
bind('placementForm', 'placement.configure', () => ({ placeOnFloor: $('floor').checked, queryPadding: Number($('padding').value), maxMarkerPlaneDistance: Number($('planeDistance').value), minimumNormalAlignment: Number($('alignment').value) }), true);
$('startTracking').onclick = () => command('tracking.start', {});
$('stopTracking').onclick = () => { if (confirm('Tracking stoppen und alle lokalen Platzierungen löschen?')) command('tracking.stop', {}); };
$('retryTracking').onclick = () => { if (confirm('Tracking neu starten und alle lokalen Platzierungen löschen?')) command('tracking.retry', {}); };
$('connectionForm').onsubmit = event => { event.preventDefault(); accessToken = $('token').value; connect(); };
$('clearLog').onclick = () => $('events').replaceChildren();
setInterval(controls, 1000); connect();

function flushPace() {
    if (queuedPace === null || !fresh() || pending || snapshot.pending) return;
    const pace = queuedPace; queuedPace = null;
    $('paceSync').textContent = 'Wird an die App übertragen …';
    command('runner.pace', { paceMinutesPerKilometre: pace }, $('livePaceForm'));
}
function schedulePace(immediate = false) {
    clearTimeout(paceTimer); queuedPace = null;
    const value = selectedPace;
    updateSliderLabel();
    if (!Number.isFinite(value) || value < 0.1 || value > 60) return;
    $('paceSync').textContent = 'Änderung wird automatisch übernommen …';
    paceTimer = setTimeout(() => { queuedPace = value; flushPace(); }, immediate ? 0 : 500);
}
$('paceInput').addEventListener('input', () => {
    selectedPace = $('paceUnit').value === 'pace' ? Number($('paceInput').value) / 60 : 60 / Number($('paceInput').value);
    schedulePace();
});
$('paceUnit').addEventListener('change', () => setSliderFromPace(selectedPace));
$('livePaceForm').onsubmit = event => { event.preventDefault(); schedulePace(true); };
setInterval(flushPace, 100);

function setSliderFromPace(pace) {
    selectedPace = pace;
    const slider = $('paceInput'), isPace = $('paceUnit').value === 'pace';
    slider.min = isPace ? 6 : 1;
    slider.max = isPace ? Math.max(900, Math.ceil(pace * 60)) : Math.max(30, 60 / pace);
    slider.step = isPace ? 1 : 0.1;
    slider.value = isPace ? pace * 60 : 60 / pace;
    slider.classList.toggle('pace-mode', isPace);
    $('sliderUnitLabel').textContent = isPace ? 'Pace' : 'Geschwindigkeit';
    $('sliderMinimum').textContent = isPace ? paceText(Number(slider.max) / 60) + ' min/km' : '1 km/h';
    $('sliderMaximum').textContent = isPace ? '0:06 min/km' : Number(slider.max).toLocaleString('de-DE') + ' km/h';
    updateSliderLabel();
}
function updateSliderLabel() {
    const isPace = $('paceUnit').value === 'pace';
    const display = pace => isPace ? paceText(pace) + ' min/km' : (60 / pace).toLocaleString('de-DE', {maximumFractionDigits: 1}) + ' km/h';
    $('sliderSpeed').textContent = display(selectedPace);
    $('paceInput').setAttribute('aria-valuetext', display(selectedPace));
    const confirmed = snapshot?.state?.paceMinutesPerKilometre;
    $('paceConfirmed').textContent = Number.isFinite(confirmed) && confirmed > 0 ? display(confirmed) : '—';
}
setSliderFromPace(selectedPace);
