/* wypchnij-do-cms.mjs — repo → CMS, w kolejności, której nie da się pomylić.
 *
 * KOLEJNOŚĆ PUBLIKACJI JEST WARUNKIEM KONIECZNYM, nie zaleceniem:
 *
 *     push do GH  →  Pages przebudowane  →  zapis do CMS  →  publikacja itemu
 *
 * Odwrotna kolejność otwiera okno, w którym `parser-url` w CMS wskazuje na plik,
 * którego jeszcze nie ma. Ta sama pułapka jest zapisana w skillu
 * `mp-pomiar-i-pulapki` §3.5 i raz kosztowała zepsute środowisko testowe.
 *
 * Dlatego ten skrypt NIE PRZYPOMINA o kolejności — on ją wymusza: przed
 * jakimkolwiek zapisem pobiera każdy `parser-url` z Pages i wymaga odpowiedzi
 * 200 o treści identycznej z regeneracją. Nie ma pliku na Pages → nie ma zapisu.
 * Przypomnienie da się przeoczyć; 404 nie da się.
 *
 * CZEGO TEN SKRYPT NIE ROBI: nie publikuje. `publish_collection_items` nie
 * przyjmuje parametru domeny `[U]`, więc publikacja itemu jest ZAWSZE zmianą
 * produkcyjną i zawsze decyzją operatora.
 *
 * ODCZYT ZWROTNY JEST OBOWIĄZKOWY, nie ozdobny: zapis do CMS potrafi zgłosić
 * timeout po 180 s i timeout NIE NIESIE INFORMACJI O SKUTKU — 2026-08-19 raz
 * oznaczał udany zapis, raz porażkę z 14 pustymi polami `[V]`. Rozstrzyga
 * wyłącznie ponowny odczyt. Zapis jest idempotentny, więc powtórka jest bezpieczna.
 *
 * Użycie:
 *   WEBFLOW_TOKEN=… node lancuch-html/wypchnij-do-cms.mjs            # SUCHY BIEG
 *   WEBFLOW_TOKEN=… node lancuch-html/wypchnij-do-cms.mjs --wykonaj
 *   WEBFLOW_TOKEN=… node lancuch-html/wypchnij-do-cms.mjs --zaloz-pole-parser-url --wykonaj
 *   … --pomin-pages     # tylko gdy Pages celowo nie ma (np. pierwszy przebieg lokalny)
 */
import path from 'node:path';
import { zbuduj } from './generuj-html.mjs';
import { wczytajPlik } from './zrodlo.mjs';
import { KATALOG_ZRODEL, KOLEKCJA, idZrodel } from './wspolne.mjs';

const API = 'https://api.webflow.com/v2';
const argv = process.argv.slice(2);
const wykonaj = argv.includes('--wykonaj');
const pominPages = argv.includes('--pomin-pages');
const zalozPole = argv.includes('--zaloz-pole-parser-url');
const token = process.env.WEBFLOW_TOKEN;

if (!token) {
  console.error('brak WEBFLOW_TOKEN w środowisku — token site API z uprawnieniem CMS:write');
  process.exit(2);
}

const naglowki = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function api(sciezka, opcje = {}) {
  const r = await fetch(API + sciezka, { ...opcje, headers: { ...naglowki, ...(opcje.headers || {}) } });
  const tekst = await r.text();
  if (!r.ok) throw new Error(`${opcje.method || 'GET'} ${sciezka} → ${r.status} ${tekst.slice(0, 300)}`);
  return tekst ? JSON.parse(tekst) : null;
}

// ------------------------------------------------------------------ 1. budowa
const budowy = [];
let bledy = 0;
for (const id of idZrodel()) {
  const zrodlo = wczytajPlik(path.join(KATALOG_ZRODEL, `${id}.txt`));
  const w = zbuduj(id, zrodlo);
  if (w.bledy.length) {
    bledy += w.bledy.length;
    console.log(`✗ ${zrodlo.meta.slug}`);
    w.bledy.forEach((b) => console.log(`    ${b}`));
  }
  budowy.push(w);
}
if (bledy) {
  console.error(`\n${bledy} błędów w źródłach — nic nie wypycham. Napraw pliki i uruchom ponownie.`);
  process.exit(1);
}
console.log(`zbudowane bez błędu: ${budowy.length} przepisów`);

