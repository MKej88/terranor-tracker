# Implementasjon

Kommunemodulen bruker eksisterende `activity_candidates` for funn slik at de kommer inn i samme manuelle vurderingsflyt som øvrige Fase B-kandidater.

Egne tabeller lagrer kun driftsstatus og hva som allerede er sett:

- `municipal_source_state`
- `municipal_seen_items`
- `municipal_monitor_runs`

Kjøringen er bevisst lett:

1. Hent hver landingsside én gang.
2. På kommunale møtesider inspiseres bare nye relevante lenker.
3. Eksisterende kontrakts-/driftssider hashes og gir kun kandidat når innholdet endres.
4. e-Avrop etterannonser filtreres først på relevante titler/CPV-kontekst før detaljsider hentes.
5. Ingen kandidat promoteres automatisk til omsetning eller EBITA.

Daglig cron: `20 3 * * *` UTC.
