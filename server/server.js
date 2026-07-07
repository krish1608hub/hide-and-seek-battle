const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

const rooms = {};

function genCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); }
  while (rooms[code]);
  return code;
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exclude) {
  room.players.forEach(p => { if (p !== exclude && p.readyState === WebSocket.OPEN) send(p, msg); });
}

wss.on('connection', (ws) => {
  let player = null; // { code, index }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const room = player ? rooms[player.code] : null;

    switch (msg.type) {

      case 'create_room': {
        if (player) return send(ws, { type: 'error', message: 'Already in a room' });
        const code = genCode();
        rooms[code] = {
          players: [ws],
          ships: [null, null],
          shots: [{}, {}],
          ready: [false, false],
          playerNames: ['', ''],
          stats: [{ hits: 0, misses: 0, shots: 0 }, { hits: 0, misses: 0, shots: 0 }],
          rematch: [false, false],
          disconnected: [false, false],
          turn: 0,
          phase: 'waiting',
          winner: null,
        };
        player = { code, index: 0 };
        send(ws, { type: 'room_created', code });
        break;
      }

      case 'join_room': {
        if (player) return send(ws, { type: 'error', message: 'Already in a room' });
        const r = rooms[msg.code];
        if (!r) return send(ws, { type: 'error', message: 'Room not found' });

        if (r.phase === 'waiting') {
          if (r.players.length >= 2) return send(ws, { type: 'error', message: 'Room is full' });
          r.players.push(ws);
          player = { code: msg.code, index: 1 };
          send(ws, { type: 'room_joined', code: msg.code, playerIndex: 1 });
          broadcast(r, { type: 'opponent_joined' }, ws);
        } else if (r.disconnected[0] || r.disconnected[1]) {
          const reconnIdx = r.disconnected[0] ? 0 : 1;
          r.players.push(ws);
          r.disconnected[reconnIdx] = false;
          player = { code: msg.code, index: reconnIdx };

          // Compute full state for rejoining player
          function makeGrid(ships, opponentShots) {
            const g = Array.from({length: 8}, () => Array(8).fill(0));
            if (!ships) return g;
            for (const s of ships) {
              for (const c of s.cells) g[c.r][c.c] = 1;
            }
            for (const key in (opponentShots || {})) {
              const [r, col] = key.split(',').map(Number);
              let hit = false;
              for (const s of ships) {
                for (const c of s.cells) {
                  if (c.r === r && c.c === col) { hit = true; break; }
                }
                if (hit) break;
              }
              g[r][col] = hit ? 2 : 3;
            }
            return g;
          }
          function makeEnemyView(myShots, opponentShips) {
            const g = Array.from({length: 8}, () => Array(8).fill(0));
            for (const key in (myShots || {})) {
              const [r, col] = key.split(',').map(Number);
              let hit = false;
              if (opponentShips) {
                for (const s of opponentShips) {
                  for (const c of s.cells) {
                    if (c.r === r && c.c === col) { hit = true; break; }
                  }
                  if (hit) break;
                }
              }
              g[r][col] = hit ? 2 : 3;
            }
            return g;
          }
          const opp = reconnIdx === 0 ? 1 : 0;
          // Build opponent sunk ships for status bar
          const oppSunk = (r.ships[opp] || []).map(s => ({
            sunk: s.hits >= s.size,
            size: s.size,
          }));
          const state = {
            type: 'reconnect_info',
            playerIndex: reconnIdx,
            playerNames: r.playerNames,
            phase: r.phase,
            turn: r.turn,
            winner: r.winner,
            stats: r.stats,
            grid: makeGrid(r.ships[reconnIdx], r.shots[opp]),
            enemyView: makeEnemyView(r.shots[reconnIdx], r.ships[opp]),
            myShips: (r.ships[reconnIdx] || []).map(s => ({ cells: s.cells, size: s.size, hits: s.hits })),
            opponentSunkShips: oppSunk,
          };
          send(ws, state);
          broadcast(r, { type: 'opponent_reconnected' }, ws);
        } else {
          return send(ws, { type: 'error', message: 'Room is full or game already started' });
        }
        break;
      }

      case 'place_ships': {
        if (!room || player.index == null) return send(ws, { type: 'error', message: 'Not in a room' });
        if (room.phase !== 'waiting') return send(ws, { type: 'error', message: 'Game already started' });
        room.ships[player.index] = msg.ships.map(s => ({
          cells: s.cells,
          size: s.size,
          hits: 0,
        }));
        room.ready[player.index] = true;
        room.playerNames[player.index] = msg.playerName || '';
        // Notify peer about placement progress
        broadcast(room, { type: 'opponent_placed', playerIndex: player.index, playerName: room.playerNames[player.index] }, ws);
        if (room.ready[0] && room.ready[1]) {
          room.turn = Math.random() < 0.5 ? 0 : 1;
          room.phase = 'play';
          room.players.forEach((p, i) => {
            send(p, { type: 'game_start', firstTurn: room.turn, yourIndex: i, playerNames: room.playerNames });
          });
        } else {
          send(ws, { type: 'waiting_opponent' });
        }
        break;
      }

      case 'fire': {
        if (!room || player.index == null) return send(ws, { type: 'error', message: 'Not in a room' });
        if (room.phase !== 'play') return send(ws, { type: 'error', message: 'Game not in play phase' });
        if (room.turn !== player.index) return send(ws, { type: 'error', message: 'Not your turn' });

        const key = `${msg.row},${msg.col}`;
        if (room.shots[player.index][key]) return send(ws, { type: 'error', message: 'Already fired there' });
        room.shots[player.index][key] = true;

        const target = player.index === 0 ? 1 : 0;
        const ships = room.ships[target];
        let hit = false;
        let sunk = false;
        let shipIdx = -1;

        for (let si = 0; si < ships.length; si++) {
          const ship = ships[si];
          for (const cell of ship.cells) {
            if (cell.r === msg.row && cell.c === msg.col) {
              hit = true;
              ship.hits++;
              if (ship.hits >= ship.size) {
                sunk = true;
                shipIdx = si;
              }
              break;
            }
          }
          if (hit) break;
        }

        const astats = room.stats[player.index];
        astats.shots++;
        if (hit) {
          astats.hits++;
        } else {
          astats.misses++;
        }

        const allSunk = ships.every(s => s.hits >= s.size);
        let gameOver = false;

        if (allSunk) {
          gameOver = true;
          room.phase = 'gameover';
          room.winner = player.index;
        } else if (!hit) {
          room.turn = target;
        }

        const result = {
          type: 'fire_result',
          row: msg.row,
          col: msg.col,
          hit,
          sunk,
          shipIdx,
          shipCells: sunk ? ships[shipIdx].cells : undefined,
          gameOver,
          winner: gameOver ? player.index : undefined,
          turn: room.turn,
          attacker: player.index,
          attackerStats: room.stats[player.index],
        };

        room.players.forEach(p => send(p, result));

        if (gameOver) {
          room.players.forEach(p => send(p, {
            type: 'game_over',
            winner: player.index,
            winnerName: msg.playerName || '',
          }));
        }
        break;
      }

      case 'rematch_request': {
        if (!room || room.phase !== 'gameover') return;
        room.rematch[player.index] = true;
        if (room.rematch[0] && room.rematch[1]) {
          room.phase = 'waiting';
          room.ships = [null, null];
          room.shots = [{}, {}];
          room.ready = [false, false];
          room.stats = [{ hits: 0, misses: 0, shots: 0 }, { hits: 0, misses: 0, shots: 0 }];
          room.rematch = [false, false];
          room.turn = 0;
          room.winner = null;
          room.players.forEach(p => send(p, { type: 'rematch_accepted' }));
        } else {
          room.players.forEach(p => send(p, { type: 'rematch_status', wants: room.rematch }));
        }
        break;
      }
      case 'rematch_decline': {
        if (!room) return;
        room.rematch = [false, false];
        room.players.forEach(p => send(p, { type: 'rematch_status', wants: [false, false] }));
        break;
      }

      case 'leave_room': {
        if (room) {
          broadcast(room, { type: 'opponent_left' }, ws);
          delete rooms[player.code];
        }
        player = null;
        break;
      }
    }
  });

  ws.on('close', () => {
    if (player && rooms[player.code]) {
      const r = rooms[player.code];
      if (r.phase === 'waiting' || r.phase === 'play' || r.phase === 'gameover') {
        r.disconnected[player.index] = true;
        r.players = r.players.filter(p => p !== ws);
        broadcast(r, { type: 'opponent_disconnected', roomCode: player.code }, ws);
      } else {
        broadcast(r, { type: 'opponent_left' }, ws);
        delete rooms[player.code];
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sea Battle Server running on http://localhost:${PORT}`);
});
