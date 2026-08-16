# Terranor Tracker

Privat verktøy for løpende resultatestimat for Terranor Group. Målet er å samle kontrakter, værforhold, tilleggsarbeider, bestillinger og historiske estimater i én modell frem mot kvartalsrapportene.

Første hovedmål er Q3 2026.

## Hva systemet gjør

Systemet følger flere typer informasjon som kan påvirke Terranors omsetning og lønnsomhet:

- **Kontrakter:** start- og sluttdato, kontraktsverdi, årlig omsetningstakt og geografi.
- **Veivær i Sverige:** målinger fra Trafikverkets værstasjoner langs veiene, blant annet veibanetemperatur, lufttemperatur, vind, nedbør og snø.
- **Vanlig svensk vær:** målinger fra Sveriges meteorologiske og hydrologiske institutt.
- **Historisk vær:** brukes for å sammenligne dagens forhold med tidligere år på samme sted og samme tid på året.
- **Tilleggsarbeider og andre aktivitetssignaler:** offentlige bestillinger, utløste opsjoner og andre kildebelagte signaler.
- **Løpende resultatestimat:** omsetning, justert EBITA og etter hvert avvik mot markedets forventninger.
- **Historikk:** gamle estimater beholdes i stedet for å overskrives, slik at modellen kan etterprøves i ettertid.

## Sider

- `/` – hovedside for resultatestimatet.
- `/status.html` – kort drifts- og datastatus for kontrakter, vær, historikk og datakvalitet.
- `/fase-b.html` – egen arbeidsflate for Fase B med kilder, nye kandidater og registrerte aktivitetssignaler.

Statussiden er bevisst holdt kort. Detaljene for opsjoner, tilleggsarbeider og bestillinger ligger på Fase B-siden for å unngå unødvendig scrolling.

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

### Tiårig sammenligningsgrunnlag for vær

Systemet henter gradvis kvalitetssikret historisk vær fra SMHIs korrigerte arkiv. For Q3 brukes perioden **2016–2025** som et tiårig sammenligningsgrunnlag for lufttemperatur, vindhastighet og nedbør.

Dette omtales som et **tiårig sammenligningsgrunnlag**, ikke som SMHIs offisielle klimanormal. Arkivinnlastingen kjøres gradvis. Én kombinasjon av værstasjon og værparameter behandles automatisk per time. Resultatet lagres som kompakte sammenligningstall for dagene i juli, august og september; hele råarkivet lagres ikke i databasen.

Når nok arkivjobber er ferdige, kan `/api/climate/comparison` vise om de siste dagene har vært mer eller mindre arbeidsvennlige enn det tiårige grunnlaget.

### Bedre geografisk dekning

Den løpende scoren for værbaserte arbeidsforhold bruker flere målestasjoner per kontrakt der de finnes. Avstand og rangering påvirker vektingen.

Geografien er fortsatt basert på representative midtpunkter for kontraktsområdene. Eksakte kontraktspolygoner bør legges inn senere dersom slike data blir tilgjengelige.

## Fase B – tilleggsarbeider, opsjoner og bestillinger

Fase B er satt i gang. Målet er å fange opp dokumenterte aktivitetssignaler som kan gi informasjon om fremtidig arbeidsmengde og lønnsomhet uten å late som om hele ordreverdien blir kvartalsomsetning.

### Egen Fase B-side

`/fase-b.html` er hovedsiden for Fase B. Den viser:

- aktive og planlagte kilder
- når kildene sist ble kontrollert
- nye funn som venter på vurdering
- mulig kontraktskobling og oppgitt verdi
- relevans for funnet
- registrerte opsjoner, tilleggsarbeider og bestillinger
- lenke tilbake til originalkilden

Nye kandidater kan godkjennes eller ignoreres direkte på siden. Det finnes også en knapp for å kjøre et nytt kildesøk manuelt.

### Første automatiske kilde

Terranors offisielle svenske nyhetsside kontrolleres automatisk **hver sjette time**. Nye artikler klassifiseres som blant annet:

- utløst opsjon
- tilleggsarbeid
- ny bestilling
- ny hovedkontrakt
- annen aktivitet

Tydelige opsjoner, tilleggsarbeider og nye bestillinger fra den offisielle selskapskilden kan registreres automatisk som aktivitetssignaler. Nye hovedkontrakter blir i første omgang kandidater fordi de hører hjemme i kontraktsregisteret og ikke skal dobbelttelles som tilleggsarbeid.

Systemet forsøker også å hente oppgitt ordreverdi og koble funnet til en kjent kontrakt når dette kan gjøres med rimelig sikkerhet.

### Viktig modellregel

Et ordre- eller aktivitetssignal blir **ikke automatisk omgjort til omsetning eller justert EBITA**. Tidspunkt for inntektsføring, margin og eventuell Q3-effekt må modelleres separat.

Fase B har et eget kandidatregister slik at uklare funn kan vurderes, godkjennes eller ignoreres uten at råfunnet forsvinner.

