'use strict';

// ============================================================================
// Tonspur - die eigentliche App.
//
// Aufbau dieser Datei:
//   1. Zustand        - was die App sich merkt (Lieder, Playlists, Warteschlange)
//   2. Start          - Daten laden und alles einrichten
//   3. Ansichten      - Lieder, Suche und Playlists auf den Bildschirm zeichnen
//   4. Abspielen      - Warteschlange, nächstes Lied, Zufall, Wiederholen
//   5. Sperrbildschirm- Titel und Tasten an das iPhone melden (Media Session)
//   6. Musik hinzufügen und löschen
//   7. Menüs und Klicks
// ============================================================================

const el = id => document.getElementById(id);
const ton = el('ton');

// ---------- 1. Zustand ----------

let lieder = [];            // alle Lieder (ohne die Musikdaten selbst)
let playlists = [];         // { id, name, liedIds: [...] }
let ansicht = { name: 'lieder', playlistId: null };

let basis = [];             // Lied-Kennungen in der ursprünglichen Reihenfolge
let warteschlange = [];     // dieselben Kennungen in der Abspiel-Reihenfolge (bei Zufall gemischt)
let stelle = -1;            // Welches Lied der Warteschlange gerade dran ist
let quelle = '';            // Woraus gespielt wird, z. B. der Name der Playlist
let zufall = false;
let wiederholen = 'aus';    // 'aus', 'alle' oder 'eins'

let aktuelleUrl = null;     // Adresse der Musikdatei, die gerade im Player steckt
let vorgeladen = null;      // { id, url } des nächsten Liedes, schon bereitgelegt
let letzteZeit = 0;         // zuletzt sicher bekannte Stelle im Lied (zum Weitermachen und Wiederherstellen)
let pausiertSeit = 0;       // Zeitpunkt der letzten Pause (0 = läuft gerade)
let ladeMarke = 0;          // zählt Ladevorgänge, damit ein veralteter nicht dazwischenfunkt
let rettungen = 0;          // wie oft der Wächter das aktuelle Lied schon neu laden musste
let reglerWirdGezogen = false;
const VERSION = 3;          // steht unten in der Liederliste; so sieht man, ob ein Update angekommen ist

// Protokoll für die Fehlersuche: Die App schreibt mit, was der Player tut.
// Ansehen kann man es unter "Lieder" ganz unten über "Diagnose".
let protokoll = [];
try { protokoll = JSON.parse(localStorage.getItem('tonspur-protokoll') || '[]'); } catch { protokoll = []; }

function merke(text) {
  const jetzt = new Date();
  const uhr = [jetzt.getHours(), jetzt.getMinutes(), jetzt.getSeconds()].map(z => String(z).padStart(2, '0')).join(':');
  protokoll.push(`${uhr} ${text}`);
  if (protokoll.length > 120) protokoll.shift();
  // Auch speichern, damit das Protokoll einen Neustart der App übersteht
  try { localStorage.setItem('tonspur-protokoll', JSON.stringify(protokoll)); } catch { /* Speicher voll: dann nur im Arbeitsspeicher */ }
}

/** Sagt dem Player "spiel ab" und schreibt mit, falls das iPhone das ablehnt. */
function spieleAb(grund) {
  const versuch = ton.play();
  if (!versuch || !versuch.catch) return;
  versuch.catch(fehler => {
    merke(`play abgelehnt (${grund}): ${fehler.name}`);
    if (fehler.name === 'NotAllowedError') zeigeMeldung('Tippe bitte noch einmal auf Play.', 3000);
  });
}
const coverAdressen = new Map();   // Lied-Kennung -> Adresse des Coverbildes

