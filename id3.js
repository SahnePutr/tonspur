'use strict';

// ============================================================================
// Tag-Leser: holt Titel, Künstler, Album und Cover aus einer MP3-Datei.
// Diese Angaben stehen ganz am Anfang der Datei in einem Block namens "ID3v2".
//
// Aufbau:  "ID3" | Version | Schalter | Größe | Rahmen, Rahmen, Rahmen ...
// Jeder Rahmen hat eine Kennung (z. B. TIT2 = Titel) und eine Länge.
// ============================================================================

/** Liest die Tags einer Datei. Fehlt etwas, bleibt das Feld leer. */
async function liesTags(datei) {
  const ergebnis = { titel: '', kuenstler: '', album: '', bild: null };
  try {
    const kopf = new Uint8Array(await datei.slice(0, 10).arrayBuffer());
    const istId3 = kopf[0] === 0x49 && kopf[1] === 0x44 && kopf[2] === 0x33; // die Buchstaben "ID3"
    if (!istId3) return ergebnis;

    const version = kopf[3];                    // 2, 3 oder 4
    const groesse = sparZahl(kopf, 6);
    const daten = new Uint8Array(await datei.slice(10, 10 + groesse).arrayBuffer());

    let ort = 0;
    if (kopf[5] & 0x40) {                       // es gibt einen Zusatzkopf: überspringen
      ort = version === 4 ? sparZahl(daten, 0) : zahl(daten, 0, 4) + 4;
    }

    // Version 2 benutzt kürzere Rahmenköpfe (3 Buchstaben + 3 Bytes Länge).
    const kennLaenge = version === 2 ? 3 : 4;
    const kopfLaenge = version === 2 ? 6 : 10;

    while (ort + kopfLaenge <= daten.length && daten[ort] !== 0) {
      const kennung = String.fromCharCode(...daten.subarray(ort, ort + kennLaenge));
      const laenge = version === 2 ? zahl(daten, ort + 3, 3)
                   : version === 4 ? sparZahl(daten, ort + 4)
                   : zahl(daten, ort + 4, 4);
      const inhalt = daten.subarray(ort + kopfLaenge, ort + kopfLaenge + laenge);
      ort += kopfLaenge + laenge;
      if (laenge <= 0) continue;

      if (kennung === 'TIT2' || kennung === 'TT2') ergebnis.titel = liesText(inhalt);
      else if (kennung === 'TPE1' || kennung === 'TP1') ergebnis.kuenstler = liesText(inhalt);
      else if (kennung === 'TALB' || kennung === 'TAL') ergebnis.album = liesText(inhalt);
      else if ((kennung === 'APIC' || kennung === 'PIC') && !ergebnis.bild) ergebnis.bild = liesBild(inhalt, version);
    }
  } catch {
    // Kaputte oder ungewöhnliche Tags: Dann nimmt die App den Dateinamen.
  }
  return ergebnis;
}

/** Normale Zahl aus mehreren Bytes (das vorderste Byte zählt am meisten). */
function zahl(bytes, start, anzahl) {
  let wert = 0;
  for (let i = 0; i < anzahl; i++) wert = wert * 256 + bytes[start + i];
  return wert;
}

/** "Synchsafe"-Zahl: ID3 nutzt hier nur 7 der 8 Bits pro Byte. */
function sparZahl(bytes, start) {
  return (bytes[start] & 0x7f) * 0x200000 + (bytes[start + 1] & 0x7f) * 0x4000
       + (bytes[start + 2] & 0x7f) * 0x80 + (bytes[start + 3] & 0x7f);
}

/** Das erste Byte eines Textrahmens sagt, in welcher Zeichenkodierung der Text steht. */
function liesText(inhalt) {
  const art = inhalt[0];
  let bytes = inhalt.subarray(1);
  let kodierung = 'windows-1252';
  if (art === 3) kodierung = 'utf-8';
  else if (art === 2) kodierung = 'utf-16be';
  else if (art === 1) {
    kodierung = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-16le';
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) bytes = bytes.subarray(2);
  }
  // Mehrere Werte sind durch ein Null-Zeichen getrennt, z. B. zwei Künstler.
  return new TextDecoder(kodierung).decode(bytes).split('\0').filter(Boolean).join(', ').trim();
}

/** Holt das eingebettete Coverbild aus einem Bildrahmen. */
function liesBild(inhalt, version) {
  const art = inhalt[0];
  let ort = 1;
  let typ = 'image/jpeg';

  if (version === 2) {
    // Version 2: drei Buchstaben wie "JPG" oder "PNG"
    if (String.fromCharCode(...inhalt.subarray(1, 4)) === 'PNG') typ = 'image/png';
    ort = 4;
  } else {
    // Ab Version 3: Bildtyp als Text bis zum Null-Zeichen, z. B. "image/png"
    let ende = ort;
    while (ende < inhalt.length && inhalt[ende] !== 0) ende++;
    const angabe = String.fromCharCode(...inhalt.subarray(ort, ende));
    if (angabe.includes('/')) typ = angabe;
    ort = ende + 1;
  }

  ort++; // ein Byte "Bildart" (Vorderseite, Rückseite ...) überspringen

  // Danach folgt eine Beschreibung, die mit einem Null-Zeichen endet (bei UTF-16 mit zwei).
  if (art === 1 || art === 2) {
    while (ort + 1 < inhalt.length && (inhalt[ort] !== 0 || inhalt[ort + 1] !== 0)) ort += 2;
    ort += 2;
  } else {
    while (ort < inhalt.length && inhalt[ort] !== 0) ort++;
    ort++;
  }

  return ort < inhalt.length ? new Blob([inhalt.subarray(ort)], { type: typ }) : null;
}
