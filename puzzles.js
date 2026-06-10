/* puzzles.js — chess.com-style puzzle mode over the Lichess puzzle set:
   the opponent's setup move plays automatically, then the solver follows
   the stored solution line with feedback, hints, an auto-replying
   defender, and an Elo-ish persistent rating. */
(function () {
  'use strict';

  const E = ChessEngine;
  const GLYPHS = {
    K: '♚︎', Q: '♛︎', R: '♜︎',
    B: '♝︎', N: '♞︎', P: '♟︎',
  };
  const K_FACTOR = 24;
  const STORE_KEY = 'chess-puzzles-v1';

  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const promoEl = $('promo');
  const promoBox = $('promo-box');

  let puzzle = null, st = null, legal = [], stepIdx = 1, solverColor = 'w';
  let selected = null, busy = false, failed = false, solved = false;
  let hintStage = 0, hintMove = null, pending = null, lastMove = null;
  let flipped = false;
  let marks = {};
  let squareEls = [];
  let gen = 0; // invalidates queued animations when a new puzzle loads

  const store = loadStore();
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && typeof s.rating === 'number') return s;
    } catch (_) { /* fresh start */ }
    return { rating: 600, streak: 0, solvedCount: 0, done: {} };
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* private mode */ }
  }

  /* ---------------- Puzzle lifecycle ---------------- */

  const uciOf = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');

  function findUci(u) {
    const from = E.algToSq(u.slice(0, 2));
    const to = E.algToSq(u.slice(2, 4));
    const promo = u[4] ? u[4].toUpperCase() : null;
    return legal.find(m => m.from === from && m.to === to && (m.promotion || null) === promo);
  }

  function pickPuzzle() {
    let pool = PUZZLES.filter(p => !store.done[p.id]);
    if (!pool.length) { store.done = {}; saveStore(); pool = PUZZLES.slice(); }
    const target = store.rating + (Math.random() * 300 - 150);
    pool.sort((a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target));
    return pool[0];
  }

  // Solver moves left, counting the one currently expected.
  const movesLeft = () => Math.ceil((puzzle.line.length - stepIdx) / 2);

  function mateTheme() {
    const t = puzzle.themes.find(x => /^mateIn\d$/.test(x));
    return t ? +t.slice(6) : 0;
  }

  function loadPuzzle(p) {
    gen++;
    const myGen = gen;
    puzzle = p || pickPuzzle();
    st = E.loadFEN(puzzle.fen);
    legal = E.legalMoves(st);
    stepIdx = 1;
    solverColor = st.turn === 'w' ? 'b' : 'w'; // solver answers the setup move
    flipped = solverColor === 'b';
    selected = null; busy = true; failed = false; solved = false;
    hintStage = 0; hintMove = null; pending = null; lastMove = null;
    marks = {};
    promoEl.hidden = true;
    $('next').textContent = 'Skip →';
    buildBoard();
    renderBoard();
    renderPanel();
    setFeedback('Watch the opponent’s move…', '');
    setTimeout(() => {
      if (myGen !== gen) return;
      const setup = findUci(puzzle.line[0]);
      st = E.makeMove(st, setup);
      legal = E.legalMoves(st);
      lastMove = setup;
      busy = false;
      sound('move');
      renderBoard();
      renderPanel();
      setFeedback('Your move — find the best reply.', '');
    }, 700);
  }

  function expectedScore() {
    return 1 / (1 + Math.pow(10, (puzzle.rating - store.rating) / 400));
  }

  // First mistake (wrong move, hint, or skip) costs rating and the streak.
  function onMistake() {
    if (failed || solved) return;
    failed = true;
    store.rating = Math.max(100, Math.round(store.rating - K_FACTOR * expectedScore()));
    store.streak = 0;
    saveStore();
    renderPanel();
  }

  function onSolved() {
    solved = true;
    store.done[puzzle.id] = 1;
    store.solvedCount++;
    let delta = 0;
    if (!failed) {
      delta = Math.max(1, Math.round(K_FACTOR * (1 - expectedScore())));
      store.rating += delta;
      store.streak++;
    }
    saveStore();
    $('next').textContent = 'Next Puzzle →';
    renderPanel();
    const tags = puzzle.themes.length ? ' · ' + puzzle.themes.join(', ') : '';
    setFeedback((failed ? 'Solved — but with mistakes.' : 'Solved! +' + delta + ' rating')
      + ' (puzzle ' + puzzle.rating + tags + ')', 'good');
  }

  /* ---------------- Move handling ---------------- */

  // The stored solution move is required; any immediate checkmate also counts.
  const isCorrect = m => uciOf(m) === puzzle.line[stepIdx] || E.forcesMate(st, m, 1);

  function applyUserMove(m) {
    busy = true;
    pending = null;
    promoEl.hidden = true;
    const myGen = gen;
    const prevSt = st, prevLegal = legal, prevLast = lastMove;
    const ok = isCorrect(m);
    st = E.makeMove(st, m);
    legal = E.legalMoves(st);
    lastMove = m;
    selected = null;

    if (ok) {
      marks = { good: m.to };
      const mate = legal.length === 0 && E.inCheck(st);
      const finished = mate || stepIdx >= puzzle.line.length - 1;
      sound(finished ? 'end' : 'check');
      renderBoard();
      if (finished) { onSolved(); return; }
      setFeedback('Correct — keep going!', 'good');
      renderPanel();
      setTimeout(() => {
        if (myGen !== gen) return;
        const reply = findUci(puzzle.line[stepIdx + 1]);
        st = E.makeMove(st, reply);
        legal = E.legalMoves(st);
        lastMove = reply;
        stepIdx += 2;
        marks = {};
        hintMove = null; hintStage = 0;
        sound('move');
        renderBoard();
        renderPanel();
        setFeedback('Your move.', '');
        busy = false;
      }, 600);
    } else {
      marks = { bad: m.to };
      sound('error');
      renderBoard();
      onMistake();
      setFeedback('That’s not it — try again.', 'bad');
      setTimeout(() => {
        if (myGen !== gen) return;
        st = prevSt; legal = prevLegal; lastMove = prevLast;
        marks = {};
        renderBoard();
        busy = false;
      }, 800);
    }
  }

  function moveTo(from, to) {
    const candidates = legal.filter(m => m.from === from && m.to === to);
    if (!candidates.length) return;
    if (candidates[0].promotion) {
      pending = { candidates };
      showPromotion(to);
    } else {
      applyUserMove(candidates[0]);
    }
  }

  /* ---------------- Board DOM (same look as the game page) ---------------- */

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
        span.className = 'piece ' + E.colorOf(p);
        span.textContent = GLYPHS[E.typeOf(p)];
      } else if (span) span.remove();

      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) el.classList.add('hl');
      if (sq === selected) el.classList.add('hl');
      if (sq === checkSq) el.classList.add('in-check');
      if (sq === marks.good) el.classList.add('mark-good');
      if (sq === marks.bad) el.classList.add('mark-bad');
      if (sq === marks.hint || sq === marks.hintTo) el.classList.add('hint-mark');
      const t = targets.find(m => m.to === sq);
      if (t) el.classList.add(t.captured ? 'capture-hint' : 'move-hint');
      if (p && canInteract() && E.colorOf(p) === st.turn) el.classList.add('grabbable');
    }
  }

  const canInteract = () => !busy && !solved && st.turn === solverColor;

  /* ---------------- Input: click + drag ---------------- */

  boardEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!canInteract() || pending) return;
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const sq = +sqEl.dataset.sq;

    if (selected !== null && legal.some(m => m.from === selected && m.to === sq)) {
      moveTo(selected, sq);
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
    ghost.style.fontSize = getComputedStyle(pieceEl).fontSize;
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
      const target = el && el.closest('.square');
      if (target) {
        const to = +target.dataset.sq;
        if (to !== from && legal.some(m => m.from === from && m.to === to)) {
          moveTo(from, to);
          return;
        }
        if (to === from && reclick && !moved) {
          selected = null;
        }
      }
      renderBoard();
    };
    const onCancel = () => { cleanup(); renderBoard(); };

    window.addEventListener('pointermove', place);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  /* ---------------- Promotion picker ---------------- */

  function showPromotion(to) {
    const color = st.turn;
    promoBox.innerHTML = '';
    for (const t of ['Q', 'N', 'R', 'B']) {
      const b = document.createElement('button');
      b.className = color;
      b.textContent = GLYPHS[t];
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        applyUserMove(pending.candidates.find(x => x.promotion === t));
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

  /* ---------------- Panel ---------------- */

  function renderPanel() {
    $('rating').textContent = store.rating;
    $('streak').textContent = store.streak;
    $('solved-count').textContent = store.solvedCount;
    const who = solverColor === 'w' ? 'White' : 'Black';
    const mateN = mateTheme();
    $('status').textContent = solved
      ? 'Solved!'
      : who + ' to move — ' + (mateN ? 'mate in ' + Math.min(mateN, movesLeft()) : 'find the best move');
  }

  function setFeedback(text, kind) {
    const el = $('feedback');
    el.textContent = text;
    el.className = kind || '';
  }

  $('hint').addEventListener('click', () => {
    if (solved || busy || pending) return;
    onMistake();
    if (!hintMove) hintMove = findUci(puzzle.line[stepIdx]);
    hintStage++;
    marks = hintStage === 1
      ? { hint: hintMove.from }
      : { hint: hintMove.from, hintTo: hintMove.to };
    setFeedback(hintStage === 1 ? 'Move this piece…' : 'Play the highlighted move.', '');
    renderBoard();
  });

  $('next').addEventListener('click', () => {
    if (busy && !solved) return; // solved leaves the board locked, but Next must work
    if (!solved) onMistake();
    loadPuzzle();
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
      else if (kind === 'error') tone(180, 0, 0.18, 'square', 0.1);
      else if (kind === 'check') { tone(660, 0, 0.09); tone(880, 0.1, 0.12); }
      else if (kind === 'end') { tone(523, 0, 0.18); tone(659, 0.12, 0.18); tone(784, 0.24, 0.3); }
    } catch (_) { /* audio unavailable */ }
  }

  // Tiny harness hook so behavior can be driven in automated checks.
  window.__puzzles = {
    state: () => ({ id: puzzle.id, fen: puzzle.fen, fenNow: E.fenKey(st), line: puzzle.line, stepIdx, themes: puzzle.themes, puzzleRating: puzzle.rating, solved, failed, busy, rating: store.rating, streak: store.streak }),
    load: i => loadPuzzle(PUZZLES[i]),
  };

  loadPuzzle();
})();
