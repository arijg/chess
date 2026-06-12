/* endgames.js — endgame trainer: play classic technique positions against
   a full-strength engine. Win drills require converting; defense drills
   require holding the draw. Completion persists per drill. */
(function () {
  'use strict';

  const E = ChessEngine;
  const pieceClass = p => 'pc-' + E.colorOf(p) + E.typeOf(p);
  const uciOf = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
  const fullFen = s => E.fenKey(s) + ' ' + s.halfmove + ' ' + s.fullmove;

  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const promoEl = $('promo');
  const promoBox = $('promo-box');

  const DRILLS = [
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

  const STORE_KEY = 'chess-endgames-v1';
  const store = loadStore();
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.done) return s;
    } catch (_) { /* fresh start */ }
    return { done: {} };
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* private mode */ }
  }

  let drill = null, st = null, legal = [], fenCounts = new Map();
  let hist = [];
  let selected = null, pending = null, lastMove = null, busy = false, over = null;
  let marks = {};
  let flipped = false;
  let squareEls = [];
  let gen = 0;

  /* ---------------- Drill lifecycle ---------------- */

  function loadDrill(d) {
    gen++;
    drill = d;
    st = E.loadFEN(d.fen);
    legal = E.legalMoves(st);
    fenCounts = new Map([[E.fenKey(st), 1]]);
    hist = [];
    selected = null; pending = null; lastMove = null; busy = false; over = null;
    marks = {};
    promoEl.hidden = true;
    flipped = d.side === 'b';
    buildBoard();
    renderBoard();
    renderDrills();
    $('tip').textContent = '💡 ' + d.tip;
    $('tip').hidden = false;
    setStatus((d.side === 'w' ? 'White' : 'Black') + ' to play — '
      + (d.goal === 'win' ? 'win the position.' : 'hold the draw.'), '');
    if (st.turn !== d.side) engineReply();
  }

  function applyMove(m, animate) {
    hist.push(st);
    st = E.makeMove(st, m);
    legal = E.legalMoves(st);
    const key = E.fenKey(st);
    fenCounts.set(key, (fenCounts.get(key) || 0) + 1);
    lastMove = m;
    selected = null; pending = null;
    promoEl.hidden = true;
    sound(m.captured ? 'capture' : 'move');
    renderBoard();
    if (animate) animateMove(m);
    checkEnd();
  }

  function checkEnd() {
    const status = E.gameStatus(st, fenCounts);
    if (!status.over) return false;
    over = status;
    busy = true;
    const winner = status.result === '1-0' ? 'w' : status.result === '0-1' ? 'b' : null;
    const success = drill.goal === 'win' ? winner === drill.side : status.result === '½-½';
    if (success) {
      store.done[drill.id] = true;
      saveStore();
      renderDrills();
      sound('end');
      setStatus('✓ ' + (drill.goal === 'win' ? 'Converted! ' : 'Held! ') + reasonText(status.reason)
        + ' Drill complete.', 'good');
    } else {
      sound('error');
      setStatus('✗ ' + reasonText(status.reason) + ' — '
        + (drill.goal === 'win' ? 'that\'s only a draw. ' : 'the draw slipped away. ') + 'Try again!', 'bad');
    }
    return true;
  }

  function reasonText(r) {
    return r === 'checkmate' ? 'Checkmate.'
      : r === 'stalemate' ? 'Stalemate.'
      : r === 'insufficient material' ? 'Insufficient material.'
      : r === 'fifty-move rule' ? 'Fifty-move rule.'
      : r === 'threefold repetition' ? 'Threefold repetition.'
      : r + '.';
  }

  function engineReply() {
    busy = true;
    const myGen = gen;
    Stockfish.go({ fen: fullFen(st) }, { movetime: 350 })
      .then(r => {
        if (myGen !== gen) return;
        const m = r.best ? legal.find(x => uciOf(x) === r.best) : null;
        busy = false;
        if (m && !over) applyMove(m, true);
      })
      .catch(() => {
        if (myGen !== gen) return;
        const m = E.bestMove(st, 3);
        busy = false;
        if (m && !over) applyMove(m, true);
      });
  }

  function doUserMove(m, viaDrag) {
    marks = {};
    applyMove(m, !viaDrag);
    if (!over) engineReply();
  }

  function undo() {
    if (busy || pending || hist.length < 2) return;
    gen++;
    for (let i = 0; i < 2; i++) {
      const key = E.fenKey(st);
      const c = fenCounts.get(key) || 0;
      if (c > 1) fenCounts.set(key, c - 1); else fenCounts.delete(key);
      st = hist.pop();
    }
    legal = E.legalMoves(st);
    over = null; busy = false;
    lastMove = null; selected = null; marks = {};
    renderBoard();
    setStatus('Your move.', '');
  }

  /* ---------------- Panels ---------------- */

  function renderDrills() {
    const el = $('drills');
    el.innerHTML = '';
    for (const d of DRILLS) {
      const row = document.createElement('div');
      row.className = 'line-row' + (drill && drill.id === d.id ? ' drill-active' : '');
      const badge = document.createElement('span');
      badge.className = 'line-eval' + (d.goal === 'draw' ? ' black-better' : '');
      badge.textContent = d.goal === 'win' ? 'Win' : 'Draw';
      const name = document.createElement('span');
      name.className = 'line-moves';
      name.textContent = (store.done[d.id] ? '✓ ' : '') + d.name;
      row.appendChild(badge);
      row.appendChild(name);
      row.addEventListener('click', () => loadDrill(d));
      el.appendChild(row);
    }
  }

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = kind || '';
  }

  $('retry').addEventListener('click', () => { if (drill) loadDrill(drill); });
  $('undo').addEventListener('click', undo);
  $('hint').addEventListener('click', () => {
    if (!drill || busy || over || pending) return;
    const myGen = gen;
    Stockfish.go({ fen: fullFen(st) }, { movetime: 350 }).then(r => {
      if (myGen !== gen || !r.best) return;
      const m = legal.find(x => uciOf(x) === r.best);
      if (m) { marks = { hint: m.from, hintTo: m.to }; renderBoard(); }
    }).catch(() => {
      const m = E.bestMove(st, 3);
      if (myGen === gen && m) { marks = { hint: m.from, hintTo: m.to }; renderBoard(); }
    });
  });

  /* ---------------- Board DOM (same look as the other pages) ---------------- */

  function buildBoard() {
    boardEl.innerHTML = '';
    squareEls = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = flipped ? 7 - col : col;
        const rank = flipped ? row : 7 - row;
        const sq = rank * 16 + file;
        const d = document.createElement('div');
        d.className = ((file + rank) % 2 === 0) ? 'square dark' : 'square light';
        d.dataset.sq = sq;
        d.dataset.base = d.className;
        if (col === 0) {
          const c = document.createElement('span');
          c.className = 'coord rank';
          c.textContent = rank + 1;
          d.appendChild(c);
        }
        if (row === 7) {
          const c = document.createElement('span');
          c.className = 'coord file';
          c.textContent = E.FILES[file];
          d.appendChild(c);
        }
        boardEl.appendChild(d);
        squareEls.push(d);
      }
    }
  }

  const squareEl = sq => boardEl.querySelector('.square[data-sq="' + sq + '"]');

  function renderBoard() {
    const checkSq = E.inCheck(st) ? E.findKing(st.board, st.turn) : -1;
    const targets = selected !== null ? legal.filter(m => m.from === selected) : [];

    for (const el of squareEls) {
      const sq = +el.dataset.sq;
      const p = st.board[sq];
      el.className = el.dataset.base;

      let span = el.querySelector('.piece');
      if (p) {
        if (!span) {
          span = document.createElement('span');
          el.appendChild(span);
        }
        span.className = 'piece ' + pieceClass(p);
      } else if (span) span.remove();

      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) el.classList.add('hl');
      if (sq === selected) el.classList.add('hl');
      if (sq === checkSq) el.classList.add('in-check');
      if (sq === marks.hint || sq === marks.hintTo) el.classList.add('hint-mark');
      const t = targets.find(m => m.to === sq);
      if (t) el.classList.add(t.captured ? 'capture-hint' : 'move-hint');
      if (p && !busy && !over && st.turn === drill.side && E.colorOf(p) === st.turn) el.classList.add('grabbable');
    }
  }

  /* ---------------- Move animation (FLIP) ---------------- */

  function flipAnimate(pieceSq, fromSq) {
    const toEl = squareEl(pieceSq), fromEl = squareEl(fromSq);
    const piece = toEl && toEl.querySelector('.piece');
    if (!piece || !fromEl) return;
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) return;
    piece.style.transition = 'none';
    piece.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    requestAnimationFrame(() => {
      piece.style.transition = 'transform .15s ease';
      piece.style.transform = '';
      setTimeout(() => { piece.style.transition = ''; }, 220);
    });
  }

  function animateMove(m) {
    flipAnimate(m.to, m.from);
    if (m.flags === 'ck') flipAnimate(m.to - 1, m.to + 1);
    if (m.flags === 'cq') flipAnimate(m.to + 1, m.to - 2);
  }

  /* ---------------- Input: click + drag ---------------- */

  boardEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!drill || busy || over || pending || st.turn !== drill.side) return;
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const sq = +sqEl.dataset.sq;

    if (selected !== null && legal.some(m => m.from === selected && m.to === sq)) {
      moveTo(selected, sq, false);
      return;
    }
    const p = st.board[sq];
    if (p && E.colorOf(p) === st.turn) {
      const reclick = selected === sq;
      selected = sq;
      renderBoard();
      startDrag(e, sq, reclick);
    } else if (selected !== null) {
      selected = null;
      renderBoard();
    }
  });

  function startDrag(e, from, reclick) {
    const pieceEl = squareEl(from)?.querySelector('.piece');
    if (!pieceEl) return;
    const rect = pieceEl.getBoundingClientRect();
    const ghost = pieceEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    pieceEl.classList.add('dragging-src');

    let moved = false;
    const startX = e.clientX, startY = e.clientY;
    const place = ev => {
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top = ev.clientY + 'px';
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 5) moved = true;
    };
    place(e);

    const cleanup = () => {
      ghost.remove();
      pieceEl.classList.remove('dragging-src');
      window.removeEventListener('pointermove', place);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const onUp = ev => {
      cleanup();
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const tEl = el && el.closest('.square');
      if (tEl) {
        const to = +tEl.dataset.sq;
        if (to !== from && legal.some(m => m.from === from && m.to === to)) {
          moveTo(from, to, true);
          return;
        }
        if (to === from && reclick && !moved) selected = null;
      }
      renderBoard();
    };
    const onCancel = () => { cleanup(); renderBoard(); };

    window.addEventListener('pointermove', place);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  function moveTo(from, to, viaDrag) {
    const candidates = legal.filter(m => m.from === from && m.to === to);
    if (!candidates.length) return;
    if (candidates[0].promotion) {
      pending = { candidates };
      showPromotion(to);
    } else {
      doUserMove(candidates[0], viaDrag);
    }
  }

  /* ---------------- Promotion picker ---------------- */

  function showPromotion(to) {
    const color = st.turn;
    promoBox.innerHTML = '';
    for (const t of ['Q', 'N', 'R', 'B']) {
      const b = document.createElement('button');
      b.innerHTML = '<div class="promo-piece pc-' + color + t + '"></div>';
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        doUserMove(pending.candidates.find(x => x.promotion === t), false);
      });
      promoBox.appendChild(b);
    }
    const file = to & 15, rank = to >> 4;
    const col = flipped ? 7 - file : file;
    const atTop = flipped ? rank === 0 : rank === 7;
    promoBox.style.left = col * 12.5 + '%';
    promoBox.style.top = atTop ? '0' : 'auto';
    promoBox.style.bottom = atTop ? 'auto' : '0';
    promoEl.hidden = false;
  }

  promoEl.addEventListener('click', () => {
    pending = null;
    selected = null;
    promoEl.hidden = true;
    renderBoard();
  });

  /* ---------------- Sounds (WebAudio, no assets) ---------------- */

  function sound(kind) {
    try {
      sound.ctx = sound.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = sound.ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const tone = (freq, at, dur, type, vol) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type || 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol || 0.12, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + dur);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + at);
        o.stop(ctx.currentTime + at + dur + 0.05);
      };
      if (kind === 'move') tone(540, 0, 0.09);
      else if (kind === 'capture') tone(330, 0, 0.1, 'square', 0.09);
      else if (kind === 'error') tone(180, 0, 0.18, 'square', 0.1);
      else if (kind === 'end') { tone(523, 0, 0.18); tone(659, 0.12, 0.18); tone(784, 0.24, 0.3); }
    } catch (_) { /* audio unavailable */ }
  }

  // Tiny harness hook so behavior can be driven in automated checks.
  window.__endgames = {
    state: () => ({ drill: drill ? drill.id : null, fenNow: drill ? E.fenKey(st) : null, turn: st ? st.turn : null, busy, over: over ? over.reason : null, done: { ...store.done } }),
    load: id => { const d = DRILLS.find(x => x.id === id); if (d) loadDrill(d); },
    drills: DRILLS.map(d => ({ id: d.id, fen: d.fen, goal: d.goal, side: d.side })),
  };

  loadDrill(DRILLS[0]);
})();
