# Terranor Tracker

Privat verktøy for løpende resultatestimat for Terranor Group. Målet er å samle kontrakter, værforhold, tilleggsarbeider og historiske estimater i én modell frem mot kvartalsrapportene.

Første hovedmål er Q3 2026.

## Hva systemet gjør

Systemet følger flere typer informasjon som kan påvirke Terranors omsetning og lønnsomhet:

- **Kontrakter:** start- og sluttdato, kontraktsverdi, årlig omsetningstakt og geografi.
- **Veivær i Sverige:** målinger fra Trafikverkets værstasjoner langs veiene, blant annet veibanetemperatur, lufttemperatur, vind, nedbør og snø.
- **Vanlig svensk vær:** målinger fra Sveriges meteorologiske og hydrologiske institutt.
- **Historisk vær:** brukes for å sammenligne dagens forhold med det som er normalt på samme sted og samme tid på året.
- **Tilleggsarbeider og andre aktivitetssignaler:** offentlige bestillinger, budsjetter, opsjoner og andre kildebelagte signaler.
- **Løpende resultatestimat:** omsetning, justert EBITA og etter hvert avvik mot markedets forventninger.
- **Historikk:** gamle estimater beholdes i stedet for å overskrives, slik at modellen kan etterprøves i ettertid.

## Forklaring av værkildene

Forkortelsene brukes i koden og i enkelte API-adresser, men på nettsiden vises mer forklarende navn.

- **VViS:** Trafikverkets system for veiværstasjoner i Sverige. Dette er den viktigste kilden for forhold direkte langs veiene.
- **SMHI:** Sveriges meteorologiske og hydrologiske institutt. Gir vanlige meteorologiske målinger og historikk.
- **DMI:** Danmarks Meteorologiske Institut. Planlagt kilde for danske kontrakter.
- **FMI:** Finlands meteorologiske institutt. Planlagt kilde for finske kontrakter.

## Værbasert arbeidsegnethet

Systemet beregner en egen score for hvor gunstige værforholdene er for drift og vedlikehold. I koden heter denne funksjonen fortsatt `workability`, men på nettsiden omtales den som **værbasert arbeidsegnethet** eller **værbaserte arbeidsforhold**.

Scoren bruker blant annet:

- nedbør
- vind
- snø
- veibanetemperatur
- frost
- sterk varme
- hvor god datadekningen er

Dette er **ikke et direkte omsetningsestimat**. Målet er først å måle arbeidsforholdene, og deretter undersøke hvordan avvik fra normalt vær henger sammen med aktivitet og marginer.

## Nåværende status

Følgende er satt opp og i drift:

- privat innlogging
- Cloudflare D1-database
- kontraktsregister
- timebasert innsamling av svenske værdata
- veivær fra Trafikverket
- vanlige svenske værstasjoner
- historisk innlasting av svenske værdata
- værbasert arbeidsegnethet
- kontraktsbro for Q3
- register for tilleggsarbeider og andre signaler
- kvalitetskontroll av datainnsamlingen
- historikk for beregnede scorer og estimater

Danske og finske værkilder er planlagt, men ikke koblet til ennå.

## Automatisk kjøring

Cloudflare kjører en planlagt jobb hver time, 15 minutter over hel time:

```text
15 * * * *
```

Det betyr at innsamlingen kjører hele døgnet uten at en lokal PC eller nettleser må stå på.

Den timebaserte jobben kjører blant annet:

1. nye svenske værmålinger
2. nye veiværmålinger fra Trafikverket
3. beregning av værbasert arbeidsegnethet
4. gradvis innlasting av manglende historiske værdata

## Teknisk oppbygning

Noen produktnavn og tekniske navn kan ikke oversettes naturlig og beholdes derfor:

- **Cloudflare Worker:** den serverløse bakgrunnstjenesten som kjører API-et og de planlagte jobbene.
- **Cloudflare D1:** databasen som lagrer kontrakter, værmålinger, signaler og historikk.
- **Workers Static Assets:** de statiske filene som utgjør nettsiden.
- **Cron:** teknisk navn på tidsplanen som starter den automatiske jobben hver time.
- **API:** grensesnittet som nettsiden og testadressene bruker for å hente data fra bakgrunnstjenesten.

## Mappestruktur

```text
public/             Nettsiden
src/index.js        Grunnleggende API, innlogging og timebasert innsamling
src/index2.js       Utvidede API-funksjoner
src/weather.js      Vanlige svenske værdata
src/vvis.js         Veivær fra Trafikverket
src/workability.js  Værbasert arbeidsegnethet
src/backfill.js     Historisk innlasting av værdata
src/bridge.js       Kontraktsbro for Q3
src/signals.js      Tilleggsarbeider og andre aktivitetssignaler
src/quality.js      Kvalitetskontroll
db/                 Databaseskjema
wrangler.jsonc      Cloudflare-oppsett
package.json        Tekniske kommandoer
```

## Viktige API-adresser

Disse adressene brukes hovedsakelig til kontroll og feilsøking. Navnene er beholdt på engelsk fordi de allerede brukes av koden.

```text
/api/health                 Grunnleggende status
/api/status                 Samlet status for datainnsamlingen
/api/contracts              Kontraktsregister
/api/weather/contracts      Svenske værstasjoner per kontrakt
/api/vvis/contracts         Veiværstasjoner per kontrakt
/api/workability            Værbasert arbeidsegnethet
/api/workability/history    Historikk for arbeidsegnethet
/api/backfill/smhi/status   Status for historisk værinnlasting
/api/contract-bridge        Kontraktsbro for Q3
/api/signals                Tilleggsarbeider og andre aktivitetssignaler
/api/data-quality           Kvalitetskontroll
```

## Arbeidsplan frem mot Q3 2026

1. Fullfør historisk værinnlasting for alle relevante svenske kontrakter.
2. Bygg historisk normalvær og mål løpende avvik fra normalen.
3. Forbedre geografien for store driftsområder med flere målepunkter.
4. Fyll signalregisteret med dokumenterte tilleggsarbeider og nye bestillinger.
5. Koble danske og finske værdata til relevante kontrakter.
6. Etter Q2-rapporten: sammenlign den låste Q2-modellen med faktiske tall.
7. Kalibrer modellen én gang og dokumenter endringene.
8. Lås Q3-metodikken og lagre alle senere estimater uten overskriving.
9. Sammenlign det låste Q3-estimatet med markedets forventninger og faktiske Q3-tall.

## Lokale kommandoer

Disse er kun relevante ved lokal utvikling:

```bash
npm install
npm run dev
npm run check
npm run deploy
```
