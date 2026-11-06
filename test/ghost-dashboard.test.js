import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function view(overrides = {}, mode = 'AllTimePersonalBest') {
    const elements = new Map();
    const element = () => ({ textContent: '', dataset: {}, children: [], append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
    const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const context = vm.createContext({ $, sync: (id, value) => { $(id).value = value; }, document: { createElement: element }, state: {
        runnerMode: mode, activeRunnerPace: 5, comparisonControlVersion: 1,
        performance: { ghostReplayVersion: 1, ghostReferenceDistanceMetres: 10000, ghostPlayback: 'RecordedTrace', ghostReferenceAchievedUtc: '2026-11-06T10:00:00Z', ghostDistanceMetres: 5100, hasProgressComparison: true, userLeadMetres: 12,
            comparisonDistanceMetres: 5000, measuredDistanceMetres: 5112, measuredSeconds: 1500, lapNumber: 2, lapDistanceMetres: 112, lapSeconds: 40, lapValid: true, lapAverageSpeedKmh: 10, allTimeBestSeconds: 1500, recordCount: 0, ...overrides }
    } });
    vm.runInContext(`function paceText(value) { return '5:00'; }\n${source.slice(source.indexOf('function durationText('), source.indexOf('// Circular lane controls'))}\nrenderPerformance(state);`, context);
    return $;
}

test('dynamic dashboard distinguishes active longer reference from selected measurement distance', () => {
    const $ = view();
    assert.match($('ghostReplayStatus').textContent, /Referenz 10 km/);
    assert.equal($('measuredLength').textContent, '5 km');
    assert.match($('comparisonEffort').textContent, /5:00 min\/km/);
    assert.doesNotMatch($('comparisonEffort').textContent, /25:00/);
    assert.equal($('ghostLead').textContent, '12.0 m vor dem Ghost');
});
test('holding final speed is labelled explicitly', () => {
    const $ = view({ ghostPlayback: 'HoldingSpeed' });
    assert.equal($('comparisonSource').textContent, 'Letztes Tempo halten');
    assert.match($('ghostReplayStatus').textContent, /zusammengesetzten Vergleich/);
});
test('missing measurement continuity suppresses apparent overtaking', () => {
    assert.equal(view({ hasProgressComparison: false })('ghostLead').textContent, 'Kein durchgängiger Messvergleich');
});
test('legacy average and fixed pace remain distinct from recorded replay', () => {
    assert.equal(view({ ghostPlayback: 'RecordAverage' })('comparisonSource').textContent, 'Rekord · Durchschnittspace');
    assert.equal(view({}, 'FixedPace')('comparisonSource').textContent, 'Voreingestelltes Ghost-Tempo');
});
