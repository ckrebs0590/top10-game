const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const C = require('./categories');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve static files
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const ROUNDS = 5;
const RECONNECT_TIMEOUT = 60_000;  // 60s
const ROOM_EXPIRY = 30 * 60_000;  // 30 min

// ═══════════════════════════════════════════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════════════════════════════════════════

const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/1/0
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function generateToken() {
  return crypto.randomUUID();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stripRankValue(item) {
  return [item[0], item[1], item[2], item[3]]; // name, desc, emoji, wikiKey — NO rankValue
}

function pickCategories() {
  const keys = shuffle(Object.keys(C));
  return keys.slice(0, ROUNDS);
}

function computeDeviation(playerRanking, correctOrder) {
  // playerRanking: array of item indices at slots 0-9 (slot 0 = player's #1)
  // correctOrder: array of item indices sorted by rankValue desc (index 0 = correct #1)
  let total = 0;
  for (let slot = 0; slot < 10; slot++) {
    const itemIdx = playerRanking[slot];
    const correctSlot = correctOrder.indexOf(itemIdx);
    total += Math.abs(slot - correctSlot);
  }
  return total;
}

// Cleanup expired rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_EXPIRY) {
      rooms.delete(code);
    }
  }
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════════
// GAME LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

function startRound(room) {
  const catKey = room.categories[room.round];
  const cat = C[catKey];

  // Pick 10 random items
  const shuffled = shuffle(cat.items).slice(0, 10);

  // Correct order: sort by rankValue descending
  const withIdx = shuffled.map((item, i) => ({ item, idx: i }));
  withIdx.sort((a, b) => b.item[4] - a.item[4]);
  room.correctOrder = withIdx.map(x => x.idx);

  // Items for client (no rankValue)
  room.currentItems = shuffled.map(stripRankValue);
  room.submissions = {};
  room.phase = 'playing';
  room.lastActivity = Date.now();

  // Send to both players
  const payload = {
    round: room.round,
    totalRounds: ROUNDS,
    categoryName: cat.name,
    categoryEmoji: cat.emoji,
    criterion: cat.criterion,
    criterionDesc: cat.criterionDesc,
    items: room.currentItems,
  };

  for (const p of room.players) {
    if (p.connected) {
      io.to(p.id).emit('round_start', payload);
    }
  }
}

