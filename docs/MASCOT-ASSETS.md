# Mascot Assets — Turtle

Every image below is a placeholder to be swapped for real generated/sourced artwork later. Filenames and locations are locked now so tickets can reference stable paths — the pixels underneath are not locked.

I can't generate images directly, so this is the fallback: a manifest of exactly what to create and where it goes, plus placeholder files the scaffold ticket drops in so nothing in the app is missing an asset reference while real art doesn't exist yet.

## Style

Modern / clean line-art — simple geometric shape, single line-weight, minimal detail. Prioritize legibility at small sizes (the app icon in particular) over expressiveness.

## Why a turtle, specifically

Worth keeping if it holds: a turtle flips itself back over when it falls. That's the same shape as the "I Fell Off" button — the mascot means something instead of just decorating the screen. Recommend leaning on that specific pose for the fall-off flow rather than a generic mascot appearance everywhere.

## Asset list

| Filename (under `src/assets/turtle/` once scaffolded) | Used where | Depicts |
|---|---|---|
| `turtle-icon.svg` | App icon / Capacitor splash screen | Simple, clean silhouette — needs to read at ~48px, so keep detail low regardless of the style choice below |
| `turtle-loading.svg` | Any loading state — generation call, Edge Function round-trips | Neutral, idle turtle |
| `turtle-fall-1.svg` | I Fell Off, 1st occurrence | Gentle, upright, already moving — barely a reaction |
| `turtle-fall-2.svg` | I Fell Off, 2nd occurrence (the Amendment screen) | Attentive, looking at the proposed change |
| `turtle-fall-3.svg` | I Fell Off, 3rd occurrence (downscope) | On its back, mid-flip — "the system is fixing this" |
| `turtle-review.svg` | Cycle-close review | Resting, reflective |

Six assets, not one per screen — sized to MVP. Add more only if a specific screen actually needs its own.

## To replace later

Drop real artwork in at the same filename and no code changes are needed. If a filename needs to change, grep `src/` for it first — there's no asset-indirection layer for something this small, by design.
