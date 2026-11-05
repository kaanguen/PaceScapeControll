# PaceScape Control — Einrichtung und Prüfung

[Zurück zur Übersicht](../README.md) · [WebSocket-Protokoll](../PROTOCOL.md)

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

Der Server bindet standardmäßig an `0.0.0.0` und ist über die lokale Rechner-IP erreichbar. Website und App stellen jeweils eine WebSocket-Verbindung zu diesem Server her. Eine Brille und mehrere Dashboards werden unterstützt. Die Website sendet alle Steuerbefehle über WebSocket.

## Optional im lokalen WLAN

Rechner und Brille müssen einander erreichen können. Server bewusst für das LAN starten:

```sh
npm start
```

Für die Verbindung über die lokale Rechner-IP ist kein Zugriffsschlüssel nötig. Der Server ist standardmäßig im lokalen Netz erreichbar.

Die App liest beim Start optional `pacescape-control.json` aus `Application.persistentDataPath`:

```json
{
  "Enabled": true,
  "ServerUrl": "ws://192.168.1.42:8787/ws",
  "AccessToken": ""
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
| Läufer einstellen | Pace, Spur und Startabstand werden gemeinsam validiert und übernommen; Pace wirkt live, die Position lässt sich nur im wartenden Ready-Zustand ändern |
| Lauf starten | Übernimmt die aktuellen drei Läufereingaben gemeinsam und startet erst bei vollständig sichtbaren, getrackten Platzierungen |
| Pause / Weiterlaufen | Hält und setzt die vorhandenen Positionen fort; Weiterlaufen übernimmt keine ungespeicherten Eingaben |
| Zurücksetzen | Beendet den Lauf, stellt die Startposition wieder her und behält Anker und Strecke |
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
- Tracking- oder Serververbindungsverlust pausiert einen laufenden Lauf. Sichtbarkeit und Verbindung können sich erholen, der Lauf setzt sich erst nach Weiterlaufen fort. Der Server sendet jede Sekunde ein Lebenszeichen; nach sechs Sekunden ohne aktuelles Lebenszeichen pausiert die App und verbindet sich neu. Das Schließen nur des Browser-Tabs pausiert den Lauf nicht.
- Unity wendet Befehle auf dem Hauptthread an; ein dort länger als drei Sekunden wartender Befehl wird verworfen. Hintergrundwechsel trennt die Verbindung; die App verbindet sich nach Rückkehr erneut. Tracking-Pause und Sichtbarkeit bleiben unter Kontrolle der bestehenden XR-Lebenszykluslogik.
- Beide Seiten verbinden sich nach Netzwerkfehlern erneut. Browser-Ablehnung wegen eines falschen Schlüssels erfordert bewusstes Neuverbinden. Änderungen an der App-Verbindungsdatei erfordern einen App-Neustart.
- WebSocket-Nachrichten sind auf 16 KiB und 30 Nachrichten pro Sekunde pro Verbindung begrenzt. Fremde Browser-Ursprünge werden abgewiesen; ein Zugriffsschlüssel wird nicht benötigt.

## Dateien und Prüfung

- `server.js`: HTTP-Dateiserver und WebSocket-Relay.
- `public/`: Dashboard ohne Build-Schritt und ohne externe Ressourcen.
- `scripts/simulate-headset.js`: getrennt gekennzeichnete Test-Brille.
- `test/service.test.js`: echte lokale HTTP-/WebSocket-Integrationstests.
- [`PROTOCOL.md`](../PROTOCOL.md): JSON-Vertrag für die App.
- Unity: `PaceScape/Assets/Scripts/RemoteControl/` im bestehenden PaceScape-Repository, kleine geprüfte Zugriffsmethoden an `TagTracker` und `MarkerPlanePlacement` sowie Android-Manifest-Erweiterung.

Server-Tests ersetzen keine Unity-Kompilierung, Editor-Tests oder Geräteprüfung. `PaceScape.Tracking.EditorTests` inklusive `RemoteControlTests` und `RunControlTests` im Unity Test Runner ausführen. Auf der Brille Pace, Spur/Offset für neue Platzierungen, Tracking-Neustart, Berechtigungsfehler, WLAN-/USB-Abbruch und Pause/Rückkehr mit einem neuen Build prüfen.

## Explizite Laufsteuerung

Der Läufer läuft nach der Platzierung nicht mehr automatisch los. Die Erkennung startet weiterhin mit der App. Erst „Lauf starten“ setzt alle aktuellen Läufer in Bewegung. Marker und Boden müssen dafür vollständig getrackt sein. Laufzustände sind `Ready`, `Running` und `Paused`; der Status allein ersetzt nicht die separate Platzierungsbereitschaft.

Pace, Spur und Startabstand werden mit „Läufer einstellen“ oder beim Start in einem gemeinsamen Befehl gesetzt. Bestehende wartende Objekte werden an den gewählten Start gesetzt. Während Running oder Paused sind Positionsänderungen gesperrt; die Pace bleibt veränderbar. Zurücksetzen hält die Strecke/Anker und erlaubt erneut Positionsänderungen. Tracking-Neustarts löschen dagegen die Platzierungen. Neue Marker werden während Running/Paused vorgemerkt und erst nach Ready platziert.

Die App meldet `runnerControlVersion: 1`. Für diese Erweiterung sind der aktualisierte Server und ein neu gebauter, installierter App-Stand nötig. Ältere Apps erhalten keine neuen Laufbefehle. Es wurde kein zusätzlicher Laufzeit-/Distanzmesser und keine Speicherung von Trainingssitzungen ergänzt.

13 Server-/Simulatortests sowie der Browserablauf Start → Pause → Pace ändern → Weiterlaufen → Zurücksetzen wurden geprüft. Unity-Kompilierung, Unity-Test-Runner und die Wirkung auf der echten Brille bleiben offen.


## Verbindung ohne Zugriffsschlüssel

Der Server lauscht jetzt standardmäßig auf `0.0.0.0:8787` und akzeptiert App und Dashboard ohne Zugriffsschlüssel. `npm start` genügt. Die App verwendet `ws://RECHNER-IP:8787/ws`; ein eventuell noch gesendeter alter Schlüssel wird ignoriert. `ACCESS_TOKEN` hat keine Wirkung mehr. Die lokale IP muss vom Gerät erreichbar sein. Alle Teilnehmer im erreichbaren lokalen Netz können die App steuern; den Port nicht öffentlich freigeben. Frühere Angaben zur verpflichtenden Schlüsselprüfung gelten nicht mehr.
