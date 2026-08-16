# Terranor Tracker

Privat verktøy for løpende resultatestimat for Terranor Group. Målet er å samle kontrakter, værforhold, tilleggsarbeider og historiske estimater i én modell frem mot kvartalsrapportene.

Første hovedmål er Q3 2026.

## Hva systemet gjør

Systemet følger flere typer informasjon som kan påvirke Terranors omsetning og lønnsomhet:

- **Kontrakter:** start- og sluttdato, kontraktsverdi, årlig omsetningstakt og geografi.
- **Veivær i Sverige:** målinger fra Trafikverkets værstasjoner langs veiene, blant annet veibanetemperatur, lufttemperatur, vind, nedbør og snø.
- **Vanlig svensk vær:** målinger fra Sveriges meteorologiske og hydrologiske institutt.
- **Historisk vær:** brukes for å sammenligne dagens forhold med tidligere år på samme sted og samme tid på året.
- **Tilleggsarbeider og andre aktivitetssignaler:** offentlige bestillinger, budsjetter, opsjoner og andre kildebelagte signaler.
- **Løpende resultatestimat:** omsetning, justert EBITA og etter hvert avvik mot markedets forventninger.
- **Historikk:** gamle estimater beholdes i stedet for å overskrives, slik at modellen kan etterprøves i ettertid.

## Forklaring av værkildene

Forkortelsene brukes i koden og i enkelte API-adresser, men på nettsiden vises mer forklarende navn.

- **VViS:** Trafikverkets system for veiværstasjoner i Sverige. Dette er den viktigste kilden for forhold direkte langs veiene.
- **SMHI:** Sveriges meteorologiske og hydrologiske institutt. Gir vanlige meteorologiske målinger og historikk.
- **DMI:** Danmarks Meteorologiske Institut. Planlagt kilde for danske kontrakter.
- **FMI:** Finlands meteorologiske institutt. Planlagt kilde for finske kontrakter.

## Værbaserte arbeidsforhold

Systemet beregner en egen score for hvor gunstige værforholdene er for drift og vedlikehold. I koden heter funksjonen fortsatt `workability`, men på nettsiden omtales den som **værbaserte arbeidsforhold**.

Scoren bruker blant annet nedbør, vind, snø, veibanetemperatur, frost, sterk varme og datadekning. Dette er **ikke et direkte omsetningsestimat**.

Fra fase A brukes flere målestasjoner per kontrakt. Store driftsområder kan bruke opptil tre veiværstasjoner og to vanlige værstasjoner. Dette reduserer risikoen for at én enkelt stasjon gir et misvisende bilde.

## Fase A – historikk og geografi

Fase A er satt i gang og består av to deler.

### 1. Tiårig sammenligningsgrunnlag for vær

Systemet henter gradvis kvalitetssikret historisk vær fra SMHIs korrigerte arkiv. For Q3 brukes perioden **2016–2025** som et tiårig sammenligningsgrunnlag for:

- lufttemperatur
- vindhastighet
- nedbør
- andel timer med sterk varme
- andel timer med sterk vind
- andel timer med nedbør

Dette omtales som et **tiårig sammenligningsgrunnlag**, ikke som SMHIs offisielle klimanormal. En offisiell klimanormal bygger normalt på en lengre standardperiode.

Arkivinnlastingen kjøres gradvis for å unngå store enkeltjobber. Én kombinasjon av værstasjon og værparameter behandles automatisk per time. Resultatet lagres som kompakte normalverdier for dagene i juli, august og september; hele råarkivet lagres ikke i databasen.

Når nok arkivjobber er ferdige, kan `/api/climate/comparison` vise om de siste dagene har vært mer eller mindre arbeidsvennlige enn det tiårige grunnlaget.

### 2. Bedre geografisk dekning

Den løpende scoren for værbaserte arbeidsforhold bruker nå flere målestasjoner per kontrakt der de finnes. Avstand og rangering påvirker vektingen.

Dette er en klar forbedring fra å bruke bare én stasjon, men geografien er fortsatt basert på representative midtpunkter for kontraktsområdene. Eksakte kontraktspolygoner bør legges inn senere dersom slike data blir tilgjengelige.

## Nåværende status