// Die Symbole als kleine Zeichnungen (SVG). "linie: true" heißt: nur Umriss statt Fläche.
const SYMBOLE = {
  play: { pfad: 'M8 5v14l11-7z' },
  pause: { pfad: 'M6 5h4v14H6zM14 5h4v14h-4z' },
  weiter: { pfad: 'M6 6l8.5 6L6 18zM16 6h2v12h-2z' },
  zurueck: { pfad: 'M18 6l-8.5 6L18 18zM6 6h2v12H6z' },
  plus: { pfad: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z' },
  mehr: { pfad: 'M6 10a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4z' },
  note: { pfad: 'M9 3h10v4h-8v10a3 3 0 11-2-2.83z' },
  liste: { pfad: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z' },
  runter: { pfad: 'M6.4 8.6L12 14.2l5.6-5.6L19 10l-7 7-7-7z' },
  suche: { pfad: 'M10.5 4a6.5 6.5 0 104 11.6l4.4 4.4 1.1-1.1-4.4-4.4A6.5 6.5 0 0010.5 4zm0 1.6a4.9 4.9 0 110 9.8 4.9 4.9 0 010-9.8z' },
  zufall: { linie: true, pfad: 'M3 7h3.5c2 0 3.3 1 4.5 3l2 4c1.2 2 2.5 3 4.5 3H21M18 14l3 3-3 3M3 17h3.5c1.2 0 2.2-.4 3-1.2M21 7h-3.5c-1.2 0-2.2.4-3 1.2M18 4l3 3-3 3' },
  wiederholen: { linie: true, pfad: 'M4 12V9a3 3 0 013-3h11M15 3l3 3-3 3M20 12v3a3 3 0 01-3 3H6M9 21l-3-3 3-3' },
  wiederholenEins: { linie: true, pfad: 'M4 12V9a3 3 0 013-3h11M15 3l3 3-3 3M20 12v3a3 3 0 01-3 3H6M9 21l-3-3 3-3M11.2 10.6l1.3-.8V14' },
};

function symbol(name) {
  const s = SYMBOLE[name];
  const stil = s.linie
    ? 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    : 'fill="currentColor"';
  return `<svg viewBox="0 0 24 24" ${stil} aria-hidden="true"><path d="${s.pfad}"/></svg>`;
}

/** Macht Text ungefährlich, bevor er als HTML eingesetzt wird (z. B. ein Titel mit "<"). */
function sicher(text) {
  return String(text).replace(/[&<>"']/g, z => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]));
}

function alsZeit(sekunden) {
  if (!isFinite(sekunden) || sekunden <= 0) return '0:00';
  const s = Math.floor(sekunden);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const findeLied = id => lieder.find(l => l.id === id);
const aktuellesLied = () => findeLied(warteschlange[stelle]);

// ---------- 2. Start ----------

async function start() {
  // Feste Symbole aus index.html einsetzen (alles mit data-symbol="...")
  document.querySelectorAll('[data-symbol]').forEach(e => { e.innerHTML = symbol(e.dataset.symbol) + e.innerHTML; });

  await oeffneDatenbank();
  lieder = (await dbAlle('lieder')).sort((a, b) => a.hinzugefuegt - b.hinzugefuegt);
  playlists = await dbAlle('playlists');

  ladeZustand();
  zeichne();
  zeigeSpielstand();
  richteSperrbildschirmEin();

  // Den Browser bitten, die Musik nicht von selbst zu löschen, wenn der Speicher knapp wird.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  // Der "Service Worker" (sw.js) sorgt dafür, dass die App auch ohne Internet startet.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

/** Merkt sich Warteschlange und Stelle, damit die App nach dem Schließen dort weitermacht. */
function speichereZustand() {
  localStorage.setItem('tonspur-zustand', JSON.stringify({
    basis, warteschlange, stelle, quelle, zufall, wiederholen, zeit: letzteZeit,
  }));
}

function ladeZustand() {
  try {
    const z = JSON.parse(localStorage.getItem('tonspur-zustand') || 'null');
    if (!z) return;
    // Nur Lieder behalten, die es noch gibt.
    basis = z.basis.filter(findeLied);
    warteschlange = z.warteschlange.filter(findeLied);
    stelle = Math.min(z.stelle, warteschlange.length - 1);
    quelle = z.quelle || '';
    zufall = !!z.zufall;
    wiederholen = z.wiederholen || 'aus';
    letzteZeit = z.zeit || 0;
  } catch {
    // Unlesbarer Zustand: einfach ohne Warteschlange starten.
  }
}

// ---------- 3. Ansichten ----------

/** Zeichnet die gerade gewählte Ansicht neu. */
function zeichne() {
  const inhalt = el('inhalt');
  if (ansicht.name === 'lieder') inhalt.innerHTML = zeichneLieder();
  else if (ansicht.name === 'suche') inhalt.innerHTML = zeichneSuche();
  else if (ansicht.name === 'playlists') inhalt.innerHTML = zeichnePlaylists();
  else inhalt.innerHTML = zeichnePlaylist();

  // In der Leiste unten den passenden Bereich hervorheben
  const bereich = ansicht.name === 'playlist' ? 'playlists' : ansicht.name;
  document.querySelectorAll('.leiste button').forEach(k => k.classList.toggle('aktiv', k.dataset.ansicht === bereich));

  if (ansicht.name === 'lieder') zeigeSpeicherplatz();
}

function wechsleAnsicht(name, playlistId = null) {
  ansicht = { name, playlistId };
  zeichne();
  el('inhalt').scrollTop = 0;
}

/** Die Lied-Kennungen, die in der aktuellen Ansicht zu sehen sind (in dieser Reihenfolge wird gespielt). */
function sichtbareIds() {
  if (ansicht.name === 'playlist') {
    const liste = playlists.find(p => p.id === ansicht.playlistId);
    return liste ? liste.liedIds.filter(findeLied) : [];
  }
  if (ansicht.name === 'suche') return sucheLieder(el('suchfeld') ? el('suchfeld').value : '').map(l => l.id);
  return lieder.map(l => l.id);
}

function coverAdresse(lied) {
  if (!lied || !lied.cover) return null;
  if (!coverAdressen.has(lied.id)) coverAdressen.set(lied.id, URL.createObjectURL(lied.cover));
  return coverAdressen.get(lied.id);
}

/** Inhalt eines Cover-Kästchens: das Bild oder, wenn es keins gibt, eine Note. */
function coverInhalt(lied) {
  const adresse = coverAdresse(lied);
  return adresse ? `<img src="${adresse}" alt="" loading="lazy">` : symbol('note');
}

function liedZeile(lied) {
  const laeuft = aktuellesLied() && aktuellesLied().id === lied.id;
  return `
    <li class="zeile${laeuft ? ' aktiv' : ''}" data-aktion="spielen" data-id="${lied.id}">
      <div class="cover klein">${coverInhalt(lied)}</div>
      <div class="zeilen-text">
        <div class="titel">${sicher(lied.titel)}</div>
        <div class="unter">${sicher(lied.kuenstler || 'Unbekannt')}</div>
      </div>
      <span class="dauer" data-dauer="${lied.id}">${lied.dauer ? alsZeit(lied.dauer) : ''}</span>
      <button class="symbolknopf" data-aktion="menue" data-id="${lied.id}" aria-label="Mehr">${symbol('mehr')}</button>
    </li>`;
}

const SPIELKNOEPFE = `
  <div class="knopfreihe">
    <button class="pille akzent" data-aktion="allesSpielen">${symbol('play')}Abspielen</button>
    <button class="pille" data-aktion="zufaelligSpielen">${symbol('zufall')}Zufällig</button>
  </div>`;

function zeichneLieder() {
  const kopf = `
    <div class="kopfzeile">
      <h1>Deine Musik</h1>
      <button class="rundknopf" data-aktion="hinzufuegen" aria-label="Musik hinzufügen">${symbol('plus')}</button>
    </div>`;

  if (lieder.length === 0) {
    return kopf + `
      <div class="leer">
        <div class="kreis">${symbol('note')}</div>
        <h2>Noch keine Musik</h2>
        <p class="hinweis">Tippe auf „Musik hinzufügen“ und wähle deine MP3-Dateien aus. Sie werden in der App gespeichert und laufen danach auch ohne Internet.</p>
        <button class="pille akzent" data-aktion="hinzufuegen">${symbol('plus')}Musik hinzufügen</button>
        ${installHinweis()}
      </div>`;
  }

  return kopf + SPIELKNOEPFE
    + `<ul>${lieder.map(liedZeile).join('')}</ul>`
    + `<p class="fusszeile"><span id="speicherInfo">${lieder.length} Lieder</span> · Version ${VERSION} · <button class="textlink" data-aktion="diagnose">Diagnose</button></p>`;
}

/** Auf dem iPhone in Safari: erklären, wie die Seite zur App auf dem Home-Bildschirm wird. */
function installHinweis() {
  const istIphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const istInstalliert = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!istIphone || istInstalliert) return '';
  return `
    <div class="kasten hinweis">
      <b>Zuerst als App installieren:</b> Tippe unten in Safari auf „Teilen“ und dann auf „Zum Home-Bildschirm“.
      Öffne Tonspur danach über das neue Symbol und füge erst dort deine Musik hinzu.
    </div>`;
}

async function zeigeSpeicherplatz() {
  if (!navigator.storage || !navigator.storage.estimate || !el('speicherInfo')) return;
  const { usage } = await navigator.storage.estimate();
  const info = el('speicherInfo');
  if (info && usage) info.textContent = `${lieder.length} Lieder · ${(usage / 1048576).toFixed(0)} MB auf diesem Gerät`;
}

function sucheLieder(text) {
  const gesucht = text.trim().toLowerCase();
  if (!gesucht) return [];
  return lieder.filter(l => `${l.titel} ${l.kuenstler} ${l.album}`.toLowerCase().includes(gesucht));
}

function zeichneSuche() {
  return `
    <div class="kopfzeile"><h1>Suche</h1></div>
    <input class="suchfeld" id="suchfeld" type="search" placeholder="Titel, Künstler oder Album" autocomplete="off">
    <ul id="suchTreffer"></ul>`;
}

/** Wird bei jedem getippten Buchstaben aufgerufen und erneuert nur die Trefferliste. */
function zeigeSuchTreffer() {
  const text = el('suchfeld').value;
  const treffer = sucheLieder(text);
  el('suchTreffer').innerHTML = treffer.length
    ? treffer.map(liedZeile).join('')
    : (text.trim() ? '<p class="hinweis">Nichts gefunden.</p>' : '');
}

function zeichnePlaylists() {
  const zeilen = playlists.map(p => {
    const erstes = p.liedIds.map(findeLied).find(l => l && l.cover);
    return `
      <li class="zeile" data-aktion="oeffnePlaylist" data-id="${p.id}">
        <div class="cover klein">${coverInhalt(erstes)}</div>
        <div class="zeilen-text">
          <div class="titel">${sicher(p.name)}</div>
          <div class="unter">${p.liedIds.filter(findeLied).length} Lieder</div>
        </div>
      </li>`;
  }).join('');

  return `
    <div class="kopfzeile">
      <h1>Playlists</h1>
      <button class="rundknopf" data-aktion="neuePlaylist" aria-label="Neue Playlist">${symbol('plus')}</button>
    </div>
    ${playlists.length ? `<ul>${zeilen}</ul>` : '<p class="hinweis">Noch keine Playlist. Mit dem Plus legst du eine an. Lieder fügst du über die drei Punkte neben einem Lied hinzu.</p>'}`;
}

function zeichnePlaylist() {
  const liste = playlists.find(p => p.id === ansicht.playlistId);
  if (!liste) return zeichnePlaylists();
  const inhalt = liste.liedIds.map(findeLied).filter(Boolean);
  const gesamt = inhalt.reduce((summe, l) => summe + (l.dauer || 0), 0);

  return `
    <button class="zurueck-link" data-aktion="ansicht" data-ansicht="playlists">${symbol('runter')}Playlists</button>
    <div class="playlist-kopf">
      <div class="cover mittel">${coverInhalt(inhalt.find(l => l.cover))}</div>
      <div class="zeilen-text">
        <h1>${sicher(liste.name)}</h1>
        <div class="unter">${inhalt.length} Lieder${gesamt ? ' · ' + Math.round(gesamt / 60) + ' Min.' : ''}</div>
      </div>
      <button class="symbolknopf" data-aktion="playlistMenue" aria-label="Mehr">${symbol('mehr')}</button>
    </div>
    ${inhalt.length ? SPIELKNOEPFE + `<ul>${inhalt.map(liedZeile).join('')}</ul>`
      : '<p class="hinweis">Diese Playlist ist leer. Geh zu „Lieder“, tippe bei einem Lied auf die drei Punkte und wähle „Zu Playlist hinzufügen“.</p>'}`;
}

// ---------- 4. Abspielen ----------

function mische(liste) {
  const kopie = liste.slice();
  for (let i = kopie.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [kopie[i], kopie[j]] = [kopie[j], kopie[i]];
  }
  return kopie;
}

/** Startet eine Liste von Liedern ab dem Lied mit der Nummer "beginn". */
function starteListe(ids, beginn, vonWo) {
  if (ids.length === 0) return;
  basis = ids.slice();
  quelle = vonWo;
  if (zufall) {
    // Das gewählte Lied kommt zuerst, der Rest wird gemischt.
    warteschlange = [ids[beginn], ...mische(ids.filter((_, i) => i !== beginn))];
    stelle = 0;
  } else {
    warteschlange = ids.slice();
    stelle = beginn;
  }
  spieleStelle();
}

/**
 * Spielt das Lied, auf das "stelle" zeigt.
 * Wichtig für den gesperrten Bildschirm: Liegt das Lied schon bereit ("vorgeladen"),
 * startet es sofort, ohne auf den Speicher zu warten. Sonst könnte das iPhone
 * die Wiedergabe im Hintergrund anhalten.
 */
function spieleStelle() {
  const lied = aktuellesLied();
  if (!lied) return;
  letzteZeit = 0;
  rettungen = 0;
  ladeMarke++; // ein noch laufendes Neuladen des alten Liedes gilt ab jetzt nicht mehr

  // Nach einer längeren Pause kann das iPhone die App eingefroren haben.
  // Bereitgelegte Dateien sind dann manchmal unbrauchbar, deshalb werden sie frisch geholt.
  if (nachLangerPause()) verwirfVorgeladenes();

  const starte = url => {
    const alteUrl = aktuelleUrl;
    aktuelleUrl = url;
    ton.src = url;
    spieleAb('neues Lied');
    if (alteUrl) URL.revokeObjectURL(alteUrl); // alte Datei aus dem Arbeitsspeicher freigeben
    legeNaechstesBereit();
  };

  if (vorgeladen && vorgeladen.id === lied.id) {
    merke(`Lied ${stelle + 1} startet (lag bereit)`);
    const url = vorgeladen.url;
    vorgeladen = null;
    starte(url);
  } else {
    merke(`Lied ${stelle + 1} startet (wird geholt)`);
    verwirfVorgeladenes();
    leereSofort();
    dbHole('dateien', lied.id).then(datei => {
      if (!aktuellesLied() || aktuellesLied().id !== lied.id) return; // inzwischen wurde etwas anderes gewählt
      if (!datei) { naechstes(false); return; }
      starte(URL.createObjectURL(datei));
    });
  }

  zeigeSpielstand();
  meldeLiedAnSperrbildschirm(lied);
  speichereZustand();
}

/** Holt die Datei des nächsten Liedes schon jetzt aus dem Speicher. */
function legeNaechstesBereit() {
  const naechste = naechsteStelle(true);
  if (naechste < 0 || naechste === stelle) return;
  const id = warteschlange[naechste];
  if (vorgeladen && vorgeladen.id === id) return;
  verwirfVorgeladenes();
  dbHole('dateien', id).then(datei => {
    if (!datei || warteschlange[naechsteStelle(true)] !== id) return;
    verwirfVorgeladenes();
    vorgeladen = { id, url: URL.createObjectURL(datei) };
  });
}

function verwirfVorgeladenes() {
  if (vorgeladen) URL.revokeObjectURL(vorgeladen.url);
  vorgeladen = null;
}

/**
 * Welche Stelle kommt als Nächstes? Gibt -1 zurück, wenn Schluss ist.
 * vonSelbst = true: Das Lied ist zu Ende gelaufen. false: Der Mensch hat "Weiter" gedrückt.
 */
function naechsteStelle(vonSelbst) {
  if (vonSelbst && wiederholen === 'eins') return stelle;
  if (stelle + 1 < warteschlange.length) return stelle + 1;
  if (wiederholen === 'alle' || !vonSelbst) return warteschlange.length ? 0 : -1;
  return -1;
}

function naechstes(vonSelbst) {
  const neu = naechsteStelle(vonSelbst);
  if (neu < 0) return;                       // Ende der Playlist: einfach aufhören
  if (neu === stelle && ton.src) {           // dasselbe Lied noch einmal
    ton.currentTime = 0;
    spieleAb('wiederholen');
    return;
  }
  stelle = neu;
  spieleStelle();
}

function vorheriges() {
  // Wie bei den meisten Playern: Nach mehr als 3 Sekunden springt "Zurück" erst an den Liedanfang.
  if (ton.currentTime > 3 || stelle <= 0) { ton.currentTime = 0; return; }
  stelle--;
  spieleStelle();
}

function playPause() {
  if (!aktuellesLied()) return;
  if (ton.paused || !ton.src) setzeFort(); else ton.pause();
}

/** War die Wiedergabe länger als 3 Sekunden angehalten? */
function nachLangerPause() {
  return pausiertSeit > 0 && Date.now() - pausiertSeit > 3000;
}

/**
 * Macht nach einer Pause weiter.
 * Das iPhone friert die App ein, wenn eine Weile nichts läuft. Danach tut der Player
 * manchmal nur so, als würde er spielen: kein Ton, Zeit bleibt bei 0:00.
 * Deshalb wird das Lied nach einer längeren Pause frisch aus dem Speicher geholt
 * und an die gemerkte Stelle gespult, statt einfach nur "weiter" zu drücken.
 */
function setzeFort() {
  if (!aktuellesLied()) return;
  // War das Lied schon zu Ende (letztes Lied der Playlist), beginnt es wieder von vorn.
  const amEnde = ton.ended || (liedDauer() > 0 && letzteZeit > liedDauer() - 1);
  const zeit = amEnde ? 0 : letzteZeit;

  if (!ton.src || ton.error || nachLangerPause()) {
    merke(`weiter nach Pause: frisch laden ab ${zeit.toFixed(0)} s`);
    leereSofort();
    ladeNeu(zeit, true);
  } else {
    // Normalfall: sofort abspielen, direkt aus dem Tastendruck heraus.
    merke('weiter: direkt');
    spieleAb('weiter');
  }
}

/**
 * Leert den Player sofort und noch im selben Tastendruck.
 * Das hat zwei Zwecke: Das alte Lied verstummt gleich, und das iPhone merkt sich,
 * dass ein Mensch die Wiedergabe ausgelöst hat. Nur dann erlaubt es Ton und zeigt
 * den Player auf dem Sperrbildschirm, auch wenn die Datei erst einen Moment später
 * aus dem Speicher kommt.
 */
function leereSofort() {
  ton.pause();
  ton.removeAttribute('src');
  ton.load();
}

/** Legt das aktuelle Lied frisch ein und spult an die Stelle "zeit" (in Sekunden). */
function ladeNeu(zeit, danachSpielen) {
  const lied = aktuellesLied();
  if (!lied) return;
  const marke = ++ladeMarke;
  verwirfVorgeladenes();

  dbHole('dateien', lied.id).then(datei => {
    // Abbrechen, wenn inzwischen ein anderes Lied oder ein neuerer Ladevorgang dran ist
    if (!datei || marke !== ladeMarke || !aktuellesLied() || aktuellesLied().id !== lied.id) return;

    const alteUrl = aktuelleUrl;
    const url = URL.createObjectURL(datei);
    aktuelleUrl = url;
    ton.src = url;
    if (zeit > 0) {
      ton.addEventListener('loadedmetadata', () => { if (aktuelleUrl === url) ton.currentTime = zeit; }, { once: true });
    }
    if (danachSpielen) spieleAb('frisch geladen');
    if (alteUrl) URL.revokeObjectURL(alteUrl);
    legeNaechstesBereit();
  });
}

/** Länge des aktuellen Liedes. Kennt der Player sie gerade nicht, hilft der gespeicherte Wert. */
function liedDauer() {
  if (isFinite(ton.duration) && ton.duration > 0) return ton.duration;
  const lied = aktuellesLied();
  return lied && lied.dauer ? lied.dauer : 0;
}

/**
 * Wächter: schaut alle 1,5 Sekunden nach, ob die Zeit wirklich weiterläuft.
 * Steht sie trotz "spielt" etwa 5 Sekunden still, wird das Lied neu geladen (höchstens zweimal).
 */
let waechterZeit = 0;
let stillstand = 0;
setInterval(() => {
  // Nur bei sichtbarer App eingreifen. Im Hintergrund drosselt das iPhone die Uhr der App,
  // dort könnte der Wächter sich irren.
  if (document.hidden || ton.paused || ton.ended || ton.seeking || !aktuellesLied()) { stillstand = 0; return; }
  if (Math.abs(ton.currentTime - waechterZeit) > 0.05) {
    waechterZeit = ton.currentTime;
    stillstand = 0;
    return;
  }
  stillstand++;
  if (stillstand >= 3 && rettungen < 2) {
    rettungen++;
    stillstand = 0;
    merke(`Waechter: Zeit steht bei ${ton.currentTime.toFixed(1)} s, lade neu`);
    ladeNeu(letzteZeit, true);
  }
}, 1500);

function schalteZufall() {
  zufall = !zufall;
  const aktuell = warteschlange[stelle];
  if (aktuell) {
    if (zufall) {
      warteschlange = [aktuell, ...mische(basis.filter(id => id !== aktuell))];
      stelle = 0;
    } else {
      warteschlange = basis.slice();
      stelle = warteschlange.indexOf(aktuell);
    }
    legeNaechstesBereit();
  }
  zeigeSpielstand();
  speichereZustand();
}

function schalteWiederholen() {
  wiederholen = { aus: 'alle', alle: 'eins', eins: 'aus' }[wiederholen];
  legeNaechstesBereit();
  zeigeSpielstand();
  speichereZustand();
}

/** Bringt Mini-Player, großen Player und die Markierung in der Liste auf den aktuellen Stand. */
function zeigeSpielstand() {
  const lied = aktuellesLied();
  el('miniPlayer').hidden = !lied;
  if (!lied) { el('grossPlayer').hidden = true; return; }

  el('miniTitel').textContent = el('grossTitel').textContent = lied.titel;
  el('miniKuenstler').textContent = el('grossKuenstler').textContent = lied.kuenstler || 'Unbekannt';
  el('miniCover').innerHTML = el('grossCover').innerHTML = coverInhalt(lied);
  el('grossQuelle').textContent = quelle;

  el('miniPlay').innerHTML = el('grossPlay').innerHTML = symbol(ton.paused ? 'play' : 'pause');
  el('zufallKnopf').classList.toggle('an', zufall);
  el('wiederholenKnopf').classList.toggle('an', wiederholen !== 'aus');
  el('wiederholenKnopf').innerHTML = symbol(wiederholen === 'eins' ? 'wiederholenEins' : 'wiederholen');

  document.querySelectorAll('.zeile[data-aktion="spielen"]').forEach(z => z.classList.toggle('aktiv', z.dataset.id === lied.id));
}

function zeigeFortschritt() {
  const dauer = liedDauer();
  const anteil = dauer ? Math.min(1, ton.currentTime / dauer) : 0;
  el('miniBalken').style.width = `${anteil * 100}%`;
  if (!reglerWirdGezogen) {
    el('zeitRegler').value = Math.round(anteil * 1000);
    el('zeitRegler').style.setProperty('--stand', `${anteil * 100}%`);
    el('zeitJetzt').textContent = alsZeit(ton.currentTime);
  }
  el('zeitGesamt').textContent = alsZeit(dauer);
}

// Was das Ton-Element meldet:
ton.addEventListener('ended', () => naechstes(true));          // Lied zu Ende: sofort das nächste
ton.addEventListener('play', () => { zeigeSpielstand(); meldePosition(); });
ton.addEventListener('playing', () => { pausiertSeit = 0; });   // es kommt wirklich Ton
ton.addEventListener('pause', () => { pausiertSeit = Date.now(); zeigeSpielstand(); speichereZustand(); });
ton.addEventListener('seeked', () => { letzteZeit = ton.currentTime; });
ton.addEventListener('timeupdate', () => {
  if (ton.currentTime > 0) letzteZeit = ton.currentTime;       // Stelle merken, solange der Player gesund ist
  zeigeFortschritt();
  if (Math.floor(ton.currentTime) % 5 === 0) speichereZustand(); // ungefähr alle 5 Sekunden merken
});
ton.addEventListener('loadedmetadata', () => {
  // Die Länge eines Liedes erfährt die App erst jetzt. Beim ersten Mal wird sie gespeichert.
  const lied = aktuellesLied();
  if (lied && !lied.dauer && isFinite(ton.duration)) {
    lied.dauer = ton.duration;
    dbSetze('lieder', lied);
    document.querySelectorAll(`[data-dauer="${lied.id}"]`).forEach(e => { e.textContent = alsZeit(lied.dauer); });
  }
  zeigeFortschritt();
  meldePosition();
});
ton.addEventListener('error', () => { if (ton.src) zeigeMeldung('Dieses Lied lässt sich nicht abspielen.', 3000); });

// Fürs Protokoll: jedes wichtige Ereignis des Players mit Zeit und Zustand festhalten.
for (const name of ['play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'emptied']) {
  ton.addEventListener(name, () => {
    const fehler = ton.error ? ` Fehler ${ton.error.code}` : '';
    merke(`${name} bei ${ton.currentTime.toFixed(1)} s, Daten ${ton.readyState}${fehler}${document.hidden ? ', im Hintergrund' : ''}`);
  });
}

// Der Schieberegler im großen Player
el('zeitRegler').addEventListener('input', () => {
  reglerWirdGezogen = true;
  const anteil = el('zeitRegler').value / 1000;
  el('zeitRegler').style.setProperty('--stand', `${anteil * 100}%`);
  el('zeitJetzt').textContent = alsZeit(anteil * liedDauer());
});
el('zeitRegler').addEventListener('change', () => {
  reglerWirdGezogen = false;
  const ziel = el('zeitRegler').value / 1000 * liedDauer();
  if (!liedDauer()) return;
  letzteZeit = ziel;
  // Hat der Player gerade keine Daten (z. B. nach dem Einfrieren), wird das Lied an der Zielstelle neu geladen.
  if (ton.readyState >= 1 && !ton.error) ton.currentTime = ziel;
  else ladeNeu(ziel, !ton.paused);
});

// ---------- 5. Sperrbildschirm, Kontrollzentrum und Kopfhörer ----------
// Über die "Media Session" erfährt das iPhone, welches Lied läuft,
// und die App erfährt, wenn jemand auf dem Sperrbildschirm oder am AirPod eine Taste drückt.

function richteSperrbildschirmEin() {
  if (!('mediaSession' in navigator)) return;
  const tasten = {
    play: () => setzeFort(),
    pause: () => ton.pause(),
    nexttrack: () => naechstes(false),
    previoustrack: () => vorheriges(),
    seekto: angabe => { if (angabe.seekTime != null) ton.currentTime = angabe.seekTime; },
  };
  for (const [taste, tue] of Object.entries(tasten)) {
    const mitProtokoll = angabe => { merke(`Taste von aussen: ${taste}`); tue(angabe || {}); };
    try { navigator.mediaSession.setActionHandler(taste, mitProtokoll); } catch { /* Taste wird hier nicht unterstützt */ }
  }
  if (aktuellesLied()) meldeLiedAnSperrbildschirm(aktuellesLied());
}

function meldeLiedAnSperrbildschirm(lied) {
  if (!('mediaSession' in navigator)) return;
  const cover = coverAdresse(lied);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: lied.titel,
    artist: lied.kuenstler || '',
    album: lied.album || '',
    artwork: cover
      ? [{ src: cover, sizes: '512x512', type: lied.cover.type || 'image/jpeg' }]
      : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

/** Sagt dem iPhone, wie lang das Lied ist und wo es steht (für den Balken auf dem Sperrbildschirm). */
function meldePosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(ton.duration) || ton.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: ton.duration,
      position: Math.min(ton.currentTime, ton.duration),
      playbackRate: ton.playbackRate || 1,
    });
  } catch { /* ungültige Werte einfach überspringen */ }
}
ton.addEventListener('seeked', meldePosition);

// ---------- 6. Musik hinzufügen und löschen ----------

const MUSIK_ENDUNGEN = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i;

/** Speichert die gewählten Musikdateien in der App. */
async function importiere(dateien) {
  const musik = [...dateien].filter(d => d.type.startsWith('audio/') || MUSIK_ENDUNGEN.test(d.name));
  if (musik.length === 0) { zeigeMeldung('Das waren keine Musikdateien.', 3000); return; }

  const neue = [];
  let doppelt = 0;
  for (let i = 0; i < musik.length; i++) {
    const datei = musik[i];
    zeigeMeldung(`Lied ${i + 1} von ${musik.length} wird gespeichert …`);
    try {
      const tags = await liesTags(datei);

      // Ohne Tags hilft der Dateiname, z. B. "03 Künstler - Titel.mp3"
      if (!tags.titel) {
        const name = datei.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s.\-_]+/, '');
        const strich = name.indexOf(' - ');
        if (strich > 0) { tags.kuenstler = tags.kuenstler || name.slice(0, strich); tags.titel = name.slice(strich + 3); }
        else tags.titel = name;
      }

      // Dasselbe Lied (gleicher Titel, Künstler und Dateigröße) nicht zweimal speichern
      if (lieder.some(l => l.titel === tags.titel && l.kuenstler === tags.kuenstler && l.groesse === datei.size)) { doppelt++; continue; }

      const lied = {
        id: crypto.randomUUID(),
        titel: tags.titel,
        kuenstler: tags.kuenstler,
        album: tags.album,
        dauer: 0,
        cover: tags.bild ? await verkleinere(tags.bild, 512) : null,
        groesse: datei.size,
        hinzugefuegt: Date.now() + i,
      };
      await dbSetze('dateien', datei, lied.id);
      await dbSetze('lieder', lied);
      lieder.push(lied);
      neue.push(lied);
    } catch (fehler) {
      // Meist ist dann der Speicher des Geräts voll.
      zeigeMeldung(`Speichern abgebrochen: ${fehler && fehler.message ? fehler.message : 'Speicher voll?'}`, 5000);
      break;
    }
  }

  zeichne();
  if (neue.length) zeigeMeldung(`${neue.length} Lieder hinzugefügt${doppelt ? `, ${doppelt} waren schon da` : ''}.`, 3500);
  else if (doppelt) zeigeMeldung('Diese Lieder waren alle schon da.', 3500);

  // Bei mehreren neuen Liedern anbieten, gleich eine Playlist daraus zu machen.
  if (neue.length > 1) {
    const name = prompt(`Aus den ${neue.length} neuen Liedern eine Playlist machen?\nGib einen Namen ein oder tippe auf „Abbrechen“.`);
    if (name && name.trim()) {
      const liste = { id: crypto.randomUUID(), name: name.trim(), liedIds: neue.map(l => l.id) };
      playlists.push(liste);
      await dbSetze('playlists', liste);
      wechsleAnsicht('playlist', liste.id);
    }
  }
  ermittleDauern(neue);
}

/** Verkleinert ein Coverbild, damit 300 Cover nicht den Speicher füllen. */
async function verkleinere(bild, kante) {
  try {
    const quelleBild = await createImageBitmap(bild);
    const faktor = Math.min(1, kante / Math.max(quelleBild.width, quelleBild.height));
    const flaeche = document.createElement('canvas');
    flaeche.width = Math.round(quelleBild.width * faktor);
    flaeche.height = Math.round(quelleBild.height * faktor);
    flaeche.getContext('2d').drawImage(quelleBild, 0, 0, flaeche.width, flaeche.height);
    return await new Promise(fertig => flaeche.toBlob(b => fertig(b || bild), 'image/jpeg', 0.85));
  } catch {
    return bild; // Verkleinern nicht möglich: Originalbild behalten
  }
}

/**
 * Versucht, die Länge der neuen Lieder im Hintergrund herauszufinden.
 * Manche Geräte erlauben das erst beim Abspielen. Dann bricht die Suche ab
 * und die Länge wird später beim ersten Hören eingetragen.
 */
async function ermittleDauern(neueLieder) {
  const messer = new Audio();
  messer.preload = 'metadata';
  for (const lied of neueLieder) {
    const datei = await dbHole('dateien', lied.id);
    if (!datei) continue;
    const url = URL.createObjectURL(datei);
    const dauer = await new Promise(fertig => {
      const wecker = setTimeout(() => fertig(0), 3000);
      messer.onloadedmetadata = () => { clearTimeout(wecker); fertig(messer.duration); };
      messer.onerror = () => { clearTimeout(wecker); fertig(-1); };
      messer.src = url;
    });
    URL.revokeObjectURL(url);
    if (dauer === 0) break;                 // Gerät lädt nichts im Voraus: aufhören
    if (dauer > 0 && isFinite(dauer) && !lied.dauer) {
      lied.dauer = dauer;
      await dbSetze('lieder', lied);
      document.querySelectorAll(`[data-dauer="${lied.id}"]`).forEach(e => { e.textContent = alsZeit(dauer); });
    }
  }
  messer.removeAttribute('src');
}

async function loescheLied(lied) {
  if (!confirm(`„${lied.titel}“ von diesem Gerät löschen?`)) return;
  const liefGerade = aktuellesLied() && aktuellesLied().id === lied.id;

  await dbLoesche('dateien', lied.id);
  await dbLoesche('lieder', lied.id);
  lieder = lieder.filter(l => l.id !== lied.id);
  for (const liste of playlists.filter(p => p.liedIds.includes(lied.id))) {
    liste.liedIds = liste.liedIds.filter(id => id !== lied.id);
    await dbSetze('playlists', liste);
  }

  // Auch aus der Warteschlange nehmen
  const aktuell = warteschlange[stelle];
  basis = basis.filter(id => id !== lied.id);
  warteschlange = warteschlange.filter(id => id !== lied.id);
  if (liefGerade) {
    ton.pause();
    ton.removeAttribute('src');
    ton.load();
    stelle = Math.min(stelle, warteschlange.length - 1);
    if (stelle >= 0) spieleStelle();
  } else {
    stelle = warteschlange.indexOf(aktuell);
  }
  verwirfVorgeladenes();
  legeNaechstesBereit();
  speichereZustand();
  zeichne();
  zeigeSpielstand();
}

let meldungsWecker = null;
/** Zeigt unten einen kurzen Hinweis. Ohne "dauer" bleibt er stehen, bis ein neuer kommt. */
function zeigeMeldung(text, dauer) {
  clearTimeout(meldungsWecker);
  el('meldung').textContent = text;
  el('meldung').hidden = false;
  if (dauer) meldungsWecker = setTimeout(() => { el('meldung').hidden = true; }, dauer);
}

// ---------- 7. Menüs und Klicks ----------

let blattEintraege = [];

/** Öffnet ein Menü von unten. eintraege = [{ text, tue, gefahr }] */
function zeigeBlatt(titel, eintraege) {
  blattEintraege = eintraege;
  el('blatt').innerHTML = `<div class="blatt-titel">${sicher(titel)}</div>`
    + eintraege.map((e, nr) => `<button data-aktion="blattWahl" data-nr="${nr}"${e.gefahr ? ' class="gefahr"' : ''}>${sicher(e.text)}</button>`).join('');
  el('blattHintergrund').hidden = false;
}

function liedMenue(lied) {
  const eintraege = [
    { text: 'Als Nächstes spielen', tue: () => spieleAlsNaechstes(lied) },
    { text: 'Zu Playlist hinzufügen', tue: () => waehlePlaylist(lied) },
  ];
  if (ansicht.name === 'playlist') {
    eintraege.push({ text: 'Aus dieser Playlist entfernen', tue: () => entferneAusPlaylist(lied) });
  }
  eintraege.push({ text: 'Vom Gerät löschen', gefahr: true, tue: () => loescheLied(lied) });
  zeigeBlatt(lied.titel, eintraege);
}

function spieleAlsNaechstes(lied) {
  if (!aktuellesLied()) { starteListe([lied.id], 0, 'Einzelnes Lied'); return; }
  if (aktuellesLied().id === lied.id) return;
  // Falls das Lied schon in der Warteschlange steht, wird es dort herausgenommen und neu eingereiht.
  const aktuell = warteschlange[stelle];
  warteschlange = warteschlange.filter(id => id !== lied.id);
  stelle = warteschlange.indexOf(aktuell);
  warteschlange.splice(stelle + 1, 0, lied.id);
  if (!basis.includes(lied.id)) basis.push(lied.id);
  legeNaechstesBereit();
  speichereZustand();
  zeigeMeldung('Wird als Nächstes gespielt.', 2000);
}

function waehlePlaylist(lied) {
  const eintraege = playlists.map(liste => ({
    text: liste.name,
    tue: async () => {
      if (liste.liedIds.includes(lied.id)) { zeigeMeldung('Das Lied ist schon in dieser Playlist.', 2500); return; }
      liste.liedIds.push(lied.id);
      await dbSetze('playlists', liste);
      zeigeMeldung(`Zu „${liste.name}“ hinzugefügt.`, 2500);
    },
  }));
  eintraege.push({ text: '+ Neue Playlist', tue: () => neuePlaylist([lied.id]) });
  zeigeBlatt('Zu welcher Playlist?', eintraege);
}

async function neuePlaylist(liedIds = []) {
  const name = prompt('Name der neuen Playlist:');
  if (!name || !name.trim()) return;
  const liste = { id: crypto.randomUUID(), name: name.trim(), liedIds };
  playlists.push(liste);
  await dbSetze('playlists', liste);
  if (liedIds.length) zeigeMeldung(`Zu „${liste.name}“ hinzugefügt.`, 2500);
  else wechsleAnsicht('playlist', liste.id);
}

async function entferneAusPlaylist(lied) {
  const liste = playlists.find(p => p.id === ansicht.playlistId);
  if (!liste) return;
  liste.liedIds = liste.liedIds.filter(id => id !== lied.id);
  await dbSetze('playlists', liste);
  zeichne();
}

function playlistMenue() {
  const liste = playlists.find(p => p.id === ansicht.playlistId);
  if (!liste) return;
  zeigeBlatt(liste.name, [
    {
      text: 'Umbenennen', tue: async () => {
        const name = prompt('Neuer Name:', liste.name);
        if (!name || !name.trim()) return;
        liste.name = name.trim();
        await dbSetze('playlists', liste);
        zeichne();
      },
    },
    {
      text: 'Playlist löschen', gefahr: true, tue: async () => {
        if (!confirm(`Playlist „${liste.name}“ löschen?\nDie Lieder bleiben auf dem Gerät.`)) return;
        playlists = playlists.filter(p => p.id !== liste.id);
        await dbLoesche('playlists', liste.id);
        wechsleAnsicht('playlists');
      },
    },
  ]);
}

/**
 * Zeigt den inneren Zustand des Players. Das hilft bei der Fehlersuche auf dem iPhone,
 * weil man dort sonst nicht hineinschauen kann.
 */
function zeigeDiagnose() {
  const sitzung = 'mediaSession' in navigator;
  const zustand = [
    `Tonspur Version ${VERSION}`,
    `Sperrbildschirm-Anbindung: ${sitzung ? 'vorhanden' : 'fehlt'}`,
    `gemeldetes Lied: ${sitzung && navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : '-'}`,
    `pausiert: ${ton.paused ? 'ja' : 'nein'}`,
    `Daten bereit (0-4): ${ton.readyState}`,
    `Ladezustand (0-3): ${ton.networkState}`,
    `Zeit: ${ton.currentTime.toFixed(1)} von ${ton.duration}`,
    `gemerkte Stelle: ${letzteZeit.toFixed(1)}`,
    `Fehlernummer: ${ton.error ? ton.error.code : 'keine'}`,
    `Rettungen durch den Waechter: ${rettungen}`,
    `Sekunden seit Pause: ${pausiertSeit ? Math.round((Date.now() - pausiertSeit) / 1000) : '-'}`,
    `als App installiert: ${navigator.standalone === true ? 'ja' : 'nein'}`,
    `Offline-Helfer aktiv: ${navigator.serviceWorker && navigator.serviceWorker.controller ? 'ja' : 'nein'}`,
  ];

  // Zustand und Protokoll in einem Fenster zeigen, mit einem Knopf zum Kopieren.
  const text = zustand.join('\n') + '\n\n--- Protokoll (neueste Zeile unten) ---\n' + protokoll.join('\n');
  blattEintraege = [
    {
      text: 'Alles kopieren', tue: () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => zeigeMeldung('Kopiert. Jetzt im Chat einfügen.', 3000), () => zeigeMeldung('Kopieren ging nicht. Mach bitte einen Screenshot.', 4000));
        } else zeigeMeldung('Kopieren ging nicht. Mach bitte einen Screenshot.', 4000);
      },
    },
    { text: 'Protokoll leeren', tue: () => { protokoll = []; localStorage.removeItem('tonspur-protokoll'); zeigeMeldung('Protokoll geleert.', 2000); } },
  ];
  el('blatt').innerHTML = '<div class="blatt-titel">Diagnose</div>'
    + `<pre class="protokoll">${sicher(text)}</pre>`
    + blattEintraege.map((e, nr) => `<button data-aktion="blattWahl" data-nr="${nr}">${sicher(e.text)}</button>`).join('');
  el('blattHintergrund').hidden = false;
  el('blatt').scrollTop = el('blatt').scrollHeight;
}

