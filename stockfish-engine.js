/* stockfish-engine.js — lazy-loading wrapper around the vendored
   single-threaded Stockfish WASM build (vendor/stockfish/). Nothing is
   downloaded or started until init() is first called. All UCI plumbing
   lives here; callers get a small promise-based API:

     Stockfish.init()                     -> Promise (loads the engine)
     Stockfish.isReady()                  -> boolean
     Stockfish.go(position, opts)         -> Promise<{best, score}>
       position: {fen} or {moves: [uci...]} from the start position
       opts: {elo} or {skill}, plus {movetime} or {depth}
       score: {type: 'cp'|'mate', value, pv} from the side to move's view */
(function (global) {
  'use strict';

  const WORKER_URL = 'vendor/stockfish/stockfish-18-lite-single.js';

  let worker = null;
  let readyPromise = null;
  let ready = false;
  let listeners = [];
  let queue = Promise.resolve(); // engine handles one search at a time

  function onLine(line) {
    listeners = listeners.filter(l => !l(line));
  }

  function waitFor(pred) {
    return new Promise(resolve => {
      listeners.push(line => {
        if (!pred(line)) return false;
        resolve();
        return true;
      });
    });
  }

  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      let w;
      try {
        w = new Worker(WORKER_URL);
      } catch (e) {
        reject(e);
        return;
      }
      w.onerror = e => reject(new Error('Stockfish failed to load: ' + (e.message || 'worker error')));
      w.onmessage = ev => onLine(String(ev.data));
      worker = w;
      waitFor(l => l === 'uciok')
        .then(() => {
          w.postMessage('isready');
          return waitFor(l => l === 'readyok');
        })
        .then(() => { ready = true; resolve(); }, reject);
      w.postMessage('uci');
    });
    readyPromise.catch(() => {}); // surfaced to each caller via go()/init()
    return readyPromise;
  }

  function configure(opts) {
    if (opts.elo) {
      worker.postMessage('setoption name UCI_LimitStrength value true');
      worker.postMessage('setoption name UCI_Elo value ' + opts.elo);
    } else {
      worker.postMessage('setoption name UCI_LimitStrength value false');
      worker.postMessage('setoption name Skill Level value ' + (opts.skill != null ? opts.skill : 20));
    }
    worker.postMessage('setoption name MultiPV value ' + (opts.multiPV || 1));
  }

  function go(position, opts) {
    opts = opts || {};
    const job = queue
      .then(init)
      .then(() => new Promise(resolve => {
        configure(opts);
        worker.postMessage('position ' + (position.moves !== undefined
          ? 'startpos' + (position.moves.length ? ' moves ' + position.moves.join(' ') : '')
          : 'fen ' + position.fen));
        let score = null;
        const lines = []; // latest info per MultiPV slot
        listeners.push(line => {
          if (line.startsWith('info ') && line.includes(' score ')) {
            const m = line.match(/score (cp|mate) (-?\d+)/);
            if (m) {
              const pv = line.match(/ pv (.+)$/);
              const entry = { type: m[1], value: +m[2], pv: pv ? pv[1].split(' ') : [] };
              const mpv = line.match(/ multipv (\d+)/);
              lines[mpv ? +mpv[1] - 1 : 0] = entry;
              score = lines[0] || entry;
            }
            return false;
          }
          if (line.startsWith('bestmove')) {
            const best = line.split(/\s+/)[1];
            resolve({ best: !best || best === '(none)' ? null : best, score, lines: lines.filter(Boolean) });
            return true;
          }
          return false;
        });
        worker.postMessage('go ' + (opts.depth ? 'depth ' + opts.depth : 'movetime ' + (opts.movetime || 800)));
      }));
    queue = job.then(() => {}, () => {});
    return job;
  }

  global.Stockfish = { init, go, isReady: () => ready };
})(typeof globalThis !== 'undefined' ? globalThis : this);
