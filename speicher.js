'use strict';

// ============================================================================
// Speicher: legt Lieder und Playlists dauerhaft auf dem Gerät ab.
// Dafür gibt es im Browser eine eingebaute Datenbank namens "IndexedDB".
// Sie hat drei "Lager":
//   lieder    - Angaben zu jedem Lied (Titel, Künstler, Cover ...)
//   dateien   - die eigentlichen Musikdateien
//   playlists - die Playlists (Name und Liste von Lied-Kennungen)
// ============================================================================

let datenbank = null;

/** Öffnet die Datenbank. Beim allerersten Start werden die Lager angelegt. */
function oeffneDatenbank() {
  return new Promise((fertig, fehler) => {
    const anfrage = indexedDB.open('tonspur', 1);
    anfrage.onupgradeneeded = () => {
      const db = anfrage.result;
      db.createObjectStore('lieder', { keyPath: 'id' });
      db.createObjectStore('dateien');
      db.createObjectStore('playlists', { keyPath: 'id' });
    };
    anfrage.onsuccess = () => { datenbank = anfrage.result; fertig(); };
    anfrage.onerror = () => fehler(anfrage.error);
  });
}

/**
 * Führt einen Lese- oder Schreibvorgang aus und wartet, bis er wirklich fertig ist.
 * "tue" bekommt das Lager und gibt die Anfrage zurück (z. B. lager.get(...)).
 */
function dbVorgang(lager, modus, tue) {
  return new Promise((fertig, fehler) => {
    const vorgang = datenbank.transaction(lager, modus);
    const anfrage = tue(vorgang.objectStore(lager));
    vorgang.oncomplete = () => fertig(anfrage.result);
    vorgang.onerror = vorgang.onabort = () => fehler(vorgang.error);
  });
}

const dbAlle = lager => dbVorgang(lager, 'readonly', l => l.getAll());
const dbHole = (lager, schluessel) => dbVorgang(lager, 'readonly', l => l.get(schluessel));
const dbSetze = (lager, wert, schluessel) => dbVorgang(lager, 'readwrite', l => l.put(wert, schluessel));
const dbLoesche = (lager, schluessel) => dbVorgang(lager, 'readwrite', l => l.delete(schluessel));
