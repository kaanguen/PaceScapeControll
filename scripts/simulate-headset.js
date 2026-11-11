import WebSocket from 'ws';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands } from '../server.js';

const warmupPlans = new WeakMap();
function resetWarmup(state, status = 'Idle') {
    warmupPlans.delete(state);
    state.canRun = state.trackingEnabled && state.runnableMarkers > 0;
    state.warmup = {
        active: false, canStart: state.runState === 'Ready' && state.trackingEnabled,
        status, stepIndex: -1, stepCount: 0, animationId: null, stepElapsed: 0, stepDuration: 0
    };
}

function showWarmupStep(state, index, elapsed = 0) {
    const plan = warmupPlans.get(state);
    if (index >= plan.length) return resetWarmup(state, 'Completed');
    const step = plan[index];
    state.canRun = false;
    state.warmup = { active: true, canStart: false, status: 'Playing', stepIndex: index,
        stepCount: plan.length, animationId: step.animationId, stepElapsed: elapsed, stepDuration: step.seconds };
}

function tickWarmup(state, delta) {
    const plan = warmupPlans.get(state);
    if (!plan) return;
    let { stepIndex: index, stepElapsed: elapsed } = state.warmup;
    elapsed += delta;
    while (index < plan.length && elapsed >= plan[index].seconds) {
        elapsed -= plan[index].seconds;
        index++;
    }
    showWarmupStep(state, index, elapsed);
}

export function createSimulationState() {
    const state = { warmupControlVersion: 1, deviceName: 'PaceScape Simulator', isSimulation: true, isEditor: false, trackingEnabled: true, phase: 'Ready', startupStatus: 'Simulation – ein synthetischer Marker; keine echte Brillenprüfung.', startupError: '', placedMarkers: 1, pendingMarkers: 0, runnerControlVersion: 1, runnerModeControlVersion: 1, ghostControlVersion: 1, runnerMode: 'FixedPace', comparisonControlVersion: 1, activeRunnerPace: 6, performance: { comparisonDistanceMetres: 400, useDemoRecords: false, measuredDistanceMetres: 0, measuredSeconds: 0, lapNumber: 1, lapDistanceMetres: 0, lapSeconds: 0, lapValid: true, lapAverageSpeedKmh: 0, sessionBestSeconds: 0, allTimeBestSeconds: 0, targetExampleSeconds: 0, measurementStatus: 'NoSignal', records: [], laps: [] }, runState: 'Ready', runnableMarkers: 1, canRun: true, paceMinutesPerKilometre: 6, spawnLane: 1, distanceBehindStartLine: 0.5, markerLength: 0.1, startupTimeoutSeconds: 15, maxTrackedMarkers: 64, placeOnFloor: true, queryPadding: 1, maxMarkerPlaneDistance: 0.15, minimumNormalAlignment: 0.9 };
    resetWarmup(state);
    return state;
}

export function applySimulationCommand(state, message) {
    const { commandType: type, payload: p } = message;
    if (!Object.hasOwn(commands, type) || !p || !commands[type](p)) return { success: false, error: 'Invalid command or parameters.' };
    const positionChanges = p.spawnLane !== undefined && (p.spawnLane !== state.spawnLane || p.distanceBehindStartLine !== state.distanceBehindStartLine);
    if (type === 'exercise.startWarmup') {
        if (!state.warmup.canStart) return { success: false, error: 'Warm-up requires a waiting session and active tracking.' };
        warmupPlans.set(state, structuredClone(p.steps));
        showWarmupStep(state, 0);
    } else if (type === 'exercise.nextWarmup' || type === 'exercise.stopWarmup') {
        if (!state.warmup.active) return { success: false, error: 'No active warm-up.' };
        if (type === 'exercise.nextWarmup') showWarmupStep(state, state.warmup.stepIndex + 1);
        else resetWarmup(state, 'Stopped');
    } else if (type === 'runner.comparison') {
        if (state.runState === 'Running' || (p.comparisonDistanceMetres !== state.performance.comparisonDistanceMetres && state.runState !== 'Ready')) return { success: false, error: 'Reset before changing comparison distance; pause before changing demonstration settings.' };
        Object.assign(state.performance, p);
    } else if (type === 'runner.mode') {
        if (state.runnerMode !== p.runnerMode && state.runState === 'Running') state.runState = 'Paused';
        state.runnerMode = p.runnerMode;
    } else if (type === 'run.start') {
        if (state.runState !== 'Ready' || !state.canRun) return { success: false, error: 'Start requires a waiting run and tracked placement.' };
        Object.assign(state, p); state.runState = 'Running';
        resetWarmup(state, state.warmup.status);
    } else if (type === 'run.pause') {
        if (state.runState !== 'Running') return { success: false, error: 'Only a running session can be paused.' };
        state.runState = 'Paused';
    } else if (type === 'run.resume') {
        if (state.runState !== 'Paused' || !state.canRun) return { success: false, error: 'Resume requires a paused run and tracked placement.' };
        state.runState = 'Running';
    } else if (type === 'run.reset') {
        state.runState = 'Ready';
        resetWarmup(state, state.warmup.active ? 'Stopped' : state.warmup.status);
    } else if (type.startsWith('runner.')) {
        if (positionChanges && (state.runState !== 'Ready' || state.warmup.active)) return { success: false, error: 'Reset the run before changing its start position.' };
        Object.assign(state, p);
    } else {
        Object.assign(state, p); state.runState = 'Ready';
        if (type === 'tracking.stop') { state.trackingEnabled = false; state.phase = 'Stopped'; state.placedMarkers = 0; }
        else if (type === 'tracking.start' || type === 'tracking.retry') { state.trackingEnabled = true; state.phase = 'Ready'; state.placedMarkers = 1; }
        state.runnableMarkers = state.trackingEnabled ? state.placedMarkers : 0;
        resetWarmup(state, state.warmup.active ? 'TrackingLost' : state.warmup.status);
    }
    const demos = { 400: 120, 5000: 1500, 10000: 3300 };
    state.performance.targetExampleSeconds = state.performance.useDemoRecords ? demos[state.performance.comparisonDistanceMetres] || 0 : 0;
    state.activeRunnerPace = state.runnerMode === 'AllTimePersonalBest' && state.performance.targetExampleSeconds > 0 ? state.performance.targetExampleSeconds * 1000 / state.performance.comparisonDistanceMetres / 60 : state.paceMinutesPerKilometre;
    return { success: true, error: '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const ws = new WebSocket(process.env.SERVER_URL || 'ws://127.0.0.1:8787/ws');
    const state = createSimulationState();
    const send = m => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    const publish = () => send({ type: 'state', state });
    ws.on('open', () => send({ type: 'hello', role: 'headset', protocol: 1, token: process.env.ACCESS_TOKEN || '' }));
    let lastTick = performance.now();
    ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.type === 'welcome') { console.log('SIMULATION connected. No actual headset or marker is used.'); publish(); }
        if (m.type !== 'command') return;
        const now = performance.now();
        tickWarmup(state, (now - lastTick) / 1000);
        lastTick = now;
        const result = applySimulationCommand(state, m);
        publish(); send({ type: 'ack', commandId: m.commandId, ...result });
    });
    const timer = setInterval(() => {
        const now = performance.now();
        tickWarmup(state, (now - lastTick) / 1000);
        lastTick = now;
        publish();
    }, 250);
    ws.on('error', error => console.error(error.message));
    ws.on('close', () => { state.runState = 'Paused'; clearInterval(timer); console.log('Simulation disconnected.'); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => ws.close());
}
