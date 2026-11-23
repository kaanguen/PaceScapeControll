# PaceScapeBodyTrackingTest

C++-Live-Viewer für die Orbbec Femto Bolt unter Windows x64. Der Orbbec K4A Wrapper liefert die Tiefenbilder und die Kamerakalibrierung. Das Azure Kinect Body Tracking SDK berechnet pro Person ein 3D-Skelett und eine Body-Index-Maske. Der Viewer stellt die Gelenke und Knochen in derselben kalibrierten Tiefen-Punktwolke dar und färbt die zur Person gehörenden Punkte passend zum Skelett ein.

## Bauen und starten

Voraussetzungen sind Visual Studio 2022 Build Tools mit MSVC v143 und einem Windows SDK sowie das Windows-ZIP des [Orbbec K4A Wrappers](https://github.com/orbbec/OrbbecSDK-K4A-Wrapper/releases). Getestetes ZIP-Layout mit Version 2.0.12.

Im Projektordner in PowerShell:

```powershell
.\build.ps1 -OrbbecWrapperZip 'C:\Pfad\zum\OrbbecSDK_K4A_Wrapper_windows.zip'
Set-Location .\build\bin\Release
.\PaceScapeBodyTrackingTest.exe
```

Das Skript baut Release x64, stellt die NuGet-Pakete wieder her und kopiert dann den Orbbec-Wrapper mit seinen Laufzeitdateien neben die EXE. Verwende nach einem Neubau das Skript, damit die Sensor-DLLs im Ausgabeordner zur Femto Bolt passen.

Die EXE nutzt standardmäßig DirectML. Mit `./PaceScapeBodyTrackingTest.exe CPU` kannst du den Tracker auf der CPU starten.

Beim Start listet die EXE die GPUs auf und wählt für DirectML die Hardware-GPU mit dem meisten dedizierten Grafikspeicher. Auf Laptops ist GPU 0 oft die integrierte Grafik, die die Tracking-Rate senkt. Mit `--gpu <Nummer>` lässt sich eine andere GPU erzwingen. Alle zwei Sekunden meldet die Konsole die erreichten Tracking-Bilder pro Sekunde. Für schnelle Bewegungen wie Laufen sollten es die vollen 30 sein.

### Aufstellung für Laufbewegungen

Der Tracker erkennt 2D-Gelenkpunkte im Infrarotbild und passt dann ein 3D-Skelettmodell an die Tiefendaten an. Laut Microsoft-Vortrag (Z. Liu, *3D Skeletal Tracking on Azure Kinect*) sind unzuverlässige Tiefe, dunkle infrarot-absorbierende Kleidung, abgeschnittene Körperteile im Bildfeld und Selbstverdeckung, etwa bei Seitenansicht, die schwierigen Fälle. Für Laufen heißt das: den ganzen Körper inklusive Füße im Bild halten, die Kamera eher frontal oder schräg von vorn statt seitlich aufstellen, Laufbandkonsole und Haltegriffe nicht zwischen Kamera und Beinen und keine schwarze Sportkleidung tragen. Die Tiefeneinstellung NFOV unbinned deckt etwa 0,5 bis 3,9 m ab. Diese Hinweise stammen nicht aus eigenen Messungen.

## Livebild in PaceScapeControll

Starte den aktualisierten PaceScapeControll-Server auf dem Kamerarechner mit `npm start`. Starte die EXE anschließend aus ihrem Ausgabeordner mit `./PaceScapeBodyTrackingTest.exe --dashboard`. Öffne auf demselben Rechner `http://localhost:8787`. Das Livebild erscheint unter **Bewegung** und **Bewegungsanalyse**.

Der Dashboard-Modus nimmt synchronisierte RGB- und Tiefenbilder auf und projiziert die 3D-Gelenke in das RGB-Bild. Der Server hält das jeweils aktuelle Bild mit Skelettdaten im Speicher und blendet es nach 2,5 Sekunden ohne neue Frames aus. Ohne `--dashboard` läuft der lokale Viewer mit dem Tiefenstream.

- **Linke Maustaste ziehen** dreht die Ansicht.
- **Strg + linke Maustaste ziehen** verschiebt sie.
- **Mausrad** zoomt.
- **B** blendet Gelenkachsen ein oder aus.
- **Esc** oder das Schließen des Fensters beendet den Viewer.

## Avatar in der Brille

Starte den PaceScapeControll-Server auf dem Kamerarechner und die EXE mit `./PaceScapeBodyTrackingTest.exe --avatar`. Beide Schalter lassen sich kombinieren (`--dashboard --avatar`). Die EXE sendet die 3D-Gelenkrotationen der Person, die der Kamera am nächsten ist, mit bis zu 30 Hz an `http://127.0.0.1:8787/api/body-tracking/pose`. Der Server leitet sie an die Brille weiter, sobald im Dashboard unter **Bewegung** der Knopf **Avatar spiegeln** aktiviert ist. Dafür braucht die Brillen-App einen bereiten Lauf und genau einen getrackten Marker. Der Avatar bleibt an seiner Startposition und zeigt deine Haltung seitengleich.

## Projektstruktur

Der Ordner `vendor/` enthält den benötigten 3D-Viewer und die gemeinsamen Header aus den Azure-Kinect-Samples unter der mitgelieferten MIT-Lizenz. Die NuGet-Abhängigkeiten liegen unter `packages/`. Öffne für IntelliSense diesen Projektordner in VS Code.
