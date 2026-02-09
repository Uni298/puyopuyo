const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const discordBot = require("./discord_bot"); // Import Bot
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静的ファイルを提侁E
app.use(express.static(__dirname));

// ルーム管琁E
const rooms = new Map();


function generateRoomCode() {
  const chars = "0123456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}


function generatePlayerId() {
  return Math.random().toString(36).substring(2, 15);
}

// ハートビート間隔 (30秒)
const HEARTBEAT_INTERVAL = 30000;

function noop() {}

function heartbeat() {
  this.isAlive = true;
}

// WebSocket接続処理
wss.on('connection', (ws) => {
  console.log("New client connected");
  ws.playerId = generatePlayerId();
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  // クライアントからのメッセージ処理
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // クライアントからのPONG相当のメッセージがあれば処理
      if (data.type === 'pong') {
          ws.isAlive = true;
          return;
      }

      handleMessage(ws, data);
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  // 切断時の処理
  ws.on('close', () => {
    console.log("Client disconnected");
    handleDisconnect(ws); // Keep original disconnect logic
    if (ws.roomCode) {
      leaveRoom(ws);
    }
  });
});

// 定期的にPingを送信して生存確認
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping(noop);
    // ブラウザのWS実装によってはpingフレームを直接扱えない場合があるので、
    // アプリケーションレベルのpingも送っておく
    ws.send(JSON.stringify({ type: 'ping' }));
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
  clearInterval(interval);
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
    case "piece_update":
      if (ws.roomCode) {
        const room = rooms.get(ws.roomCode);
        if (room) {
          room.players.forEach((player) => {
            if (player.playerId !== ws.playerId) {
              player.send(
                JSON.stringify({
                  type: "piece_update",
                  playerId: ws.playerId,
                  data: data.data,
                }),
              );
            }
          });
        }
      }
      break;
    case "hard_drop_animation":
      if (ws.roomCode) {
        const room = rooms.get(ws.roomCode);
        if (room) {
          room.players.forEach((player) => {
            if (player.playerId !== ws.playerId) {
              player.send(
                JSON.stringify({
                  type: "hard_drop_animation",
                  playerId: ws.playerId,
                  data: data.data,
                }),
              );
            }
          });
        }
      }
      break;
    case "clear_animation":
      if (ws.roomCode) {
        const room = rooms.get(ws.roomCode);
        if (room) {
          room.players.forEach((player) => {
            if (player.playerId !== ws.playerId) {
              player.send(
                JSON.stringify({
                  type: "clear_animation",
                  playerId: ws.playerId,
                  data: data.data,
                }),
              );
            }
          });
        }
      }
      break;
    case "chat_message":
      if (ws.roomCode) {
        const room = rooms.get(ws.roomCode);
        if (room) {
          const playerState = room.playerStates.get(ws.playerId);
          const playerName = playerState ? playerState.name : "Unknown";
          
          // Discordに送信
          discordBot.sendChatMessage(ws.roomCode, playerName, data.message);

          room.players.forEach((player) => {
            player.send(
              JSON.stringify({
                type: "chat_message",
                playerName: playerName,
                message: data.message,
              }),
            );
          });
        }
      }
      break;
    case "update_settings":
      updateSettings(ws, data);
      break;
    case "game_over":
      handleGameOver(ws);
      break;
    case 'leave_room':
      handleLeaveRoom(ws);
      break;
    case 'game_reset':
      // ... (existing)
      break;
    case "return_to_lobby":
      handleReturnToLobby(ws);
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
    playerTargets: new Map(),
    settings: {
      garbageRate: 1.0,
      dropSpeed: 500,
      defeatTime: 10,
      garbageDelay: 3,
      garbagePrediction: true, // デフォルトでON
    },
  };

  const playerName = data.playerName || `Player 1`;
  room.playerStates.set(ws.playerId, {
    id: ws.playerId,
    ready: false,
    alive: true,
    name: playerName,
    score: 0,
    isSpectator: false,
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
    // ゲーム中の場合�E観戦モードで参加
    room.players.push(ws);
    const playerName = data.playerName || `Spectator ${room.players.length}`;
    room.playerStates.set(ws.playerId, {
      id: ws.playerId,
      ready: false,
      alive: false,
      name: playerName,
      score: 0,
      isSpectator: true,
    });

    ws.roomCode = data.roomCode;
    ws.isHost = false;
    ws.isSpectator = true;

    ws.send(
      JSON.stringify({
        type: "spectator_mode",
        roomCode: data.roomCode,
        playerId: ws.playerId,
        players: Array.from(room.playerStates.values()),
      }),
    );

    console.log(`Spectator joined room: ${data.roomCode}`);
    return;
  }

  room.players.push(ws);
  const playerName = data.playerName || `Player ${room.players.length}`;
  room.playerStates.set(ws.playerId, {
    id: ws.playerId,
    ready: false,
    alive: true,
    name: playerName,
    score: 0,
    isSpectator: false,
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
  discordBot.updateRoomInfo(data.roomCode);
}

function toggleReady(ws) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room || room.gameStarted) return;

  const playerState = room.playerStates.get(ws.playerId);
  if (!playerState) return;

  playerState.ready = !playerState.ready;

  broadcastRoomState(room);
  discordBot.updateRoomInfo(ws.roomCode);
 
  const allReady = Array.from(room.playerStates.values())
    .filter(p => !p.isSpectator)
    .every(p => p.ready);

  if (allReady && room.players.length >= 2) {
    startGame(room);
  }
}

