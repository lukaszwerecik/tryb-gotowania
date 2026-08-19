/* suchy-bieg-minutnikow.mjs — czy minutniki w trybie gotowania naprawdę odliczają.
 *
 * Wszystkie 16 przepisów ma minutniki (55 sztuk łącznie), a żaden dotąd nie był
 * uruchomiony poza ręcznym klikaniem na telefonie. Ta próba odpala każdy z nich
 * w prawdziwym runtime (`tryb-gotowania.min.js`) w Chromium i sprawdza cztery
 * rzeczy, których nie widać z lektury kodu: czy kafel powstaje, czy pokazuje
 * właściwy czas startowy, czy odlicza, i czy dochodzi do zera we właściwym stanie.
 *
 * CZAS JEST WSTRZYKIWANY, nie odczekiwany. Runtime czyta go wyłącznie przez
 * `MP.zegar.teraz()` — to nie jest ułatwienie dla próby, tylko istniejący hak,
 * postawiony dokładnie po to (przebieg 3 w STAN.md). Odczekiwanie 90 minut na
 * minutnik wołowiny nie byłoby dokładniejsze, tylko wolniejsze.
 *
 * Uruchomienie: node narzedzia/suchy-bieg-minutnikow.mjs [--zrzuty]
 * Wymaga lokalnego Chromium, więc nie stoi w bramce CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { parser } from '../odmiana-node.mjs';
import { zrodla } from '../lancuch-html/wspolne.mjs';

const P = parser();
const PARSER = fs.readFileSync('przepis-parser.min.js', 'utf8');
const TRYB = fs.readFileSync('tryb-gotowania.min.js', 'utf8');
const ZRZUTY = process.argv.includes('--zrzuty');
const KAT_ZRZUTOW = '/tmp/zrzuty-minutnikow';
if (ZRZUTY) fs.mkdirSync(KAT_ZRZUTOW, { recursive: true });

const strona = `<!doctype html><meta charset="utf-8">
<body style="margin:0;font-family:system-ui">
<script>window.MP={zegar:{__t:1000000000000,teraz:function(){return this.__t}}};</script>
<script>${PARSER}</script><script>${TRYB}</script></body>`;

const przegladarka = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const kontekst = await przegladarka.newContext({ viewport: { width: 390, height: 844 } });

/* Strona MUSI mieć prawdziwe pochodzenie, a nie `about:blank`: runtime zapisuje
   sesję w `localStorage`, a przy pochodzeniu nieprzezroczystym przeglądarka
   odmawia dostępu i `otworz()` rzuca SecurityError. `setContent` daje właśnie
   takie pochodzenie — stąd fikcyjny adres i przechwycenie żądania. */
const ADRES = 'https://proba.test/przepis';
await kontekst.route(ADRES, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: strona }));
const otworzKarte = async () => { const k = await kontekst.newPage(); await k.goto(ADRES); return k; };

let zdane = 0, oblane = 0, minutnikow = 0;
const zle = (n, p) => { oblane++; console.log(`✗ ${n}\n    ${p}`); };

