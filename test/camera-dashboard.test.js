import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const cameraFunctions = source.slice(source.indexOf('function clearCameraFrame('), source.indexOf('function renderSessionSummary('));

test('camera frames are exposed to the image element as JPEG blobs', () => {
    const elements = new Map();
    const element = () => ({
        hidden: false,
        src: '',
        classList: { toggle() {} },
        removeAttribute(name) { if (name === 'src') this.src = ''; }
    });
    const $ = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    const urls = new Map();
    const context = vm.createContext({
        $, Blob, Date, window: { addEventListener() {} },
        URL: {
            createObjectURL(blob) { const url = `blob:${urls.size}`; urls.set(url, blob); return url; },
            revokeObjectURL(url) { urls.delete(url); }
        },
        cameraFrameUrl: null,
        cameraFrameAt: 0,
        pending: null,
        fresh: () => true,
        snapshot: { state: { cameraControlVersion: 1, camera: { supported: true, enabled: true } } },
        renderCameraControls() {}
    });
    vm.runInContext(`${cameraFunctions}\nreceiveCameraFrame(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));`, context);

    assert.equal(urls.get('blob:0').type, 'image/jpeg');
    $('cameraFrame').onload();
    assert.equal($('cameraFrame').hidden, false);
    assert.equal($('cameraEmpty').hidden, true);
});
