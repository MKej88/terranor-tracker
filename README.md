# Terranor Tracker

Privat analyseverktøy for løpende oppfølging av Terranor Group. Trackeren samler kontrakter, vær, historiske sammenligninger, offentlige tildelinger, planlagte anskaffelser, tilleggsarbeider og andre kildebelagte aktivitetssignaler frem mot kvartalsrapportene.

Nåværende målkvartal er **Q3 2026**.

## Terranor Tracker 2.0

Versjon 2.0 rydder opp den tekniske arkitekturen og skjerper datakvaliteten før selve resultatmodellen bygges videre.

De viktigste prinsippene er:

- **Én Worker-inngang:** `src/worker.js` håndterer innlogging, API-ruting og alle planlagte jobber.
- **Én kvartalskonfigurasjon:** målkvartal, datoer og kvalitetsgrenser ligger i `src/config.js`.
- **Manglende data er ikke godt vær:** værscorer beregnes bare når kritiske parametre har tilstrekkelig dekning.
- **Ferdig betyr faktisk dekning:** 60-dagershistorikk og 10-årsgrunnlag vurderes på parameterdekning, ikke bare eldste observasjon eller antall kjørte jobber.
- **Kildebelagte signaler holdes adskilt fra estimater:** ordre, opsjoner og offentlige funn blir ikke automatisk omgjort til omsetning eller EBITA.
- **Endringer skal kunne testes:** grunnleggende tester kjøres automatisk i GitHub Actions før kode flettes til `main`.

## Sider

- `/` – hovedside og overordnet datastatus.
- `/status.html` – svensk vær, datakvalitet, historikk og geografi.
- `/sverige.html` – detaljert svensk vær- og kontraktsvisning.
- `/fase-b.html` – kontrakter, tilleggsarbeider, offentlige tildelinger og aktivitetssignaler.
- `/fase-c.html` – løpende vær og 60-dagershistorikk for Danmark og Finland.
- `/norden.html` – nordisk 10-årsgrunnlag og historisk sammenligning.

## Datakilder

### Sverige

- **SMHI:** vanlig meteorologisk vær.
- **Trafikverket VViS:** veivær, inkludert veibanetemperatur og andre forhold langs veiene.
- **Trafikverket – tildelte kontrakter:** Terranors deltakelse, vinnere, tilbud og kontraktsverdier.
- **Trafikverket – planlagte anskaffelser:** fremtidig pipeline for relevante drifts- og vedlikeholdsanskaffelser.

### Danmark

- **DMI:** meteorologiske observasjoner for Terranor-relaterte kontraktsområder og regionale proxyer.

### Finland

- **FMI:** timebaserte observasjoner via instituttets WFS-tjeneste for Terranor-relaterte områder.

### Fase B

- Terranors offisielle nyhetsside.
- Trafikverkets offentlige kontrakts- og innkjøpskilder.
- Utvalgte kommunale sider og e-Avrop for kontraktsnære beslutninger, tildelinger, opsjoner og oppfølging.

## Kvalitetsregler i 2.0

Kritiske værparametre er **lufttemperatur, vind og nedbør**.

### Løpende arbeidsforhold

En værscore beregnes bare når kritiske parametre har minst **70 % dekning** i den aktuelle perioden. Hver parameter bruker sin egen nevner, slik at manglende nedbørs- eller vindmålinger ikke feilaktig tolkes som godt vær.

### 60-dagershistorikk

Et væranker regnes som ferdig når:

1. tidsintervallet faktisk dekker hele den ønskede perioden, og
2. temperatur, vind og nedbør hver har minst **85 % dekning**.

Dette gjelder både Sverige og den nordiske historikkjeden.

### 10-årsgrunnlag

For Q3 brukes **2016–2025** som tiårig sammenligningsgrunnlag. Dette er ikke en offisiell 30-års klimanormal.

En historisk stasjon eller et væranker regnes som klart når alle tre kritiske parametre har:

- minst **9 historiske år**, og
- minst **85 % dekning av Q3-dagene** i sammenligningsperioden.

## Værbaserte arbeidsforhold

`src/workability.js` beregner en absolutt score for hvor arbeidsvennlige forholdene er. Flere målestasjoner kan inngå per kontrakt, med avstands- og rangeringsvekting. Når både VViS og SMHI finnes, får veivær størst vekt.

Scoren er **ikke et direkte resultatestimat**. Historisk væravvik beregnes separat mot 10-årsgrunnlaget.

## Trafikverket-pipeline

Trafikverket-modulen lagrer:

- Terranor-deltakelser og vinn/tap.
- Alle tilbydere i de relevante anskaffelsene.
- kontraktsverdi inklusive opsjoner fra Trafikverkets fil.
- planlagte relevante anskaffelser og JournalID.
- snapshots av endringer i innkjøpsplanen.

XLSX-filene identifiseres med **SHA-256-hash**. Dermed oppdages en ny versjon også hvis Trafikverket erstatter innholdet bak samme URL.

Ved innkjøpsplanimport skrives den nye versjonen først. Gamle rader deaktiveres først etter at hele den nye versjonen er skrevet, slik at en avbrutt import ikke tømmer den aktive pipelinen.

## Kommunale kilder

Kommunale funn blir kandidater for vurdering. I 2.0 krever automatisk kontraktskobling tekst som faktisk skiller kontrakten fra kommunen generelt. Det er ikke lenger nok at kommunen bare har én kjent Terranor-kontrakt.