/** Der Name, der im großen Player oben steht ("Deine Musik", "Suche" oder der Playlist-Name). */
function nameDerAnsicht() {
  if (ansicht.name === 'playlist') {
    const liste = playlists.find(p => p.id === ansicht.playlistId);
    return liste ? liste.name : '';
  }
  return ansicht.name === 'suche' ? 'Suche' : 'Deine Musik';
}

// Jeder Knopf trägt im HTML ein data-aktion="...". Hier steht, was die Aktion tut.
const AKTIONEN = {
  ansicht: knopf => wechsleAnsicht(knopf.dataset.ansicht),
  hinzufuegen: () => el('dateiWahl').click(),
  spielen: zeile => {
    const ids = sichtbareIds();
    starteListe(ids, Math.max(0, ids.indexOf(zeile.dataset.id)), nameDerAnsicht());
  },
  allesSpielen: () => { zufall = false; starteListe(sichtbareIds(), 0, nameDerAnsicht()); },
  zufaelligSpielen: () => {
    const ids = sichtbareIds();
    zufall = true;
    starteListe(ids, Math.floor(Math.random() * ids.length), nameDerAnsicht());
  },
  diagnose: () => zeigeDiagnose(),
  menue: knopf => { const lied = findeLied(knopf.dataset.id); if (lied) liedMenue(lied); },
  menueAktuell: () => {
    if (!aktuellesLied()) return;
    liedMenue(aktuellesLied());
    // Im großen Player gibt es zusätzlich die Diagnose für die Fehlersuche.
    blattEintraege.push({ text: 'Diagnose anzeigen', tue: zeigeDiagnose });
    el('blatt').insertAdjacentHTML('beforeend', `<button data-aktion="blattWahl" data-nr="${blattEintraege.length - 1}">Diagnose anzeigen</button>`);
  },
  neuePlaylist: () => neuePlaylist(),
  oeffnePlaylist: zeile => wechsleAnsicht('playlist', zeile.dataset.id),
  playlistMenue: () => playlistMenue(),
  playPause: () => playPause(),
  weiter: () => naechstes(false),
  zurueck: () => vorheriges(),
  zufall: () => schalteZufall(),
  wiederholen: () => schalteWiederholen(),
  oeffnePlayer: () => { el('grossPlayer').hidden = false; },
  schliessePlayer: () => { el('grossPlayer').hidden = true; },
  blattZu: (ziel, ereignis) => { if (ereignis.target === el('blattHintergrund')) el('blattHintergrund').hidden = true; },
  blattWahl: knopf => {
    el('blattHintergrund').hidden = true;
    blattEintraege[Number(knopf.dataset.nr)].tue();
  },
};

