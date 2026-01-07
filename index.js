const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const SCALES = require("./scales");

// roomCode -> {
//   players: Map(socketId -> name),
//   hostId: string|null,
//   game: {
//     phase: "lobby" | "write" | "guess" | "over",
//     writeEndsAt: number|null,
//     writeDurationMs: number|null,
//     writeTimerId: NodeJS.Timeout|null,
//     assignments: Map(socketId -> Array<{promptId, scale, target}>),
//     clues: Map(promptId -> { authorId, scale, target, clueText }>
//     guessOrder: string[],
//     currentIndex: number,
//     score: number,
//     maxScore: number,
//     guessValue: number,
//     revealed: boolean,
//     readyVoters: Set<string>,
//   } | null
// }
const rooms = new Map();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("Backend OK. Probá /health"));
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}
function normalizeName(name) {
  const n = String(name || "").trim();
  return n.length ? n : "Jugador";
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sampleWithoutRepeat(arr, n) {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}
function getScalesPerPlayer(playerCount) {
  if (playerCount <= 4) return 3;
  if (playerCount <= 7) return 2;
  return 1;
}

// ✅ NUEVO scoring más estricto: 3 / 8 / 14 / 22
function scoreFromDistance(d) {
  if (d <= 3) return 4;
  if (d <= 8) return 3;
  if (d <= 14) return 2;
  if (d <= 22) return 1;
  return 0;
}

function getTotalPrompts(game) {
  if (!game?.assignments) return 0;
  return Array.from(game.assignments.values()).reduce((acc, a) => acc + a.length, 0);
}

// Timer proporcional a #pistas
function computeWriteDurationMs(totalPrompts) {
  // 45s por pista (ajustable)
  const perPrompt = 45_000;
  const min = 2 * 60_000; // 2 min
  const max = 8 * 60_000; // 8 min
  const raw = totalPrompts * perPrompt;
  return Math.min(max, Math.max(min, raw));
}

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const phase = room.game?.phase || "lobby";
  const payload = {
    roomCode,
    hostId: room.hostId,
    players: Array.from(room.players.entries()).map(([id, name]) => ({ id, name })),
    phase,

    score: phase !== "lobby" ? room.game?.score || 0 : 0,
    maxScore: room.game?.maxScore ?? null,

    // WRITE
    writeEndsAt: phase === "write" ? room.game.writeEndsAt : null,
    writeDurationMs: phase === "write" ? room.game.writeDurationMs : null,
    readyCount: phase === "write" ? room.game.clues.size : 0,
    totalPrompts: phase === "write" ? getTotalPrompts(room.game) : 0,

    // GUESS
    guessIndex: phase === "guess" ? room.game.currentIndex : 0,
    guessTotal: phase === "guess" ? room.game.guessOrder.length : 0,
  };

  io.to(roomCode).emit("room:state", payload);
}

function emitGuessPrompt(roomCode) {
  const room = rooms.get(roomCode);
  if (!room?.game || room.game.phase !== "guess") return;

  const promptId = room.game.guessOrder[room.game.currentIndex];
  const clue = room.game.clues.get(promptId);
  if (!clue) return;

  room.game.guessValue = 50;
  room.game.revealed = false;
  room.game.readyVoters = new Set();

  const authorName = room.players.get(clue.authorId) || "Jugador";

  io.to(roomCode).emit("guess:prompt", {
    roomCode,
    promptId,
    index: room.game.currentIndex + 1,
    total: room.game.guessOrder.length,
    score: room.game.score,
    scale: clue.scale,
    clueText: clue.clueText,
    authorId: clue.authorId,
    authorName,
  });

  io.to(roomCode).emit("guess:state", {
    promptId,
    guessValue: room.game.guessValue,
    by: null,
  });

  const requiredCount = Math.max(0, room.players.size - 1);
  io.to(roomCode).emit("guess:ready_state", {
    promptId,
    readyCount: 0,
    requiredCount,
    readyIds: [],
  });
}

function startGuessPhase(roomCode, reason = "all_ready") {
  const room = rooms.get(roomCode);
  if (!room?.game) return;

  if (room.game.writeTimerId) {
    clearTimeout(room.game.writeTimerId);
    room.game.writeTimerId = null;
  }
  room.game.writeEndsAt = null;
  room.game.writeDurationMs = null;

  const clueIds = Array.from(room.game.clues.keys());
  if (clueIds.length === 0) {
    room.game.phase = "over";
    room.game.score = 0;
    room.game.maxScore = 0;
    io.to(roomCode).emit("game:over", { score: 0, maxScore: 0, reason: "no_clues" });
    emitRoomState(roomCode);
    return;
  }

  room.game.phase = "guess";
  room.game.guessOrder = shuffle(clueIds);
  room.game.currentIndex = 0;
  room.game.score = 0;
  room.game.maxScore = clueIds.length * 4;

  io.to(roomCode).emit("phase:guess", { roomCode, reason });
  emitRoomState(roomCode);
  emitGuessPrompt(roomCode);
}

function resetToLobby(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.game?.writeTimerId) clearTimeout(room.game.writeTimerId);
  room.game = null;

  io.to(roomCode).emit("phase:lobby", { roomCode });
  emitRoomState(roomCode);
}

