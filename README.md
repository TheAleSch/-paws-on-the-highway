# Paws on the Highway

An endless one-thumb highway game for POW!BOX: switch lanes to dodge kittens and dogs, grab pickups (spare tire, nitro, shield, 2× points, star, jets) and drive from day into night. Ported from a single-file HTML5 canvas game to the POW!BOX arcade runtime (`v1`).

- `src/game.ts`: the whole game. Canvas 2D scene with a multiply light map, a WebGL2 post pass composited onto the SDK canvas (Canvas 2D fallback), HUD drawn on canvas inside the viewport safe bands.
- `game.json`: manifest and creation contract (scored, `scalar-score/1`).

## Status

`powbox check` passes (0 issues, ~13 KB gzip). Not yet submitted.

## Remaining steps

1. Install the creator kit version recommended by `GET /api/agent/v1/me` (`0.4.3` validated locally; `0.4.6` was not on npm).
2. Replace the placeholder `"creator": "@alesch"` in `game.json` with `creator.manifestHandle` from `/me`.
3. `powbox dev . --open`: play, Record, Stop, Confirm and select a 3–20 s take (local takes are not committed).
4. `powbox check . --json`, then `powbox submit . --wait --json` with the agent link stored via `powbox login`.
