const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// 词语库（两个词字数必须相同）
const WORD_PAIRS = {
  2: [
    ['西瓜', '冬瓜'], ['苹果', '梨子'], ['咖啡', '奶茶'], ['手机', '电脑'],
    ['微信', '钉钉'], ['火锅', '烤肉'], ['篮球', '足球'], ['太阳', '月亮'],
    ['老虎', '狮子'], ['飞机', '火车'], ['汽车', '摩托'], ['冰淇淋', '棒冰'],
    ['钢笔', '铅笔'], ['椅子', '凳子'], ['袜子', '手套']
  ],
  3: [
    ['麦当劳', '肯德基'], ['巧克力', '棉花糖'], ['冰激凌', '棒棒糖'],
    ['向日葵', '蒲公英'], ['草莓酱', '蓝莓酱'], ['小米粥', '南瓜粥'],
    ['运动鞋', '皮鞋靴'], ['太阳镜', '老花镜'], ['充电宝', '移动盘'],
    ['咖啡杯', '茶叶罐']
  ],
  4: [
    ['巧克力蛋糕', '奶油蛋糕'], ['星巴克咖啡', '瑞幸咖啡'],
    ['阿里巴巴', '京东商城'], ['美团外卖', '饿了么'],
    ['故宫博物院', '国家博物馆']
  ]
};

// 分组规则
function getGroupSizes(total) {
  const rules = {
    7:  [2, 3, 2],
    8:  [2, 3, 3],
    9:  [3, 3, 3],
    10: [3, 4, 3]
  };
  return rules[total] || null;
}

// 随机打乱数组
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 游戏房间状态
const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      judge: null,
      players: {},   // socketId -> { name, ready, role, ws }
      phase: 'waiting', // waiting | started | settlement | ended
      wordA: null,
      wordB: null,
      wordLength: null,
      submissions: {}
    };
  }
  return rooms[roomId];
}

