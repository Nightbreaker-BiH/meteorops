# MeteorOps

MeteorOps je samostalna web aplikacija za planiranje meteorskih rojeva, procjenu observing prozora, setup preporuke i operativni rad na terenu.

## Sta sada pokriva

- rang listu aktivnih rojeva za izabrani datum i lokaciju
- throughput model sa activity, darkness, Moon, horizon-mask i weather faktorima
- terrain-profile horizon solver sa 16-sektorskim maskama i fallback na manual mask
- radiant drift kroz sezonu i interpolirani dusk/dawn timing
- pessimistic / expected / optimistic throughput raspon sa score-om pouzdanosti
- weather sloj sa cloud, low-cloud, visibility, wind i rain parametrima
- setup adviser za `timelapse`, `stills`, `visual`, `video` i `allsky`
- panel kamere neba za lokalnu kameru preko browsera ili javni live feed embed
- live meteor trigger nad lokalnim video feedom sa frame-difference heuristikom i trigger preview-em
- hands-free voice logger preko Web Speech API-ja za brzo logovanje meteor događaja
- radiant sky map sa lokalnim horizontom i Moon pozicijom
- optimal look-direction overlay za vizuelni ili kameraski pointing
- observer sectors za vise posmatraca ili kamera
- scientific watch form sa `LM`, cloud fraction, `SQM`, effective time i watch-center poljima
- UTC event logger za pojedinacne meteore sa magnitudom, bojom, train i fragmentation poljima
- auto fireball draft assistant za jake evente
- session logger i lokalnu self-calibration heuristiku
- GMN-ready mod stanica i multi-station tabla za lokalnu mrezu stanica
- QC dashboard sa weather freshness, trigger statusom i cloud-break nowcast heuristikom
- javni `Tonight in BiH` pregled top lokacija i rojeva
- fireball feed sa NASA/JPL fallback uzorkom
- export u `.ics`, `.json`, `.csv` i tekstualni report
- PWA manifest, service worker i lokalne reminder notifikacije
- `Nocturne` i `Solar` tema

## Pokretanje

```bash
npm run dev
```

Za staticki build i lokalno posluzen `dist/`:

```bash
npm run build
```

## Testovi

```bash
npm test
```

Testovi trenutno pokrivaju osnovnu astro geometriju, throughput model, twilight suppression, terrain horizon solver, uncertainty band i calibration logiku. Browser-only slojevi poput kamere, glasovnog loggera i triggera zahtijevaju runtime provjeru u browseru.

## Napomena o tacnosti

Planner koristi brze astronomske aproksimacije i heuristicki throughput model. Dobar je za terensku odluku, session planning i operativni pregled, ali nije zamjena za formalni reduction ili publikacijski nivo analize.

## Glavni izvori

- International Meteor Organization: <https://www.imo.net/>
- IMO visual methods: <https://www.imo.net/observations/methods/visual-observation/>
- American Meteor Society shower reference: <https://www.amsmeteors.org/meteor-showers/>
- Open-Meteo Forecast API: <https://api.open-meteo.com/>
- NASA/JPL Fireball API: <https://ssd-api.jpl.nasa.gov/doc/fireball.html>
