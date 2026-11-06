import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const result = vm.runInNewContext(source.slice(source.indexOf('function sessionPrResult(')) + '\nsessionPrResult');
const measured = { sessionRecordVersion: 1, sessionNewPersonalBest: true, sessionBestSeconds: 118, sessionPreviousBestSeconds: 120 };
test('confirms an improved saved record with an actual time difference', () => {
    const pr = result(measured, true);
    assert.equal(pr.confirmed, true);
    assert.equal(pr.label, 'PR geknackt');
    assert.match(pr.description, /2 Sekunden schneller/);
});
test('distinguishes first records from beaten prior records', () => {
    assert.equal(result({ ...measured, sessionPreviousBestSeconds: 0 }, true).label, 'Erster PR');
});
test('never confirms unsaved, failed, legacy or unmeasured records', () => {
    for (const overrides of [{ savePending: true }, { storageError: 'disk full' }, { sessionRecordVersion: 0 }, { sessionNewPersonalBest: false }, { sessionBestSeconds: 0 }, { sessionBestSeconds: 121 }, { sessionPreviousBestSeconds: -1 }]) {
        assert.equal(result({ ...measured, ...overrides }, true).confirmed, false);
    }
    assert.equal(result(null, false).confirmed, false);
});
