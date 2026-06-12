/* endgames-data.js — drill positions for the endgame trainer. Each FEN is
   validated by test-endgames.js in CI: legal position, correct side to
   move, and playable. */
const ENDGAME_DRILLS = [
    { id: 'qmate', name: 'Queen mate', goal: 'win', side: 'w',
      fen: '8/8/8/4k3/8/8/3Q4/4K3 w - - 0 1',
      tip: 'Box the king toward the edge with queen moves a knight\'s jump away, bring your own king, then mate. Watch out for stalemate!' },
    { id: 'rmate', name: 'Rook mate', goal: 'win', side: 'w',
      fen: '8/8/8/4k3/8/8/3R4/4K3 w - - 0 1',
      tip: 'Cut the king off, shrink the box rank by rank, and use your king to take the opposition before each check.' },
    { id: 'ladder', name: 'Two-rook ladder', goal: 'win', side: 'w',
      fen: '8/8/8/4k3/8/8/R7/1R2K3 w - - 0 1',
      tip: 'Alternate checks rank by rank, like climbing a ladder. Slide a rook to the far side if the king attacks it.' },
    { id: 'kp', name: 'King & pawn: promote', goal: 'win', side: 'w',
      fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
      tip: 'Your king stands in front of the pawn — that wins. Step to the side the enemy king doesn\'t, then escort the pawn home.' },
    { id: 'kpdraw', name: 'King & pawn: hold the draw', goal: 'draw', side: 'b',
      fen: '8/8/4k3/8/4PK2/8/8/8 b - - 0 1',
      tip: 'Stay in front of the pawn and take the opposition. If the kings stand off, step straight back, not sideways.' },
    { id: 'lucena', name: 'Lucena: build the bridge', goal: 'win', side: 'w',
      fen: '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1',
      tip: 'Check the king away, advance your rook to the fourth rank, walk your king out, and block the checks with the rook: the bridge.' },
    { id: 'philidor', name: 'Philidor: hold the draw', goal: 'draw', side: 'b',
      fen: '4k3/8/8/4PK2/8/8/r7/4R3 b - - 0 1',
      tip: 'Park your rook on your third rank to fence the king out. The moment the pawn steps forward, swing behind it and check forever.' },
  ];
if (typeof module !== 'undefined' && module.exports) module.exports = ENDGAME_DRILLS;
