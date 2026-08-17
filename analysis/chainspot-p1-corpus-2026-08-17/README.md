# ChainSpot P1 corpus traces — 2026-08-17 tuning experiment

Trace artifacts from the first execution of the Toph vertical slice
(hand-rolled, ChainSpot-side) against the 4 annotated corpus courses.
Produced by `scripts/toph-run.ts` on ChainSpot branch
`claude/disc-golf-course-research-0nqf8j` @ 6785064; corpus =
`chainspot-corpus` `dev/Annotated` (AlexClark excluded). Full write-up:
ChainSpot `scripts/cv-probes/toph-p1-corpus-tuning-findings.md`; Linear
ticket CHSPT-70.

Layout, per course (DashsTrack, Heritage, Lenard, TowneLake):

- `default/` — trace at historical P1 constants: `manifest.json`
  (stages/assets/entities/events, jq-friendly, no pixel data) +
  `assets/*.png` (bright/dark masks; labelmaps encoded label = R + G<<8).
- `tuned/` — same at the candidate config
  (badgeExcl 0.08 / teeArea 0.06 / bFill 0.26 / minDim 0.30).
- `default-firstloss.json`, `tuned-firstloss.json` — per-truth first-loss
  attributions (the headline query output).
- `../tuning-sweep.txt` — full config × course sweep table.
- `../zerobend-measurement.txt` — 0-bend badge-on-chord measurement
  (straight holes: badge 0.1–2.1px off tee→basket chord at t≈0.51;
  bent 11–35px; zero aliasing).

Frames: images are the corpus `-full` screenshots after ChainSpot's intake
autocrop (traces + annotations share the post-crop frame; dimensions
validated against each annotation's recorded source size).

Totals: tees 18→58/72, baskets 51→67/72, FPs 17→3 (default → tuned);
DashsTrack unchanged (t18/18 b18/18 +0) under every config.