// Ein einziger Klick-Empfänger für die ganze Seite: Er sucht den angeklickten Knopf und führt seine Aktion aus.
document.addEventListener('click', ereignis => {
  const ziel = ereignis.target.closest('[data-aktion]');
  if (ziel && AKTIONEN[ziel.dataset.aktion]) AKTIONEN[ziel.dataset.aktion](ziel, ereignis);
});

document.addEventListener('input', ereignis => { if (ereignis.target.id === 'suchfeld') zeigeSuchTreffer(); });

el('dateiWahl').addEventListener('change', async () => {
  const dateien = [...el('dateiWahl').files];
  el('dateiWahl').value = '';
  if (dateien.length) await importiere(dateien);
});

// Am PC: Musikdateien einfach ins Fenster ziehen
document.addEventListener('dragover', ereignis => ereignis.preventDefault());
document.addEventListener('drop', ereignis => {
  ereignis.preventDefault();
  if (ereignis.dataTransfer && ereignis.dataTransfer.files.length) importiere(ereignis.dataTransfer.files);
});

// Wenn die App in den Hintergrund geht, den Stand sichern.
document.addEventListener('visibilitychange', () => {
  merke(document.hidden ? 'App im Hintergrund' : 'App wieder sichtbar');
  if (document.hidden) speichereZustand();
});

// Nach dem Start das zuletzt gehörte Lied wieder einlegen (ohne es abzuspielen).
start().then(() => { if (aktuellesLied()) ladeNeu(letzteZeit, false); });
