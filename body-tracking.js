const maxFrameBytes = 2 * 1024 * 1024;
const maxMetadataBytes = 32 * 1024;
const startOfImage = 0xffd8;
const endOfImage = 0xffd9;

function validSkeletons(bodies, width, height) {
    return Array.isArray(bodies) && bodies.length <= 32 && bodies.every(body =>
        Array.isArray(body) && body.length === 2 && Number.isInteger(body[0]) && body[0] >= 0 &&
        Array.isArray(body[1]) && body[1].length <= 31 && body[1].every(segment =>
            Array.isArray(segment) && segment.length === 4 && segment.every((value, index) =>
                Number.isFinite(value) && value >= 0 && value < (index % 2 === 0 ? width : height))));
}

function isValidFrame(frame) {
    if (frame.length < 10) return false;
    const metadataBytes = frame.readUInt32LE(0);
    const imageStart = 4 + metadataBytes;
    if (metadataBytes > maxMetadataBytes || imageStart + 4 > frame.length) return false;

    try {
        const metadata = JSON.parse(frame.toString('utf8', 4, imageStart));
        let bodies = metadata;
        let imageEnd = frame.length;
        if (!Array.isArray(metadata)) {
            const { bodies: tracks, depth, depthBodies } = metadata;
            if (!Array.isArray(depth) || depth.length !== 2 ||
                !depth.every(size => Number.isInteger(size) && size > 0 && size <= 1024)) return false;
            if (depthBodies !== undefined && !validSkeletons(depthBodies, depth[0], depth[1])) return false;
            bodies = tracks;
            imageEnd -= depth[0] * depth[1];
        }
        if (imageEnd < imageStart + 4 || frame.readUInt16BE(imageStart) !== startOfImage ||
            frame.readUInt16BE(imageEnd - 2) !== endOfImage) return false;

        return validSkeletons(bodies, 4096, 4096);
    } catch {
        return false;
    }
}

export const bodyPoseJointCount = 32;
const maxPoseBytes = 16 * 1024;

const isLocalRequest = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');

// One Azure Kinect skeleton: absolute joint rotations (x, y, z, w per joint) in depth-camera space
// and the SDK confidence level per joint (0 none, 1 low, 2 medium, 3 high).
export function parseBodyPose(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 3 || !Number.isInteger(value.bodyId) || value.bodyId < 0 ||
        value.bodyId > 0x7fffffff || !Array.isArray(value.rotations) ||
        value.rotations.length !== bodyPoseJointCount * 4 || !Array.isArray(value.confidence) ||
        value.confidence.length !== bodyPoseJointCount) return null;
    for (let joint = 0; joint < bodyPoseJointCount; joint++) {
        const q = value.rotations.slice(joint * 4, joint * 4 + 4);
        if (!q.every(Number.isFinite)) return null;
        const length = Math.hypot(...q);
        if (length < 0.9 || length > 1.1) return null;
        const confidence = value.confidence[joint];
        if (!Number.isInteger(confidence) || confidence < 0 || confidence > 3) return null;
    }
    // Rounded rotations keep relay messages small; 1e-5 is far below the SDK's angular resolution.
    return {
        bodyId: value.bodyId,
        rotations: value.rotations.map(v => Math.round(v * 1e5) / 1e5),
        confidence: [...value.confidence]
    };
}

// Poses older than this are not offered to the local Unity Editor preview (matches BodyMirrorDriver).
export const bodyPosePreviewMaxAgeMs = 500;

// Accepts 3D poses from the local PaceScapeBodyTrackingTest process; the relay decides whether to forward them.
// GET returns the newest pose to local non-browser clients only, for the Unity Editor body-mirror preview.
export function createBodyPoseRoute(onPose) {
    let latest;
    return async (req, res, headers) => {
        const finish = code => { res.writeHead(code, headers).end(); };
        if (!isLocalRequest(req)) return finish(403);
        if (req.method === 'GET') {
            if (req.headers.origin) return finish(403);
            if (!latest || Date.now() - latest.receivedAt > bodyPosePreviewMaxAgeMs) return finish(204);
            res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(latest.json);
        }
        if (req.method !== 'POST') return finish(405);
        if (req.headers.origin || req.headers['content-type'] !== 'application/json') return finish(415);
        const length = Number(req.headers['content-length']);
        if (!Number.isInteger(length) || length < 2 || length > maxPoseBytes) {
            res.setHeader('Connection', 'close');
            return finish(413);
        }

        const chunks = [];
        try {
            for await (const chunk of req) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            if (body.length !== length) return finish(400);
            const pose = parseBodyPose(JSON.parse(body.toString('utf8')));
            if (!pose) return finish(400);
            latest = { json: JSON.stringify(pose), receivedAt: Date.now() };
            onPose(pose);
            return finish(204);
        } catch {
            if (!res.destroyed) finish(400);
        }
    };
}

export function createBodyTrackingRoute() {
    let latest;
    let sequence = 0;
    const streamId = Date.now().toString(36);
    return async (req, res, headers) => {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
            /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
        const finish = code => { res.writeHead(code, headers).end(); };
        if (!local) return finish(403);

        if (req.method === 'GET') {
            if (!latest || Date.now() - latest.receivedAt > 2500) {
                latest = undefined;
                return finish(204);
            }
            const etag = '"' + streamId + '-' + latest.sequence + '"';
            if (req.headers['if-none-match'] === etag) return finish(304);
            res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', ETag: etag });
            return res.end(latest.frame);
        }

        if (req.method !== 'POST') return finish(405);
        if (req.headers.origin || req.headers['content-type'] !== 'application/octet-stream') return finish(415);
        const length = Number(req.headers['content-length']);
        if (!Number.isInteger(length) || length < 10 || length > maxFrameBytes) {
            res.setHeader('Connection', 'close');
            return finish(413);
        }

        const chunks = [];
        try {
            for await (const chunk of req) chunks.push(chunk);
            const frame = Buffer.concat(chunks);
            if (frame.length !== length || !isValidFrame(frame)) return finish(400);
            latest = { frame, receivedAt: Date.now(), sequence: ++sequence };
            return finish(204);
        } catch {
            if (!res.destroyed) finish(400);
        }
    };
}