### Kilder som skal kobles på videre

Neste trinn i fase B er å legge til mer direkte offentlige kilder fra Trafikverket og deretter relevante kommunale beslutnings- og bestillingskilder. Disse skal prioriteres fremfor usikre sekundærkilder.

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
- automatisk overvåking av Terranors offisielle nyhetsside
- kandidatregister for nye aktivitetssignaler
- kvalitetskontroll av datainnsamlingen
- historikk for beregnede scorer og estimater
- kort statusside på `/status.html`
- egen Fase B-side på `/fase-b.html`

Danske og finske værkilder er planlagt, men ikke koblet til ennå.

## Automatisk kjøring

Cloudflare kjører en planlagt jobb hver time, 15 minutter over hel time:

```text
15 * * * *
```

Den timebaserte jobben kjører blant annet:

1. nye svenske værmålinger
2. nye veiværmålinger fra Trafikverket
3. beregning av værbaserte arbeidsforhold
4. gradvis innlasting av manglende 60-dagershistorikk
5. gradvis bygging av tiårig sammenligningsgrunnlag for Q3-vær
6. hver sjette time: kontroll av den aktive kilden for opsjoner, tilleggsarbeider og bestillinger

## Teknisk oppbygning

Noen produktnavn og tekniske navn kan ikke oversettes naturlig og beholdes derfor:

- **Cloudflare Worker:** den serverløse bakgrunnstjenesten som kjører API-et og de planlagte jobbene.
- **Cloudflare D1:** databasen som lagrer kontrakter, værmålinger, signaler og historikk.
- **Workers Static Assets:** de statiske filene som utgjør nettsiden.
- **Cron:** teknisk navn på tidsplanen som starter den automatiske jobben hver time.
- **API:** grensesnittet som nettsiden og kontrolladressene bruker for å hente data fra bakgrunnstjenesten.

## Mappestruktur

```text
public/index.html    Hovedsiden
public/status.html   Kort drifts- og datastatus
public/fase-b.html   Fase B: tilleggsarbeider og bestillinger
public/fase-b.js     Visning og behandling av Fase B-funn
src/index.js         Grunnleggende API, innlogging og timebasert innsamling
src/index2.js        Utvidede API-funksjoner
src/weather.js       Vanlige svenske værdata
src/vvis.js          Veivær fra Trafikverket
src/workability.js   Værbaserte arbeidsforhold
src/backfill.js      60-dagers historisk innlasting
src/climate.js       Tiårig sammenligningsgrunnlag fra SMHI
src/geography.js     Kontroll av geografisk værdekning
src/activity.js      Fase B: opsjoner, tilleggsarbeider og bestillinger
src/bridge.js        Kontraktsbro for Q3
src/signals.js       Register over aktivitetssignaler
src/quality.js       Kvalitetskontroll
db/                  Databaseskjema
wrangler.jsonc       Cloudflare-oppsett
package.json         Tekniske kommandoer
```

## Viktige API-adresser

```text
/api/health                  Grunnleggende status
/api/status                  Samlet status for datainnsamlingen
/api/contracts               Kontraktsregister
/api/weather/contracts       Svenske værstasjoner per kontrakt
/api/vvis/contracts          Veiværstasjoner per kontrakt
/api/workability             Værbaserte arbeidsforhold
/api/workability/history     Historikk for arbeidsforhold
/api/backfill/smhi/status    Status for 60-dagers værhistorikk
/api/climate/status          Status for tiårig sammenligningsgrunnlag
/api/climate/run             Kjør neste historiske arkivjobb manuelt
/api/climate/comparison      Vær mot tiårig sammenligningsgrunnlag
/api/geography               Geografisk dekning per kontrakt
/api/activity/run            Kjør fase B-overvåkingen manuelt
/api/activity/status         Status for fase B og registrerte signaler
/api/activity/candidates     Nye kandidater fra overvåkede kilder
/api/activity/review         Godkjenn eller ignorer en kandidat
/api/contract-bridge         Kontraktsbro for Q3
/api/signals                 Registrerte aktivitetssignaler
/api/data-quality            Kvalitetskontroll
```

## Arbeidsplan frem mot Q3 2026

1. **Fase A – pågår:** fullfør tiårig værgrunnlag og sluttkontroll av geografisk dekning.
2. **Fase B – pågår:** bygg ut kildeovervåkingen for tilleggsarbeider, opsjoner og offentlige bestillinger.
3. Koble danske og finske værdata til relevante kontrakter.
4. Etter Q2-rapporten: sammenlign den låste Q2-modellen med faktiske tall.
5. Kalibrer modellen én gang og dokumenter endringene.
6. Lås Q3-metodikken og lagre alle senere estimater uten overskriving.
7. Sammenlign det låste Q3-estimatet med markedets forventninger og faktiske Q3-tall.

## Lokale kommandoer

```bash
npm install
npm run dev
npm run check
npm run deploy
```
