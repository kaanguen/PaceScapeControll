# PaceScape Control protocol 1

This is a separate protocol from RunningServer. Text JSON only, WebSocket path `/ws`.

## Connection

Within five seconds send:

```json
{"type":"hello","protocol":1,"role":"headset","token":""}
```

Dashboards use role `dashboard`. The server replies `{"type":"welcome","protocol":1}`. No access token is required; any legacy token field is ignored. Only one headset is accepted. The server pings every ten seconds; WebSocket clients must answer pong. Browser and .NET WebSocket implementations handle control frames.

## State

The headset sends a complete state every second and after applying a command:

```json
{"type":"state","state":{"deviceName":"Magic Leap 2","isEditor":false,"trackingEnabled":true,"phase":"Ready","startupStatus":"Ready","startupError":"","placedMarkers":1,"pendingMarkers":0,"paceMinutesPerKilometre":6,"spawnLane":1,"distanceBehindStartLine":0.5,"markerLength":0.1,"startupTimeoutSeconds":15,"maxTrackedMarkers":64,"placeOnFloor":true,"queryPadding":1,"maxMarkerPlaneDistance":0.15,"minimumNormalAlignment":0.9}}
```

The simulator adds `isSimulation:true`. No device position or running physiology is transmitted. State describes configured target pace, not measured physical speed. Run-control-capable clients also include `runnerControlVersion: 1`, `runState: "Ready" | "Running" | "Paused"`, `runnableMarkers` (visible tracked anchor count) and `canRun` (foreground Ready tracking with every current placement tracked). The server rejects new run commands for clients without this capability.

The server sends dashboards `{"type":"status","headsetConnected":true,"state":{...},"updatedAt":1790000000000,"pending":0}`. `updatedAt` is server reception time in Unix milliseconds. Disconnection clears state. No persistent state or command replay.

## Commands

Dashboard sends:

```json
{"type":"command","requestId":"dashboard-local-id","commandType":"runner.pace","payload":{"paceMinutesPerKilometre":6.5}}
```

Relay generates a UUID and forwards:

```json
{"type":"command","commandId":"server-generated-uuid","commandType":"runner.pace","payload":{"paceMinutesPerKilometre":6.5}}
```

| Command | Required payload |
| --- | --- |
| `runner.configure`, `run.start` | All three fields: `paceMinutesPerKilometre` number 0.1–60, `spawnLane` integer 1–8, `distanceBehindStartLine` number 0–1000 |
| `run.pause`, `run.resume`, `run.reset` | `{}` |
| `runner.pace` | `paceMinutesPerKilometre`: number, 0.1–60 |
| `runner.spawn` | `spawnLane`: integer 1–8, `distanceBehindStartLine`: number 0–1000 |
| `tracking.configure` | `markerLength`: number 0.001–10, `startupTimeoutSeconds`: number 1–300, `maxTrackedMarkers`: integer 1–64 |
| `placement.configure` | `placeOnFloor`: boolean, `queryPadding`: number 0.1–100, `maxMarkerPlaneDistance`: number 0.001–10, `minimumNormalAlignment`: number 0–1 |
| `tracking.start`, `tracking.stop`, `tracking.retry` | `{}` |

Limits are transport/validation limits, not prescribed training parameters. All numbers must be finite; no implicit string conversion. Server and Unity both validate configuration. Settings apply to the current app process only. `runner.configure` applies all settings after validation; positional edits also reset existing waiting objects and are rejected during Running/Paused. Legacy `runner.spawn` follows the same position rule. Pace remains live. `run.start` accepts complete settings and only a Ready run with `canRun`; absence of placement rejects the command without changing settings or queuing a future start. `run.pause` retains positions; `run.resume` only resumes Paused with `canRun`. `run.reset` returns current objects to their configured start, retains anchors/track, and sets Ready. Newly observed markers are deferred while Running/Paused. There is no automatic resume. Detector and plane configuration restart active tracking; when stopped, they only update settings. Start and retry require a device build. Scene asset/prefab changes remain Editor operations.

After applying on Unity's main thread, send updated state, then:

```json
{"type":"ack","commandId":"server-generated-uuid","success":true,"error":""}
```

Failure uses `success:false` and a description. The relay returns the originating dashboard's `requestId`, generated `commandId`, success and error. Other dashboards see shared status/pending but do not receive this command's ACK. A successful start ACK indicates startup requested; use subsequent phase/status/error to assess XR readiness.

Only one pending command globally. Missing ACK fails after eight seconds. Stale state (>5 s) rejects commands. Disconnect fails pending work without replay. Timeouts/disconnects do not prove a command was never executed. Unity discards commands waiting >3 s in its main-thread queue. There is no automatic retry, and the endpoint does not expose arbitrary code execution.

## Liveness and interrupted runs

The server sends the headset `{"type":"control","protocol":1}` every second. Unity pauses a running session on observed disconnect or six seconds without a recent application heartbeat, then reconnects. The heartbeat is independent of low-level ping/pong; it is not a training parameter. Local tracking loss and backgrounding also pause the run. Recovered visibility, restored connectivity or a newly received heartbeat never resumes it. The operator explicitly sends `run.resume`. Closing only a dashboard does not stop the headset/server connection.

Tracking stop/retry and detector/plane configuration cleanup return the run to Ready and clear old placements; a fresh explicit start is required after reacquisition. Tracker initialization still begins with the app. All placed objects share one run state.


## Verbindung ohne Zugriffsschlüssel

Der Server lauscht jetzt standardmäßig auf `0.0.0.0:8787` und akzeptiert App und Dashboard ohne Zugriffsschlüssel. `npm start` genügt. Die App verwendet `ws://RECHNER-IP:8787/ws`; ein eventuell noch gesendeter alter Schlüssel wird ignoriert. `ACCESS_TOKEN` hat keine Wirkung mehr. Die lokale IP muss vom Gerät erreichbar sein. Alle Teilnehmer im erreichbaren lokalen Netz können die App steuern; den Port nicht öffentlich freigeben. Frühere Angaben zur verpflichtenden Schlüsselprüfung gelten nicht mehr.