for (const { slug, zrodlo } of zrodla()) {
  const baza = zrodlo.meta['porcje-bazowe'];
  const skl = P._wewnetrzne.parsujSkladniki(zrodlo.pola.skladniki);
  const kroki = P._wewnetrzne.parsujKroki(zrodlo.pola.kroki, skl.map((s) => s.key));
  const zMinutnikiem = kroki.map((k, i) => ({ k, i })).filter(({ k }) => k.minutnik);
  if (!zMinutnikiem.length) continue;

  const karta = await otworzKarte();
  const model = { skladniki: skl, kroki, porcjeBazowe: baza, tytul: zrodlo.meta.nazwa,
                  czas: String(zrodlo.meta['czas-minuty']), meta: [], zamienniki: {}, bledy: [], pola: {} };
  const bledy = [];

  await karta.evaluate(({ model, baza }) => {
    const widok = MP.przepis.naPorcje(model, baza);
    MP.tryb.otworz(widok, { model, porcje: baza });
  }, { model, baza });

  for (const { k, i } of zMinutnikiem) {
    minutnikow++;
    const wynik = await karta.evaluate(({ nr, sek }) => {
      MP.tryb.minutniki.wyczysc();
      MP.tryb.pokazKrok(nr);
      const krok = MP.tryb.czesci && null;
      const m = MP.tryb.minutniki.zKroku(
        { minutnik: { sekundy: sek, nazwa: 'próba' }, kryteriumHtml: null });
      if (!m) return { blad: 'zKroku nie zwrócił minutnika' };
      const czytaj = () => {
        const l = MP.tryb.minutniki.lista()[0];
        const el = l && l.el && l.el.odliczanie;
        return l ? { pozostalo: l.pozostalo, stan: l.stan, naEkranie: el ? el.textContent : null } : null;
      };
      const start = czytaj();
      MP.zegar.__t += (sek - 5) * 1000; MP.tryb.minutniki.tyk();
      const przed = czytaj();
      MP.zegar.__t += 5 * 1000; MP.tryb.minutniki.tyk();
      const koniec = czytaj();
      MP.zegar.__t += 3 * 1000; MP.tryb.minutniki.tyk();
      const poZerze = czytaj();
      return { start, przed, koniec, poZerze, format: MP.tryb.minutniki.formatuj(sek) };
    }, { nr: i + 1, sek: k.minutnik.sekundy });

    const s = k.minutnik.sekundy;
    const etykieta = `${slug} · krok ${i + 1} · ${k.minutnik.nazwa} (${s}s)`;
    if (wynik.blad) { bledy.push(`${etykieta}: ${wynik.blad}`); continue; }
    if (!wynik.start) { bledy.push(`${etykieta}: kafel nie powstał`); continue; }
    if (wynik.start.pozostalo !== s) bledy.push(`${etykieta}: start ${wynik.start.pozostalo}s, oczekiwałem ${s}s`);
    if (wynik.start.naEkranie !== wynik.format) bledy.push(`${etykieta}: na ekranie „${wynik.start.naEkranie}", oczekiwałem „${wynik.format}"`);
    if (wynik.przed.pozostalo !== 5) bledy.push(`${etykieta}: po przewinięciu ${wynik.przed.pozostalo}s, oczekiwałem 5s — NIE ODLICZA`);
    if (wynik.przed.stan !== 'koncowka') bledy.push(`${etykieta}: przy 5s stan „${wynik.przed.stan}", oczekiwałem „koncowka"`);
    if (wynik.koniec.pozostalo !== 0) bledy.push(`${etykieta}: na końcu ${wynik.koniec.pozostalo}s, oczekiwałem 0`);
    if (wynik.koniec.stan !== 'zero') bledy.push(`${etykieta}: na końcu stan „${wynik.koniec.stan}", oczekiwałem „zero"`);
    if (wynik.poZerze.pozostalo !== 0) bledy.push(`${etykieta}: po zerze zszedł na ${wynik.poZerze.pozostalo}s — odlicza w minus`);
  }

  if (ZRZUTY) {
    await karta.evaluate(({ nr, sek }) => {
      MP.tryb.minutniki.wyczysc(); MP.tryb.pokazKrok(nr);
      MP.tryb.minutniki.zKroku({ minutnik: { sekundy: sek, nazwa: 'próba' }, kryteriumHtml: null });
      MP.zegar.__t += (sek - 8) * 1000; MP.tryb.minutniki.tyk();
    }, { nr: zMinutnikiem[0].i + 1, sek: zMinutnikiem[0].k.minutnik.sekundy });
    await karta.screenshot({ path: path.join(KAT_ZRZUTOW, `${slug}.png`) });
  }

  await karta.close();
  if (bledy.length) zle(slug, bledy.slice(0, 3).join('\n    '));
  else { zdane++; console.log(`✓ ${slug} — ${zMinutnikiem.length} minutnik(ów) odlicza do zera`); }
}

