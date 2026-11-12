'use strict';

// ============================================================================
// Quellen: sucht Musik im Internet.
//
// Eingebunden sind nur Quellen mit frei lizenzierter Musik (Creative Commons
// oder gemeinfrei), bei denen Anhören und Herunterladen ausdrücklich erlaubt ist:
//
//   Openverse         - eine Suchmaschine für freie Medien. Sie durchsucht
//                       unter anderem Jamendo, Freesound und Wikimedia Commons.
//   Internet Archive  - ein großes Online-Archiv mit vielen Netlabels.
//
// Jede Quelle liefert "Treffer" in derselben Form zurück:
//   { schluessel, quelle, titel, kuenstler, album, dauer, coverUrl,
//     strom, ladbar, seite, lizenz }
// "strom" ist die Adresse der Tondatei. "ladbar" sagt, ob die Quelle erlaubt,
// die Datei im Browser herunterzuladen (für die Offline-Wiedergabe).
// ============================================================================

/** Kann dieses Gerät das Dateiformat überhaupt abspielen? (Das iPhone kann z. B. oft kein OGG.) */
function istAbspielbar(endung) {
  const arten = {
    mp3: 'audio/mpeg', mp31: 'audio/mpeg', mp32: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', ogx: 'audio/ogg', opus: 'audio/ogg; codecs=opus',
  };
  const art = arten[String(endung || '').toLowerCase()];
  return !!art && document.createElement('audio').canPlayType(art) !== '';
}

/** Holt eine Antwort als JSON und bricht ab, wenn die Quelle zu lange braucht. */
async function holeJson(adresse, sekunden = 12) {
  const abbruch = new AbortController();
  const wecker = setTimeout(() => abbruch.abort(), sekunden * 1000);
  try {
    const antwort = await fetch(adresse, { signal: abbruch.signal });
    if (antwort.status === 429) throw new Error('zu viele Anfragen, bitte kurz warten');
    if (!antwort.ok) throw new Error(`Fehler ${antwort.status}`);
    return await antwort.json();
  } finally {
    clearTimeout(wecker);
  }
}

// ---------- Openverse ----------

const OPENVERSE_NAMEN = { jamendo: 'Jamendo', freesound: 'Freesound', wikimedia_audio: 'Wikimedia', ccmixter: 'ccMixter' };

async function sucheOpenverse(text) {
  const daten = await holeJson(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(text)}&page_size=20`);
  return (daten.results || [])
    .filter(e => e.url && istAbspielbar(e.filetype))
    .filter(e => !e.duration || e.duration >= 30000)        // kurze Geräusche (unter 30 Sekunden) weglassen
    .map(e => ({
      schluessel: `openverse:${e.id}`,
      quelle: OPENVERSE_NAMEN[e.source] || e.source || 'Openverse',
      titel: e.title || 'Ohne Titel',
      kuenstler: e.creator || '',
      album: e.audio_set && e.audio_set.title ? e.audio_set.title : '',
      dauer: e.duration ? e.duration / 1000 : 0,             // Openverse nennt Millisekunden
      coverUrl: e.thumbnail || '',
      strom: e.url,
      ladbar: e.source !== 'jamendo',                         // Jamendo erlaubt im Browser nur das Anhören
      seite: e.foreign_landing_url || '',
      lizenz: e.license ? `CC ${String(e.license).toUpperCase()}${e.license_version ? ' ' + e.license_version : ''}` : '',
    }));
}

// ---------- Internet Archive ----------
// Das Archiv kennt keine einzelnen Lieder, sondern "Einträge" (meist Alben).
// Deshalb zwei Schritte: erst passende Einträge suchen, dann deren Liederlisten holen.

async function sucheArchiv(text) {
  // Nur Einträge mit ausdrücklich angegebener Lizenz (licenseurl), also frei nutzbare Musik.
  const wort = text.replace(/["()\[\]:]/g, ' ').trim();
  const frage = `(title:(${wort}) OR creator:(${wort})) AND mediatype:audio AND licenseurl:[* TO *]`;
  const suche = await holeJson('https://archive.org/advancedsearch.php?q=' + encodeURIComponent(frage)
    + '&fl[]=identifier&rows=6&sort[]=downloads+desc&output=json');
  const kennungen = (suche.response && suche.response.docs ? suche.response.docs : []).map(d => d.identifier);

  // Die Liederlisten gleichzeitig holen. Ein einzelner Fehlschlag soll die anderen nicht stören.
  const listen = await Promise.all(kennungen.map(k => holeJson(`https://archive.org/metadata/${encodeURIComponent(k)}`, 10).catch(() => null)));

  const gesucht = wort.toLowerCase().split(/\s+/).filter(Boolean);
  const treffer = [];
  listen.forEach((eintrag, nr) => {
    if (!eintrag || !eintrag.files || !eintrag.metadata) return;
    const kennung = kennungen[nr];
    const kopf = eintrag.metadata;
    const einer = wert => Array.isArray(wert) ? wert[0] : (wert || '');
    const pfad = name => `https://archive.org/download/${encodeURIComponent(kennung)}/${name.split('/').map(encodeURIComponent).join('/')}`;

    // Coverbild: eine Bilddatei aus dem Eintrag (die lässt sich auch offline speichern).
    const bild = eintrag.files.find(f => /\.(jpe?g|png)$/i.test(f.name) && !/_thumb|_itemimage|spectrogram/i.test(f.name));
    const coverUrl = bild ? pfad(bild.name) : `https://archive.org/services/img/${encodeURIComponent(kennung)}`;

    // Nur die Original-MP3s, nicht die automatisch erzeugten kleineren Kopien.
    let dateien = eintrag.files.filter(f => /\.mp3$/i.test(f.name) && !/64kb|_vbr\.mp3$|_sample/i.test(f.name));
    // Lieder, deren Titel zum Suchwort passt, zuerst. Pro Eintrag höchstens vier Lieder.
    const passt = f => gesucht.some(w => String(f.title || f.name).toLowerCase().includes(w));
    dateien = dateien.filter(passt).concat(dateien.filter(f => !passt(f))).slice(0, 4);

    for (const f of dateien) {
      treffer.push({
        schluessel: `archiv:${kennung}/${f.name}`,
        quelle: 'Internet Archive',
        titel: einer(f.title) || f.name.replace(/\.mp3$/i, '').replace(/^\d+[\s._-]+/, '').replace(/_/g, ' '),
        kuenstler: einer(f.creator) || einer(f.artist) || einer(kopf.creator),
        album: einer(f.album) || einer(kopf.title),
        dauer: alsSekunden(f.length),
        coverUrl,
        strom: pfad(f.name),
        ladbar: true,
        seite: `https://archive.org/details/${encodeURIComponent(kennung)}`,
        lizenz: lizenzName(einer(kopf.licenseurl)),
      });
    }
  });
  return treffer;
}