function processSubmissions(room) {
  const p0ranking = room.submissions[room.players[0].id];
  const p1ranking = room.submissions[room.players[1].id];

  const p0dev = computeDeviation(p0ranking, room.correctOrder);
  const p1dev = computeDeviation(p1ranking, room.correctOrder);

  room.scores[0].deviations.push(p0dev);
  room.scores[1].deviations.push(p1dev);

  let roundWinner = -1; // -1 = tie
  if (p0dev < p1dev) {
    room.scores[0].roundsWon++;
    roundWinner = 0;
  } else if (p1dev < p0dev) {
    room.scores[1].roundsWon++;
    roundWinner = 1;
  }

  room.phase = 'round_result';
  room.readyNext = new Set();
  room.lastActivity = Date.now();

  // Build correct ranking with names for display
  const correctItems = room.correctOrder.map(idx => room.currentItems[idx]);

  // Build player rankings with names
  const p0items = p0ranking.map(idx => room.currentItems[idx]);
  const p1items = p1ranking.map(idx => room.currentItems[idx]);

  // Per-item deviations
  const p0itemDevs = p0ranking.map((itemIdx, slot) => Math.abs(slot - room.correctOrder.indexOf(itemIdx)));
  const p1itemDevs = p1ranking.map((itemIdx, slot) => Math.abs(slot - room.correctOrder.indexOf(itemIdx)));

  const result = {
    round: room.round,
    totalRounds: ROUNDS,
    correct: correctItems,
    p0Ranking: p0items,
    p1Ranking: p1items,
    p0Deviation: p0dev,
    p1Deviation: p1dev,
    p0ItemDevs: p0itemDevs,
    p1ItemDevs: p1itemDevs,
    roundWinner,
    scores: [
      { roundsWon: room.scores[0].roundsWon, deviations: room.scores[0].deviations },
      { roundsWon: room.scores[1].roundsWon, deviations: room.scores[1].deviations },
    ],
    playerNames: [room.players[0].name, room.players[1].name],
  };

  // If this was the last round, add final result
  if (room.round >= ROUNDS - 1) {
    room.phase = 'final';
    let overallWinner = -1;
    if (room.scores[0].roundsWon > room.scores[1].roundsWon) overallWinner = 0;
    else if (room.scores[1].roundsWon > room.scores[0].roundsWon) overallWinner = 1;
    result.isFinal = true;
    result.overallWinner = overallWinner;
  }

  for (const p of room.players) {
    if (p.connected) {
      io.to(p.id).emit('round_result', { ...result, yourIndex: room.players.indexOf(p) });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {

  // ── Create Room ──────────────────────────────────────────────────────
  socket.on('create_room', ({ playerName }) => {
    const code = generateCode();
    const token = generateToken();

    const room = {
      code,
      players: [{ id: socket.id, name: playerName || 'Spieler 1', token, connected: true }],
      phase: 'lobby',
      round: 0,
      categories: pickCategories(),
      currentItems: [],
      correctOrder: [],
      submissions: {},
      scores: [
        { roundsWon: 0, deviations: [] },
        { roundsWon: 0, deviations: [] },
      ],
      readyNext: new Set(),
      disconnectTimers: {},
      lastActivity: Date.now(),
    };

    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.playerToken = token;

    socket.emit('room_created', { code, token, playerName: playerName || 'Spieler 1' });
  });

  // ── Join Room ────────────────────────────────────────────────────────
  socket.on('join_room', ({ code, playerName }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('error_msg', { message: 'Raum nicht gefunden' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error_msg', { message: 'Raum ist voll' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('error_msg', { message: 'Spiel bereits gestartet' });
      return;
    }

    const token = generateToken();
    room.players.push({ id: socket.id, name: playerName || 'Spieler 2', token, connected: true });
    room.lastActivity = Date.now();

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerToken = token;

    // Notify both players
    const names = room.players.map(p => p.name);
    room.players.forEach((p, i) => {
      io.to(p.id).emit('room_joined', { players: names, yourIndex: i, token: p.token });
    });

    // Start first round after short delay
    setTimeout(() => {
      if (room.players.length === 2 && room.phase === 'lobby') {
        startRound(room);
      }
    }, 3000);
  });

  // ── Submit Ranking ───────────────────────────────────────────────────
  socket.on('submit_ranking', ({ ranking }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'playing') return;

    // Validate ranking
    if (!Array.isArray(ranking) || ranking.length !== 10) return;
    const valid = ranking.every(idx => typeof idx === 'number' && idx >= 0 && idx < 10);
    if (!valid) return;
    if (new Set(ranking).size !== 10) return; // all unique

    room.submissions[socket.id] = ranking;
    room.lastActivity = Date.now();

    // Notify opponent
    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent && opponent.connected) {
      io.to(opponent.id).emit('opponent_done');
    }

    // Check if both submitted
    const bothSubmitted = room.players.every(p => room.submissions[p.id]);
    if (bothSubmitted) {
      processSubmissions(room);
    }
  });

  // ── Ready for Next Round ─────────────────────────────────────────────
  socket.on('ready_next', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'round_result') return;

    room.readyNext.add(socket.id);
    room.lastActivity = Date.now();

    // Check if both ready
    const bothReady = room.players.every(p => room.readyNext.has(p.id));
    if (bothReady && room.round < ROUNDS - 1) {
      room.round++;
      startRound(room);
    }
  });

  // ── Reconnect ────────────────────────────────────────────────────────
  socket.on('reconnect_attempt', ({ token }) => {
    for (const [code, room] of rooms) {
      const player = room.players.find(p => p.token === token);
      if (player) {
        // Restore connection
        const oldId = player.id;
        player.id = socket.id;
        player.connected = true;
        socket.join(code);
        socket.roomCode = code;
        socket.playerToken = token;

        // Clear disconnect timer
        if (room.disconnectTimers[oldId]) {
          clearTimeout(room.disconnectTimers[oldId]);
          delete room.disconnectTimers[oldId];
        }

        // Notify opponent
        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent && opponent.connected) {
          io.to(opponent.id).emit('opponent_reconnected');
        }

        // Send current state
        const playerIdx = room.players.indexOf(player);
        const names = room.players.map(p => p.name);

        if (room.phase === 'playing') {
          const catKey = room.categories[room.round];
          const cat = C[catKey];
          socket.emit('reconnect_state', {
            phase: 'playing',
            yourIndex: playerIdx,
            players: names,
            round: room.round,
            totalRounds: ROUNDS,
            categoryName: cat.name,
            categoryEmoji: cat.emoji,
            criterion: cat.criterion,
            criterionDesc: cat.criterionDesc,
            items: room.currentItems,
            alreadySubmitted: !!room.submissions[socket.id],
          });
        } else if (room.phase === 'round_result') {
          socket.emit('reconnect_state', { phase: 'waiting', yourIndex: playerIdx, players: names });
        } else if (room.phase === 'lobby') {
          socket.emit('reconnect_state', { phase: 'lobby', yourIndex: playerIdx, players: names, code });
        }
        return;
      }
    }
    socket.emit('error_msg', { message: 'Sitzung nicht gefunden' });
  });

  // ── Play Again ───────────────────────────────────────────────────────
  socket.on('play_again', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'final') return;

    room.readyNext.add(socket.id);
    room.lastActivity = Date.now();

    const bothReady = room.players.every(p => room.readyNext.has(p.id));
    if (bothReady) {
      // Reset game
      room.round = 0;
      room.categories = pickCategories();
      room.scores = [
        { roundsWon: 0, deviations: [] },
        { roundsWon: 0, deviations: [] },
      ];
      room.readyNext = new Set();
      startRound(room);
    } else {
      // Notify opponent
      const opponent = room.players.find(p => p.id !== socket.id);
      if (opponent && opponent.connected) {
        io.to(opponent.id).emit('opponent_wants_rematch');
      }
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.connected = false;

    // Notify opponent
    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent && opponent.connected) {
      io.to(opponent.id).emit('opponent_disconnected');
    }

    // Start reconnect timeout
    room.disconnectTimers[socket.id] = setTimeout(() => {
      // Player didn't reconnect — opponent wins by forfeit
      if (opponent && opponent.connected) {
        io.to(opponent.id).emit('opponent_forfeit');
      }
      // Clean up room if both disconnected
      const allDisconnected = room.players.every(p => !p.connected);
      if (allDisconnected) {
        rooms.delete(room.code);
      }
    }, RECONNECT_TIMEOUT);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`🎮 Top 10 Game Server running on http://localhost:${PORT}`);
});