Hvis en detaljside midlertidig ikke kan hentes, markeres den ikke som ferdig behandlet; den prøves igjen ved neste kjøring. PDF-lenker som ikke leses som fulltekst merkes eksplisitt som vurdert ut fra lenketittel og kontekst.

## Kontraktsregister

Kontrakter seedes fra kode til D1. Seeds bruker kontrollert UPSERT i stedet for `INSERT OR IGNORE`, slik at korrigerte verdier i kode kan oppdatere eksisterende D1-rader uten å nullstille tidligere dokumenterte verdier.

## Arkitektur

```text
Cloudflare
│
├─ Worker: src/worker.js
│  ├─ autentisering
│  ├─ API-router
│  └─ cron-dispatcher
│
├─ D1: terranor-tracker-db
└─ Static Assets: public/
```

Den gamle `index.js`–`index6.js`-kjeden er fjernet. `wrangler.jsonc` peker direkte på `src/worker.js`, og ny funksjonalitet skal legges i featuremoduler og registreres i den samlede routeren i stedet for å opprette nye wrapper-lag.

### Viktige moduler

```text
src/worker.js                    Samlet Worker-router og cron-dispatcher
src/config.js                    Målkvartal og kvalitetsgrenser
src/db.js                        Kjerne-tabeller og kontraktseeds
src/weather.js                   SMHI live-data
src/vvis.js                      Trafikverket VViS
src/workability.js               Værbaserte arbeidsforhold
src/backfill.js                  Svensk 60-dagershistorikk
src/climate.js                   Svensk 10-årsgrunnlag
src/climate-status.js            Streng readiness for svensk historikk
src/geography.js                 Svensk geografisk dekning
src/activity.js                  Terranor-nyheter og aktivitetssignaler
src/trafikverket-procurement.js  Trafikverket tildelinger og pipeline
src/municipal-monitor.js         Kommunale/offentlige kilder
src/nordic.js                    Nordisk værgrunnlag
src/dmi.js                       Danmark live-data
src/fmi.js                       Finland live-data
src/nordic-backfill.js           Nordisk 60-dagershistorikk
src/nordic-climate.js            Nordisk 10-årsarkiv
src/nordic-climate-status.js     Streng nordisk readiness
src/weather-quality.js           Felles kvalitetsfunksjoner
test/                            Automatiske tester
```

## Planlagte jobber

Jobbene er bevisst fordelt utover timen for å redusere samtidige tunge kall.

| Tid | Jobb |
|---|---|
| `5 * * * *` | SMHI live |
| `15 * * * *` | Trafikverket VViS |
| `25 * * * *` | DMI live |
| `30 * * * *` | Nordisk 10-årsgrunnlag |
| `35 * * * *` | FMI live |
| `40 * * * *` | Danmark/Finland 60-dagershistorikk |
| `45 * * * *` | Sverige 60-dagershistorikk |
| `50 * * * *` | Svensk 10-årsgrunnlag |
| `55 * * * *` | Værbaserte arbeidsforhold |
| `0 */6 * * *` | Terranor aktivitetssignaler |
| `10 2 * * *` | Trafikverket tildelinger/pipeline |
| `20 3 * * *` | Kommunale kilder |

## API

Lesende endepunkter bruker normalt `GET`. Manuelle handlinger som starter innsamling eller endrer data bruker `POST`.

Eksempler:

```text
GET  /api/health
GET  /api/overview
GET  /api/contracts
GET  /api/data-quality
GET  /api/workability
GET  /api/backfill/smhi/status
POST /api/backfill/smhi/run
GET  /api/climate/status
GET  /api/climate/comparison
POST /api/climate/full-run
GET  /api/activity/status
POST /api/activity/run
GET  /api/trafikverket/status
GET  /api/trafikverket/awards
GET  /api/trafikverket/plan
POST /api/trafikverket/run
GET  /api/municipal/status
POST /api/municipal/run
GET  /api/nordic/backfill/status
POST /api/nordic/backfill/run
GET  /api/nordic/climate/status
GET  /api/nordic/climate/comparison
POST /api/nordic/climate/run
```

Alle private API-endepunkter bruker samme innloggingssesjon. POST-kall kontrollerer også Origin når nettleseren sender den.

## Sikkerhet

- APP_PASSWORD og SESSION_SECRET lagres som Cloudflare-secrets.
- Sesjonen er HMAC-SHA256-signert og tidsbegrenset.
- Cookie bruker `HttpOnly`, `Secure` og `SameSite=Strict`.
- HTML-svar får blant annet CSP, `frame-ancestors 'none'`, `X-Content-Type-Options` og restriktiv referrer-policy.
- Eksterne tekstverdier escapes før de settes inn i de oppdaterte detaljsidene.

## Tester og CI

Kjør lokalt:

```bash
npm test
npm run check
```

GitHub Actions kjører begge kontrollene automatisk på pull requests og ved push til `main`.

## Viktig modellregel

Ingen av følgende skal automatisk bli bokført som kvartalsomsetning eller justert EBITA uten en eksplisitt modellregel:

- godt eller dårlig vær
- aktivitetssignal
- offentlig bestilling
- opsjon
- planlagt anskaffelse
- kontraktsverdi

Trackeren skal først samle, kvalitetssikre og dokumentere data. Selve økonomiske oversettelsen skal være separat, versjonert og mulig å etterprøve.