Følgende er satt opp og i drift:

- privat innlogging
- Cloudflare D1-database
- kontraktsregister
- timebasert innsamling av svenske værdata
- veivær fra Trafikverket
- vanlige svenske værstasjoner
- 60-dagers historisk innlasting av svenske værdata
- tiårig sammenligningsgrunnlag fra kvalitetssikret SMHI-arkiv
- flerstasjonsdekning for værbaserte arbeidsforhold
- kontraktsbro for Q3
- register for tilleggsarbeider og andre signaler
- kvalitetskontroll av datainnsamlingen
- historikk for beregnede scorer og estimater
- egen statusside på `/status.html`

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
3. beregning av værbaserte arbeidsforhold
4. gradvis innlasting av manglende 60-dagershistorikk
5. gradvis bygging av tiårig sammenligningsgrunnlag for Q3-vær

## Teknisk oppbygning

Noen produktnavn og tekniske navn kan ikke oversettes naturlig og beholdes derfor:

- **Cloudflare Worker:** den serverløse bakgrunnstjenesten som kjører API-et og de planlagte jobbene.
- **Cloudflare D1:** databasen som lagrer kontrakter, værmålinger, signaler og historikk.
- **Workers Static Assets:** de statiske filene som utgjør nettsiden.
- **Cron:** teknisk navn på tidsplanen som starter den automatiske jobben hver time.
- **API:** grensesnittet som nettsiden og testadressene bruker for å hente data fra bakgrunnstjenesten.

## Mappestruktur

```text
public/             Nettsiden og statussiden
src/index.js        Grunnleggende API, innlogging og timebasert innsamling
src/index2.js       Utvidede API-funksjoner
src/weather.js      Vanlige svenske værdata
src/vvis.js         Veivær fra Trafikverket
src/workability.js  Værbaserte arbeidsforhold
src/backfill.js     60-dagers historisk innlasting
src/climate.js      Tiårig sammenligningsgrunnlag fra SMHI
src/geography.js    Kontroll av geografisk værdekning
src/bridge.js       Kontraktsbro for Q3
src/signals.js      Tilleggsarbeider og andre aktivitetssignaler
src/quality.js      Kvalitetskontroll
db/                 Databaseskjema
wrangler.jsonc      Cloudflare-oppsett
package.json        Tekniske kommandoer
```

## Viktige API-adresser

Disse adressene brukes hovedsakelig til kontroll og feilsøking. Navnene beholdes i koden selv om nettsiden bruker norske forklaringer.

```text
/api/health                 Grunnleggende status
/api/status                 Samlet status for datainnsamlingen
/api/contracts              Kontraktsregister
/api/weather/contracts      Svenske værstasjoner per kontrakt
/api/vvis/contracts         Veiværstasjoner per kontrakt
/api/workability            Værbaserte arbeidsforhold
/api/workability/history    Historikk for arbeidsforhold
/api/backfill/smhi/status   Status for 60-dagers værhistorikk
/api/climate/status         Status for tiårig sammenligningsgrunnlag
/api/climate/run            Kjør neste historiske arkivjobb manuelt
/api/climate/comparison     Vær mot tiårig sammenligningsgrunnlag
/api/geography              Geografisk dekning per kontrakt
/api/contract-bridge        Kontraktsbro for Q3
/api/signals                Tilleggsarbeider og andre aktivitetssignaler
/api/data-quality           Kvalitetskontroll
```

## Arbeidsplan frem mot Q3 2026

1. **Fase A – pågår:** fullfør tiårig værgrunnlag og forbedre geografisk dekning.
2. Fyll signalregisteret med dokumenterte tilleggsarbeider og nye bestillinger.
3. Koble danske og finske værdata til relevante kontrakter.
4. Etter Q2-rapporten: sammenlign den låste Q2-modellen med faktiske tall.
5. Kalibrer modellen én gang og dokumenter endringene.
6. Lås Q3-metodikken og lagre alle senere estimater uten overskriving.
7. Sammenlign det låste Q3-estimatet med markedets forventninger og faktiske Q3-tall.

## Lokale kommandoer

Disse er kun relevante ved lokal utvikling:

```bash
npm install
npm run dev
npm run check
npm run deploy
```
