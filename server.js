const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const discordBot = require("./discord_bot"); // Import Bot
require('dotenv').config();

// プリセット保存用の設定
const PRESETS_FILE = path.join(__dirname, 'presets.json');
let presetsCache = {};

// プリセットを読み込む
function loadPresets() {
  try {
    if (fs.existsSync(PRESETS_FILE)) {
      const data = fs.readFileSync(PRESETS_FILE, 'utf8');
      presetsCache = JSON.parse(data);
      console.log('Presets loaded from file');
    } else {
      presetsCache = {};
      console.log('No presets file found, starting with empty cache');
    }
  } catch (error) {
    console.error('Error loading presets:', error);
    presetsCache = {};
  }
}

// プリセットを保存する
function savePresets() {
  try {
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presetsCache, null, 2), 'utf8');
    console.log('Presets saved to file');
  } catch (error) {
    console.error('Error saving presets:', error);
  }
}

// サーバー起動時にプリセットを読み込む
loadPresets();

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
    case "update_player_settings":
      handleUpdatePlayerSettings(ws, data);
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
    case "skill_activated":
      handleSkillActivated(ws, data);
      break;
    case "skill2_activated":
      handleSkill2Activated(ws, data);
      break;
    case "kick_player":
      handleKickPlayer(ws, data);
      break;
    case "force_start":
      handleForceStart(ws);
      break;
    case "save_preset":
      handleSavePreset(ws, data);
      break;
    case "load_preset":
      handleLoadPreset(ws, data);
      break;
    case "force_end_game":
      handleForceEndGame(ws);
      break;
    case "add_bot":
      handleAddBot(ws, data);
      break;
    case "remove_bot":
      handleRemoveBot(ws, data);
      break;
  }
}

