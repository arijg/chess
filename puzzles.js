/* puzzles.js — chess.com-style puzzle mode over the Lichess puzzle set:
   the opponent's setup move plays automatically, then the solver follows
   the stored solution line with feedback, hints, an auto-replying
   defender, and an Elo-ish persistent rating. */
(function () {
  'use strict';

  const E = ChessEngine;
  const pieceClass = p => 'pc-' + E.colorOf(p) + E.typeOf(p);
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
  let rush = null; // Puzzle Rush run: {score, strikes, timeLeft, target, used, over, timer}

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

  const BANDS = { easy: [0, 950], medium: [950, 1400], hard: [1400, 1800], expert: [1800, 9999] };

  function pickPuzzle() {
    const band = BANDS[store.difficulty];
    const inBand = p => !band || (p.rating >= band[0] && p.rating < band[1]);
    const inTheme = p => !store.theme || p.themes.includes(store.theme);
    let pool = PUZZLES.filter(p => !store.done[p.id] && inBand(p) && inTheme(p));
    if (!pool.length) pool = PUZZLES.filter(p => inBand(p) && inTheme(p)); // exhausted: allow repeats
    if (!pool.length) pool = PUZZLES.filter(inTheme); // band+theme combo empty: drop the band
    if (!pool.length) pool = PUZZLES.slice();
    if (band) return pool[Math.floor(Math.random() * pool.length)];
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
      animateMove(setup);
      renderPanel();
      setFeedback('Your move — find the best reply.', '');
    }, rush && !rush.over ? 350 : 700);
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
    if (rush && !rush.over) {
      rush.score++;
      rush.target += 35 + Math.random() * 30; // ramp the difficulty
      renderPanel();
      setFeedback('✓ ' + rush.score + ' solved — next!', 'good');
      setTimeout(() => {
        if (rush && !rush.over) loadPuzzle(pickRushPuzzle());
      }, 500);
      return;
    }
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

  function applyUserMove(m, viaDrag) {
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
      if (!viaDrag) animateMove(m);
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
        animateMove(reply);
        renderPanel();
        setFeedback('Your move.', '');
        busy = false;
      }, rush && !rush.over ? 350 : 600);
    } else {
      marks = { bad: m.to };
      sound('error');
      renderBoard();
      if (!viaDrag) animateMove(m);
      if (rush && !rush.over) {
        // Rush: no retries — a wrong move is a strike and the run moves on.
        rush.strikes++;
        renderPanel();
        setFeedback('✗ Strike ' + rush.strikes + ' of 3', 'bad');
        setTimeout(() => {
          if (!rush || rush.over) return;
          if (rush.strikes >= 3) endRush();
          else loadPuzzle(pickRushPuzzle());
        }, 700);
        return;
      }
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

  function moveTo(from, to, viaDrag) {
    const candidates = legal.filter(m => m.from === from && m.to === to);
    if (!candidates.length) return;
    if (candidates[0].promotion) {
      pending = { candidates };
      showPromotion(to);
    } else {
      applyUserMove(candidates[0], viaDrag);
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
        span.className = 'piece ' + pieceClass(p);
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
      const target = el && el.closest('.square');
      if (target) {
        const to = +target.dataset.sq;
        if (to !== from && legal.some(m => m.from === from && m.to === to)) {
          moveTo(from, to, true);
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
      b.innerHTML = '<div class="promo-piece pc-' + color + t + '"></div>';
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

  /* ---------------- Puzzle Rush ---------------- */

  const fmtTime = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  function startRush() {
    if (rush && rush.timer) clearInterval(rush.timer);
    rush = {
      score: 0, strikes: 0, target: 450, timeLeft: 300000,
      last: performance.now(), used: new Set(), over: false,
    };
    rush.timer = setInterval(rushTick, 200);
    $('rush').textContent = 'End Rush';
    $('rush-exit').hidden = true;
    $('hint').hidden = true;
    $('next').hidden = true;
    $('difficulty-wrap').hidden = true;
    $('theme-wrap').hidden = true;
    loadPuzzle(pickRushPuzzle());
  }

  function rushTick() {
    if (!rush || rush.over) return;
    const now = performance.now();
    rush.timeLeft -= now - rush.last;
    rush.last = now;
    if (rush.timeLeft <= 0) { rush.timeLeft = 0; endRush(); }
    renderPanel();
  }

  function pickRushPuzzle() {
    let pool = PUZZLES.filter(p => !rush.used.has(p.id));
    if (!pool.length) pool = PUZZLES.slice();
    let best = pool[0], bd = Infinity;
    for (const p of pool) {
      const d = Math.abs(p.rating - rush.target);
      if (d < bd) { bd = d; best = p; }
    }
    rush.used.add(best.id);
    return best;
  }

  function endRush() {
    if (!rush || rush.over) return;
    rush.over = true;
    clearInterval(rush.timer);
    gen++; // cancel any queued advance/reply
    busy = true; // lock the board
    const isBest = rush.score > (store.rushBest || 0);
    store.rushBest = Math.max(store.rushBest || 0, rush.score);
    saveStore();
    $('rush').textContent = 'Play Again';
    $('rush-exit').hidden = false;
    renderPanel();
    sound('end');
    setFeedback('Run over! Score ' + rush.score + (isBest ? ' — new best!' : ' · Best ' + store.rushBest), isBest ? 'good' : '');
  }

  function exitRush() {
    if (rush && rush.timer) clearInterval(rush.timer);
    rush = null;
    $('rush').textContent = '⚡ Rush';
    $('rush-exit').hidden = true;
    $('hint').hidden = false;
    $('next').hidden = false;
    $('difficulty-wrap').hidden = false;
    $('theme-wrap').hidden = false;
    loadPuzzle();
  }

  $('rush').addEventListener('click', () => {
    if (!rush || rush.over) startRush();
    else endRush();
  });
  $('rush-exit').addEventListener('click', exitRush);

  /* ---------------- Panel ---------------- */

  function renderPanel() {
    if (rush) {
      $('rating-label').textContent = 'Score';
      $('streak-label').textContent = 'Strikes';
      $('solved-label').textContent = 'Time';
      $('rating').textContent = rush.score;
      $('streak').textContent = rush.strikes ? '✗'.repeat(rush.strikes) : '—';
      $('solved-count').textContent = fmtTime(rush.timeLeft);
    } else {
      $('rating-label').textContent = 'Rating';
      $('streak-label').textContent = 'Streak';
      $('solved-label').textContent = 'Solved';
      $('rating').textContent = store.rating;
      $('streak').textContent = store.streak;
      $('solved-count').textContent = store.solvedCount;
    }
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
    if (solved || busy || pending || rush) return;
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
    if (rush) return;
    if (busy && !solved) return; // solved leaves the board locked, but Next must work
    if (!solved) onMistake();
    loadPuzzle();
  });

  $('difficulty').addEventListener('change', e => {
    store.difficulty = e.target.value;
    saveStore();
    loadPuzzle(); // settings change, not a skip — no rating penalty
  });

  // Theme filter, built from the tags present in the puzzle set.
  (function buildThemeFilter() {
    const counts = {};
    for (const p of PUZZLES) for (const t of p.themes) counts[t] = (counts[t] || 0) + 1;
    const pretty = t => t.replace(/([A-Z])/g, ' $1').replace(/(\d+)/g, ' $1')
      .replace(/^./, c => c.toUpperCase()).replace(/\s+/g, ' ').trim();
    const sel = $('theme');
    sel.innerHTML = '<option value="">All themes</option>' + Object.entries(counts)
      .filter(([, c]) => c >= 40)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => '<option value="' + t + '">' + pretty(t) + ' (' + c + ')</option>')
      .join('');
    sel.value = store.theme || '';
    if (sel.value !== (store.theme || '')) sel.value = ''; // stored theme no longer exists
  })();
  $('theme').addEventListener('change', e => {
    store.theme = e.target.value;
    saveStore();
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
    state: () => ({ id: puzzle.id, fen: puzzle.fen, fenNow: E.fenKey(st), line: puzzle.line, stepIdx, themes: puzzle.themes, puzzleRating: puzzle.rating, solved, failed, busy, rating: store.rating, streak: store.streak, rush: rush ? { score: rush.score, strikes: rush.strikes, timeLeft: rush.timeLeft, over: rush.over, best: store.rushBest || 0 } : null }),
    load: i => loadPuzzle(PUZZLES[i]),
  };

  $('difficulty').value = store.difficulty || 'auto';
  loadPuzzle();
})();
