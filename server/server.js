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
        if (r.players.length >= 2) return send(ws, { type: 'error', message: 'Room is full' });
        if (r.phase !== 'waiting') return send(ws, { type: 'error', message: 'Game already started' });
        r.players.push(ws);
        player = { code: msg.code, index: 1 };
        send(ws, { type: 'room_joined', code: msg.code, playerIndex: 1 });
        broadcast(r, { type: 'opponent_joined' }, ws);
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

      case 'rematch': {
        if (!room) return;
        if (room.phase !== 'gameover') return;
        room.phase = 'waiting';
        room.ships = [null, null];
        room.shots = [{}, {}];
        room.ready = [false, false];
        room.turn = 0;
        room.winner = null;
        room.players.forEach(p => send(p, { type: 'rematch_accepted' }));
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
      broadcast(r, { type: 'opponent_disconnected' }, ws);
      if (r.players.length <= 2) delete rooms[player.code];
      else r.players = r.players.filter(p => p !== ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sea Battle Server running on http://localhost:${PORT}`);
});