function startWritePhase(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const playerIds = Array.from(room.players.keys());
  const perPlayer = getScalesPerPlayer(playerIds.length);

  const assignments = new Map();
  const clues = new Map();

  for (const pid of playerIds) {
    const pickedScales = sampleWithoutRepeat(SCALES, perPlayer);
    const list = pickedScales.map((scale) => {
      const promptId = `${roomCode}-${pid}-${scale.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const target = randInt(8, 92);
      return { promptId, scale, target };
    });

    assignments.set(pid, list);

    io.to(pid).emit("write:assignments", {
      roomCode,
      prompts: list.map((p) => ({ promptId: p.promptId, scale: p.scale, target: p.target })),
    });
  }

  const totalPrompts = Array.from(assignments.values()).reduce((acc, a) => acc + a.length, 0);
  const writeDurationMs = computeWriteDurationMs(totalPrompts);

  const now = Date.now();
  const writeEndsAt = now + writeDurationMs;

  const writeTimerId = setTimeout(() => {
    const r = rooms.get(roomCode);
    if (!r?.game || r.game.phase !== "write") return;
    startGuessPhase(roomCode, "timer");
  }, writeDurationMs);

  room.game = {
    phase: "write",
    writeEndsAt,
    writeDurationMs,
    writeTimerId,
    assignments,
    clues,
    guessOrder: [],
    currentIndex: 0,
    score: 0,
    maxScore: null,
    guessValue: 50,
    revealed: false,
    readyVoters: new Set(),
  };

  io.to(roomCode).emit("game:started", { roomCode, phase: "write", writeEndsAt, writeDurationMs });
  emitRoomState(roomCode);
}

io.on("connection", (socket) => {
  console.log("✅ connected:", socket.id);

  socket.on("room:join", ({ roomCode, name }) => {
    const code = normalizeRoomCode(roomCode);
    const playerName = normalizeName(name);
    if (!code) return;

    socket.join(code);

    if (!rooms.has(code)) {
      rooms.set(code, { players: new Map(), hostId: socket.id, game: null });
    }

    const room = rooms.get(code);
    room.players.set(socket.id, playerName);

    emitRoomState(code);
  });

  socket.on("game:start", ({ roomCode }) => {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    startWritePhase(code);
  });

  socket.on("write:submit", ({ roomCode, promptId, clueText }) => {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room?.game || room.game.phase !== "write") return;

    const myPrompts = room.game.assignments.get(socket.id);
    if (!myPrompts) return;

    const found = myPrompts.find((p) => p.promptId === promptId);
    if (!found) return;

    const text = String(clueText || "").trim();
    if (!text) return;

    room.game.clues.set(promptId, {
      authorId: socket.id,
      scale: found.scale,
      target: found.target,
      clueText: text,
    });

    socket.emit("write:ack", { promptId });
    emitRoomState(code);

    const totalPrompts = getTotalPrompts(room.game);
    if (room.game.clues.size >= totalPrompts) {
      startGuessPhase(code, "all_ready");
    }
  });

  socket.on("guess:update", ({ roomCode, promptId, guessValue }) => {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room?.game || room.game.phase !== "guess") return;
    if (room.game.revealed) return;

    const currentPromptId = room.game.guessOrder[room.game.currentIndex];
    if (!currentPromptId || promptId !== currentPromptId) return;

    const clue = room.game.clues.get(promptId);
    if (!clue) return;
    if (socket.id === clue.authorId) return;

    const v = Math.max(0, Math.min(100, Number(guessValue)));
    if (Number.isNaN(v)) return;

    room.game.guessValue = v;
    io.to(code).emit("guess:state", { promptId, guessValue: v, by: socket.id });
  });

  socket.on("guess:ready", ({ roomCode, promptId }) => {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room?.game || room.game.phase !== "guess") return;
    if (room.game.revealed) return;

    const currentPromptId = room.game.guessOrder[room.game.currentIndex];
    if (!currentPromptId || promptId !== currentPromptId) return;

    const clue = room.game.clues.get(promptId);
    if (!clue) return;

    if (socket.id === clue.authorId) return;

    room.game.readyVoters.add(socket.id);

    const requiredCount = Math.max(0, room.players.size - 1);
    const readyIds = Array.from(room.game.readyVoters);

    io.to(code).emit("guess:ready_state", {
      promptId,
      readyCount: readyIds.length,
      requiredCount,
      readyIds,
    });

    if (readyIds.length >= requiredCount) {
      const g = room.game.guessValue;
      const distance = Math.abs(g - clue.target);
      const points = scoreFromDistance(distance);

      room.game.score += points;
      room.game.revealed = true;

      io.to(code).emit("guess:reveal", {
        promptId,
        guess: g,
        target: clue.target,
        distance,
        points,
        totalScore: room.game.score,
      });

      emitRoomState(code);
    }
  });

  socket.on("guess:next", ({ roomCode }) => {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room?.game || room.game.phase !== "guess") return;
    if (socket.id !== room.hostId) return;
    if (!room.game.revealed) return;

    room.game.currentIndex += 1;

    if (room.game.currentIndex >= room.game.guessOrder.length) {
      room.game.phase = "over";
      io.to(code).emit("game:over", {
        score: room.game.score,
        maxScore: room.game.maxScore ?? 0,
        reason: "finished",
      });
      emitRoomState(code);
      return;
    }

    emitRoomState(code);
    emitGuessPrompt(code);
  });

  socket.on("game:to_lobby", ({ roomCode }) => {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    resetToLobby(code);
  });

  socket.on("game:restart", ({ roomCode }) => {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    startWritePhase(code);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      if (!room.players.has(socket.id)) continue;

      room.players.delete(socket.id);

      if (room.game?.assignments?.has(socket.id)) {
        const prompts = room.game.assignments.get(socket.id);
        room.game.assignments.delete(socket.id);
        if (prompts?.length) for (const p of prompts) room.game.clues.delete(p.promptId);
      }

      if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value || null;
      }

      if (room.players.size === 0) {
        if (room.game?.writeTimerId) clearTimeout(room.game.writeTimerId);
        rooms.delete(code);
        continue;
      }

      emitRoomState(code);
    }

    console.log("❌ disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 server listening on http://localhost:${PORT}`);
});
