const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静的ファイルを提供
app.use(express.static(__dirname));

// ルーム管理
const rooms = new Map();

// ルームコード生成（6桁の英数字）
function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// プレイヤーID生成
function generatePlayerId() {
  return Math.random().toString(36).substring(2, 15);
}

// WebSocket接続処理
wss.on("connection", (ws) => {
  console.log("New client connected");
  ws.playerId = generatePlayerId();

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (error) {
      console.error("Error parsing message:", error);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    handleDisconnect(ws);
  });
});

function handleMessage(ws, data) {
  switch (data.type) {
    case "create_room":
      createRoom(ws, data);
      break;
    case "join_room":
      joinRoom(ws, data);
      break;
    case "leave_room":
      leaveRoom(ws);
      break;
    case "toggle_ready":
      toggleReady(ws);
      break;
    case "game_update":
      broadcastGameUpdate(ws, data);
      break;
    case "send_garbage":
      sendGarbage(ws, data);
      break;
    case "update_settings":
      updateSettings(ws, data);
      break;
    case "game_over":
      handleGameOver(ws);
      break;
  }
}

function updateSettings(ws, data) {
  if (!ws.roomCode || !ws.isHost) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  if (data.settings) {
    room.settings = { ...room.settings, ...data.settings };
    broadcastRoomState(room);
  }
}

function createRoom(ws, data) {
  let roomCode;
  do {
    roomCode = generateRoomCode();
  } while (rooms.has(roomCode));

  const room = {
    code: roomCode,
    host: ws,
    players: [ws],
    playerStates: new Map(),
    gameStarted: false,
    alivePlayers: [],
    settings: {
      garbageRate: 1.0,
      dropSpeed: 500,
      defeatTime: 10,
    },
  };

  room.playerStates.set(ws.playerId, {
    id: ws.playerId,
    ready: false,
    alive: true,
    name: `Player ${room.players.length}`,
  });

  rooms.set(roomCode, room);
  ws.roomCode = roomCode;
  ws.isHost = true;

  ws.send(
    JSON.stringify({
      type: "room_created",
      roomCode: roomCode,
      playerId: ws.playerId,
    }),
  );

  broadcastRoomState(room);

  console.log(`Room created: ${roomCode}`);
}

function joinRoom(ws, data) {
  const room = rooms.get(data.roomCode);

  if (!room) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "ルームが見つかりません",
      }),
    );
    return;
  }

  if (room.gameStarted) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "ゲームは既に開始しています",
      }),
    );
    return;
  }

  room.players.push(ws);
  room.playerStates.set(ws.playerId, {
    id: ws.playerId,
    ready: false,
    alive: true,
    name: `Player ${room.players.length}`,
  });

  ws.roomCode = data.roomCode;
  ws.isHost = false;

  ws.send(
    JSON.stringify({
      type: "room_joined",
      roomCode: data.roomCode,
      playerId: ws.playerId,
    }),
  );

  broadcastRoomState(room);

  console.log(
    `Player joined room: ${data.roomCode} (Total: ${room.players.length})`,
  );
}

function toggleReady(ws) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room || room.gameStarted) return;

  const playerState = room.playerStates.get(ws.playerId);
  if (!playerState) return;

  playerState.ready = !playerState.ready;

  broadcastRoomState(room);

  // 全員準備完了チェック
  const allReady = Array.from(room.playerStates.values()).every((p) => p.ready);
  if (allReady && room.players.length >= 2) {
    startGame(room);
  }
}

function startGame(room) {
  room.gameStarted = true;
  room.alivePlayers = room.players.map((p) => p.playerId);

  // 全プレイヤーの状態をリセット
  room.playerStates.forEach((state) => {
    state.alive = true;
    state.ready = false;
  });

  const startMessage = JSON.stringify({
    type: "game_start",
    players: Array.from(room.playerStates.values()),
    settings: room.settings,
  });

  room.players.forEach((player) => {
    player.send(startMessage);
  });

  console.log(
    `Game started in room: ${room.code} with ${room.players.length} players`,
  );
}

