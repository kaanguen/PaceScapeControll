<div align="center">

  <img src="docs/assets/pacescape-logo.png" alt="PaceScape" width="520">

  <h3>Dein Lauftraining. Direkt unter Kontrolle.</h3>
  <p>PaceScape Control · Die lokale Steuerungswebsite für deine Magic Leap 2.</p>

  <img src="https://img.shields.io/badge/Node.js-22%2B-222222?style=flat-square" alt="Node.js 22 oder neuer">
  <img src="https://img.shields.io/badge/Verbindung-WebSocket-5EEAD4?style=flat-square" alt="WebSocket">
  <img src="https://img.shields.io/badge/Headset-Magic_Leap_2-00CDB5?style=flat-square" alt="Magic Leap 2">
  <img src="https://img.shields.io/badge/Status-Früher_Prototyp-7952FF?style=flat-square" alt="Status: Früher Prototyp">

  <br><br>
  <a href="#die-idee">Die Idee</a> &nbsp;·&nbsp;
  <a href="#entwicklungsstand">Entwicklungsstand</a> &nbsp;·&nbsp;
  <a href="#schnellstart">Schnellstart</a> &nbsp;·&nbsp;
  <a href="docs/setup.md">Dokumentation</a>

</div>

---

## Die Idee

**PaceScape Control** bringt die Steuerung der PaceScape-App auf deinen Rechner. Über eine lokale **WebSocket-Verbindung** stellst du Pace und Startposition ein, steuerst das Tracking und siehst den Zustand der **Magic Leap 2**.

| 🏃 Tempo einstellen | 🛤️ Platzierung steuern | 🥽 App im Blick |
| :---: | :---: | :---: |
| Die Zielpace live für platzierte Objekte ändern. | Spur und Startabstand für neue Platzierungen wählen. | Trackingphase, Marker und Meldungen direkt sehen. |

Das Dashboard nutzt ein schlichtes Dark-Mode-Design mit türkisfarbenen Akzenten, Seitenleiste und schematischer Laufbahnübersicht. Die Grafik zeigt die bestätigte Spur für neue Platzierungen; sie ist keine Live-Positionsmessung.

<details>
  <summary>Dashboard ansehen</summary>
  <br>
  <img src="docs/assets/dashboard-preview.png" alt="PaceScape Control im Dark Mode mit schematischer Laufbahn, Status und Steuerungskarten. Die abgebildeten Werte stammen aus der Test-Brille." width="1100">
  <p><em>Vorschau mit ausdrücklich gekennzeichneter Simulation, ohne echte Brillen- oder Trainingsdaten.</em></p>
</details>

## Entwicklungsstand

**Die lokale Steuerung ist implementiert. Die Prüfung mit der echten Brille steht noch aus.**

- **Implementiert:** Lokaler HTTP-/WebSocket-Server, deutsches Dashboard, Live-Pace, Spur und Startabstand für neue Platzierungen, Tracking starten/stoppen/neu platzieren sowie Erkennungs- und Bodeneinstellungen.
- **App-Anbindung:** Die passende Unity-Anbindung liegt im PaceScape-Projekt unter `Assets/Scripts/RemoteControl/`. Ein erfolgreicher Befehl wird erst nach Bestätigung der App angezeigt; ein Tracking-Start muss anschließend über die Statusmeldungen beurteilt werden.
- **Geprüft:** Acht Server-Integrationstests bestanden; Pace und Startposition im Browser mit der Test-Brille bestätigt.
- **In Prüfung:** Unity-Kompilierung, Unity-Tests und die Verbindung sowie tatsächliche Wirkung auf Magic Leap 2. Für die App-Anbindung ist ein neuer Geräte-Build nötig.
- **Noch nicht vorhanden:** BLE-, Laufband-, Herzfrequenz-, Trainingsplan- und Live-Messdatenfunktionen.

## Schnellstart

Voraussetzung: **Node.js 22 oder neuer**. Im Repository-Ordner:

```sh
npm ci
npm start
```

Die Website unter **[localhost:8787](http://localhost:8787)** öffnen. Der Server läuft standardmäßig nur auf diesem Rechner; Website und App verbinden sich über WebSockets.

Für die Brille per USB: aktualisierte PaceScape-App installieren, USB-Debugging freigeben und bei verfügbarem ADB die Weiterleitung setzen:

```sh
adb reverse tcp:8787 tcp:8787
```

Danach die App starten. Sie verwendet standardmäßig `ws://127.0.0.1:8787/ws`. Ohne USB-Weiterleitung bezeichnet localhost auf der Brille die Brille selbst.

**Ohne Brille ausprobieren:** In einem zweiten Terminal `npm run simulate` starten. Die Test-Brille ist im Dashboard als Simulation gekennzeichnet und muss vor dem Verbinden des echten Geräts beendet werden. `npm test` führt die Server-Tests aus; Strg+C beendet den jeweiligen Prozess.

USB-Einrichtung, optionaler WLAN-Betrieb mit Zugriffsschlüssel und Fehlerverhalten sind in der **[Einrichtungsanleitung](docs/setup.md)** beschrieben. Lokales `ws://` ist unverschlüsselt; für WLAN ein vertrauenswürdiges Netz ohne öffentliche Portfreigabe verwenden.

---

<p align="center">
  <a href="docs/setup.md">Einrichtung &amp; Geräteprüfung</a> &nbsp;·&nbsp;
  <a href="PROTOCOL.md">WebSocket-Protokoll</a>
</p>