// ホストによる強制終了
function handleForceEndGame(ws) {
  if (!ws.roomCode || !ws.isHost) return;
  
  const room = rooms.get(ws.roomCode);
  if (!room || !room.gameStarted) return;
  
  // 全プレイヤーにゲーム終了を通知
  room.players.forEach((player) => {
    player.send(JSON.stringify({
      type: "force_game_end",
      message: "ホストによってゲームが終了されました"
    }));
  });
  
  // ゲーム終了処理
  if (room.alivePlayers.length === 1 || room.alivePlayers.length === 0) {
    const winnerId = room.alivePlayers.length === 1 ? room.alivePlayers[0] : null;

    const playerScores = Array.from(room.playerStates.values())
      .filter((p) => !p.isSpectator)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((p, index) => ({
        id: p.id,
        name: p.name,
        score: p.score || 0,
        totalGarbageSent: p.totalGarbageSent || 0,
        totalGarbageReceived: p.totalGarbageReceived || 0,
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
    if (winnerId) {
        const winnerName = room.playerStates.get(winnerId)?.name || 'Unknown';
        if (room.code) {
            discordBot.notifyGameEnd(room.code, winnerName);
        }
    }

    if (room.resetTimeout) clearTimeout(room.resetTimeout);
    room.resetTimeout = setTimeout(() => {
      room.gameStarted = false;
      broadcastRoomState(room);
      discordBot.updateRoomInfo(room.code);
    }, 5000);
  }
  
  room.gameStarted = false;
}

// プリセットを保存
function handleSavePreset(ws, data) {
  if (!data.playerName) return;
  
  if (!presetsCache[data.playerName]) {
    presetsCache[data.playerName] = {};
  }
  
  if (data.swipeSettings) {
    presetsCache[data.playerName].swipeSettings = data.swipeSettings;
  }
  
  if (data.keySettings) {
    presetsCache[data.playerName].keySettings = data.keySettings;
  }
  
  // ファイルに保存
  savePresets();
  
  ws.send(JSON.stringify({
    type: "preset_saved",
    playerName: data.playerName,
    success: true
  }));
}

// プリセットを読み込み
function handleLoadPreset(ws, data) {
  if (!data.playerName) return;
  
  const preset = presetsCache[data.playerName];
  
  ws.send(JSON.stringify({
    type: "preset_loaded",
    playerName: data.playerName,
    preset: preset || null,
    success: !!preset
  }));
}

function updateSettings(ws, data) {
  if (!ws.roomCode || !ws.isHost) {
    console.log(`updateSettings rejected: ws.roomCode=${ws.roomCode}, ws.isHost=${ws.isHost}`);
    return;
  }

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  // 追加検証: ルームのホストが現在のプレイヤーかどうかを確認
  if (room.host !== ws) {
    console.log(`updateSettings rejected: sender is not the room host`);
    return;
  }

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
      skillType: 1, // 0: None, 1: Skill 1, 2: Skill 2
      skillRequiredCount: 20, // スキル発動に必要なぷよ消去数
      animationMode: 'normal', // アニメーション通常 or クイックドロップ
      garbageMode: 'drop', // おじゃま出現方法: drop(落下) or raise(上昇)
      holdEnabled: true, // ホールド機能のON/OFF
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
    garbageMultiplier: 1.0,
    totalGarbageSent: 0,
    totalGarbageReceived: 0,
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
    // ゲーム中の場合E観戦モードで参加
    room.players.push(ws);
    const playerName = data.playerName || `Spectator ${room.players.length}`;
    room.playerStates.set(ws.playerId, {
      id: ws.playerId,
      ready: false,
      alive: false,
      name: playerName,
      score: 0,
      isSpectator: true,
      totalGarbageSent: 0,
      totalGarbageReceived: 0,
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
    garbageMultiplier: 1.0,
    totalGarbageSent: 0,
    totalGarbageReceived: 0,
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

function handleKickPlayer(ws, data) {
  if (!ws.roomCode || !ws.isHost) return;
  
  const room = rooms.get(ws.roomCode);
  if (!room || room.gameStarted) return;
  
  const targetId = data.targetId;
  if (!targetId || targetId === ws.playerId) return;
  
  const targetPlayer = room.players.find(p => p.playerId === targetId);
  if (!targetPlayer) return;
  
  // キックされたプレイヤーに通知
  targetPlayer.send(JSON.stringify({
    type: "kicked",
    message: "ホストによってキックされました"
  }));
  
  // プレイヤーを削除
  room.players = room.players.filter(p => p.playerId !== targetId);
  room.playerStates.delete(targetId);
  
  targetPlayer.roomCode = null;
  targetPlayer.isHost = false;
  
  broadcastRoomState(room);
  discordBot.updateRoomInfo(ws.roomCode);
  
  console.log(`Player ${targetId} kicked from room: ${ws.roomCode}`);
}

function handleForceStart(ws) {
  if (!ws.roomCode || !ws.isHost) return;
  
  const room = rooms.get(ws.roomCode);
  if (!room || room.gameStarted) return;
  if (room.players.length < 1) return;
  
  // 準備完了していないプレイヤーを観戦者に設定
  room.playerStates.forEach((state, playerId) => {
    if (!state.ready && !state.isSpectator) {
      state.isSpectator = true;
      state.alive = false;
      
      // 該当プレイヤーに観戦者設定を通知
      const player = room.players.find(p => p.playerId === playerId);
      if (player) {
        player.isSpectator = true;
      }
    }
  });
  
  startGame(room);
}

function startGame(room) {
  if (room.resetTimeout) {
    clearTimeout(room.resetTimeout);
    room.resetTimeout = null;
  }
  room.gameStarted = true;
  room.alivePlayers = room.players.map((p) => p.playerId);
  // Botも生存リストに追加
  if (room.bots && room.bots.length > 0) {
    room.bots.forEach(b => { if (!room.alivePlayers.includes(b.id)) room.alivePlayers.push(b.id); });
  }


  room.playerStates.forEach((state) => {
    if (!state.isSpectator) {
      state.alive = true;
      state.ready = false;
      state.score = 0;
      state.totalGarbageSent = 0;
      state.totalGarbageReceived = 0;
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

  // Botゲームループ開始
  startBotsInRoom(room, seed);

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
    
    // ホスト交代を他のプレイヤーに通知
    room.players.forEach((player) => {
      if (player.playerId !== ws.playerId) {
        player.send(JSON.stringify({
          type: "host_changed",
          newHostId: room.host.playerId
        }));
      }
    });
  }

  // プレイヤーが退出したことを通知（ゲーム中のみ）
  if (room.gameStarted && room.players.length > 0) {
    room.players.forEach((player) => {
      if (player.playerId !== ws.playerId) {
        player.send(JSON.stringify({
          type: "player_left",
          playerId: ws.playerId
        }));
      }
    });
  }

  if (room.players.length === 0) {
    // Botタイマーをすべて停止
    if (room.bots) {
      room.bots.forEach(b => { if (b.dropTimer) clearInterval(b.dropTimer); });
      room.bots = [];
    }
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

function handleUpdatePlayerSettings(ws, data) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  const playerState = room.playerStates.get(ws.playerId);
  if (!playerState) return;

  if (data.garbageMultiplier !== undefined) {
    playerState.garbageMultiplier = parseFloat(data.garbageMultiplier);
  }

  broadcastRoomState(room);
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

  // ターゲチEを記録
  room.playerTargets.set(ws.playerId, targetId);

  const targetPlayer = room.players.find((p) => p.playerId === targetId);
  const targetBotState = room.bots && room.bots.find((b) => b.id === targetId);
  const targetState = room.playerStates.get(targetId);
  const attackerState = room.playerStates.get(ws.playerId);

  if (targetState && attackerState) {
    const multiplier = targetState.garbageMultiplier || 1.0;
    const finalAmount = Math.floor(data.amount * multiplier);

    // 累計おじゃま送信・受信数を更新
    attackerState.totalGarbageSent = (attackerState.totalGarbageSent || 0) + finalAmount;
    targetState.totalGarbageReceived = (targetState.totalGarbageReceived || 0) + finalAmount;

    if (targetPlayer) {
      // ターゲットに送信
      targetPlayer.send(
        JSON.stringify({
          type: "receive_garbage",
          fromPlayerId: ws.playerId,
          amount: finalAmount,
          colors: data.colors,
          sourcePositions: data.positions,
        }),
      );
    } else if (targetBotState) {
      // Botに送信 (キューに追加)
      const delayMs = ((room.settings && room.settings.garbageDelay) || 3) * 1000;
      targetBotState.garbageQueue.push({ amount: finalAmount, time: Date.now() + delayMs });
    }

    // 攻撁EEEE刁Eに送信通知を送るEアニメーション用EE
    ws.send(
      JSON.stringify({
        type: "attack_ack",
        targetId: targetId,
        amount: finalAmount,
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
            amount: finalAmount,
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
  if (room.alivePlayers.length === 1 || room.alivePlayers.length === 0) {
    const winnerId = room.alivePlayers.length === 1 ? room.alivePlayers[0] : null;

    const playerScores = Array.from(room.playerStates.values())
      .filter((p) => !p.isSpectator)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((p, index) => ({
        id: p.id,
        name: p.name,
        score: p.score || 0,
        totalGarbageSent: p.totalGarbageSent || 0,
        totalGarbageReceived: p.totalGarbageReceived || 0,
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
    if (winnerId) {
        const winnerName = room.playerStates.get(winnerId)?.name || 'Unknown';
        if (room.code) {
            discordBot.notifyGameEnd(room.code, winnerName);
        }
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
          state.totalGarbageSent = 0;
          state.totalGarbageReceived = 0;
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

function handleSkillActivated(ws, data) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  // スキルが無効な場合は何もしない
  if (room.settings && room.settings.skillType !== 1) return;

  const playerState = room.playerStates.get(ws.playerId);
  const playerName = playerState ? playerState.name : 'Unknown';

  // 自分以外の全プレイヤーにスキル発動を通知（透明おじゃまぷよを送信）
  room.players.forEach((player) => {
    if (player.playerId !== ws.playerId) {
      player.send(
        JSON.stringify({
          type: "skill_activated",
          fromPlayerId: ws.playerId,
          fromPlayerName: playerName,
        }),
      );
    }
  });
}

function handleSkill2Activated(ws, data) {
  if (!ws.roomCode) return;

  const room = rooms.get(ws.roomCode);
  if (!room) return;

  // スキル2が無効な場合は何もしない
  if (room.settings && room.settings.skillType !== 2) return;

  // 自分以外の生存プレイヤーをリストアップ
  const otherAlivePlayers = room.players.filter(p => p.playerId !== ws.playerId && room.alivePlayers.includes(p.playerId));
  if (otherAlivePlayers.length === 0) return;

  // ランダムなターゲットを選択
  const targetPlayer = otherAlivePlayers[Math.floor(Math.random() * otherAlivePlayers.length)];
  
  if (targetPlayer) {
    targetPlayer.send(
      JSON.stringify({
        type: "skill2_applied",
        fromPlayerId: ws.playerId,
      }),
    );
    
    // 他のプレイヤー（ターゲット以外）にも通知（任意、演出用）
    room.players.forEach((player) => {
        if (player.playerId !== ws.playerId && player.playerId !== targetPlayer.playerId) {
            player.send(JSON.stringify({
                type: "skill2_activated_broadcast",
                fromPlayerId: ws.playerId,
                toPlayerId: targetPlayer.playerId
            }));
        }
    });
  }
}

// ============================================================
// BOT システム
// ============================================================

const BOT_COLS = 6;
const BOT_ROWS = 14;
const BOT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];

function createBotState(name, difficulty) {
  return {
    id: 'bot_' + Math.random().toString(36).substring(2, 10),
    name: name || 'CPU',
    difficulty: difficulty || 'normal', // easy / normal / hard
    isBot: true,
    ready: true,
    alive: true,
    score: 0,
    isSpectator: false,
    garbageMultiplier: 1.0,
    totalGarbageSent: 0,
    totalGarbageReceived: 0,
    // ゲームステート
    grid: Array.from({length: BOT_ROWS}, () => Array(BOT_COLS).fill(null)),
    // seed-based RNG (共有シードを使う)
    rngSeed: 0,
    rngState: 0,
    // 次のぷよキュー（サーバー側で管理）
    nextQueue: [],
    currentPair: null,
    pendingGarbage: 0,
    garbageQueue: [],
    dropTimer: null,
    thinkTimer: null,
    gameOver: false,
  };
}

// LCG乱数（ゲームと同じシードで同じ色列を生成）
function botRng(state) {
  // Phaser.Math.RandomDataGenerator互換の簡易実装
  state.rngState = (state.rngState * 1664525 + 1013904223) & 0xffffffff;
  return (state.rngState >>> 0) / 0x100000000;
}

function botPickColor(state) {
  const idx = Math.floor(botRng(state) * BOT_COLORS.length);
  return BOT_COLORS[idx];
}

function botCreatePair(state) {
  return { main: botPickColor(state), sub: botPickColor(state) };
}

// シードを使ってRNG初期化（Phaser互換の簡易版）
function initBotRng(state, seed) {
  // Phaser RandomDataGenerator は seeds配列からハッシュを作る
  // 簡易版: seedをそのままrngStateに使う
  state.rngSeed = seed;
  state.rngState = seed ^ 0xdeadbeef;
  // 数回空回しして初期化
  for (let i = 0; i < 10; i++) botRng(state);
}

// ====== Bot AI: 盤面評価 ======

function cloneGrid(grid) {
  return grid.map(row => [...row]);
}

// 重力適用（ぷよを下に落とす）
function applyGravityBot(grid) {
  let moved = true;
  while (moved) {
    moved = false;
    for (let row = BOT_ROWS - 2; row >= 0; row--) {
      for (let col = 0; col < BOT_COLS; col++) {
        if (grid[row][col] && !grid[row + 1][col]) {
          grid[row + 1][col] = grid[row][col];
          grid[row][col] = null;
          moved = true;
        }
      }
    }
  }
}

// 氾濫探索（連鎖検出）
function floodFillBot(grid, startRow, startCol, visited) {
  const color = grid[startRow][startCol];
  if (!color || color === 'gray') return [];
  const group = [];
  const stack = [[startRow, startCol]];
  while (stack.length > 0) {
    const [r, c] = stack.pop();
    if (r < 0 || r >= BOT_ROWS || c < 0 || c >= BOT_COLS) continue;
    if (visited[r][c]) continue;
    if (grid[r][c] !== color) continue;
    visited[r][c] = true;
    group.push([r, c]);
    stack.push([r-1,c],[r+1,c],[r,c-1],[r,c+1]);
  }
  return group;
}

// マッチを検出して消去、おじゃまも巻き込み
function findAndClearBot(grid) {
  const visited = Array.from({length: BOT_ROWS}, () => Array(BOT_COLS).fill(false));
  const toRemove = new Set();
  let cleared = 0;

  for (let r = 0; r < BOT_ROWS; r++) {
    for (let c = 0; c < BOT_COLS; c++) {
      if (grid[r][c] && grid[r][c] !== 'gray' && !visited[r][c]) {
        const group = floodFillBot(grid, r, c, visited);
        if (group.length >= 4) {
          group.forEach(([gr, gc]) => toRemove.add(`${gr},${gc}`));
          cleared += group.length;
          // おじゃまを巻き込み
          group.forEach(([gr, gc]) => {
            [[gr-1,gc],[gr+1,gc],[gr,gc-1],[gr,gc+1]].forEach(([nr,nc]) => {
              if (nr>=0&&nr<BOT_ROWS&&nc>=0&&nc<BOT_COLS&&grid[nr][nc]==='gray') {
                toRemove.add(`${nr},${nc}`);
              }
            });
          });
        }
      }
    }
  }
  toRemove.forEach(key => {
    const [r,c] = key.split(',').map(Number);
    grid[r][c] = null;
  });
  return cleared;
}

// 連鎖シミュレーション
function simulateChains(grid) {
  let totalChains = 0;
  let totalCleared = 0;
  let chainCount = 0;
  while (true) {
    applyGravityBot(grid);
    const cleared = findAndClearBot(grid);
    if (cleared === 0) break;
    chainCount++;
    totalCleared += cleared;
  }
  return { chains: chainCount, cleared: totalCleared };
}

// 盤面評価関数
function evaluateGrid(grid, difficulty) {
  // 1. 高さペナルティ
  let heightPenalty = 0;
  let maxHeight = 0;
  for (let c = 0; c < BOT_COLS; c++) {
    let h = 0;
    for (let r = 0; r < BOT_ROWS; r++) {
      if (grid[r][c]) { h = BOT_ROWS - r; break; }
    }
    heightPenalty += h * h;
    if (h > maxHeight) maxHeight = h;
  }

  // 2. 連鎖シミュレーション
  const simGrid = cloneGrid(grid);
  const { chains, cleared } = simulateChains(simGrid);

  // 3. 穴ペナルティ（塞がれた空きマス）
  let holes = 0;
  for (let c = 0; c < BOT_COLS; c++) {
    let foundPuyo = false;
    for (let r = 0; r < BOT_ROWS; r++) {
      if (grid[r][c]) foundPuyo = true;
      else if (foundPuyo) holes++;
    }
  }

  // 4. 隣接ボーナス（同色が隣り合っている）
  let adjacency = 0;
  for (let r = 0; r < BOT_ROWS; r++) {
    for (let c = 0; c < BOT_COLS; c++) {
      if (!grid[r][c] || grid[r][c] === 'gray') continue;
      if (r+1 < BOT_ROWS && grid[r+1][c] === grid[r][c]) adjacency++;
      if (c+1 < BOT_COLS && grid[r][c+1] === grid[r][c]) adjacency++;
    }
  }

  // 難易度別のウェイト
  let chainWeight, heightWeight, holeWeight, adjWeight;
  if (difficulty === 'easy') {
    chainWeight = 50; heightWeight = -3; holeWeight = -5; adjWeight = 5;
  } else if (difficulty === 'hard') {
    chainWeight = 300; heightWeight = -8; holeWeight = -20; adjWeight = 15;
  } else { // normal
    chainWeight = 150; heightWeight = -5; holeWeight = -12; adjWeight = 10;
  }

  return (
    chains * chainWeight +
    cleared * 20 +
    heightPenalty * heightWeight +
    holes * holeWeight +
    adjacency * adjWeight
  );
}

// ぷよペアを盤面に配置
function placePairBot(grid, col, rotation, mainColor, subColor) {
  // rotation: 0=sub上, 1=sub右, 2=sub下, 3=sub左
  let mainRow = -1, subRow = -1, mainCol = col, subCol = col;

  if (rotation === 0) { // sub上
    // メインを先に落とす
    for (let r = BOT_ROWS - 1; r >= 0; r--) {
      if (!grid[r][col]) { mainRow = r; break; }
    }
    if (mainRow < 0) return false;
    // サブはメインの上
    subRow = mainRow - 1;
    if (subRow < 0) return false; // はみ出す
    // 既にある場合
    if (grid[subRow][col]) {
      // サブをmainRowに重ねることはできない → 再計算
      // mainRowに2つ積む場合
      subRow = mainRow - 1;
    }
  } else if (rotation === 1) { // sub右
    subCol = col + 1;
    if (subCol >= BOT_COLS) return false;
    for (let r = BOT_ROWS - 1; r >= 0; r--) {
      if (!grid[r][col]) { mainRow = r; break; }
    }
    for (let r = BOT_ROWS - 1; r >= 0; r--) {
      if (!grid[r][subCol]) { subRow = r; break; }
    }
    if (mainRow < 0 || subRow < 0) return false;
  } else if (rotation === 2) { // sub下（メインが上）
    // subを先に落とす
    for (let r = BOT_ROWS - 1; r >= 0; r--) {
      if (!grid[r][col]) { subRow = r; break; }
    }
    if (subRow < 0) return false;
    mainRow = subRow - 1;
    if (mainRow < 0) return false;
    if (grid[mainRow][col]) return false;
  } else { // rotation === 3: sub左
    subCol = col - 1;
    if (subCol < 0) return false;
    for (let r = BOT_ROWS - 1; r >= 0; r--) {
      if (!grid[r][col]) { mainRow = r; break; }
    }
    for (let r = BOT_ROWS - 1; r >= 0; r--) {
      if (!grid[r][subCol]) { subRow = r; break; }
    }
    if (mainRow < 0 || subRow < 0) return false;
  }

  grid[mainRow][mainCol] = mainColor;
  if (subRow >= 0 && subRow < BOT_ROWS) grid[subRow][subCol] = subColor;
  return true;
}

// Bot AI: 次の手を決定（NEXTまで考慮）
function botDecideMove(botState, lookahead) {
  const main1 = botState.currentPair.main;
  const sub1 = botState.currentPair.sub;
  const next1 = botState.nextQueue[0];
  const next2 = botState.nextQueue[1];

  let bestScore = -Infinity;
  let bestMove = { col: 2, rotation: 0 };

  const difficulty = botState.difficulty;

  for (let col = 0; col < BOT_COLS; col++) {
    for (let rot = 0; rot < 4; rot++) {
      const g1 = cloneGrid(botState.grid);
      if (!placePairBot(g1, col, rot, main1, sub1)) continue;
      applyGravityBot(g1);

      let score = evaluateGrid(g1, difficulty);

      // NEXTを1手先読み（normalとhard）
      if (lookahead >= 1 && next1) {
        let bestNext = -Infinity;
        for (let c2 = 0; c2 < BOT_COLS; c2++) {
          for (let r2 = 0; r2 < 4; r2++) {
            const g2 = cloneGrid(g1);
            if (!placePairBot(g2, c2, r2, next1.main, next1.sub)) continue;
            applyGravityBot(g2);
            const s2 = evaluateGrid(g2, difficulty);
            if (s2 > bestNext) bestNext = s2;
          }
        }
        if (bestNext > -Infinity) score += bestNext * 0.5;
      }

      // NEXTを2手先読み（hardのみ）
      if (lookahead >= 2 && next2) {
        let bestNext2 = -Infinity;
        for (let c3 = 0; c3 < BOT_COLS; c3++) {
          for (let r3 = 0; r3 < 4; r3++) {
            const g3 = cloneGrid(g1);
            if (!placePairBot(g3, c3, r3, next2.main, next2.sub)) continue;
            applyGravityBot(g3);
            const s3 = evaluateGrid(g3, difficulty);
            if (s3 > bestNext2) bestNext2 = s3;
          }
        }
        if (bestNext2 > -Infinity) score += bestNext2 * 0.25;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMove = { col, rotation: rot };
      }
    }
  }

  return bestMove;
}

// Bot ゲームループ
function botTick(room, botState) {
  if (botState.gameOver || !room.gameStarted) return;

  // おじゃまぷよキュー処理
  if (botState.garbageQueue && botState.garbageQueue.length > 0) {
    const now = Date.now();
    const delayMs = ((room.settings && room.settings.garbageDelay) || 3) * 1000;
    for (let i = botState.garbageQueue.length - 1; i >= 0; i--) {
      if (now >= botState.garbageQueue[i].time) {
        botState.pendingGarbage += botState.garbageQueue[i].amount;
        botState.garbageQueue.splice(i, 1);
      }
    }
  }

  // おじゃまぷよ落下処理（garbageModeに応じてdrop/raiseを切り替え）
  if (botState.pendingGarbage > 0) {
    const drop = Math.min(botState.pendingGarbage, 30);
    botState.pendingGarbage -= drop;
    const garbageMode = (room.settings && room.settings.garbageMode) || 'drop';

    if (garbageMode === 'raise') {
      // テトリス風上昇：段数計算して下から押し上げ
      let totalRows = Math.floor(drop / 2);
      if (totalRows < 1) totalRows = 1;
      const rowsToAdd = Math.min(totalRows, 4);

      // ゲームオーバーチェック：最上段のぷよが押し出されるか
      let gameOver = false;
      for (let row = 0; row < rowsToAdd; row++) {
        for (let col = 0; col < BOT_COLS; col++) {
          if (botState.grid[row][col]) { gameOver = true; break; }
        }
        if (gameOver) break;
      }
      if (gameOver) { botGameOver(room, botState); return; }

      // 既存ぷよを上にシフト
      for (let row = 0; row < BOT_ROWS - rowsToAdd; row++) {
        for (let col = 0; col < BOT_COLS; col++) {
          botState.grid[row][col] = botState.grid[row + rowsToAdd][col];
        }
      }
      // 下からgarbageを追加
      for (let rowOffset = 0; rowOffset < rowsToAdd; rowOffset++) {
        const targetRow = BOT_ROWS - 1 - rowOffset;
        for (let col = 0; col < BOT_COLS; col++) {
          botState.grid[targetRow][col] = 'gray';
        }
      }
    } else {
      // 通常drop: ランダムな列に落とす
      for (let i = 0; i < drop; i++) {
        const col = Math.floor(Math.random() * BOT_COLS);
        for (let r = BOT_ROWS - 1; r >= 0; r--) {
          if (!botState.grid[r][col]) {
            botState.grid[r][col] = 'gray';
            break;
          }
        }
      }
    }
    // おじゃまぷよ落下後にボーダーラインチェック（中央上2マス）
    let isDanger = false;
    if (botState.grid[0][2] || botState.grid[0][3]) { isDanger = true; }
    if (isDanger) {
      // Botゲームオーバー
      botGameOver(room, botState);
      return;
    }
  }

  // 新しいぷよを生成
  if (!botState.currentPair) {
    // キューを補充
    while (botState.nextQueue.length < 3) {
      botState.nextQueue.push(botCreatePair(botState));
    }
    botState.currentPair = botState.nextQueue.shift();

    // スポーン位置チェック（中央上2マスにぷよがあればゲームオーバー）
    if (botState.grid[0][2] || botState.grid[0][3]) {
      botGameOver(room, botState);
      return;
    }
  }

  // 難易度に応じたlookahead
  let lookahead = 0;
  if (botState.difficulty === 'normal') lookahead = 1;
  if (botState.difficulty === 'hard') lookahead = 2;

  // 最善手を計算
  const move = botDecideMove(botState, lookahead);

  // ぷよを配置
  const newGrid = cloneGrid(botState.grid);
  const placed = placePairBot(newGrid, move.col, move.rotation,
    botState.currentPair.main, botState.currentPair.sub);

  if (!placed) {
    // 配置失敗 → フォールバック（任意の列に縦に置く）
    let fallbackPlaced = false;
    for (let fc = 0; fc < BOT_COLS; fc++) {
      if (placePairBot(newGrid, fc, 0, botState.currentPair.main, botState.currentPair.sub)) {
        fallbackPlaced = true;
        break;
      }
    }
    if (!fallbackPlaced) {
      botGameOver(room, botState);
      return;
    }
  }

  applyGravityBot(newGrid);

  // 連鎖処理 & 攻撃計算（newGridに実際に消去を適用する）
  let chainCount = 0;
  let totalGarbageSent = 0;
  let garbageSendPositions = [];

  while (true) {
    applyGravityBot(newGrid);
    const visited = Array.from({length: BOT_ROWS}, () => Array(BOT_COLS).fill(false));
    const toRemove = new Set();
    let cleared = 0;

    for (let r = 0; r < BOT_ROWS; r++) {
      for (let c = 0; c < BOT_COLS; c++) {
        if (newGrid[r][c] && newGrid[r][c] !== 'gray' && !visited[r][c]) {
          const group = floodFillBot(newGrid, r, c, visited);
          if (group.length >= 4) {
            group.forEach(([gr,gc]) => { toRemove.add(`${gr},${gc}`); garbageSendPositions.push({row:gr,col:gc}); });
            cleared += group.length;
            group.forEach(([gr,gc]) => {
              [[gr-1,gc],[gr+1,gc],[gr,gc-1],[gr,gc+1]].forEach(([nr,nc]) => {
                if(nr>=0&&nr<BOT_ROWS&&nc>=0&&nc<BOT_COLS&&newGrid[nr][nc]==='gray') {
                  toRemove.add(`${nr},${nc}`);
                }
              });
            });
          }
        }
      }
    }
    if (cleared === 0) break;
    chainCount++;

    // おじゃまぷよ計算
    const actualMatch = cleared;
    const baseGarbage = Math.floor((actualMatch / 2) * (room.settings.garbageRate || 1.0));
    totalGarbageSent += baseGarbage;

    // newGridに実際に消去を適用
    toRemove.forEach(key => {
      const [r,c] = key.split(',').map(Number);
      newGrid[r][c] = null;
    });
  }

  // 相殺後に攻撃
  let remainingGarbage = totalGarbageSent;
  if (botState.pendingGarbage > 0) {
    const offset = Math.min(remainingGarbage, botState.pendingGarbage);
    botState.pendingGarbage -= offset;
    remainingGarbage -= offset;
  }

  if (remainingGarbage > 0 && room.alivePlayers.includes(botState.id)) {
    // ランダムなターゲットに攻撃
    const opponents = room.alivePlayers.filter(id => id !== botState.id);
    if (opponents.length > 0) {
      const targetId = opponents[Math.floor(Math.random() * opponents.length)];
      // ターゲットがBotかプレイヤーか
      const targetBotState = room.bots && room.bots.find(b => b.id === targetId);
      if (targetBotState) {
        // Bot → Bot 攻撃
        const delayMs = ((room.settings && room.settings.garbageDelay) || 3) * 1000;
        targetBotState.garbageQueue.push({ amount: remainingGarbage, time: Date.now() + delayMs });
        botState.totalGarbageSent = (botState.totalGarbageSent || 0) + remainingGarbage;
        targetBotState.totalGarbageReceived = (targetBotState.totalGarbageReceived || 0) + remainingGarbage;
      } else {
        // Bot → プレイヤー 攻撃
        const targetPlayer = room.players.find(p => p.playerId === targetId);
        const targetState = room.playerStates.get(targetId);
        if (targetPlayer && targetState) {
          const multiplier = targetState.garbageMultiplier || 1.0;
          const finalAmount = Math.floor(remainingGarbage * multiplier);
          botState.totalGarbageSent = (botState.totalGarbageSent || 0) + finalAmount;
          targetState.totalGarbageReceived = (targetState.totalGarbageReceived || 0) + finalAmount;

          const delayMs = ((room.settings && room.settings.garbageDelay) || 3) * 1000;
          targetPlayer.send(JSON.stringify({
            type: 'receive_garbage',
            fromPlayerId: botState.id,
            amount: finalAmount,
            colors: Array(finalAmount).fill('gray'),
            sourcePositions: garbageSendPositions.slice(0, finalAmount),
          }));
          ws_send_attack_ack(room, botState.id, targetId, finalAmount, garbageSendPositions);
        }
      }
    }
  }

  botState.grid = newGrid;
  botState.currentPair = null;

  // Bot移動アニメーション：次のぷよの移動を段階的に送信
  if (!botState.nextQueue) botState.nextQueue = [];
  while (botState.nextQueue.length < 3) {
    botState.nextQueue.push(botCreatePair(botState));
  }
  const nextPairPreview = botState.nextQueue[0];
  if (nextPairPreview) {
    const previewMove = botDecideMove({ ...botState, currentPair: nextPairPreview }, botState.difficulty === 'hard' ? 1 : 0);
    const targetCol = previewMove.col;
    const targetRot = previewMove.rotation;
    const colors = { main: nextPairPreview.main, sub: nextPairPreview.sub };
    const startCol = 2; // スポーン列
    const thinkDelay = botState.botSpeed || 1200;
    const stepDelay = Math.max(50, Math.floor(thinkDelay / 12)); // 移動ステップ間隔

    // 段階的に移動アニメーションを送信
    const steps = [];
    let curCol = startCol;
    let curRot = 0;

    // まず回転ステップを追加
    if (targetRot !== curRot) {
      steps.push({ col: curCol, row: 0, rotation: targetRot });
      curRot = targetRot;
    }

    // 次に左右移動ステップ
    const dir = targetCol > curCol ? 1 : -1;
    while (curCol !== targetCol) {
      curCol += dir;
      steps.push({ col: curCol, row: 0, rotation: curRot });
    }

    // 各ステップを遅延送信
    steps.forEach((step, i) => {
      setTimeout(() => {
        if (!botState.gameOver && room.gameStarted) {
          room.players.forEach(p => {
            try {
              p.send(JSON.stringify({
                type: 'piece_update',
                playerId: botState.id,
                data: { ...step, colors }
              }));
            } catch(e) {}
          });
        }
      }, stepDelay * i);
    });

    // 最終位置（ハードドロップ後）
    setTimeout(() => {
      if (!botState.gameOver && room.gameStarted) {
        room.players.forEach(p => {
          try {
            p.send(JSON.stringify({
              type: 'piece_update',
              playerId: botState.id,
              data: { col: targetCol, row: 0, rotation: targetRot, colors }
            }));
          } catch(e) {}
        });
      }
    }, stepDelay * steps.length);
  }

  // フィールド更新をプレイヤーに送信
  broadcastBotFieldUpdate(room, botState);

  // ゲームオーバーチェック（中央上2マス col=2,3 にぷよがあるか）
  let isDanger = false;
  if (botState.grid[0][2] || botState.grid[0][3]) { isDanger = true; }
  if (isDanger) {
    botGameOver(room, botState);
  }
}

function ws_send_attack_ack(room, fromId, toId, amount, positions) {
  // 全員に third_party_attack を送る（観戦者向け）
  room.players.forEach(p => {
    p.send(JSON.stringify({
      type: 'third_party_attack',
      fromPlayerId: fromId,
      toPlayerId: toId,
      amount: amount,
      sourcePositions: positions.slice(0, amount),
    }));
  });
}

function broadcastBotFieldUpdate(room, botState) {
  const gridData = botState.grid.map(row => row.map(c => c || null));
  let totalGarbage = botState.pendingGarbage;
  if (botState.garbageQueue) totalGarbage += botState.garbageQueue.reduce((s,i) => s+i.amount, 0);

  room.players.forEach(p => {
    p.send(JSON.stringify({
      type: 'opponent_update',
      playerId: botState.id,
      data: gridData,
      garbageCount: totalGarbage,
    }));
  });
}

function botGameOver(room, botState) {
  if (botState.gameOver) return;
  botState.gameOver = true;
  if (botState.dropTimer) { clearInterval(botState.dropTimer); botState.dropTimer = null; }

  room.alivePlayers = room.alivePlayers.filter(id => id !== botState.id);
  room.players.forEach(p => {
    p.send(JSON.stringify({ type: 'player_defeated', playerId: botState.id }));
  });

  checkGameEnd(room);
}

function startBotsInRoom(room, seed) {
  if (!room.bots || room.bots.length === 0) return;

  room.bots.forEach(botState => {
    // 古いタイマーがあれば確実に停止
    if (botState.dropTimer) {
      clearInterval(botState.dropTimer);
      botState.dropTimer = null;
    }

    botState.grid = Array.from({length: BOT_ROWS}, () => Array(BOT_COLS).fill(null));    botState.gameOver = false;
    botState.pendingGarbage = 0;
    botState.garbageQueue = [];
    botState.currentPair = null;
    botState.score = 0;
    botState.totalGarbageSent = 0;
    botState.totalGarbageReceived = 0;
    initBotRng(botState, seed + botState.id.charCodeAt(4));
    // Nextキュー初期化
    botState.nextQueue = [];
    while (botState.nextQueue.length < 3) {
      botState.nextQueue.push(botCreatePair(botState));
    }

    // Bot思考間隔: difficulty を速度(ms)として直接使う
    // easy=2000ms, normal=1200ms, hard=600ms, veryhard=300ms
    let thinkDelay;
    if (botState.difficulty === 'easy') thinkDelay = 2500;
    else if (botState.difficulty === 'hard') thinkDelay = 600;
    else if (botState.difficulty === 'veryhard') thinkDelay = 250;
    else thinkDelay = 1200; // normal
    // ユーザー指定のspeedがあればそちらを使う
    if (botState.botSpeed && botState.botSpeed > 0) thinkDelay = botState.botSpeed;

    // 少し遅れてスタート
    const startDelay = 3500; // カウントダウン分待つ
    setTimeout(() => {
      if (!botState.gameOver && room.gameStarted) {
        botState.dropTimer = setInterval(() => {
          botTick(room, botState);
        }, thinkDelay);
      }
    }, startDelay);
  });
}

// ホストがBotを追加するハンドラ
function handleAddBot(ws, data) {
  if (!ws.roomCode || !ws.isHost) return;
  const room = rooms.get(ws.roomCode);
  if (!room || room.gameStarted) return;

  if (!room.bots) room.bots = [];
  if (room.bots.length >= 6) {
    ws.send(JSON.stringify({ type: 'error', message: 'Botは最大6体まで追加できます' }));
    return;
  }

  const difficulty = data.difficulty || 'normal';
  const diffLabel = difficulty === 'easy' ? 'イージー' : difficulty === 'hard' ? 'ハード' : difficulty === 'veryhard' ? '超ハード' : 'ノーマル';
  const botName = data.name || `CPU(${diffLabel})`;
  const botState = createBotState(botName, difficulty);
  // botSpeedが指定されていれば設定（ms単位）
  if (data.botSpeed && data.botSpeed > 0) {
    botState.botSpeed = data.botSpeed;
  }

  room.bots.push(botState);
  room.playerStates.set(botState.id, {
    id: botState.id,
    name: botState.name,
    ready: true,
    alive: true,
    isBot: true,
    isSpectator: false,
    score: 0,
    garbageMultiplier: 1.0,
    totalGarbageSent: 0,
    totalGarbageReceived: 0,
  });

  broadcastRoomState(room);
}

function handleRemoveBot(ws, data) {
  if (!ws.roomCode || !ws.isHost) return;
  const room = rooms.get(ws.roomCode);
  if (!room || room.gameStarted) return;
  if (!room.bots) return;

  const botId = data.botId;
  room.bots = room.bots.filter(b => b.id !== botId);
  room.playerStates.delete(botId);

  broadcastRoomState(room);
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