function startGame(room) {
  if (room.resetTimeout) {
    clearTimeout(room.resetTimeout);
    room.resetTimeout = null;
  }
  room.gameStarted = true;
  room.alivePlayers = room.players.map((p) => p.playerId);


  room.playerStates.forEach((state) => {
    if (!state.isSpectator) {
      state.alive = true;
      state.ready = false;
      state.score = 0;
    }
  });


  if (!room.playerTargets) {
    room.playerTargets = new Map();
  } else {
    room.playerTargets.clear();
  }


  const seed = Math.floor(Math.random() * 1000000);

  const startMessage = JSON.stringify({
    type: "game_start",
    players: Array.from(room.playerStates.values()),
    settings: room.settings,
    seed: seed,
  });

  room.players.forEach((player) => {
    player.send(startMessage);
  });

  console.log(
    `Game started in room: ${room.code} with ${room.players.length} players`,
  );
  discordBot.updateRoomInfo(room.code);
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

    room.host = room.players[0];
    room.host.isHost = true;
    room.host.send(
      JSON.stringify({
        type: "you_are_host",
      }),
    );
  }

  if (room.players.length === 0) {

    rooms.delete(ws.roomCode);
    console.log(`Room deleted: ${ws.roomCode}`);
    discordBot.onRoomClosed(ws.roomCode);
  } else {
    broadcastRoomState(room);

    if (room.gameStarted) {
      checkGameEnd(room);
    }
  }

  console.log(`Player left room: ${ws.roomCode}`);
  discordBot.updateRoomInfo(ws.roomCode);
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

  // スコアを更新
  if (data.score !== undefined) {
    const playerState = room.playerStates.get(ws.playerId);
    if (playerState) {
      playerState.score = data.score;
    }
  }

  room.players.forEach((player) => {
    if (player.playerId !== ws.playerId) {
      player.send(
        JSON.stringify({
          type: "opponent_update",
          playerId: ws.playerId,
          data: data.gameState,
          garbageCount: data.garbageCount || 0,
          score: data.score // 相手にもスコアを送る（表示用）
        }),
      );
    }
  });
}