/* --- kontrola negatywna 1: zegar stoi → minutnik NIE MOŻE odliczyć --- */
{
  const karta = await otworzKarte();
  const r = await karta.evaluate(() => {
    MP.tryb.otworz({ tytul: 't', czas: '10', meta: [], porcje: 2, skladniki: [], kroki: [
      { numer: 1, zIlu: 1, tytul: 'krok', tekst: '', tekstHtml: '', badge: '5:00',
        minutnik: { sekundy: 300, nazwa: 'próba' }, skladnikiTeraz: [], skladnikiDalej: [],
        skladnikiZuzyte: [], zamiennikiWgKlucza: {} }], zamienniki: {}, bledy: [] }, { porcje: 2 });
    MP.tryb.minutniki.zKroku({ minutnik: { sekundy: 300, nazwa: 'próba' } });
    const a = MP.tryb.minutniki.lista()[0].pozostalo;
    MP.tryb.minutniki.tyk();                       // zegar NIE przesunięty
    const b = MP.tryb.minutniki.lista()[0].pozostalo;
    return { a, b };
  });
  if (r.a === 300 && r.b === 300) { zdane++; console.log('✓ KONTROLA NEGATYWNA — przy stojącym zegarze minutnik nie odlicza (mierzę czas, nie interwał)'); }
  else zle('KONTROLA NEGATYWNA zegara', `pozostało ${r.a} → ${r.b} bez ruchu zegara`);
  await karta.close();
}

/* --- kontrola negatywna 2: trzeci minutnik ma otworzyć dialog S4 --- */
{
  const karta = await otworzKarte();
  const r = await karta.evaluate(() => {
    MP.tryb.otworz({ tytul: 't', czas: '10', meta: [], porcje: 2, skladniki: [], kroki: [
      { numer: 1, zIlu: 1, tytul: 'krok', tekst: '', tekstHtml: '', badge: '1:00',
        minutnik: { sekundy: 60, nazwa: 'a' }, skladnikiTeraz: [], skladnikiDalej: [],
        skladnikiZuzyte: [], zamiennikiWgKlucza: {} }], zamienniki: {}, bledy: [] }, { porcje: 2 });
    MP.tryb.minutniki.uruchom({ nazwa: 'a', sekundy: 60 });
    MP.tryb.minutniki.uruchom({ nazwa: 'b', sekundy: 60 });
    MP.tryb.minutniki.uruchom({ nazwa: 'c', sekundy: 60 });
    return { ile: MP.tryb.minutniki.lista().length, limit: MP.tryb.minutniki.limit,
             dialog: MP.tryb.dialog.rodzaj() };
  });
  if (r.ile === r.limit && r.dialog) { zdane++; console.log(`✓ KONTROLA NEGATYWNA — trzeci minutnik nie wchodzi, otwiera dialog „${r.dialog}"`); }
  else zle('KONTROLA NEGATYWNA limitu', JSON.stringify(r));
  await karta.close();
}

