# ParkMatch MVP

Parklücken privat von Auto zu Auto weitergeben. Wer wegfährt, bietet seine Lücke an, wer sucht, nimmt sie mit einem Tipp. Funktioniert überall per GPS.

## Testen

* Öffne die App auf zwei Handys über die GitHub-Pages-Adresse und erlaube den Standort.
* Handy A: **Ich fahre weg** und Abfahrtszeit wählen. Handy B: **Ich suche**, Lücke antippen, **Nehmen**.
* Beide sehen sich live auf der Karte. Unter 40 m Abstand bestätigen beide die Übergabe, danach Daumen hoch oder runter.
* Allein testen: Menü, **Demo-Modus** einschalten. Virtuelle Fahrer bieten Lücken an und kommen zu deiner Lücke.
* Am Schreibtisch mit zwei Browserfenstern: Menü, **Standort per Tippen**, dann Position auf der Karte setzen.

## Technik

* Reine Web-App (HTML, CSS, JavaScript), installierbar über „Zum Home-Bildschirm“.
* Karte: MapLibre GL mit CARTO Dark Matter (Kartendaten © OpenStreetMap).
* Echtzeit: MQTT über einen öffentlichen Test-Broker (HiveMQ, Ausweich: EMQX, Mosquitto). Kein eigenes Backend.
* Punkte, Fahrzeug und Bewertung liegen lokal auf dem Gerät.

## Grenzen des MVP

* Der öffentliche Broker ist für Tests gedacht: Nachrichten sind nicht verschlüsselt und nicht privat. Für echte Nutzer braucht es ein eigenes Backend (z. B. Firebase oder Supabase) mit Login.
* Punkte und Bewertungen lassen sich lokal manipulieren.
* Kein Push bei geschlossener App, Hinweise kommen nur bei geöffneter App.
