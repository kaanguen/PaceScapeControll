import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulationState, applySimulationCommand } from '../scripts/simulate-headset.js';
const settings = { paceMinutesPerKilometre: 6.5, spawnLane: 4, distanceBehindStartLine: 0.75 };
const apply = (s, commandType, payload = {}) => applySimulationCommand(s, { commandType, payload });

test('simulator waits for explicit start and supports configure/start/pause/resume/reset', () => {
    const s = createSimulationState();
    assert.equal(s.runState, 'Ready');
    assert.equal(apply(s, 'runner.configure', settings).success, true);
    assert.equal(s.runState, 'Ready');
    assert.equal(apply(s, 'run.start', settings).success, true);
    assert.equal(s.runState, 'Running');
    assert.equal(apply(s, 'run.start', settings).success, false);
    assert.equal(apply(s, 'run.pause').success, true);
    assert.equal(s.runState, 'Paused');
    assert.equal(apply(s, 'run.resume').success, true);
    assert.equal(apply(s, 'run.reset').success, true);
    assert.equal(s.runState, 'Ready');
    assert.equal(s.placedMarkers, 1);
    assert.equal(s.spawnLane, 4);
});

test('simulator rejects untracked start/resume and positional edits during an active run', () => {
    const s = createSimulationState();
    s.canRun = false;
    assert.equal(apply(s, 'run.start', settings).success, false);
    assert.equal(s.spawnLane, 1);
    s.canRun = true;
    apply(s, 'run.start', settings);
    assert.equal(apply(s, 'runner.configure', { ...settings, spawnLane: 8 }).success, false);
    assert.equal(s.spawnLane, 4);
    assert.equal(apply(s, 'runner.configure', { ...settings, paceMinutesPerKilometre: 5 }).success, true);
    assert.equal(s.runState, 'Running');
    apply(s, 'run.pause'); s.canRun = false;
    assert.equal(apply(s, 'run.resume').success, false);
    assert.equal(s.runState, 'Paused');
});

test('simulated tracking restart clears run state while stop clears placement', () => {
    const s = createSimulationState();
    apply(s, 'run.start', settings);
    apply(s, 'tracking.stop');
    assert.equal(s.runState, 'Ready');
    assert.equal(s.placedMarkers, 0);
    assert.equal(s.canRun, false);
    assert.equal(apply(s, 'run.start', settings).success, false);
    apply(s, 'tracking.start');
    assert.equal(s.runState, 'Ready');
    assert.equal(s.canRun, true);
    assert.equal(s.isSimulation, true);
});

test('mode changes retain settings and pause; invalid and repeated modes do not alter the run', () => {
    const state = createSimulationState();
    state.runState = 'Running';
    const settings = { paceMinutesPerKilometre: state.paceMinutesPerKilometre, spawnLane: state.spawnLane, distanceBehindStartLine: state.distanceBehindStartLine };
    assert.equal(applySimulationCommand(state, { commandType: 'runner.mode', payload: { runnerMode: 'AllTimePersonalBest' } }).success, true);
    assert.equal(state.runState, 'Paused');
    assert.equal(state.runnerMode, 'AllTimePersonalBest');
    for (const [key, value] of Object.entries(settings)) assert.equal(state[key], value);
    state.runState = 'Running';
    assert.equal(applySimulationCommand(state, { commandType: 'runner.mode', payload: { runnerMode: 'AllTimePersonalBest' } }).success, true);
    assert.equal(state.runState, 'Running');
    assert.equal(applySimulationCommand(state, { commandType: 'runner.mode', payload: { runnerMode: 'GhostRunner' } }).success, false);
    assert.equal(state.runnerMode, 'AllTimePersonalBest');
    assert.equal(state.runState, 'Running');
    applySimulationCommand(state, { commandType: 'run.reset', payload: {} });
    assert.equal(state.runnerMode, 'AllTimePersonalBest');
});

test('comparison demonstration values stay separate from measured PRs and distance changes require reset', () => {
    const state = createSimulationState();
    assert.equal(apply(state, 'runner.comparison', { comparisonDistanceMetres: 5000, useDemoRecords: true }).success, true);
    assert.equal(apply(state, 'runner.mode', { runnerMode: 'AllTimePersonalBest' }).success, true);
    assert.equal(state.activeRunnerPace, 5);
    assert.equal(state.performance.allTimeBestSeconds, 0);
    assert.deepEqual(state.performance.records, []);
    state.runState = 'Running';
    assert.equal(apply(state, 'runner.comparison', { comparisonDistanceMetres: 10000, useDemoRecords: true }).success, false);
    state.runState = 'Paused';
    assert.equal(apply(state, 'runner.comparison', { comparisonDistanceMetres: 10000, useDemoRecords: true }).success, false);
    assert.equal(apply(state, 'runner.comparison', { comparisonDistanceMetres: 5000, useDemoRecords: false }).success, true);
    assert.equal(state.activeRunnerPace, 6);
});

test('fixed ghost is the default and ignores the current-run best and belt speed', () => {
    const state = createSimulationState();
    assert.equal(state.runnerMode, 'FixedPace');
    assert.equal(state.ghostControlVersion, 1);
    state.performance.sessionBestSeconds = 80;
    state.treadmill = { connected: true, hasSpeed: true, speedKmh: 0 };
    assert.equal(apply(state, 'runner.pace', { paceMinutesPerKilometre: 6 }).success, true);
    assert.equal(state.activeRunnerPace, 6);
    assert.equal(apply(state, 'runner.mode', { runnerMode: 'FollowInput' }).success, false);
    assert.equal(state.runnerMode, 'FixedPace');
});
