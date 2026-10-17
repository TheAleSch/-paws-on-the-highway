# POW!BOX Arcade game

Edit `src/game.ts`, `game.json` and `assets/`. Source is TypeScript-only.

Run `pnpm dlx @powbox/creator-kit@0.4.0 check .` locally. Run `powbox dev <dir> --open`, play and record the actual local Draft, review/trim, Confirm/select, then run `powbox submit <dir> --wait --json`. A selected, confirmed current-build local preview is mandatory. Do not call /sources or /submit before this loop completes. Missing, stale or unconfirmed previews upload nothing. `--preview` is a compatibility alias only.

Read https://dev.pow.box and https://pow.box/agent/llms.txt for the creation contract, exact npm discovery and authentication guidance. Platform runtime dependencies are supplied by the CLI and hosting runtime.