/* --- akordeon i geometria wobec projektu ---------------------------------
   Decyzja operatora 2026-08-19: kafle UNOSZĄ SIĘ nad paskiem nawigacji i najwyżej
   JEDEN jest rozwinięty. Przed poprawką dwa kafle rozpychały BOTTOM do 462 px
   z 780 — pasek przestawał być czymś, co unosi się nad treścią. Liczby niżej są
   wprost z klatek Figmy `7195:11065` (kafel krótki 126, BOTTOM 218) i
   `7211:10893` (kafel pełny 236, stos 248, BOTTOM 328), przy ramce 360×780. */
{
  const karta = await kontekst.newPage();
  await karta.setViewportSize({ width: 360, height: 780 });
  await karta.goto(ADRES);
  const r = await karta.evaluate(() => {
    const krok = { numer: 1, zIlu: 2, tytul: 'duś ragù', tekst: 'x', tekstHtml: 'x', badge: '35 min',
      /* DOKŁADNY tekst z klatki `7211:10893`. Nie jest obojętny: wysokość kafla to
         198 + wysokość podpowiedzi, a ta zależy od liczby wierszy. Krótsze zdanie
         dało 217 zamiast 236 i wyglądało jak rozjazd runtime'u, którym nie było. */
      kryteriumHtml: 'Gdy skończy, sos ma być gęsty, a tłuszcz zbiera się na wierzchu.', minutnik: { sekundy: 2100, nazwa: 'ragù' },
      skladnikiTeraz: [], skladnikiDalej: [], skladnikiZuzyte: [], zamiennikiWgKlucza: {} };
    MP.tryb.otworz({ tytul: 't', czas: '35', meta: [], porcje: 2, skladniki: [], kroki: [krok], zamienniki: {}, bledy: [] }, { porcje: 2 });
    MP.tryb.pokazKrok(1);
    const K = MP.tryb.korzen();
    const pud = (s) => { const e = K.querySelector(s); const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const formy = () => [].slice.call(K.querySelectorAll('.mp-tryb__pigulka')).map((e) => e.getAttribute('data-forma'));

    MP.tryb.minutniki.zKroku(krok);
    const jeden = { formy: formy(), kafel: pud('.mp-tryb__pigulka'), stos: pud('.mp-tryb__stos'),
                    bottom: pud('.mp-tryb__bottom'), nawigacja: pud('.mp-tryb__nawigacja'),
                    tresc: pud('.mp-tryb__top') };
    MP.tryb.minutniki.uruchom({ nazwa: 'makaron', sekundy: 540 });
    const dwa = { formy: formy(), bottom: pud('.mp-tryb__bottom') };
    MP.tryb.minutniki.przelacz(MP.tryb.minutniki.lista()[0]);
    const poPrzelaczeniu = formy();
    return { jeden, dwa, poPrzelaczeniu };
  });
  const bledy = [];
  if (r.jeden.formy.join() !== 'pelna') bledy.push(`świeży minutnik ma formę „${r.jeden.formy}", oczekiwałem rozwiniętej`);
  if (r.jeden.kafel.h !== 236 || r.jeden.kafel.w !== 328 || r.jeden.kafel.x !== 16)
    bledy.push(`kafel ${JSON.stringify(r.jeden.kafel)} ≠ Figma x=16 w=328 h=236`);
  if (r.jeden.stos.h !== 248) bledy.push(`stos ${r.jeden.stos.h} ≠ 248`);
  if (r.jeden.bottom.h !== 328) bledy.push(`BOTTOM ${r.jeden.bottom.h} ≠ 328`);
  if (r.jeden.nawigacja.h !== 80 || r.jeden.nawigacja.y !== 700) bledy.push(`nawigacja ${JSON.stringify(r.jeden.nawigacja)} ≠ y=700 h=80`);
  /* Kafle UNOSZĄ SIĘ nad treścią: treść ma pełną wysokość ramki, a nie jest
     skracana o pasek. To jest ta własność, którą operator nazwał wprost. */
  if (r.jeden.tresc.h !== 780) bledy.push(`treść ${r.jeden.tresc.h} ≠ 780 — pasek skraca treść zamiast unosić się nad nią`);
  if (r.dwa.formy.filter((f) => f !== 'zwinieta').length !== 1)
    bledy.push(`przy dwóch minutnikach rozwiniętych: ${JSON.stringify(r.dwa.formy)}, oczekiwałem dokładnie jednego`);
  if (r.dwa.bottom.h >= 400) bledy.push(`dwa minutniki rozpychają BOTTOM do ${r.dwa.bottom.h} px`);
  if (r.poPrzelaczeniu.filter((f) => f !== 'zwinieta').length !== 1)
    bledy.push(`po ręcznym rozwinięciu: ${JSON.stringify(r.poPrzelaczeniu)}, oczekiwałem dokładnie jednego`);

  if (bledy.length) zle('akordeon i geometria wobec Figmy', bledy.join('\n    '));
  else { zdane++; console.log(`✓ akordeon i geometria — kafel 328×236, stos 248, BOTTOM 328, nawigacja 80, treść 780; dwa minutniki: BOTTOM ${r.dwa.bottom.h}`); }
  await karta.close();
}

await przegladarka.close();
console.log(`\nminutników sprawdzonych: ${minutnikow}`);
console.log(`zdane: ${zdane} · oblane: ${oblane}`);
process.exit(oblane ? 1 : 0);