function leaveRoom(ws) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  // プレイヤーをルームから削除
  room.players = room.players.filter((p) => p.playerId !== ws.playerId);
  room.playerStates.delete(ws.playerId);
  room.alivePlayers = room.alivePlayers.filter((id) => id !== ws.playerId);

  if (ws.isHost && room.players.length > 0) {
    // 新しいホストを選出
    room.host = room.players[0];
    room.host.isHost = true;
    room.host.send(
      JSON.stringify({
        type: "you_are_host",
      }),
    );
  }

  if (room.players.length === 0) {
    // ルームを削除
    rooms.delete(ws.roomCode);
    console.log(`Room deleted: ${ws.roomCode}`);
  } else {
    broadcastRoomState(room);

    // ゲーム中の場合、生存者チェック
    if (room.gameStarted) {
      checkGameEnd(room);
    }
  }

  console.log(`Player left room: ${ws.roomCode}`);
}

function handleDisconnect(ws) {
  leaveRoom(ws);
}

function broadcastRoomState(room) {
  const state = {
    type: "room_state",
    players: Array.from(room.playerStates.values()),
    hostId: room.host.playerId,
    players: Array.from(room.playerStates.values()),
    hostId: room.host.playerId,
    gameStarted: room.gameStarted,
    settings: room.settings,
  };

  const message = JSON.stringify(state);
  room.players.forEach((player) => {
    player.send(message);
  });
}

function broadcastGameUpdate(ws, data) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  // 全プレイヤーに状態を送信
  room.players.forEach((player) => {
    if (player.playerId !== ws.playerId) {
      player.send(
        JSON.stringify({
          type: "opponent_update",
          playerId: ws.playerId,
          data: data.gameState,
        }),
      );
    }
  });
}

function sendGarbage(ws, data) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  // 攻撃対象を決定（ランダムに生きているプレイヤー）
  const aliveOpponents = room.alivePlayers.filter((id) => id !== ws.playerId);
  if (aliveOpponents.length === 0) return;

  const targetId =
    aliveOpponents[Math.floor(Math.random() * aliveOpponents.length)];
  const targetPlayer = room.players.find((p) => p.playerId === targetId);

  if (targetPlayer) {
    targetPlayer.send(
      JSON.stringify({
        type: "receive_garbage",
        fromPlayerId: ws.playerId,
        amount: data.amount,
        colors: data.colors,
        sourcePositions: data.positions,
      }),
    );
  }
}

function handleGameOver(ws) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  const playerState = room.playerStates.get(ws.playerId);
  if (playerState) {
    playerState.alive = false;
  }

  room.alivePlayers = room.alivePlayers.filter((id) => id !== ws.playerId);

  // 全プレイヤーに敗北を通知
  room.players.forEach((player) => {
    player.send(
      JSON.stringify({
        type: "player_defeated",
        playerId: ws.playerId,
      }),
    );
  });

  checkGameEnd(room);
}

function checkGameEnd(room) {
  if (room.alivePlayers.length === 1) {
    // 勝者決定
    const winnerId = room.alivePlayers[0];

    room.players.forEach((player) => {
      player.send(
        JSON.stringify({
          type: "game_end",
          winnerId: winnerId,
          isWinner: player.playerId === winnerId,
        }),
      );
    });

    // ゲームをリセット
    setTimeout(() => {
      room.gameStarted = false;
      room.alivePlayers = [];
      room.playerStates.forEach((state) => {
        state.ready = false;
        state.alive = true;
      });
      broadcastRoomState(room);
    }, 3000);
  } else if (room.alivePlayers.length === 0) {
    // 引き分け（全員同時に敗北）
    room.players.forEach((player) => {
      player.send(
        JSON.stringify({
          type: "game_end",
          winnerId: null,
          isWinner: false,
        }),
      );
    });

    setTimeout(() => {
      room.gameStarted = false;
      room.alivePlayers = [];
      room.playerStates.forEach((state) => {
        state.ready = false;
        state.alive = true;
      });
      broadcastRoomState(room);
    }, 3000);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