/** Das Archiv gibt die Länge mal als "270.93" (Sekunden), mal als "4:30" an. */
function alsSekunden(angabe) {
  if (!angabe) return 0;
  const teile = String(angabe).split(':').map(Number);
  if (teile.some(isNaN)) return 0;
  return teile.reduce((summe, teil) => summe * 60 + teil, 0);
}

/** Macht aus einer Lizenz-Adresse einen kurzen Namen, z. B. "CC BY-NC 4.0". */
function lizenzName(adresse) {
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i.exec(adresse || '');
  if (cc) return `CC ${cc[1].toUpperCase()} ${cc[2]}`;
  if (/publicdomain/i.test(adresse || '')) return 'gemeinfrei';
  return adresse ? 'freie Lizenz' : '';
}

// ---------- Direkter Link ----------

/** Wer statt eines Suchworts die Adresse einer Tondatei einfügt, bekommt genau diese als Treffer. */
function trefferAusLink(text) {
  const treffer = /^https?:\/\/\S+\.(mp3|m4a|aac|wav|flac|ogg|opus)(\?\S*)?$/i.exec(text.trim());
  if (!treffer || !istAbspielbar(treffer[1])) return null;
  const adresse = text.trim();
  let name = adresse.split('?')[0].split('/').pop();
  try { name = decodeURIComponent(name); } catch { /* Name bleibt, wie er ist */ }
  return {
    schluessel: `link:${adresse}`,
    quelle: 'Direkter Link',
    titel: name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
    kuenstler: '', album: '', dauer: 0, coverUrl: '',
    strom: adresse, ladbar: true,
    seite: adresse, lizenz: '',
  };
}

// ---------- Alles zusammen ----------

const QUELLEN = [
  { name: 'Openverse', suche: sucheOpenverse },
  { name: 'Internet Archive', suche: sucheArchiv },
];

/**
 * Fragt alle Quellen gleichzeitig. Fällt eine aus, liefern die anderen trotzdem.
 * Ergebnis: { treffer: [...], ausgefallen: ['Name: Grund', ...] }
 */
async function sucheOnline(text) {
  const link = trefferAusLink(text);
  if (link) return { treffer: [link], ausgefallen: [] };

  const antworten = await Promise.allSettled(QUELLEN.map(q => q.suche(text)));
  const listen = [];
  const ausgefallen = [];
  antworten.forEach((antwort, nr) => {
    if (antwort.status === 'fulfilled') listen.push(antwort.value);
    else ausgefallen.push(`${QUELLEN[nr].name}: ${antwort.reason && antwort.reason.name === 'AbortError' ? 'antwortet nicht' : (antwort.reason && antwort.reason.message) || 'nicht erreichbar'}`);
  });

  // Die Treffer der Quellen abwechselnd mischen, damit nicht eine Quelle alles verdrängt.
  const treffer = [];
  const gesehen = new Set();
  const laengste = Math.max(0, ...listen.map(l => l.length));
  for (let i = 0; i < laengste; i++) {
    for (const liste of listen) {
      const t = liste[i];
      if (!t) continue;
      // Dasselbe Lied (gleicher Titel und Künstler) nur einmal zeigen
      const merkmal = `${t.titel}|${t.kuenstler}`.toLowerCase();
      if (gesehen.has(merkmal)) continue;
      gesehen.add(merkmal);
      treffer.push(t);
    }
  }
  return { treffer, ausgefallen };
}
