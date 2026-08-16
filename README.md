# Terranor Tracker

Privat verktøy for løpende resultatestimat for Terranor Group. Målet er å samle kontrakter, værforhold, tilleggsarbeider, bestillinger og historiske estimater i én modell frem mot kvartalsrapportene.

Første hovedmål er Q3 2026.

## Hva systemet gjør

Systemet følger flere typer informasjon som kan påvirke Terranors omsetning og lønnsomhet:

- **Kontrakter:** start- og sluttdato, kontraktsverdi, årlig omsetningstakt og geografi.
- **Veivær i Sverige:** målinger fra Trafikverkets værstasjoner langs veiene.
- **Vanlig svensk vær:** målinger fra Sveriges meteorologiske og hydrologiske institutt.
- **Dansk vær:** meteorologiske observasjoner fra Danmarks Meteorologiske Institut.
- **Finsk vær:** meteorologiske observasjoner fra Finlands meteorologiske institutt.
- **Historisk vær:** brukes for å sammenligne dagens forhold med tidligere år på samme sted og samme tid på året.
- **Tilleggsarbeider og aktivitetssignaler:** bestillinger, utløste opsjoner og andre kildebelagte signaler.
- **Løpende resultatestimat:** omsetning, justert EBITA og etter hvert avvik mot markedets forventninger.
- **Historikk:** gamle estimater beholdes i stedet for å overskrives.

## Sider

- `/` – hovedside for resultatestimatet.
- `/status.html` – kort drifts- og datastatus.
- `/fase-b.html` – Fase B: tilleggsarbeider, opsjoner og bestillinger.
- `/fase-c.html` – Fase C: danske og finske værdata, historikk og geografisk dekning.

Statussiden er bevisst holdt relativt kort. Fase B og Fase C har egne detaljsider for å unngå unødvendig scrolling.

## Forklaring av værkildene

Forkortelsene brukes i koden og i enkelte API-adresser, men nettsiden bruker mer forklarende navn.

- **VViS:** Trafikverkets system for veiværstasjoner i Sverige.
- **SMHI:** Sveriges meteorologiske og hydrologiske institutt.
- **DMI:** Danmarks Meteorologiske Institut. Fase C bruker det åpne API-et for meteorologiske observasjoner.
- **FMI:** Finlands meteorologiske institutt. Fase C bruker instituttets åpne WFS-tjeneste for observasjoner.

## Værbaserte arbeidsforhold

Systemet beregner en egen score for hvor gunstige værforholdene er for drift og vedlikehold. I koden heter funksjonen fortsatt `workability`, men på nettsiden omtales den som **værbaserte arbeidsforhold**.

Scoren bruker blant annet nedbør, vind, snø, veibanetemperatur, frost, sterk varme og datadekning. Dette er **ikke et direkte omsetningsestimat**.

Fra Fase A brukes flere målestasjoner per svensk kontrakt. Store driftsområder kan bruke opptil tre veiværstasjoner og to vanlige værstasjoner.

## Fase A – historikk og geografi

Fase A er teknisk bygget og datainnhenting/sluttkontroll pågår.

### Tiårig sammenligningsgrunnlag

Systemet henter gradvis kvalitetssikret historisk vær fra SMHIs korrigerte arkiv. For Q3 brukes perioden **2016–2025** som et tiårig sammenligningsgrunnlag for lufttemperatur, vindhastighet og nedbør.

Dette omtales som et **tiårig sammenligningsgrunnlag**, ikke som SMHIs offisielle klimanormal. Én kombinasjon av værstasjon og værparameter behandles automatisk per time. Resultatet lagres som kompakte sammenligningstall for juli, august og september.

`/api/climate/comparison` kan brukes til å sammenligne aktuelle forhold med det tiårige grunnlaget når tilstrekkelig historikk er klar.

### Bedre geografisk dekning

Den løpende svenske scoren bruker flere målestasjoner per kontrakt der de finnes. Avstand og rangering påvirker vektingen. Geografien bygger fortsatt på representative midtpunkter; eksakte kontraktspolygoner kan forbedre modellen senere.

## Fase B – tilleggsarbeider, opsjoner og bestillinger

Fase B fanger opp dokumenterte aktivitetssignaler som kan gi informasjon om fremtidig arbeidsmengde og lønnsomhet.

`/fase-b.html` viser aktive kilder, nye kandidater, mulig kontraktskobling, oppgitt verdi, relevans og registrerte signaler. Nye kandidater kan godkjennes eller ignoreres direkte på siden.