function sendGarbage(ws, data) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  let targetId;

  if (data.lockTarget && data.currentTarget) {

    if (room.alivePlayers.includes(data.currentTarget)) {
      targetId = data.currentTarget;
    }
  }

  if (!targetId) {
    const aliveOpponents = room.alivePlayers.filter((id) => id !== ws.playerId);
    if (aliveOpponents.length === 0) return;

    targetId =
      aliveOpponents[Math.floor(Math.random() * aliveOpponents.length)];
  }

  // ターゲチE��を記録
  room.playerTargets.set(ws.playerId, targetId);

  const targetPlayer = room.players.find((p) => p.playerId === targetId);

  if (targetPlayer) {
    // ターゲチE��に送信
    targetPlayer.send(
      JSON.stringify({
        type: "receive_garbage",
        fromPlayerId: ws.playerId,
        amount: data.amount,
        colors: data.colors,
        sourcePositions: data.positions,
      }),
    );

    // 攻撁E�E�E��E刁E��に送信通知を送る�E�アニメーション用�E�E
    ws.send(
      JSON.stringify({
        type: "attack_ack",
        targetId: targetId,
        amount: data.amount,
        sourcePositions: data.positions,
      }),
    );

    
    room.players.forEach((player) => {
      if (player.playerId !== ws.playerId && player.playerId !== targetId) {
        player.send(
          JSON.stringify({
            type: "third_party_attack",
            fromPlayerId: ws.playerId,
            toPlayerId: targetId,
            amount: data.amount,
            sourcePositions: data.positions,
          }),
        );
      }
    });
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


  room.players.forEach((player) => {
    player.send(
      JSON.stringify({
        type: "player_defeated",
        playerId: ws.playerId,
      }),
    );
  });

  checkGameEnd(room);
  discordBot.updateRoomInfo(ws.roomCode);
}

function checkGameEnd(room) {
  if (room.alivePlayers.length === 1) {

    const winnerId = room.alivePlayers[0];


    const playerScores = Array.from(room.playerStates.values())
      .filter((p) => !p.isSpectator)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((p, index) => ({
        id: p.id,
        name: p.name,
        score: p.score || 0,
        rank: index + 1,
        isWinner: p.id === winnerId,
      }));

    room.players.forEach((player) => {
      player.send(
        JSON.stringify({
          type: "game_end",
          winnerId: winnerId,
          isWinner: player.playerId === winnerId,
          scoreboard: playerScores,
        }),
      );
    });

    // Discord Bot Notification
    const winnerName = room.playerStates.get(winnerId)?.name || 'Unknown';
    // We need roomCode. Assuming it's added to room object or we search.
    // I will add code to room object in createRoom later if needed.
    if (room.code) {
        discordBot.notifyGameEnd(room.code, winnerName);
    }


    if (room.resetTimeout) clearTimeout(room.resetTimeout);
    room.resetTimeout = setTimeout(() => {
      room.gameStarted = false;
      room.alivePlayers = [];
      room.playerStates.forEach((state) => {
        if (!state.isSpectator) {
          state.ready = false;
          state.alive = true;
          state.score = 0;
        }
      });
      if (room.playerTargets) {
        room.playerTargets.clear();
      }
      room.resetTimeout = null;
      broadcastRoomState(room);
      discordBot.updateRoomInfo(room.code);
    }, 3000);
  } else if (room.alivePlayers.length === 0) {

    const playerScores = Array.from(room.playerStates.values())
      .filter((p) => !p.isSpectator)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((p, index) => ({
        id: p.id,
        name: p.name,
        score: p.score || 0,
        rank: index + 1,
        isWinner: false,
      }));

    room.players.forEach((player) => {
      player.send(
        JSON.stringify({
          type: "game_end",
          winnerId: null,
          isWinner: false,
          scoreboard: playerScores,
        }),
      );
    });

    if (room.resetTimeout) clearTimeout(room.resetTimeout);
    room.resetTimeout = setTimeout(() => {
      room.gameStarted = false;
      room.alivePlayers = [];
      room.playerStates.forEach((state) => {
        if (!state.isSpectator) {
          state.ready = false;
          state.alive = true;
          state.score = 0;
        }
      });
      if (room.playerTargets) {
        room.playerTargets.clear();
      }
      room.resetTimeout = null;
      broadcastRoomState(room);
      discordBot.updateRoomInfo(room.code);
    }, 3000);
  }
}

function handleReturnToLobby(ws) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;


  if (ws !== room.host) return;


  room.players.forEach((player) => {
    player.send(
      JSON.stringify({
        type: "force_return_lobby",
      }),
    );
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);

  const DISCORD_TOKEN = process.env.DISCORD_TOKEN || ''; 
  if (DISCORD_TOKEN) {
      discordBot.startBot(DISCORD_TOKEN, { rooms, broadcastChat });
  } else {
      console.log("Discord Bot: DISCORD_TOKEN not set. Bot disabled.");
  }
});

function broadcastChat(roomCode, senderName, message) {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.forEach((player) => {
        player.send(JSON.stringify({
            type: "chat_message",
            playerName: `[Discord] ${senderName}`,
            message: message
        }));
    });
}
