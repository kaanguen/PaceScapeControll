const panels = [...document.querySelectorAll('[data-body-tracking]')].map(panel => {
    const canvas = panel.querySelector('canvas');
    return { panel, canvas, context: canvas.getContext('2d'), status: panel.querySelector('[role="status"]') };
});
const palette = ['#45e5cd', '#ffba5c', '#95b4ff', '#fc94c0', '#b7ed80'];
const depthPanel = document.querySelector('[data-depth-tracking]');
const depthView = depthPanel && {
    canvas: depthPanel.querySelector('canvas'),
    status: depthPanel.querySelector('[role="status"]'),
    pixels: null
};
if (depthView) depthView.context = depthView.canvas.getContext('2d');

function setStatus(panel, message, live = false) {
    if (panel.status.textContent !== message) panel.status.textContent = message;
    panel.canvas.hidden = !live;
    if (!live) panel.context.clearRect(0, 0, panel.canvas.width, panel.canvas.height);
}

function drawSkeletons(context, width, bodies) {
    context.lineWidth = Math.max(2, width / 320);
    context.lineCap = 'round';
    for (const [id, segments] of bodies) {
        context.strokeStyle = palette[id % palette.length];
        context.beginPath();
        for (const [x1, y1, x2, y2] of segments) {
            context.moveTo(x1, y1);
            context.lineTo(x2, y2);
        }
        context.stroke();

        context.fillStyle = context.strokeStyle;
        context.beginPath();
        const radius = context.lineWidth;
        for (const [x1, y1, x2, y2] of segments) {
            context.moveTo(x1 + radius, y1);
            context.arc(x1, y1, radius, 0, Math.PI * 2);
            context.moveTo(x2 + radius, y2);
            context.arc(x2, y2, radius, 0, Math.PI * 2);
        }
        context.fill();
    }
}

function drawFrame({ canvas, context }, image, bodies) {
    if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width;
        canvas.height = image.height;
    }
    context.drawImage(image, 0, 0);
    drawSkeletons(context, canvas.width, bodies);
}

function drawDepth(view, width, height, samples) {
    const { canvas, context } = view;
    if (!view.pixels || canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        view.pixels = context.createImageData(width, height);
    }
    const pixels = view.pixels.data;
    for (let i = 0, offset = 0; i < samples.length; i++, offset += 4) {
        const value = samples[i];
        pixels[offset] = value;
        pixels[offset + 1] = value ? 64 + value * 0.75 : 0;
        pixels[offset + 2] = value ? 255 - value : 0;
        pixels[offset + 3] = 255;
    }
    context.putImageData(view.pixels, 0, 0);
}

let etag;
async function pollFrame() {
    let delay = 100;
    try {
        const response = await fetch('/api/body-tracking/frame', {
            cache: 'no-store',
            headers: etag ? { 'If-None-Match': etag } : {},
            signal: AbortSignal.timeout(2000)
        });
        if (response.status === 304) return;
        if (response.status === 204 || response.status === 403) {
            etag = undefined;
            const text = response.status === 403
                ? 'Femto-Bolt-Livebild am Kamerarechner öffnen.'
                : 'Warte auf den Femto-Bolt-Stream.';
            panels.forEach(panel => setStatus(panel, text));
            if (depthView) setStatus(depthView, text);
            delay = 500;
            return;
        }
        if (!response.ok) throw new Error('Frame unavailable');

        const buffer = await response.arrayBuffer();
        const metadataLength = new DataView(buffer).getUint32(0, true);
        const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, metadataLength)));
        const { bodies, depth, depthBodies = [] } = Array.isArray(metadata) ? { bodies: metadata } : metadata;
        const depthBytes = depth ? depth[0] * depth[1] : 0;
        const imageEnd = buffer.byteLength - depthBytes;
        const image = await createImageBitmap(new Blob([buffer.slice(4 + metadataLength, imageEnd)], { type: 'image/jpeg' }));
        try {
            const count = bodies.filter(([, segments]) => segments.length > 0).length;
            for (const panel of panels) {
                drawFrame(panel, image, bodies);
                setStatus(panel, count ? `Live · ${count} ${count === 1 ? 'Person' : 'Personen'}` : 'Live · Keine Person erkannt', true);
            }
            if (depthView && depthBytes) {
                drawDepth(depthView, depth[0], depth[1], new Uint8Array(buffer, imageEnd));
                drawSkeletons(depthView.context, depth[0], depthBodies);
                setStatus(depthView, 'Live', true);
            } else if (depthView) {
                setStatus(depthView, 'Der Kamerastream liefert kein Tiefenbild.');
            }
        } finally {
            image.close();
        }
        etag = response.headers.get('ETag');
    } catch {
        etag = undefined;
        panels.forEach(panel => setStatus(panel, 'Femto-Bolt-Stream nicht verfügbar.'));
        if (depthView) setStatus(depthView, 'Femto-Bolt-Stream nicht verfügbar.');
        delay = 1000;
    } finally {
        setTimeout(pollFrame, delay);
    }
}

if (panels.length) pollFrame();
