import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const trackProgress = vm.runInNewContext(source.slice(source.indexOf('function trackProgress('), source.indexOf('function clearCameraFrame(')) + '\ntrackProgress');
function state(overrides = {}) {
    return { comparisonControlVersion: 1, performance: { comparisonDistanceMetres: 400, lapDistanceMetres: 100, lapNumber: 2, lapValid: true, measuredSeconds: 60, measurementStatus: 'Measuring', ...overrides } };
}
test('shows measured progress including the start of a new lap without deriving it from ghost pace', () => {
    assert.equal(trackProgress(state(), true).progress, .25);
    assert.equal(trackProgress(state({ lapDistanceMetres: 0 }), true).progress, 0);
    assert.equal(trackProgress({ ...state(), activeRunnerPace: .1 }, true).progress, .25);
});
test('uses the selected comparison distance rather than assuming a physical 400m oval', () => {
    const result = trackProgress(state({ comparisonDistanceMetres: 5000, lapDistanceMetres: 2500 }), true);
    assert.equal(result.progress, .5);
    assert.equal(result.distanceLabel, '5.000 m');
});
test('suppresses markers on missing, stale, interrupted or invalid measurements', () => {
    assert.equal(trackProgress(null, false).progress, null);
    assert.equal(trackProgress(state(), false).progress, null);
    for (const overrides of [{ measurementStatus: 'NoSignal' }, { measurementStatus: 'Waiting' }, { measurementStatus: 'InterruptedLap' }, { lapValid: false }, { measuredSeconds: 0 }, { lapDistanceMetres: NaN }, { lapDistanceMetres: -1 }, { lapDistanceMetres: 401 }, { comparisonDistanceMetres: 0 }, { lapNumber: 0 }]) {
        assert.equal(trackProgress(state(overrides), true).progress, null, JSON.stringify(overrides));
    }
});
test('preserves and labels the last valid measurement while paused', () => {
    const result = trackProgress(state({ measurementStatus: 'Paused' }), true);
    assert.equal(result.progress, .25);
    assert.match(result.status, /Pausiert/);
    assert.match(result.description, /keine räumliche Ortung/);
});

test('shows independent ghost progress while running without a current belt measurement', () => {
    const running = { ...state({ measurementStatus: 'NoSignal', ghostDistanceMetres: 450 }), runState: 'Running' };
    assert.equal(trackProgress(running, true).ghostProgress, .125);
    assert.equal(trackProgress(running, true).progress, null);
    assert.equal(trackProgress(running, false).ghostProgress, null);
    assert.equal(trackProgress({ ...running, runState: 'Ready' }, true).ghostProgress, null);
});

test('uses the shared comparison gap to show an overtake across the lap boundary', () => {
    const paused = { ...state({ measurementStatus: 'Paused', lapDistanceMetres: 10, ghostDistanceMetres: 180,
        hasProgressComparison: true, userLeadMetres: 30 }), runState: 'Paused' };
    assert.equal(trackProgress(paused, true).ghostProgress, .95);
});
