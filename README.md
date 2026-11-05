# PaceScape Control

Lokaler Server mit deutscher Steuerungswebsite für die aktuelle PaceScape-App auf Magic Leap 2. Orientiert am früheren RunningServer, mit einem eigenen, auf die vorhandenen PaceScape-Funktionen begrenzten Protokoll. Der frühere Server bleibt unverändert.

## Starten

Voraussetzung: Node.js 22 oder neuer.

```sh
cd /Users/kaan/Work/PaceScapeControl
npm ci
npm start
```

Website: http://localhost:8787 · WebSocket: `ws://localhost:8787/ws`.

Mit Strg+C beenden. `npm test` prüft den Server. `npm run simulate` startet in einem zweiten Terminal eine klar gekennzeichnete Test-Brille; sie muss vor dem Verbinden der echten Brille beendet werden. Die Simulation prüft keine Unity-Funktionen.

## Brille per USB verbinden (Standard)

1. Die aktualisierte PaceScape-App mit den neuen `RemoteControl`-Skripten und dem geänderten Android-Manifest in Unity kompilieren, neu bauen und auf der Brille installieren. Der Client wird beim Start der Tracking-Szene automatisch angelegt; keine Szenenänderung nötig.
2. Die Brille per USB verbinden und USB-Debugging freigeben. ADB muss verfügbar sein.
3. `adb reverse tcp:8787 tcp:8787` ausführen. Die Regel nach einem Neustart oder erneutem Anschließen gegebenenfalls wieder setzen. Bei mehreren Geräten `adb -s GERÄTESERIENNUMMER reverse tcp:8787 tcp:8787` verwenden.
4. Die App starten und die Website am Rechner öffnen. Die App verbindet sich mit `ws://127.0.0.1:8787/ws`. Ohne USB-Weiterleitung bedeutet localhost auf der Brille die Brille selbst.

Der Server bindet standardmäßig nur an `127.0.0.1`. Website und App stellen jeweils eine WebSocket-Verbindung zu diesem Server her. Eine Brille und mehrere Dashboards werden unterstützt. Die Website sendet alle Steuerbefehle über WebSocket.

## Optional im lokalen WLAN

Rechner und Brille müssen einander erreichen können. Server bewusst für das LAN starten:

```sh
HOST=0.0.0.0 ACCESS_TOKEN='hier-eigenen-zufälligen-schlüssel-einsetzen' npm start
```

Für LAN-Bindung sind mindestens 16 Zeichen erforderlich. Den gleichen Schlüssel auf der Website unter „Lokale Verbindung“ eingeben und „Neu verbinden“ wählen. Er bleibt nur im Arbeitsspeicher des Tabs.

Die App liest beim Start optional `pacescape-control.json` aus `Application.persistentDataPath`:

```json
{
  "Enabled": true,
  "ServerUrl": "ws://192.168.1.42:8787/ws",
  "AccessToken": "hier-eigenen-zufälligen-schlüssel-einsetzen"
}
```

Die IP durch die Adresse des Rechners ersetzen. Android-Pfad beim derzeitigen Paketnamen: `/sdcard/Android/data/com.Kaan.PaceScape/files/pacescape-control.json`. Beispiel zum Übertragen einer selbst angelegten Datei:

```sh
adb shell mkdir -p /sdcard/Android/data/com.Kaan.PaceScape/files
adb push pacescape-control.json /sdcard/Android/data/com.Kaan.PaceScape/files/pacescape-control.json
```

Dann die App neu starten. Ohne Datei gelten die USB-Standardwerte. Mit `{"Enabled":false}` lässt sich die Verbindung abschalten. Einstellungen und Befehlsänderungen werden nur im laufenden App-Prozess gehalten; der Server speichert keine Trainingsdaten. Eine bestehende Verbindungsdatei bleibt auf dem Gerät erhalten.

`PORT=8788 npm start` verwendet einen anderen Port. Dann USB-Regel und `ServerUrl` entsprechend anpassen.

`ws://` ist unverschlüsselt, auch im LAN. Der Zugriffsschlüssel schützt vor unerwünschtem Verbinden, verschlüsselt aber weder Befehle noch Schlüssel. Den Dienst nur lokal oder in einem vertrauenswürdigen Netz nutzen, ohne öffentliche Portfreigabe. Das Manifest erlaubt den hierfür nötigen Internetzugriff und unverschlüsselten lokalen Verkehr. Der Client prüft Zertifikate bei `wss://` regulär; der mitgelieferte Server selbst bietet kein TLS an.

## Aktuell steuerbar

