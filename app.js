/* app.js — board UI, clocks, move list, drag & drop, and game flow. */
(function () {
  'use strict';

  const E = ChessEngine;
  const VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9 };
  const pieceClass = p => 'pc-' + E.colorOf(p) + E.typeOf(p);

  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const promoEl = $('promo');
  const promoBox = $('promo-box');
  const gameoverEl = $('gameover');

  let states, moveLog, fenCounts, currentLegal;
  let selected = null, gameOver = null, aiThinking = false, pending = null;
  let hint = null; // {from, to, stage: 1|2} — engine suggestion for the side to move
  let flipped = false;
  let gen = 0; // generation counter: invalidates queued AI moves after new game/undo
  const settings = { mode: 'two', human: 'w', depth: 2, minutes: 10 };
  let clocks = null, clockTimer = null, lastTick = 0;
  let squareEls = [];

  const cur = () => states[states.length - 1];
  const isHumanTurn = () => settings.mode === 'two' || cur().turn === settings.human;
  const isAITurn = () => settings.mode === 'ai' && cur().turn !== settings.human && !gameOver;

  /* ---------------- Game lifecycle ---------------- */

  function newGame() {
    gen++;
    states = [E.initialState()];
    moveLog = [];
    fenCounts = new Map([[E.fenKey(states[0]), 1]]);
    currentLegal = E.legalMoves(cur());
    selected = null; gameOver = null; pending = null; aiThinking = false; hint = null;
    flipped = settings.mode === 'ai' && settings.human === 'b';
    promoEl.hidden = true;
    gameoverEl.hidden = true;

    clocks = settings.minutes > 0
      ? { w: settings.minutes * 60000, b: settings.minutes * 60000 }
      : null;
    if (clockTimer) clearInterval(clockTimer);
    if (clocks) {
      lastTick = performance.now();
      clockTimer = setInterval(tickClock, 100);
    }

    buildBoard();
    renderAll();
    updateEval();
    if (isAITurn()) scheduleAI();
  }

  function tickClock() {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (!clocks || gameOver || moveLog.length === 0) { renderClocks(); return; }
    const t = cur().turn;
    clocks[t] -= dt;
    if (clocks[t] <= 0) {
      clocks[t] = 0;
      gameOver = { over: true, result: t === 'w' ? '0-1' : '1-0', reason: 'timeout' };
      sound('end');
      renderAll();
      showGameOver();
    }
    renderClocks();
  }

  function applyMove(m) {
    const st = cur();
    const san = E.san(st, m);
    const next = E.makeMove(st, m);
    states.push(next);
    moveLog.push({ m, san });
    const key = E.fenKey(next);
    fenCounts.set(key, (fenCounts.get(key) || 0) + 1);
    currentLegal = E.legalMoves(next);
    selected = null; pending = null; hint = null;
    promoEl.hidden = true;

    const status = E.gameStatus(next, fenCounts);
    if (status.over) gameOver = status;

    if (gameOver) sound('end');
    else if (E.inCheck(next)) sound('check');
    else if (m.captured) sound('capture');
    else sound('move');

    renderAll();
    updateEval();
    if (gameOver) showGameOver();
    else if (isAITurn()) scheduleAI();
  }

  function scheduleAI() {
    aiThinking = true;
    renderStatus();
    const myGen = gen;
    setTimeout(() => {
      if (myGen !== gen) return; // game was reset/undone while waiting
      const m = E.bestMove(cur(), settings.depth);
      aiThinking = false;
      if (m && !gameOver) applyMove(m);
      else renderStatus();
    }, 350);
  }

  function undo() {
    if (aiThinking || pending || !moveLog.length) return;
    gen++;
    let n = settings.mode === 'ai' && cur().turn === settings.human ? 2 : 1;
    n = Math.min(n, moveLog.length);
    for (let i = 0; i < n; i++) {
      const st = states.pop();
      const key = E.fenKey(st);
      const c = fenCounts.get(key) || 0;
      if (c > 1) fenCounts.set(key, c - 1); else fenCounts.delete(key);
      moveLog.pop();
    }
    gameOver = null;
    selected = null;
    hint = null;
    gameoverEl.hidden = true;
    currentLegal = E.legalMoves(cur());
    // If we undid past a flag fall, give that side a little time back.
    if (clocks && clocks[cur().turn] <= 0) clocks[cur().turn] = 15000;
    renderAll();
    updateEval();
    if (isAITurn()) scheduleAI();
  }

  /* ---------------- Board DOM ---------------- */

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
    const st = cur();
    const last = moveLog.length ? moveLog[moveLog.length - 1].m : null;
    const checkSq = E.inCheck(st) ? E.findKing(st.board, st.turn) : -1;
    const targets = selected !== null ? currentLegal.filter(m => m.from === selected) : [];

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

      if (last && (sq === last.from || sq === last.to)) el.classList.add('hl');
      if (sq === selected) el.classList.add('hl');
      if (sq === checkSq) el.classList.add('in-check');
      if (hint && (sq === hint.from || (hint.stage === 2 && sq === hint.to))) el.classList.add('hint-mark');
      const t = targets.find(m => m.to === sq);
      if (t) el.classList.add(t.captured ? 'capture-hint' : 'move-hint');
      if (p && !gameOver && !aiThinking && E.colorOf(p) === st.turn && isHumanTurn()) {
        el.classList.add('grabbable');
      }
    }
  }

  /* ---------------- Input: click + drag ---------------- */

  boardEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (gameOver || aiThinking || pending) return;
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const sq = +sqEl.dataset.sq;
    const st = cur();

    if (selected !== null && currentLegal.some(m => m.from === selected && m.to === sq)) {
      moveTo(selected, sq);
      return;
    }
    const p = st.board[sq];
    if (p && E.colorOf(p) === st.turn && isHumanTurn()) {
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
        if (to !== from && currentLegal.some(m => m.from === from && m.to === to)) {
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

  function moveTo(from, to) {
    const candidates = currentLegal.filter(m => m.from === from && m.to === to);
    if (!candidates.length) return;
    if (candidates[0].promotion) {
      pending = { candidates };
      showPromotion(to);
    } else {
      applyMove(candidates[0]);
    }
  }

  /* ---------------- Promotion picker ---------------- */

  function showPromotion(to) {
    const color = cur().turn;
    promoBox.innerHTML = '';
    for (const t of ['Q', 'N', 'R', 'B']) {
      const b = document.createElement('button');
      b.innerHTML = '<div class="promo-piece pc-' + color + t + '"></div>';
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        const m = pending.candidates.find(x => x.promotion === t);
        applyMove(m);
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

  /* ---------------- Rendering: panel, players, clocks ---------------- */

  function renderAll() {
    renderBoard();
    renderPlayers();
    renderClocks();
    renderStatus();
    renderMoves();
    renderEvalBar(lastEval);
  }

  /* ---------------- Evaluation bar ---------------- */

  let lastEval = 0;

  // Recompute the position score off the click path so the move renders first.
  function updateEval() {
    const seq = ++updateEval.seq;
    if (gameOver) { renderEvalBar(lastEval); return; }
    const st = cur();
    setTimeout(() => {
      if (seq !== updateEval.seq) return;
      renderEvalBar(E.evaluatePosition(st, 2));
    }, 20);
  }
  updateEval.seq = 0;

  function renderEvalBar(cp) {
    lastEval = cp;
    const bar = $('evalbar');
    const fill = $('eval-white');
    const label = $('eval-label');
    bar.classList.toggle('flipped', flipped);

    let frac, text;
    if (gameOver && gameOver.result === '1-0') { frac = 1; text = '1-0'; }
    else if (gameOver && gameOver.result === '0-1') { frac = 0; text = '0-1'; }
    else if (gameOver) { frac = 0.5; text = '½'; }
    else if (cp > 90000) { frac = 0.98; text = 'M'; }
    else if (cp < -90000) { frac = 0.02; text = 'M'; }
    else {
      // Logistic curve: +300cp ≈ 73% of the bar, like chess.com's squashing.
      frac = 1 / (1 + Math.exp(-cp / 300));
      frac = Math.min(0.95, Math.max(0.05, frac));
      text = Math.abs(cp / 100).toFixed(1);
    }
    fill.style.height = (frac * 100) + '%';

    const whiteLeads = frac >= 0.5;
    const atBottom = whiteLeads === !flipped; // label sits at the leading side's end
    label.style.top = atBottom ? 'auto' : '3px';
    label.style.bottom = atBottom ? '3px' : 'auto';
    label.style.color = whiteLeads ? '#57544f' : '#e8e6e3';
    label.textContent = text;
  }

  function playerName(color) {
    if (settings.mode === 'ai') {
      return color === settings.human
        ? 'You'
        : 'Computer (' + ['', 'Easy', 'Medium', 'Hard'][settings.depth] + ')';
    }
    return color === 'w' ? 'White' : 'Black';
  }

  function capturedBy(color) {
    const out = [];
    moveLog.forEach((e, i) => {
      const mover = i % 2 === 0 ? 'w' : 'b';
      if (mover === color && e.m.captured) out.push(e.m.captured);
    });
    return out.sort((a, b) => VALUES[E.typeOf(b)] - VALUES[E.typeOf(a)]);
  }

  function renderPlayers() {
    const bottom = flipped ? 'b' : 'w';
    const top = flipped ? 'w' : 'b';
    $('name-bottom').textContent = playerName(bottom);
    $('name-top').textContent = playerName(top);

    const capB = capturedBy(bottom), capT = capturedBy(top);
    const pts = c => c.reduce((s, p) => s + VALUES[E.typeOf(p)], 0);
    const diff = pts(capB) - pts(capT);
    // Same piece types huddle together; a gap separates different types.
    const html = (pieces, adv) => {
      const groups = [];
      for (const p of pieces) {
        const cls = pieceClass(p);
        if (groups.length && groups[groups.length - 1].cls === cls) groups[groups.length - 1].n++;
        else groups.push({ cls, n: 1 });
      }
      return groups.map(g => '<span class="cap-group">'
        + ('<span class="cap-piece ' + g.cls + '"></span>').repeat(g.n) + '</span>').join('')
        + (adv > 0 ? '<span class="adv">+' + adv + '</span>' : '');
    };
    $('cap-bottom').innerHTML = html(capB, diff);
    $('cap-top').innerHTML = html(capT, -diff);
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function renderClocks() {
    const bottom = flipped ? 'b' : 'w';
    const top = flipped ? 'w' : 'b';
    for (const [id, color] of [['clock-bottom', bottom], ['clock-top', top]]) {
      const el = $(id);
      if (!clocks) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.textContent = fmtClock(clocks[color]);
      el.classList.toggle('active', !gameOver && moveLog.length > 0 && cur().turn === color);
      el.classList.toggle('low', clocks[color] < 30000);
    }
  }

  function resultText(go) {
    const winner = go.result === '1-0' ? 'White' : go.result === '0-1' ? 'Black' : null;
    switch (go.reason) {
      case 'checkmate': return ['Checkmate', winner + ' wins'];
      case 'timeout': return ['Time’s up', winner + ' wins on time'];
      case 'stalemate': return ['Draw', 'Stalemate'];
      case 'insufficient material': return ['Draw', 'Insufficient material'];
      case 'fifty-move rule': return ['Draw', '50-move rule'];
      case 'threefold repetition': return ['Draw', 'Threefold repetition'];
      default: return ['Game over', go.result];
    }
  }

  function renderStatus() {
    const el = $('status');
    if (gameOver) {
      const [a, b] = resultText(gameOver);
      el.textContent = a + ' — ' + b;
    } else if (aiThinking) {
      el.textContent = 'Computer is thinking…';
    } else {
      el.textContent = (cur().turn === 'w' ? 'White' : 'Black') + ' to move'
        + (E.inCheck(cur()) ? ' — check!' : '');
    }
  }

  function renderMoves() {
    const el = $('moves');
    el.innerHTML = '';
    for (let i = 0; i < moveLog.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'move-row';
      const num = document.createElement('span');
      num.className = 'move-num';
      num.textContent = (i / 2 + 1) + '.';
      row.appendChild(num);
      for (const j of [i, i + 1]) {
        const s = document.createElement('span');
        s.className = 'move-san' + (j === moveLog.length - 1 ? ' current' : '');
        s.textContent = moveLog[j] ? moveLog[j].san : '';
        row.appendChild(s);
      }
      el.appendChild(row);
    }
    if (gameOver) {
      const r = document.createElement('div');
      r.className = 'move-result';
      r.textContent = gameOver.result;
      el.appendChild(r);
    }
    el.scrollTop = el.scrollHeight;
  }

  function showGameOver() {
    const [title, sub] = resultText(gameOver);
    $('go-title').textContent = title;
    $('go-sub').textContent = sub;
    gameoverEl.hidden = false;
  }

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
      else if (kind === 'check') { tone(660, 0, 0.09); tone(880, 0.1, 0.12); }
      else if (kind === 'end') { tone(523, 0, 0.18); tone(659, 0.12, 0.18); tone(784, 0.24, 0.3); }
    } catch (_) { /* audio unavailable */ }
  }

  /* ---------------- Controls ---------------- */

  $('mode').addEventListener('change', e => {
    settings.mode = e.target.value;
    $('playas-wrap').hidden = settings.mode !== 'ai';
    $('diff-wrap').hidden = settings.mode !== 'ai';
    newGame();
  });
  $('playas').addEventListener('change', e => {
    settings.human = e.target.value;
    newGame();
  });
  $('diff').addEventListener('change', e => {
    settings.depth = +e.target.value;
    renderPlayers();
  });
  $('time').addEventListener('change', e => {
    settings.minutes = +e.target.value;
    newGame();
  });
  $('new').addEventListener('click', newGame);
  $('go-new').addEventListener('click', newGame);
  $('go-close').addEventListener('click', () => { gameoverEl.hidden = true; });
  $('flip').addEventListener('click', () => {
    flipped = !flipped;
    buildBoard();
    renderAll();
  });
  $('undo').addEventListener('click', undo);
  $('hint').addEventListener('click', () => {
    if (gameOver || aiThinking || pending || !isHumanTurn()) return;
    if (!hint) {
      const m = E.bestMove(cur(), 3);
      if (!m) return;
      hint = { from: m.from, to: m.to, stage: 1 };
    } else if (hint.stage === 1) {
      hint.stage = 2;
    }
    renderBoard();
  });

  newGame();
})();
