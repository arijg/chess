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
- **Two modes**: two players on one board, or vs a built-in computer opponent (Easy / Medium / Hard)
- **chess.com-style UI**: green board, drag & drop or click-to-move, legal-move dots, last-move and check highlights, coordinates
- **Evaluation bar**: a chess.com-analysis-style bar beside the board showing who's winning, driven by a shallow engine search
- **Game clocks**: 1 / 3 / 5 / 10 / 30 minute controls, or untimed
- **Move list** in standard algebraic notation, captured-piece trays with material count, move sounds, board flip, undo
- **Puzzles** (`puzzles.html`): 600 puzzles sampled from the [Lichess puzzle database](https://database.lichess.org/) (CC0) with real Glicko-2 difficulty ratings (519–2454), full solution lines, and theme tags, with chess.com-style solving — animated setup move, correct/wrong feedback, auto-replying defense, two-stage hints, and a persistent Elo-style rating, streak, and solved count

## How it works

| File | Role |
| --- | --- |
| `chess-engine.js` | Rules engine on a [0x88 board](https://www.chessprogramming.org/0x88): move generation, legality via king-safety filtering, SAN, FEN, draw detection. Also a small negamax AI with alpha-beta pruning and piece-square tables. |
| `app.js` | UI: board rendering, pointer-event drag & drop, clocks, move list, promotion picker, WebAudio sounds. |
| `style.css` / `index.html` | Layout and chess.com-style theming. Pieces are Unicode glyphs — no images. |
| `test-perft.js` | Verification: [perft](https://www.chessprogramming.org/Perft) node counts for 5 standard positions plus rule spot-checks. |
| `puzzles.html` / `puzzles.js` | Puzzle mode: solve flow, hints, rating, auto-replying defense. |
| `puzzles-data.js` | 600 puzzles sampled from the [Lichess puzzle database](https://database.lichess.org/) (CC0): real ratings, solution lines, themes. Stratified across difficulty, quality-filtered (popularity ≥ 90–95, plays ≥ 1000–5000), every line re-validated move-by-move by the engine. |
| `convert-puzzles.js` | Validates Lichess-format puzzles against the engine and emits `puzzles-data.js`. |
| `import-puzzles.js` | Alternative source: classifies bare FEN collections (e.g. yacpdb) as mate-in-1/2/3 with the exact solver. |
| `gen-puzzles.js` | Alternative source: plays semi-random games and keeps positions where the exact mate solver finds a unique forced mate. |
| `test-puzzles.js` | Re-verifies every puzzle: solvable, unique solution, no faster mate. Run `jsc chess-engine.js puzzles-data.js test-puzzles.js`. |

## Tests

The move generator is verified against known perft counts (e.g. 197,281 nodes at depth 4 from the start position) on positions designed to catch castling, en passant, and pin bugs:

```sh
# macOS (uses the built-in JavaScriptCore shell)
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc chess-engine.js test-perft.js

# or with Node
node -e "require('./test-perft.js')"
```