function broadcast(room, msg, excludeId) {
  Object.values(room.players).forEach(p => {
    if (p.ws && p.ws.readyState === 1 && p.id !== excludeId) {
      p.ws.send(JSON.stringify(msg));
    }
  });
  if (room.judge && room.judge.ws && room.judge.ws.readyState === 1 && room.judge.id !== excludeId) {
    room.judge.ws.send(JSON.stringify(msg));
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function getRoomState(room) {
  const players = Object.values(room.players).map(p => ({
    id: p.id, name: p.name, ready: p.ready
  }));
  return {
    type: 'room_state',
    roomId: room.id,
    phase: room.phase,
    judge: room.judge ? { id: room.judge.id, name: room.judge.name } : null,
    players,
    playerCount: players.length
  };
}

wss.on('connection', (ws) => {
  const socketId = uuidv4();
  ws.socketId = socketId;
  let currentRoom = null;
  let isJudge = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'claim_judge': {
        const room = getOrCreateRoom(msg.roomId);
        if (room.judge) {
          sendTo(ws, { type: 'error', message: '该房间已有法官' });
          return;
        }
        room.judge = { id: socketId, name: msg.name, ws };
        currentRoom = room;
        isJudge = true;
        sendTo(ws, { type: 'judge_confirmed', roomId: room.id });
        broadcast(room, getRoomState(room));
        break;
      }

      case 'join_room': {
        const room = getOrCreateRoom(msg.roomId);
        if (room.phase !== 'waiting') {
          sendTo(ws, { type: 'error', message: '游戏已开始，无法加入' });
          return;
        }
        room.players[socketId] = { id: socketId, name: msg.name, ready: false, ws };
        currentRoom = room;
        sendTo(ws, { type: 'joined', roomId: room.id });
        broadcast(room, getRoomState(room));
        break;
      }

      case 'player_ready': {
        if (!currentRoom) return;
        if (currentRoom.players[socketId]) {
          currentRoom.players[socketId].ready = true;
          broadcast(currentRoom, getRoomState(currentRoom));
        }
        break;
      }

      case 'start_game': {
        if (!currentRoom || !isJudge) return;
        const room = currentRoom;
        const players = Object.values(room.players);
        const total = players.length;
        const sizes = getGroupSizes(total);
        if (!sizes) {
          sendTo(ws, { type: 'error', message: `不支持 ${total} 人游戏，请确保7-10人` });
          return;
        }
        const allReady = players.every(p => p.ready);
        if (!allReady) {
          sendTo(ws, { type: 'error', message: '还有玩家未准备' });
          return;
        }
        const shuffled = shuffle(players);
        const [sizeA, sizeB, sizeU] = sizes;
        shuffled.forEach((p, i) => {
          if (i < sizeA) p.role = 'A';
          else if (i < sizeA + sizeB) p.role = 'B';
          else p.role = 'undercover';
        });
        room.phase = 'started';
        const undercoverNames = shuffled.filter(p => p.role === 'undercover').map(p => p.name);
        players.forEach(p => {
          sendTo(p.ws, {
            type: 'game_started',
            role: p.role,
            undercoverList: p.role === 'undercover' ? undercoverNames : null
          });
        });
        sendTo(room.judge.ws, { type: 'game_started', role: 'judge', playerCount: total, sizes });
        break;
      }

      case 'distribute_words': {
        if (!currentRoom || !isJudge) return;
        const room = currentRoom;
        const { wordA, wordB, wordLength } = msg;
        room.wordA = wordA;
        room.wordB = wordB;
        room.wordLength = wordLength;
        Object.values(room.players).forEach(p => {
          if (p.role === 'A') sendTo(p.ws, { type: 'your_word', word: wordA, role: 'A' });
          else if (p.role === 'B') sendTo(p.ws, { type: 'your_word', word: wordB, role: 'B' });
          else if (p.role === 'undercover') sendTo(p.ws, { type: 'your_word', wordLength, role: 'undercover' });
        });
        sendTo(room.judge.ws, { type: 'words_distributed', wordA, wordB, wordLength });
        break;
      }

      case 'get_word_pair': {
        const len = parseInt(msg.wordLength);
        const pairs = WORD_PAIRS[len];
        if (!pairs || pairs.length === 0) {
          sendTo(ws, { type: 'error', message: `暂无 ${len} 字词对，请手动填写` });
          return;
        }
        const pair = pairs[Math.floor(Math.random() * pairs.length)];
        sendTo(ws, { type: 'word_pair_result', wordA: pair[0], wordB: pair[1] });
        break;
      }

      case 'start_settlement': {
        if (!currentRoom || !isJudge) return;
        currentRoom.phase = 'settlement';
        currentRoom.submissions = {};
        broadcast(currentRoom, { type: 'settlement_started' });
        break;
      }

      case 'submit_result': {
        if (!currentRoom) return;
        const room = currentRoom;
        const player = room.players[socketId];
        if (!player) return;
        room.submissions[socketId] = {
          name: player.name,
          role: player.role,
          groupA_names: msg.groupA_names,
          groupA_word: msg.groupA_word,
          groupB_names: msg.groupB_names,
          groupB_word: msg.groupB_word
        };
        sendTo(ws, { type: 'submit_ok' });
        // 通知法官有新提交
        if (room.judge) {
          const submissions = Object.values(room.submissions);
          sendTo(room.judge.ws, {
            type: 'submissions_update',
            submissions,
            total: Object.keys(room.players).length
          });
        }
        break;
      }

      case 'announce_result': {
        if (!currentRoom || !isJudge) return;
        const room = currentRoom;
        room.phase = 'ended';

        const subs = Object.values(room.submissions);
        const correct = (s) => s.groupA_word === room.wordA && s.groupB_word === room.wordB;

        // 卧底全部猜对 → 卧底胜；否则看平民是否全部猜对
        const undercoverSubs = subs.filter(s => s.role === 'undercover');
        const civilianSubs = subs.filter(s => s.role !== 'undercover');

        const allUndercoverCorrect = undercoverSubs.length > 0 && undercoverSubs.some(correct);
        const allCivilianCorrect = civilianSubs.length > 0 && civilianSubs.every(correct);

        let winner;
        if (allUndercoverCorrect) {
          // 卧底猜对，无论平民如何，卧底胜
          winner = 'undercover';
        } else if (allCivilianCorrect) {
          winner = 'civilian';
        } else {
          // 双方都没全对，平民胜（卧底未成功混淆）
          winner = 'civilian';
        }

        const result = {
          type: 'game_ended',
          wordA: room.wordA,
          wordB: room.wordB,
          winner, // 'undercover' | 'civilian'
          submissions: subs.map(s => ({
            ...s,
            correct: correct(s)
          }))
        };

        broadcast(room, result);
        sendTo(room.judge.ws, result);
        break;
      }

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    if (isJudge) {
      // judge disconnected
    } else if (currentRoom.players[socketId]) {
      delete currentRoom.players[socketId];
      broadcast(currentRoom, getRoomState(currentRoom));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
