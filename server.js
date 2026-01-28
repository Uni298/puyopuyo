const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静的ファイルを提供
app.use(express.static(__dirname));

// ルーム管理
const rooms = new Map();

// ルームコード生成（6桁の英数字）
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// WebSocket接続処理
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
        handleDisconnect(ws);
    });
});

function handleMessage(ws, data) {
    switch (data.type) {
        case 'create_room':
            createRoom(ws, data);
            break;
        case 'join_room':
            joinRoom(ws, data);
            break;
        case 'leave_room':
            leaveRoom(ws);
            break;
        case 'start_game':
            startGame(ws);
            break;
        case 'game_update':
            broadcastGameUpdate(ws, data);
            break;
        case 'send_garbage':
            sendGarbage(ws, data);
            break;
        case 'game_over':
            handleGameOver(ws, data);
            break;
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
        guest: null,
        gameStarted: false
    };
    
    rooms.set(roomCode, room);
    ws.roomCode = roomCode;
    ws.isHost = true;
    
    ws.send(JSON.stringify({
        type: 'room_created',
        roomCode: roomCode
    }));
    
    console.log(`Room created: ${roomCode}`);
}

function joinRoom(ws, data) {
    const room = rooms.get(data.roomCode);
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'ルームが見つかりません'
        }));
        return;
    }
    
    if (room.guest) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'ルームは満員です'
        }));
        return;
    }
    
    room.guest = ws;
    ws.roomCode = data.roomCode;
    ws.isHost = false;
    
    // 両プレイヤーに通知
    room.host.send(JSON.stringify({
        type: 'player_joined',
        message: 'プレイヤーが参加しました'
    }));
    
    ws.send(JSON.stringify({
        type: 'room_joined',
        roomCode: data.roomCode
    }));
    
    console.log(`Player joined room: ${data.roomCode}`);
}

function startGame(ws) {
    if (!ws.roomCode || !ws.isHost) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room || !room.guest) return;
    
    room.gameStarted = true;
    
    // 両プレイヤーにゲーム開始を通知
    const startMessage = JSON.stringify({
        type: 'game_start'
    });
    
    room.host.send(startMessage);
    room.guest.send(startMessage);
    
    console.log(`Game started in room: ${ws.roomCode}`);
}

function leaveRoom(ws) {
    if (!ws.roomCode) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    if (ws.isHost) {
        // ホストが退出した場合、ルームを削除
        if (room.guest) {
            room.guest.send(JSON.stringify({
                type: 'room_closed',
                message: 'ホストが退出しました'
            }));
        }
        rooms.delete(ws.roomCode);
    } else {
        // ゲストが退出した場合
        room.guest = null;
        room.gameStarted = false;
        
        if (room.host) {
            room.host.send(JSON.stringify({
                type: 'player_left',
                message: 'プレイヤーが退出しました'
            }));
        }
    }
    
    console.log(`Player left room: ${ws.roomCode}`);
}

function handleDisconnect(ws) {
    leaveRoom(ws);
}

function broadcastGameUpdate(ws, data) {
    if (!ws.roomCode) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    const opponent = ws.isHost ? room.guest : room.host;
    if (opponent) {
        opponent.send(JSON.stringify({
            type: 'opponent_update',
            data: data.gameState
        }));
    }
}

function sendGarbage(ws, data) {
    if (!ws.roomCode) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    const opponent = ws.isHost ? room.guest : room.host;
    if (opponent) {
        opponent.send(JSON.stringify({
            type: 'receive_garbage',
            amount: data.amount,
            colors: data.colors,
            positions: data.positions
        }));
    }
    
    console.log(`Garbage sent: ${data.amount} puyos`);
}

function handleGameOver(ws, data) {
    if (!ws.roomCode) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    const opponent = ws.isHost ? room.guest : room.host;
    if (opponent) {
        opponent.send(JSON.stringify({
            type: 'opponent_game_over',
            winner: true
        }));
    }
    
    ws.send(JSON.stringify({
        type: 'game_result',
        winner: false
    }));
    
    // ゲームをリセット
    room.gameStarted = false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}`);
});