Terranors offisielle svenske nyhetsside kontrolleres automatisk hver sjette time. Tydelige opsjoner, tilleggsarbeider og nye bestillinger kan registreres som signaler. Nye hovedkontrakter håndteres separat for å unngå dobbelttelling.

Et ordre- eller aktivitetssignal blir **ikke automatisk omgjort til omsetning eller justert EBITA**.

## Fase C – Danmark og Finland

Fase C bygger meteorologisk datagrunnlag for danske og finske kontraktsområder. De levende datakjedene for både Danmark og Finland er teknisk validert. Neste del er å bygge historikk og forbedre kontraktsdekningen.

### Danmark

Systemet bruker DMI sitt åpne API for meteorologiske observasjoner. For hvert dansk væranker velges nærmeste aktive målestasjon som eksplisitt støtter alle fire nødvendige værparametere:

- lufttemperatur
- vindhastighet
- relativ luftfuktighet
- nedbør siste time

De aktive værankrene er **Ikast-Brande, Tønder og København**. København-kontrakten starter først i 2027, men datagrunnlaget bygges opp på forhånd.

Den manuelle valideringen ga fullført innhenting for alle tre områder. Systemet valgte Isenvad for Ikast-Brande, Store Jyndevad for Tønder og Københavns Lufthavn for København.

Danmarks fire nye statlige sommerkontrakter ligger fortsatt aggregert i modellgrunnlaget og er ikke splittet i fire separate geografiske kontraktsrader. Dette er den viktigste gjenværende geografiske oppgaven i Danmark.

### Finland

Systemet bruker FMI sin åpne WFS-tjeneste. De aktive værankrene er:

- Kemi
- Ii
- Järvenpää
- Sørøst-Finland, med Lappeenranta som eksplisitt regional proxy for det kjente dreneringsarbeidet

Kemi og Ii starter 1. oktober 2026. Järvenpää er lagt inn som en kommunal kontrakt på 116 MSEK over fire år med oppstart 1. oktober 2026.

Den manuelle FMI-valideringen for Kemi, Ii og Sørøst-Finland ble fullført uten feil. Järvenpää kobles til nærmeste FMI-observasjonsstasjon ved neste finske innhenting etter at den nye versjonen er aktiv.

Terranor har en større eksisterende finsk portefølje enn de navngitte områdene som foreløpig ligger i trackeren. Fase C er derfor **ikke full Finland-dekning ennå**.

### 60-dagers historikk

Fase C har nå egen progressiv historikkinnlasting for Danmark og Finland.

- Danmark fylles bakover i **7-dagersblokker**.
- Finland fylles bakover i **14-dagersblokker**.
- Systemet prioriterer områder med minst historisk dekning.
- Det forsøkes normalt én dansk og én finsk historikkjobb per time så lenge begge land mangler data.
- Historikken lagres i den samme observasjonstabellen som live-data og overskriver ikke andre kilder.

`/fase-c.html` viser samlet fremdrift, antall ferdige værankere, gjennomsnittlig antall historiske dager per land og siste historikkjobb. Knappen **Fyll historikk nå** kan brukes til en manuell delkjøring.

### Viktig modellregel

DMI- og FMI-data blir **ikke automatisk gjort om til omsetning eller justert EBITA**. Først må geografisk dekning, historikk og forholdet mellom vær og kontraktsøkonomi valideres.

## Nåværende status

Følgende er satt opp eller i aktiv innsamling:

- privat innlogging
- Cloudflare D1-database
- kontraktsregister
- svenske veivær- og meteorologiske data
- 60-dagers svensk værhistorikk
- tiårig svensk sammenligningsgrunnlag
- flerstasjonsdekning for svenske arbeidsforhold
- Fase B-kandidat- og signalregister
- automatisk overvåking av Terranors offisielle nyhetsside
- validert levende DMI-innsamling for Danmark
- validert levende FMI-innsamling for Finland
- progressive 60-dagershistorikk for Danmark og Finland
- danske og finske værankere, inkludert Järvenpää
- egen Fase B-side og egen Fase C-side
- kvalitetskontroll og historikk

## Automatisk kjøring

Cloudflare kjører hovedjobben hver time, 15 minutter over hel time:

```text
15 * * * *
```

Den timebaserte jobben kjører blant annet:

1. nye svenske meteorologiske målinger
2. nye svenske veiværmålinger
3. beregning av værbaserte arbeidsforhold
4. gradvis svensk 60-dagershistorikk
5. gradvis tiårig svensk sammenligningsgrunnlag
6. danske DMI-observasjoner
7. finske FMI-observasjoner
8. gradvis dansk og finsk 60-dagershistorikk
9. hver sjette time: Fase B-kildeovervåking

## Teknisk oppbygning

- **Cloudflare Worker:** serverløs bakgrunnstjeneste for API og tidsstyrte jobber.
- **Cloudflare D1:** databasen for kontrakter, værmålinger, signaler og historikk.
- **Workers Static Assets:** nettsidene og JavaScript-filene.
- **Cron:** tidsplanen som starter den automatiske jobben.
- **API:** grensesnittet sidene bruker for å hente data.

## Mappestruktur

```text
public/index.html            Hovedsiden
public/status.html           Kort drifts- og datastatus
public/fase-b.html           Fase B
public/fase-b.js             Fase B-visning og behandling
public/fase-c.html           Fase C – Danmark og Finland
public/fase-c.js             Fase C-status, historikk og manuelle kjøringer
src/index.js                 Grunnleggende API og svensk innsamling
src/index2.js                Utvidede API-funksjoner og planlagte jobber
src/weather.js               Vanlige svenske værdata
src/vvis.js                  Veivær fra Trafikverket
src/workability.js           Værbaserte arbeidsforhold
src/backfill.js              60-dagers svensk historikk
src/climate.js               Tiårig svensk sammenligningsgrunnlag
src/geography.js             Svensk geografisk værdekning
src/activity.js              Fase B-kildeovervåking
src/nordic.js                Fase C – grunnskjema og finsk innsamling
src/dmi.js                   Fase C – dansk DMI-innsamling
src/nordic-contracts.js      Fase C-kontrakter som manglet i grunnregisteret
src/nordic-extra-targets.js  Ekstra værankere, blant annet Järvenpää
src/nordic-backfill.js       Progressiv 60-dagershistorikk for Danmark/Finland
src/bridge.js                Kontraktsbro for Q3
src/signals.js               Aktivitetssignaler
src/quality.js               Kvalitetskontroll
db/                          Databaseskjema
wrangler.jsonc               Cloudflare-oppsett
package.json                 Tekniske kommandoer
```

## Viktige API-adresser

```text
/api/health                       Grunnleggende status
/api/status                       Samlet status for datainnsamlingen
/api/contracts                    Kontraktsregister
/api/weather/contracts            Svenske værstasjoner per kontrakt
/api/vvis/contracts               Svenske veiværstasjoner per kontrakt
/api/workability                  Værbaserte arbeidsforhold
/api/workability/history          Historikk for arbeidsforhold
/api/backfill/smhi/status         Status for 60-dagers svensk værhistorikk
/api/climate/status               Status for tiårig sammenligningsgrunnlag
/api/climate/run                  Kjør neste historiske arkivjobb manuelt
/api/climate/comparison           Vær mot tiårig sammenligningsgrunnlag
/api/geography                    Svensk geografisk dekning
/api/activity/run                 Kjør Fase B manuelt
/api/activity/status              Status for Fase B
/api/activity/candidates          Fase B-kandidater
/api/activity/review              Godkjenn eller ignorer kandidat
/api/nordic/run                   Kjør Fase C live; country=Denmark/Finland/all
/api/nordic/status                Fase C-status og værankere
/api/nordic/backfill/run          Kjør neste historikkdel manuelt
/api/nordic/backfill/status       Fremdrift for 60-dagershistorikk
/api/contract-bridge              Kontraktsbro for Q3
/api/signals                      Registrerte aktivitetssignaler
/api/data-quality                 Kvalitetskontroll
```

## Arbeidsplan frem mot Q3 2026

1. **Fase A – pågår:** fullfør historikk og sluttvalider geografisk dekning.
2. **Fase B – pågår:** bygg ut offentlige kilder for tilleggsarbeider og bestillinger.
3. **Fase C – pågår:** fyll 60-dagershistorikk og utvid kontraktsgeografien i Danmark og Finland.
4. Etter Q2-rapporten: sammenlign den låste Q2-modellen med faktiske tall.
5. Kalibrer modellen én gang og dokumenter endringene.
6. Lås Q3-metodikken og lagre alle senere estimater uten overskriving.
7. Sammenlign låst Q3-estimat med markedets forventninger og faktiske Q3-tall.

## Lokale kommandoer

```bash
npm install
npm run dev
npm run check
npm run deploy
```
