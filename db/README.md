# D1-database

`schema.sql` beskriver Terranor Trackers delte kjerneskjema. Flere featuremoduler har i tillegg egne idempotente `ensure*Schema()`-funksjoner fordi databasen er bygget trinnvis mens trackeren har vært under utvikling.

## Regel fra Tracker 2.0

Nye databaseendringer skal ikke gjøres som skjulte engangsendringer i produksjonsdatabasen.

For hver ny strukturendring skal vi:

1. gjøre endringen idempotent og bakoverkompatibel,
2. dokumentere den i kode og i dette området,
3. beholde eksisterende data ved oppgradering,
4. unngå å endre eller deaktivere gammel produksjonsdata før en ny import er komplett,
5. legge større fremtidige skjemaendringer i eksplisitte D1-migreringer.

Eksisterende featuretabeller fortsetter foreløpig å bli sikret av modulenes `ensure*Schema()` for å unngå en risikabel engangsmigrering av den levende databasen. Dette kan flyttes gradvis til nummererte D1-migreringer etter at 2.0-arkitekturen er stabil i produksjon.

## Viktig

Kontraktseeds bruker UPSERT. En korrigert ikke-null verdi i kode kan derfor oppdatere eksisterende kontraktsmetadata, mens `NULL` i seed-data ikke overskriver en verdi som allerede finnes i D1.