// ------------------------------------------------------------------ 2. bramka Pages
if (pominPages) {
  console.log('\n! --pomin-pages: NIE sprawdzam, czy ładunki są na Pages. Zapisany parser-url ' +
    'może wskazywać na plik, którego nie ma — to jest dokładnie ta awaria, przed którą chroni ta bramka.');
} else {
  console.log('\nbramka Pages — czy każdy ładunek jest już pod swoim adresem:');
  let brakuje = 0;
  for (const w of budowy) {
    let stan;
    try {
      const r = await fetch(w.ladunek.url, { cache: 'no-store' });
      stan = r.ok ? (await r.text()) === w.ladunek.tresc ? 'ok' : 'inna treść' : `HTTP ${r.status}`;
    } catch (e) { stan = `sieć: ${e.message}`; }
    if (stan !== 'ok') { brakuje++; console.log(`  ✗ ${w.zrodlo.meta.slug}: ${stan} — ${w.ladunek.url}`); }
  }
  if (brakuje) {
    console.error(`\n${brakuje} ładunków nie ma na Pages. Najpierw push, potem (do minuty) ten skrypt. ` +
      'Zapis do CMS teraz dałby stronę wskazującą na nieistniejący plik.');
    process.exit(1);
  }
  console.log(`  ✓ ${budowy.length}/${budowy.length} ładunków dostępnych i zgodnych co do bajtu`);
}

// ------------------------------------------------------------------ 3. pole parser-url
const pola = (await api(`/collections/${KOLEKCJA}`)).fields || [];
const maParserUrl = pola.some((f) => f.slug === 'parser-url');
if (!maParserUrl) {
  if (!zalozPole) {
    console.error('\nw kolekcji nie ma pola „parser-url". Dodaj je flagą --zaloz-pole-parser-url ' +
      '(typ Link) albo ręcznie w Designerze — bez niego strona nie ma skąd wziąć adresu ładunku.');
    process.exit(1);
  }
  if (wykonaj) {
    await api(`/collections/${KOLEKCJA}/fields`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'Link', displayName: 'parser url', isRequired: false,
        helpText: 'POLE POCHODNE — generuje je lancuch-html/generuj-html.mjs. Nie edytuj ręcznie: ' +
          'adres niesie hash zawartości, więc ręczna zmiana daje 404 albo stare dane.'
      })
    });
    console.log('✓ założone pole „parser url" (Link)');
  } else {
    console.log('[sucho] założyłbym pole „parser url" (Link)');
  }
}

// ------------------------------------------------------------------ 4. zapis
const doZapisu = budowy.map((w) => ({
  id: w.itemId,
  slug: w.zrodlo.meta.slug,
  fieldData: { ...w.pola, ...w.pochodne, 'parser-url': w.ladunek.url }
}));

if (!wykonaj) {
  console.log('\n[SUCHY BIEG] zapisałbym po 12 pól w każdym z ' + doZapisu.length + ' itemów:');
  console.log('  ' + Object.keys(doZapisu[0].fieldData).join(', '));
  console.log('\nUruchom ponownie z --wykonaj, żeby zapisać. Publikacji nie robię w żadnym trybie.');
  process.exit(0);
}

let zapisane = 0, nieudane = 0;
for (const it of doZapisu) {
  try {
    await api(`/collections/${KOLEKCJA}/items/${it.id}`, {
      method: 'PATCH', body: JSON.stringify({ fieldData: it.fieldData })
    });
    zapisane++;
    console.log(`✓ zapisany ${it.slug}`);
  } catch (e) {
    nieudane++;
    console.log(`✗ ${it.slug}: ${e.message}`);
    console.log('    (timeout NIE znaczy „nie zapisało się" — rozstrzygnie odczyt zwrotny niżej)');
  }
}

// ------------------------------------------------------------------ 5. odczyt zwrotny
console.log('\nodczyt zwrotny — jedyny rozstrzygający dowód zapisu:');
let rozjazdy = 0;
for (const it of doZapisu) {
  const item = await api(`/collections/${KOLEKCJA}/items/${it.id}`);
  for (const [pole, wartosc] of Object.entries(it.fieldData)) {
    if (item.fieldData[pole] !== wartosc) {
      rozjazdy++;
      console.log(`  ✗ ${it.slug} / ${pole}: w CMS ${JSON.stringify(String(item.fieldData[pole]).slice(0, 60))}`);
    }
  }
}
console.log(rozjazdy ? `  ${rozjazdy} pól nie zgadza się po zapisie` : `  ✓ wszystkie pola zgodne`);
console.log(`\nzapisane: ${zapisane} · nieudane wywołania: ${nieudane} · rozjazdy po odczycie: ${rozjazdy}`);
console.log('Itemy zostają WERSJAMI ROBOCZYMI. Publikacja jest decyzją operatora.');
process.exit(rozjazdy ? 1 : 0);
