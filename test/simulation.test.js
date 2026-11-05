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
