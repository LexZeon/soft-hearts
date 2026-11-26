# Unbound idle model (StayStill)

The small idle model the Unbound window plays while she stands (soft hearts next,
`src/unbound/motion/bundled-idle.ts`; user decision 2026-11-16, recorded in
`docs/claude/2026-11-14-staystill-idle.md`).

## Files

- `idle-vae.json`: weights of a small autoregressive conditional VAE (decoder 241,557
  parameters, learned prior 53,392), trained on this project's machine by
  `scripts/ml/train_idle_vae.py` (run "d2-e60": StayStill idle takes, freemocap
  skeleton, official training split of 35 people, a 2 °/s dead band on the head chain).
- `events.json`, `events.f32`: 412 short "quick moves" (1.2 s, 30 Hz, 27 channels,
  starting and ending at zero) cut from the same training takes by
  `scripts/ml/idle_events.py` (head turning faster than 0.6 rad/s), and the rate per
  minute the people made them at each fifth of liveliness.
- `LICENSE`: the StayStill dataset's MIT licence, as published with it.

Nothing else from the dataset is here: no raw recordings, no features. The `lafan/`
part of StayStill (retargeted to the LaFAN1 skeleton, CC BY-NC-ND) was never read.

## Source and citation

Derived from the StayStill dataset:

> Eneko Atxa Landa, Igor Rodriguez, Elena Lazkano, Taras Kucherenko.
> "StayStill." arXiv 2605.13693.
> Data: https://zenodo.org/records/18741736 (MIT).

## Settings it is played with

Shown at liveliness 0.5, without the training script's calibration gains, with its own
quick moves at the people's rate (×1), an 8 s leash toward her stand pose and soft
limits on the head turn and the hip shift (`shared/unbound/idle-model.json`). A
retrained model replaces these files and that manifest's sizes and SHA-256; the code
reads only the manifest.
