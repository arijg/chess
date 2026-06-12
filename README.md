# Chess

A chess.com-style chess game that runs entirely in the browser — no dependencies, no build step, no assets.

![Board](https://img.shields.io/badge/vanilla-JS-yellow) ![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

## Play

Open `index.html` in a browser. That's it.

Or serve it locally:

```sh
python3 -m http.server 8420
# then open http://localhost:8420
```

## Features

- **Full rules**: castling, en passant, promotion (with picker), check, checkmate, stalemate, 50-move rule, threefold repetition, insufficient material
- **Two modes**: two players on one board, or vs a computer opponent — Easy / Medium / Hard use the built-in engine, and four Stockfish tiers (1400 / 1800 / 2200 / Max) lazy-load a real Stockfish 18 running in WebAssembly, entirely in the browser
- **chess.com-style UI**: green board, drag & drop or click-to-move, legal-move dots, last-move and check highlights, coordinates, animated piece slides, premoves (vs the computer), and an auto-queen option
- **Evaluation bar**: a chess.com-analysis-style bar beside the board showing who's winning, driven by a shallow engine search
- **Game clocks**: 1 / 3 / 5 / 10 / 30 minute controls, or untimed
- **Move list** in standard algebraic notation, captured-piece trays with material count, move sounds, board flip, undo
- **History navigation**: click any move, use the arrow keys, or the ⏮◀▶⏭ buttons to replay the game
- **Post-game analysis**: a clickable evaluation graph, blunder/mistake/inaccuracy annotations on the move list, and "better was…" suggestions — analyzed by Stockfish when available, with the built-in engine as a fallback
- **Engine lines & analysis board**: after the game, the top three engine continuations are shown for whatever position you're viewing (eval badge + figurine notation), and the board unlocks — click a line or move the pieces yourself to play out variations for either side, with lines and the eval bar following along
- **Puzzles** (`puzzles.html`): 5,000 puzzles sampled from the [Lichess puzzle database](https://database.lichess.org/) (CC0) with real Glicko-2 difficulty ratings (435–2922), full solution lines, and theme tags, with chess.com-style solving — animated setup move, correct/wrong feedback, auto-replying defense, two-stage hints, a difficulty selector, and a persistent Elo-style rating, streak, and solved count
- **Puzzle Rush**: a 5-minute survival run — puzzles ramp up in difficulty, three strikes ends it, best score saved
- **Openings trainer** (`openings.html`): all 3,726 named openings from the [lichess opening book](https://github.com/lichess-org/chess-openings) (CC0) — move pieces or search to identify any opening by name and ECO code, see every named continuation as a figurine line, replay book lines, and practice them from memory with feedback and hints
- **Endgame trainer** (`endgames.html`): twelve classic technique drills (queen/rook/two-bishop/bishop-and-knight mates, the two-rook ladder, king-and-pawn wins and draws, Lucena, Philidor, queen-vs-rook, the outside passed pawn, and the wrong-bishop draw) played against the full-strength engine, with tips, hints, and persistent completion
- **PGN export & import**: copy any game out as PGN (with a `FEN` header for games that didn't start from the standard position), or paste one in to load and analyze it — comments, NAGs, and variations are handled
- **Game accuracy report**: after analysis, per-player accuracy percentages and a tally of best/great/inaccuracy/mistake/blunder moves
- **Quality-of-life**: the game in progress survives reloads, puzzles filter by theme, and the whole site is an installable PWA that works fully offline (including Stockfish and all 5,000 puzzles)

## How it works

| File | Role |
| --- | --- |
| `chess-engine.js` | Rules engine on a [0x88 board](https://www.chessprogramming.org/0x88): move generation, legality via king-safety filtering, SAN, FEN, draw detection. Also a small negamax AI with alpha-beta pruning and piece-square tables. |
| `app.js` | UI: board rendering, pointer-event drag & drop, clocks, move list, promotion picker, WebAudio sounds. |
| `style.css` / `index.html` | Layout and chess.com-style theming. |
| `pieces/` | Piece images: the [Cburnett chess set](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces) by Colin M. L. Burnett (BSD license), via Wikimedia Commons. |
| `stockfish-engine.js` | Lazy-loading promise-based wrapper around the Stockfish worker (UCI plumbing, strength limiting, search requests). |
| `vendor/stockfish/` | [Stockfish 18](https://stockfishchess.org/) lite single-threaded WASM build from [stockfish.js](https://github.com/nmrugg/stockfish.js), GPLv3 (see `vendor/stockfish/Copying.txt`). Loaded on demand only when a Stockfish difficulty or Analyze is used. |
| `test-perft.js` | Verification: [perft](https://www.chessprogramming.org/Perft) node counts for 5 standard positions plus rule spot-checks. |
| `puzzles.html` / `puzzles.js` | Puzzle mode: solve flow, hints, rating, auto-replying defense. |
| `puzzles-data.js` | 5,000 puzzles sampled from the [Lichess puzzle database](https://database.lichess.org/) (CC0): real ratings, solution lines, themes. Stratified across eight rating bands with per-band quality thresholds (popularity and play count, relaxed at the extremes), every line re-validated move-by-move by the engine. |
| `convert-puzzles.js` | Validates Lichess-format puzzles against the engine and emits `puzzles-data.js`. |
| `import-puzzles.js` | Alternative source: classifies bare FEN collections (e.g. yacpdb) as mate-in-1/2/3 with the exact solver. |
| `gen-puzzles.js` | Alternative source: plays semi-random games and keeps positions where the exact mate solver finds a unique forced mate. |
| `test-puzzles.js` | Re-verifies every puzzle: solvable, unique solution, no faster mate. Run `jsc chess-engine.js puzzles-data.js test-puzzles.js`. |
| `openings.html` / `openings.js` | Openings explorer & trainer: detection, continuation lines, replay, practice mode. |
| `endgames.html` / `endgames.js` | Endgame trainer: engine-verified drill positions played against the full-strength engine. |
| `sw.js` / `manifest.webmanifest` | PWA: offline cache (stale-while-revalidate) and install metadata. |
| `ci-runner.js` / `.github/workflows/` | CI: runs all test suites in Node on every push and pull request. |
| `openings-data.js` | 3,726 named openings from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0), converted to UCI and engine-validated by `convert-openings.js`. |

## Tests

The move generator is verified against known perft counts (e.g. 197,281 nodes at depth 4 from the start position) on positions designed to catch castling, en passant, and pin bugs:

```sh
# macOS (uses the built-in JavaScriptCore shell)
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc chess-engine.js test-perft.js

# or with Node
node -e "require('./test-perft.js')"
```