| Funktion | Wirkung |
| --- | --- |
| Pace als `6:30` | 6,5 Minuten/km; wirkt live auf bestehende und zukünftige Objekte |
| Spur 1–8, Abstand hinter Startlinie | Gilt nur für neue Markerplatzierungen; vorhandene Objekte bleiben auf ihrer bisherigen Bahn |
| Tracking starten | Aktiviert den Tracker; bedeutet Start angefordert, nicht schon bereit |
| Tracking stoppen | Deaktiviert den Tracker und löscht lokale Platzierungen |
| Tracking neu starten | Löscht Platzierungen und startet die Erkennung neu |
| Markergröße, Start-Timeout, Markerkapazität | Übernimmt Konfiguration und startet aktives Tracking neu |
| Bodenmodus, Suchzugabe, strikte Oberflächenparameter | Übernimmt Konfiguration und startet aktives Tracking neu |
| Status | Echte App-Werte: Startphase, Diagnose, Fehler, platzierte und wartende Marker |

Bei gestopptem Tracking werden Konfigurationen gespeichert, aber kein Start erzwungen. Die nächste Aktivierung verwendet die Werte. AprilTag 36H11 und die bestehende Streckengeometrie bleiben fest. Ein ACK für Tracking-Konfiguration bedeutet „übernommen / Neustart angefordert“. Ob XR und Berechtigungen erfolgreich starten, zeigen nachfolgende Statusmeldungen.

Die Eingabegrenzen sind technische Validierungsgrenzen, keine Trainingsempfehlungen: Pace 0:06–60:00 min/km, Startabstand 0–1000 m, Markergröße 0,001–10 m, Start-Timeout 1–300 s, Markerzahl 1–64, Suchzugabe 0,1–100 m, Oberflächenabstand 0,001–10 m und Normalenausrichtung 0–1. Die bisherigen Standardwerte werden nicht geändert.

Keine BLE-, Laufband-, Herzfrequenz-, Trainingsplan- oder Messdatenfunktionen: Diese sind in PaceScape noch nicht implementiert. Prefabs und Szenenreferenzen werden weiterhin im Unity Editor eingerichtet, nicht als Dateiupload über die Website.

## Verbindung und Fehlerverhalten

- Statusübertragung ungefähr einmal pro Sekunde; bei über fünf Sekunden altem Status sind Befehle gesperrt.
- Jeder Befehl erhält eine ID. Erfolg wird erst nach App-Bestätigung angezeigt. Befehle werden nicht automatisch wiederholt oder beim Wiederverbinden nachgeholt.
- Genau ein Befehl kann gleichzeitig auf Bestätigung warten. Nach acht Sekunden meldet der Server eine Zeitüberschreitung; bei Abbruch ist eine bereits begonnene Ausführung eventuell unklar. Vor erneutem Senden den aktuellen Zustand prüfen.
- Unity wendet Befehle auf dem Hauptthread an; ein dort länger als drei Sekunden wartender Befehl wird verworfen. Hintergrundwechsel trennt die Verbindung; die App verbindet sich nach Rückkehr erneut. Tracking-Pause und Sichtbarkeit bleiben unter Kontrolle der bestehenden XR-Lebenszykluslogik.
- Beide Seiten verbinden sich nach Netzwerkfehlern erneut. Browser-Ablehnung wegen eines falschen Schlüssels erfordert bewusstes Neuverbinden. Änderungen an der App-Verbindungsdatei erfordern einen App-Neustart.
- WebSocket-Nachrichten sind auf 16 KiB und 30 Nachrichten pro Sekunde pro Verbindung begrenzt. Fremde Browser-Ursprünge werden abgewiesen; LAN erfordert den gemeinsamen Schlüssel.

## Dateien und Prüfung

- `server.js`: HTTP-Dateiserver und WebSocket-Relay.
- `public/`: Dashboard ohne Build-Schritt und ohne externe Ressourcen.
- `scripts/simulate-headset.js`: getrennt gekennzeichnete Test-Brille.
- `test/service.test.js`: echte lokale HTTP-/WebSocket-Integrationstests.
- `PROTOCOL.md`: JSON-Vertrag für die App.
- Unity: `PaceScape/Assets/Scripts/RemoteControl/` im bestehenden PaceScape-Repository, kleine geprüfte Zugriffsmethoden an `TagTracker` und `MarkerPlanePlacement` sowie Android-Manifest-Erweiterung.

Server-Tests ersetzen keine Unity-Kompilierung, Editor-Tests oder Geräteprüfung. `PaceScape.Tracking.EditorTests` inklusive `RemoteControlTests` im Unity Test Runner ausführen. Auf der Brille Pace, Spur/Offset für neue Platzierungen, Tracking-Neustart, Berechtigungsfehler, WLAN-/USB-Abbruch und Pause/Rückkehr mit einem neuen Build prüfen.
