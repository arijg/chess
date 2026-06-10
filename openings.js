/* openings.js — opening explorer & trainer over the lichess opening book:
   move pieces (or search) to identify openings by name, see every named
   continuation as a figurine line, replay book lines, and practice them
   from memory with feedback. */
(function () {
  'use strict';

  const E = ChessEngine;
  const pieceClass = p => 'pc-' + E.colorOf(p) + E.typeOf(p);
  const uciOf = m => E.sqToAlg(m.from) + E.sqToAlg(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');

  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const promoEl = $('promo');
  const promoBox = $('promo-box');

  let st = E.initialState();
  let legal = E.legalMoves(st);
  let hist = [];          // previous states, for undo
  let seq = [];           // uci moves played from the start position
  let mode = 'learn';     // 'learn' | 'practice'
  let target = null;      // opening being studied / practiced
  let selected = null, pending = null, lastMove = null, busy = false;
  let marks = {};
  let squareEls = [];
  let gen = 0;

  // Openings are matched on the move sequence; precompute token arrays.
  for (const o of OPENINGS) o.moves = o.uci.split(' ');

  /* ---------------- Opening detection ---------------- */

  const seqStr = () => seq.join(' ');

  // Deepest named opening whose line is a prefix of what's on the board.
  function deepestMatch() {
    const s = seqStr() + ' ';
    let best = null;
    for (const o of OPENINGS) {
      if (s.startsWith(o.uci + ' ') && (!best || o.moves.length > best.moves.length)) best = o;
    }
    return best;
  }

  // Named continuations from the current position, grouped by next move.
  function continuations() {
    const s = seq.length ? seqStr() + ' ' : '';
    const groups = new Map(); // next uci -> {rep, count}
    for (const o of OPENINGS) {
      if (o.moves.length <= seq.length) continue;
      if (!(o.uci + ' ').startsWith(s)) continue;
      const next = o.moves[seq.length];
      const g = groups.get(next);
      if (!g) groups.set(next, { rep: o, count: 1 });
      else {
        g.count++;
        if (o.moves.length < g.rep.moves.length) g.rep = o;
      }
    }
    return [...groups.values()]
      .sort((a, b) => b.count - a.count || a.rep.name.length - b.rep.name.length)
      .slice(0, 12);
  }

  /* ---------------- Figurine lines ---------------- */

  const FIGS = {
    w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' },
    b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' },
  };
  const figurine = (san, color) => san.replace(/[KQRBN]/g, ch => FIGS[color][ch]);

  function lineToSan(st0, ucis, maxPlies) {
    let s = st0;
    const parts = [];
    for (let i = 0; i < Math.min(ucis.length, maxPlies); i++) {
      const m = E.legalMoves(s).find(x => uciOf(x) === ucis[i]);
      if (!m) break;
      const prefix = s.turn === 'w' ? s.fullmove + '. ' : (i === 0 ? s.fullmove + '… ' : '');
      parts.push(prefix + figurine(E.san(s, m), s.turn));
      s = E.makeMove(s, m);
    }
    return parts.join(' ') + (ucis.length > maxPlies ? ' …' : '');
  }

  /* ---------------- Moves ---------------- */

  function findUci(u) {
    const from = E.algToSq(u.slice(0, 2));
    const to = E.algToSq(u.slice(2, 4));
    const promo = u[4] ? u[4].toUpperCase() : null;
    return legal.find(m => m.from === from && m.to === to && (m.promotion || null) === promo);
  }

  function applyMove(m, animate) {
    hist.push(st);
    seq.push(uciOf(m));
    st = E.makeMove(st, m);
    legal = E.legalMoves(st);
    lastMove = m;
    selected = null; pending = null;
    promoEl.hidden = true;
    sound(m.captured ? 'capture' : 'move');
    renderBoard();
    if (animate) animateMove(m);
    renderPanels();
  }

  function doUserMove(m, viaDrag) {
    if (mode === 'practice') {
      const expected = target.moves[seq.length];
      if (uciOf(m) !== expected) {
        marks = { bad: m.to };
        sound('error');
        const prev = { st, legal, lastMove };
        st = E.makeMove(st, m);
        renderBoard();
        const myGen = gen;
        setTimeout(() => {
          if (myGen !== gen) return;
          st = prev.st; legal = prev.legal; lastMove = prev.lastMove;
          const exp = findUci(expected);
          marks = exp ? { hint: exp.from } : {};
          renderBoard();
          setStatus('Not the book move — the piece to move is highlighted.', 'bad');
          busy = false;
        }, 700);
        busy = true;
        return;
      }
      marks = { good: m.to };
      applyMove(m, !viaDrag);
      if (seq.length >= target.moves.length) {
        mode = 'learn';
        sound('end');
        setStatus('Line complete — you played the whole ' + target.name + '!', 'good');
        renderPanels(true);
      } else {
        setStatus('Correct! ' + seq.length + '/' + target.moves.length, 'good');
      }
      return;
    }
    marks = {};
    applyMove(m, !viaDrag);
  }

  function back() {
    if (!hist.length || busy) return;
    gen++;
    st = hist.pop();
    seq.pop();
    legal = E.legalMoves(st);
    lastMove = null; selected = null; marks = {};
    promoEl.hidden = true; pending = null;
    if (mode === 'practice') setStatus('Play the next book move. ' + seq.length + '/' + target.moves.length, '');
    renderBoard();
    renderPanels();
  }

  function reset(keepMode) {
    gen++;
    st = E.initialState();
    legal = E.legalMoves(st);
    hist = []; seq = [];
    lastMove = null; selected = null; marks = {}; busy = false;
    pending = null; promoEl.hidden = true;
    if (!keepMode) mode = 'learn';
    renderBoard();
    renderPanels();
  }

  function loadOpening(o) {
    reset();
    target = o;
    const myGen = gen;
    busy = true;
    setStatus('Watch the line, then practice it.', '');
    let i = 0;
    const step = () => {
      if (myGen !== gen) return;
      if (i >= o.moves.length) { busy = false; renderPanels(); return; }
      const m = findUci(o.moves[i]);
      if (!m) { busy = false; return; }
      i++;
      applyMove(m, true);
      setTimeout(step, 550);
    };
    setTimeout(step, 300);
  }

  function startPractice() {
    if (mode === 'practice') { // exit
      mode = 'learn';
      renderPanels();
      setStatus('Exploring freely.', '');
      return;
    }
    target = target && (seqStr() === '' || (target.uci + ' ').startsWith(seqStr() + ' ') || (seqStr() + ' ').startsWith(target.uci + ' '))
      ? target : deepestMatch();
    if (!target) { setStatus('Play or search an opening first.', 'bad'); return; }
    reset(true);
    mode = 'practice';
    renderPanels();
    setStatus('Play the ' + target.name + ' from memory (' + target.moves.length + ' moves).', '');
  }

  /* ---------------- Panels ---------------- */

  function renderPanels(skipStatus) {
    const match = deepestMatch();
    $('opening-title').textContent = match ? match.name : (seq.length ? 'Out of book' : 'Starting position');
    $('opening-eco').textContent = match ? match.eco : '';
    $('practice').textContent = mode === 'practice' ? 'Exit Practice' : 'Practice';

    // Continuation lines, analysis-panel style.
    const panel = $('continuations');
    panel.innerHTML = '';
    if (mode === 'practice') {
      panel.hidden = true;
    } else {
      panel.hidden = false;
      for (const g of continuations()) {
        const restAll = g.rep.moves.slice(seq.length);
        const row = document.createElement('div');
        row.className = 'line-row';
        const badge = document.createElement('span');
        badge.className = 'line-eval';
        badge.textContent = g.rep.eco;
        const moves = document.createElement('span');
        moves.className = 'line-moves';
        moves.textContent = lineToSan(st, restAll, 8);
        const name = document.createElement('span');
        name.className = 'cont-name';
        name.textContent = g.rep.name;
        row.appendChild(badge);
        row.appendChild(moves);
        row.appendChild(name);
        row.addEventListener('click', () => {
          if (busy) return;
          target = g.rep;
          const m = findUci(restAll[0]);
          if (m) { marks = {}; applyMove(m, true); }
        });
        panel.appendChild(row);
      }
      if (!panel.children.length && seq.length) {
        panel.innerHTML = '<div class="line-row line-loading">No more named lines from here.</div>';
      }
    }

    if (!skipStatus && mode === 'learn') {
      setStatus(seq.length
        ? lineToSan(E.initialState(), seq, 99)
        : 'Move pieces or search an opening to explore.', '');
    }
  }

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = kind || '';
  }

  /* ---------------- Search ---------------- */

  const resultsEl = $('results');
  $('search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    resultsEl.innerHTML = '';
    if (q.length < 2) { resultsEl.hidden = true; return; }
    const starts = [], contains = [];
    for (const o of OPENINGS) {
      const n = o.name.toLowerCase();
      if (n.startsWith(q) || o.eco.toLowerCase() === q) starts.push(o);
      else if (n.includes(q)) contains.push(o);
      if (starts.length > 30) break;
    }
    const hits = starts.concat(contains).slice(0, 30);
    for (const o of hits) {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML = '<span class="line-eval">' + o.eco + '</span> ' + o.name;
      row.addEventListener('click', () => {
        resultsEl.hidden = true;
        $('search').value = o.name;
        loadOpening(o);
      });
      resultsEl.appendChild(row);
    }
    resultsEl.hidden = !hits.length;
  });
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.search-wrap')) resultsEl.hidden = true;
  });

  /* ---------------- Board DOM (same look as the other pages) ---------------- */

  function buildBoard() {
    boardEl.innerHTML = '';
    squareEls = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = col;
        const rank = 7 - row;
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
      if (sq === marks.hint) el.classList.add('hint-mark');
      const t = targets.find(m => m.to === sq);
      if (t) el.classList.add(t.captured ? 'capture-hint' : 'move-hint');
      if (p && !busy && E.colorOf(p) === st.turn) el.classList.add('grabbable');
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
    if (busy || pending) return;
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
    const atTop = rank === 7;
    promoBox.style.left = file * 12.5 + '%';
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

  /* ---------------- Controls ---------------- */

  $('back').addEventListener('click', back);
  $('reset').addEventListener('click', () => { target = null; $('search').value = ''; reset(); });
  $('practice').addEventListener('click', startPractice);

  window.addEventListener('keydown', e => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') { back(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') {
      // step forward along the studied line
      if (busy || mode === 'practice' || !target) return;
      if ((target.uci + ' ').startsWith(seqStr() ? seqStr() + ' ' : '') && target.moves.length > seq.length) {
        const m = findUci(target.moves[seq.length]);
        if (m) { marks = {}; applyMove(m, true); }
      }
      e.preventDefault();
    }
  });

  // Tiny harness hook so behavior can be driven in automated checks.
  window.__openings = {
    state: () => ({ seq: seq.join(' '), mode, target: target ? target.name : null, title: $('opening-title').textContent, eco: $('opening-eco').textContent }),
    load: name => { const o = OPENINGS.find(x => x.name === name); if (o) loadOpening(o); },
  };

  buildBoard();
  renderBoard();
  renderPanels();
})();
