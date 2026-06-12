/* online.js — play a friend over a link. Connects to the relay (server/),
   does the host/guest handshake, then runs a turn-gated game on top of the
   OnlineGame core: every move is validated locally, relayed, and
   re-validated by the peer. Clocks, resign, draw offers, rematch, and
   disconnect handling included. */
(function () {
  'use strict';

  const E = ChessEngine;
  const pieceClass = p => 'pc-' + E.colorOf(p) + E.typeOf(p);

  // The relay to connect to, in priority order:
  //   1. ?relay=wss://... in the URL (persisted, handy for testing a deploy)
  //   2. the committed production relay below — set this after deploying
  //      server/cloudflare (see server/cloudflare/README.md)
  //   3. ws://localhost:8421 when developing locally
  const PLACEHOLDER = 'wss://YOUR-RELAY-HOST';
  const PROD_RELAY = 'wss://chess.ariel-5fb.workers.dev'; // Cloudflare Worker relay
  function resolveRelay() {
    try {
      const q = new URLSearchParams(location.search).get('relay');
      if (q) { localStorage.setItem('chess-relay-url', q); return q; }
      const saved = localStorage.getItem('chess-relay-url');
      if (saved) return saved;
    } catch (_) { /* ignore */ }
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'ws://' + location.hostname + ':8421';
    }
    return PROD_RELAY;
  }
  const RELAY_URL = resolveRelay();

  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const promoEl = $('promo');
  const promoBox = $('promo-box');

  let ws = null, seat = null, isHost = false;
  let game = null, myColor = 'w', settings = { minutes: 10, hostColor: 'w' };
  let phase = 'lobby';            // lobby | waiting | playing | over
  let selected = null, pending = null, lastMove = null, flipped = false;
  let marks = {};
  let squareEls = [];
  let clocks = null, clockTimer = null, lastTick = 0;
  let drawOffered = false, peerDrawOffer = false;
  let iWantRematch = false, peerWantsRematch = false;
  let gameId = null;

  /* ---------------- Connection ---------------- */

  function newId() {
    const a = new Uint8Array(5);
    (self.crypto || window.crypto).getRandomValues(a);
    return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  }

  function connect(id) {
    gameId = id;
    if (RELAY_URL === PLACEHOLDER) {
      setStatus('No relay configured. Deploy server/ and set RELAY_URL in online.js.', 'bad');
      return;
    }
    try {
      ws = new WebSocket(RELAY_URL + '/?game=' + encodeURIComponent(id));
    } catch (e) {
      setStatus('Could not connect to the relay.', 'bad');
      return;
    }
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      onServer(msg);
    };
    ws.onclose = () => {
      if (phase === 'playing') setStatus('Connection lost — reload to reconnect.', 'bad');
    };
    ws.onerror = () => setStatus('Connection error. Is the relay running?', 'bad');
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'relay', d: payload }));
  }

  function onServer(msg) {
    if (msg.t === 'welcome') {
      seat = msg.seat;
      isHost = seat === 1;
      if (isHost) {
        setStatus('Waiting for your opponent to join…', '');
        phase = 'waiting';
      } else {
        setStatus('Joined — waiting for the host to start…', '');
        phase = 'waiting';
      }
    } else if (msg.t === 'full') {
      setStatus('That game is full.', 'bad');
    } else if (msg.t === 'peer-joined') {
      if (isHost && phase === 'waiting') {
        // Host defines the game and sends it to the guest.
        const hc = settings.hostColor === 'random'
          ? (new Uint8Array(1), (self.crypto || window.crypto).getRandomValues(new Uint8Array(1))[0] < 128 ? 'w' : 'b')
          : settings.hostColor;
        settings.hostColor = hc;
        send({ k: 'setup', hostColor: hc, minutes: settings.minutes });
        startGame(hc, settings.minutes);
      }
    } else if (msg.t === 'peer-left') {
      if (phase === 'playing') setStatus('Opponent left the game.', 'bad');
      else if (phase === 'waiting' && isHost) setStatus('Waiting for your opponent to join…', '');
    } else if (msg.t === 'peer') {
      onPeer(msg.d);
    }
  }

  function onPeer(d) {
    if (!d) return;
    if (d.k === 'setup') {
      // Guest receives the host's choices; guest plays the opposite colour.
      settings.minutes = d.minutes;
      startGame(d.hostColor === 'w' ? 'b' : 'w', d.minutes);
      send({ k: 'ready' });
    } else if (d.k === 'move') {
      const r = game.applyRemoteMove(d.uci);
      if (!r.ok) { setStatus('Out-of-sync move from opponent (' + r.reason + ').', 'bad'); return; }
      lastMove = r.move;
      if (clocks && typeof d.clockMs === 'number') clocks[opp()] = d.clockMs;
      marks = {};
      sound(r.move.captured ? 'capture' : (game.gameOver ? 'end' : (E.inCheck(game.state) ? 'check' : 'move')));
      afterMove(true);
    } else if (d.k === 'resign') {
      game.resign(opp());
      endGame();
    } else if (d.k === 'flag') {
      game.resign(opp()); // opponent's flag fell; recorded as their loss
      if (game.gameOver) game.gameOver.reason = 'timeout';
      endGame();
    } else if (d.k === 'draw-offer') {
      peerDrawOffer = true;
      setStatus('Opponent offers a draw — click “Accept draw”.', '');
      $('draw').textContent = 'Accept draw';
    } else if (d.k === 'draw-accept') {
      game.drawAgreed();
      endGame();
    } else if (d.k === 'rematch') {
      peerWantsRematch = true;
      maybeRematch();
    }
  }

  const opp = () => myColor === 'w' ? 'b' : 'w';

  /* ---------------- Game lifecycle ---------------- */

  function startGame(color, minutes) {
    myColor = color;
    game = new OnlineGame(color);
    flipped = color === 'b';
    phase = 'playing';
    selected = null; pending = null; lastMove = null; marks = {};
    drawOffered = false; peerDrawOffer = false;
    iWantRematch = false; peerWantsRematch = false;
    promoEl.hidden = true;
    $('lobby').hidden = true;
    $('game-actions').hidden = false;
    $('rematch').hidden = true;
    $('draw').textContent = 'Offer draw';
    $('resign').disabled = false;
    $('draw').disabled = false;

    clocks = minutes > 0 ? { w: minutes * 60000, b: minutes * 60000 } : null;
    if (clockTimer) clearInterval(clockTimer);
    if (clocks) { lastTick = performance.now(); clockTimer = setInterval(tickClock, 100); }

    buildBoard();
    renderAll();
    setStatus(turnText(), '');
  }

  function turnText() {
    if (game.myTurn()) return 'Your move' + (E.inCheck(game.state) ? ' — check!' : '');
    return 'Opponent to move' + (E.inCheck(game.state) ? ' — check!' : '');
  }

  function tickClock() {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (!clocks || phase !== 'playing' || !game.myTurn() || !game.moveLog.length) { renderClocks(); return; }
    // Only the side to move ticks their own clock down — no cross-peer drift.
    clocks[myColor] -= dt;
    if (clocks[myColor] <= 0) {
      clocks[myColor] = 0;
      send({ k: 'flag' });
      game.resign(myColor);
      if (game.gameOver) game.gameOver.reason = 'timeout';
      endGame();
    }
    renderClocks();
  }

  function doLocalMove(m) {
    const uci = OnlineGame.uciOf(m);
    const r = game.tryLocalMove(uci);
    if (!r.ok) return;
    lastMove = m;
    selected = null; marks = {};
    send({ k: 'move', uci, clockMs: clocks ? clocks[myColor] : null });
    sound(m.captured ? 'capture' : (game.gameOver ? 'end' : (E.inCheck(game.state) ? 'check' : 'move')));
    afterMove(false);
  }

  function afterMove(animate) {
    promoEl.hidden = true;
    renderAll();
    if (animate && lastMove) animateMove(lastMove);
    if (game.gameOver) endGame();
    else setStatus(turnText(), '');
  }

  function endGame() {
    phase = 'over';
    if (clockTimer) clearInterval(clockTimer);
    selected = null;
    renderAll();
    const go = game.gameOver;
    const won = go.result === '1-0' ? 'w' : go.result === '0-1' ? 'b' : null;
    let text;
    if (go.reason === 'checkmate') text = 'Checkmate — ' + (won === myColor ? 'you win!' : 'you lose.');
    else if (go.reason === 'resignation') text = won === myColor ? 'Opponent resigned — you win!' : 'You resigned.';
    else if (go.reason === 'timeout') text = won === myColor ? 'Opponent flagged — you win!' : 'You lost on time.';
    else if (go.reason === 'agreement') text = 'Draw agreed.';
    else if (go.reason === 'stalemate') text = 'Stalemate — draw.';
    else text = 'Draw (' + go.reason + ').';
    setStatus(text, won === myColor || !won ? 'good' : 'bad');
    $('resign').disabled = true;
    $('draw').disabled = true;
    $('rematch').hidden = false;
  }

  function maybeRematch() {
    if (!(iWantRematch && peerWantsRematch)) {
      if (peerWantsRematch && !iWantRematch) setStatus('Opponent wants a rematch — click “Rematch”.', '');
      return;
    }
    // Both agreed; the host swaps colours and drives the new game.
    if (isHost) {
      const newHost = settings.hostColor === 'w' ? 'b' : 'w';
      settings.hostColor = newHost;
      send({ k: 'setup', hostColor: newHost, minutes: settings.minutes });
      startGame(newHost, settings.minutes);
    }
    // Guest waits for the incoming setup, which calls startGame.
  }

  /* ---------------- Lobby ---------------- */

  function openSetup() {
    // Reset any prior game/connection before starting a new one.
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    if (clockTimer) clearInterval(clockTimer);
    game = null; phase = 'lobby'; lastMove = null; selected = null;
    $('share').hidden = true;
    $('game-actions').hidden = true;
    buildBoard();
    renderBoard();
    setStatus('', '');
    $('setup').hidden = false;
  }

  function startCreate() {
    settings.hostColor = $('host-color').value;
    settings.minutes = +$('host-time').value;
    const id = newId();
    let link = location.origin + location.pathname + '?g=' + id;
    // If a relay override is active (testing a deploy), pass it to the friend too.
    try {
      const override = localStorage.getItem('chess-relay-url');
      if (override) link += '&relay=' + encodeURIComponent(override);
    } catch (_) { /* ignore */ }
    $('share-link').value = link;
    $('share').hidden = false;
    $('setup').hidden = true;
    connect(id);
  }

  $('create').addEventListener('click', startCreate);
  $('new-online').addEventListener('click', openSetup);
  $('setup-close').addEventListener('click', () => {
    $('setup').hidden = true;
    if (phase === 'lobby' && !ws) setStatus('Tap “New online game” to start.', '');
  });
  $('copy').addEventListener('click', () => {
    const inp = $('share-link');
    inp.select();
    if (navigator.clipboard) navigator.clipboard.writeText(inp.value).catch(() => {});
    else document.execCommand('copy');
    $('copy').textContent = 'Copied!';
    setTimeout(() => { $('copy').textContent = 'Copy link'; }, 1500);
  });

  $('resign').addEventListener('click', () => {
    if (phase !== 'playing') return;
    send({ k: 'resign' });
    game.resign(myColor);
    endGame();
  });
  $('draw').addEventListener('click', () => {
    if (phase !== 'playing') return;
    if (peerDrawOffer) { send({ k: 'draw-accept' }); game.drawAgreed(); endGame(); return; }
    if (drawOffered) return;
    drawOffered = true;
    send({ k: 'draw-offer' });
    setStatus('Draw offered.', '');
  });
  $('rematch').addEventListener('click', () => {
    if (phase !== 'over' || iWantRematch) return;
    iWantRematch = true;
    send({ k: 'rematch' });
    setStatus('Rematch requested…', '');
    maybeRematch();
  });

  /* ---------------- Rendering ---------------- */

  function renderAll() { renderBoard(); renderNames(); renderClocks(); renderMoves(); }

  function renderNames() {
    const bottom = flipped ? 'b' : 'w';
    const top = flipped ? 'w' : 'b';
    const label = c => (c === myColor ? 'You' : 'Opponent') + ' (' + (c === 'w' ? 'White' : 'Black') + ')';
    $('name-bottom').textContent = label(bottom);
    $('name-top').textContent = label(top);
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
      el.classList.toggle('active', phase === 'playing' && game.moveLog.length > 0 && game.state.turn === color);
      el.classList.toggle('low', clocks[color] < 30000);
    }
  }

  function renderMoves() {
    const el = $('moves');
    if (!game) { el.innerHTML = ''; return; }
    let html = '';
    for (let i = 0; i < game.moveLog.length; i += 2) {
      html += '<div class="move-row"><span class="move-num">' + (i / 2 + 1) + '.</span>'
        + '<span class="move-san">' + game.moveLog[i].san + '</span>'
        + '<span class="move-san">' + (game.moveLog[i + 1] ? game.moveLog[i + 1].san : '') + '</span></div>';
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }

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
    // Before a game starts, show the initial position as a static preview.
    const st = game ? game.state : E.initialState();
    const checkSq = game && E.inCheck(st) ? E.findKing(st.board, st.turn) : -1;
    const targets = game && selected !== null ? E.legalMoves(st).filter(m => m.from === selected) : [];

    for (const el of squareEls) {
      const sq = +el.dataset.sq;
      const p = st.board[sq];
      el.className = el.dataset.base;

      let span = el.querySelector('.piece');
      if (p) {
        if (!span) { span = document.createElement('span'); el.appendChild(span); }
        span.className = 'piece ' + pieceClass(p);
      } else if (span) span.remove();

      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) el.classList.add('hl');
      if (sq === selected) el.classList.add('hl');
      if (sq === checkSq) el.classList.add('in-check');
      const t = targets.find(m => m.to === sq);
      if (t) el.classList.add(t.captured ? 'capture-hint' : 'move-hint');
      if (p && game && game.myTurn() && E.colorOf(p) === myColor) el.classList.add('grabbable');
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
    if (!game || !game.myTurn() || pending) return;
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const sq = +sqEl.dataset.sq;
    const st = game.state;

    if (selected !== null && E.legalMoves(st).some(m => m.from === selected && m.to === sq)) {
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
    const pieceEl = squareEl(from) && squareEl(from).querySelector('.piece');
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
        if (to !== from && E.legalMoves(game.state).some(m => m.from === from && m.to === to)) {
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
    const candidates = E.legalMoves(game.state).filter(m => m.from === from && m.to === to);
    if (!candidates.length) return;
    if (candidates[0].promotion) {
      pending = { candidates, viaDrag };
      showPromotion(to);
    } else {
      pendingAnimate = !viaDrag;
      doLocalMove(candidates[0]);
    }
  }

  let pendingAnimate = false;

  function showPromotion(to) {
    const color = game.state.turn;
    promoBox.innerHTML = '';
    for (const t of ['Q', 'N', 'R', 'B']) {
      const b = document.createElement('button');
      b.innerHTML = '<div class="promo-piece pc-' + color + t + '"></div>';
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        const m = pending.candidates.find(x => x.promotion === t);
        pendingAnimate = !pending.viaDrag;
        doLocalMove(m);
      });
      promoBox.appendChild(b);
    }
    const file = to & 15, rank = to >> 4;
    const colpos = flipped ? 7 - file : file;
    const atTop = flipped ? rank === 0 : rank === 7;
    promoBox.style.left = colpos * 12.5 + '%';
    promoBox.style.top = atTop ? '0' : 'auto';
    promoBox.style.bottom = atTop ? 'auto' : '0';
    promoEl.hidden = false;
  }

  promoEl.addEventListener('click', () => {
    pending = null; selected = null; promoEl.hidden = true; renderBoard();
  });

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = kind || '';
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

  // Tiny harness hook so behavior can be driven in automated checks.
  window.__online = {
    state: () => ({ phase, seat, isHost, myColor, turn: game ? game.state.turn : null,
      moves: game ? game.moveLog.map(x => x.san) : [], over: game && game.gameOver ? game.gameOver.reason : null,
      status: $('status').textContent }),
    relayUrl: RELAY_URL,
  };

  // Static starting-position preview while in the lobby.
  buildBoard();
  renderBoard();

  // Joining via a shared link: ?g=<id>
  const params = new URLSearchParams(location.search);
  const join = params.get('g');
  if (join) {
    $('lobby').hidden = true;
    setStatus('Connecting…', '');
    connect(join);
  } else {
    // Host: open the settings popup right away.
    $('setup').hidden = false;
    setStatus('Choose your colour and time, then create a game.', '');
  }
})();
