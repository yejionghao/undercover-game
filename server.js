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
      players: {},   // socketId -> { id, name, ready, role, ws, seq, alive }
      phase: 'waiting', // waiting | started | describing | discussing | voting | settlement | ended
      wordA: null,
      wordB: null,
      wordLength: null,
      submissions: {},

      // 新增：多轮流程状态
      round: 0,                  // 当前轮次（从1开始）
      playerSeqList: [],         // 按序号排列的 socketId 列表
      aliveSeqList: [],          // 当前存活玩家 socketId（按序号）
      eliminated: [],            // 已淘汰的 socketId 列表
      descriptions: [],          // 本轮描述记录 [{round, seq, name, text}]
      allDescriptions: [],       // 所有轮次的描述记录
      describeOrder: [],         // 本轮描述顺序 [socketId]
      describeIndex: 0,          // 当前描述到第几个
      describeStartSocketId: null, // 本轮描述起点 socketId
      lastEliminatedSocketId: null, // 上轮被淘汰的 socketId
      lastPeaceNight: false,     // 上轮是否平安夜
      lastDescribeStartSocketId: null, // 上轮起点

      // 投票
      votes: {},                 // socketId -> targetSocketId | null
      tieSocketIds: [],          // 平票玩家
      tieRound: 0,               // 加时投票次数（0=正常，1=第一次加时）
    };
  }
  return rooms[roomId];
}

function broadcast(room, msg, excludeId) {
  const msgStr = JSON.stringify(msg);
  Object.values(room.players).forEach(p => {
    if (p.ws && p.ws.readyState === 1 && p.id !== excludeId) {
      p.ws.send(msgStr);
    }
  });
  if (room.judge && room.judge.ws && room.judge.ws.readyState === 1 && room.judge.id !== excludeId) {
    room.judge.ws.send(msgStr);
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function getRoomState(room) {
  const players = Object.values(room.players).map(p => ({
    id: p.id, name: p.name, ready: p.ready, seq: p.seq
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

// 获取存活玩家（按序号排列）
function getAlivePlayers(room) {
  return room.playerSeqList
    .map(id => room.players[id])
    .filter(p => p && p.alive);
}

// 从指定 socketId 之后的下一个存活玩家（循环）
function getNextAliveAfter(room, socketId) {
  const alive = getAlivePlayers(room);
  if (alive.length === 0) return null;
  const idx = room.playerSeqList.indexOf(socketId);
  if (idx === -1) return alive[0];
  // 从 idx+1 开始往后找存活
  for (let i = 1; i <= room.playerSeqList.length; i++) {
    const nextId = room.playerSeqList[(idx + i) % room.playerSeqList.length];
    if (room.players[nextId] && room.players[nextId].alive) return room.players[nextId];
  }
  return null;
}

// 构建本轮描述顺序（从 startSocketId 开始，只含存活玩家）
function buildDescribeOrder(room, startSocketId) {
  const order = [];
  const total = room.playerSeqList.length;
  const startIdx = room.playerSeqList.indexOf(startSocketId);
  if (startIdx === -1) return getAlivePlayers(room).map(p => p.id);
  for (let i = 0; i < total; i++) {
    const id = room.playerSeqList[(startIdx + i) % total];
    if (room.players[id] && room.players[id].alive) {
      order.push(id);
    }
  }
  return order;
}

// 检查游戏结束条件
function checkGameOver(room) {
  const alive = getAlivePlayers(room);
  const aliveUndercover = alive.filter(p => p.role === 'undercover');
  const aliveCivilians = alive.filter(p => p.role !== 'undercover');

  if (aliveUndercover.length === 0) {
    // 所有卧底淘汰 → 平民胜，进入结算
    return { over: true, winner: 'civilian' };
  }
  if (aliveCivilians.length <= aliveUndercover.length) {
    // 平民数 <= 卧底数 → 卧底胜
    return { over: true, winner: 'undercover' };
  }
  return { over: false };
}

wss.on('connection', (ws) => {
  const socketId = uuidv4();
  ws.socketId = socketId;
  let currentRoom = null;
  let isJudge = false;

  // 优化1：连接建立后立即注入 socketId
  sendTo(ws, { type: 'welcome', socketId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ===== 原有消息处理 =====

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
        room.players[socketId] = { id: socketId, name: msg.name, ready: false, ws, seq: 0, alive: true };
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

        // 分配序号（按 players 加入顺序，不打乱）
        const joinOrder = Object.values(room.players);
        joinOrder.forEach((p, i) => {
          p.seq = i + 1;
          p.alive = true;
        });
        room.playerSeqList = joinOrder.map(p => p.id);

        room.phase = 'started';

        const undercoverNames = shuffled.filter(p => p.role === 'undercover').map(p => p.name);
        players.forEach(p => {
          sendTo(p.ws, {
            type: 'game_started',
            role: p.role,
            seq: p.seq,
            undercoverList: p.role === 'undercover' ? undercoverNames : null
          });
        });
        sendTo(room.judge.ws, {
          type: 'game_started',
          role: 'judge',
          playerCount: total,
          sizes,
          // 法官看到所有玩家的身份和序号
          playerDetails: joinOrder.map(p => ({
            id: p.id, name: p.name, seq: p.seq, role: p.role
          }))
        });

        // 广播玩家序号
        broadcast(room, {
          type: 'player_seq',
          players: joinOrder.map(p => ({ id: p.id, name: p.name, seq: p.seq }))
        });
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

      // 保留旧的 start_settlement（从法官手动触发，兼容旧流程）
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
        if (room.judge) {
          const submissions = Object.values(room.submissions);
          const alivePlayers = getAlivePlayers(room);
          sendTo(room.judge.ws, {
            type: 'submissions_update',
            submissions,
            total: alivePlayers.length
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

        const undercoverSubs = subs.filter(s => s.role === 'undercover');
        const civilianSubs = subs.filter(s => s.role !== 'undercover');

        const anyUndercoverCorrect = undercoverSubs.length > 0 && undercoverSubs.some(correct);
        const groupASubs = civilianSubs.filter(s => s.role === 'A');
        const groupBSubs = civilianSubs.filter(s => s.role === 'B');
        const civilianWin = groupASubs.some(correct) && groupBSubs.some(correct);

        let winner;
        if (anyUndercoverCorrect) winner = 'undercover';
        else if (civilianWin) winner = 'civilian';
        else winner = 'undercover';

        const result = {
          type: 'game_ended',
          wordA: room.wordA,
          wordB: room.wordB,
          winner,
          submissions: subs.map(s => ({ ...s, correct: correct(s) }))
        };

        broadcast(room, result);
        sendTo(room.judge.ws, result);
        break;
      }

      // ===== 新增：多轮流程消息 =====

      case 'start_description_round': {
        // 法官发起开始本轮描述
        if (!currentRoom || !isJudge) return;
        const room = currentRoom;
        room.round += 1;
        room.descriptions = [];
        room.describeIndex = 0;
        room.phase = 'describing';
        room.tieRound = 0;

        // 确定起点
        let startPlayer;
        const alive = getAlivePlayers(room);

        if (room.round === 1) {
          // 第一轮：随机抽取存活玩家
          startPlayer = alive[Math.floor(Math.random() * alive.length)];
        } else if (room.lastPeaceNight) {
          // 平安夜后：从上轮起点的下一个开始
          startPlayer = getNextAliveAfter(room, room.lastDescribeStartSocketId);
        } else if (room.lastEliminatedSocketId) {
          // 上轮有淘汰：从被淘汰者的下一序号开始
          startPlayer = getNextAliveAfter(room, room.lastEliminatedSocketId);
        } else {
          startPlayer = alive[0];
        }

        room.describeStartSocketId = startPlayer.id;
        room.lastDescribeStartSocketId = startPlayer.id;
        room.lastPeaceNight = false;
        room.describeOrder = buildDescribeOrder(room, startPlayer.id);

        broadcast(room, {
          type: 'start_description_round',
          round: room.round,
          startPlayerSeq: startPlayer.seq,
          startPlayerName: startPlayer.name,
          startPlayerSocketId: startPlayer.id,
          aliveCount: alive.length
        });

        // 通知第一个该描述的玩家
        notifyNextDescribe(room);
        break;
      }

      case 'submit_description': {
        if (!currentRoom) return;
        const room = currentRoom;
        const player = room.players[socketId];
        if (!player) return;

        // 校验是否轮到此人
        const expectedId = room.describeOrder[room.describeIndex];
        if (expectedId !== socketId) {
          sendTo(ws, { type: 'error', message: '还没轮到你描述' });
          return;
        }

        const record = {
          round: room.round,
          seq: player.seq,
          name: player.name,
          text: msg.text || '',
          socketId: socketId
        };
        room.descriptions.push(record);
        room.allDescriptions.push(record);

        // 广播新描述
        broadcast(room, {
          type: 'description_update',
          round: room.round,
          seq: player.seq,
          name: player.name,
          text: msg.text || ''
        });

        // 移到下一个
        room.describeIndex++;
        if (room.describeIndex >= room.describeOrder.length) {
          // 所有人描述完毕
          if (room.judge) {
            sendTo(room.judge.ws, {
              type: 'all_described',
              round: room.round,
              descriptions: room.descriptions
            });
          }
        } else {
          notifyNextDescribe(room);
        }
        break;
      }

      case 'end_description_round': {
        // 法官结束描述环节，进入讨论
        if (!currentRoom || !isJudge) return;
        const room = currentRoom;
        room.phase = 'discussing';
        broadcast(room, {
          type: 'discussion_started',
          countdown: 300,
          round: room.round,
          descriptions: room.descriptions
        });
        // 优化2：服务端统一控制300秒倒计时，时间到自动触发投票
        if (room._discussionTimer) clearTimeout(room._discussionTimer);
        room._discussionTimer = setTimeout(() => {
          if (room.phase === 'discussing') {
            startVoting(room);
          }
          room._discussionTimer = null;
        }, 300000);
        break;
      }

      case 'vote_started_manual': {
        // 法官手动触发投票（倒计时结束后前端也可自动触发）
        if (!currentRoom || !isJudge) return;
        startVoting(currentRoom);
        break;
      }

      case 'submit_vote': {
        if (!currentRoom) return;
        const room = currentRoom;
        const voter = room.players[socketId];
        if (!voter || !voter.alive) return;
        if (room.phase !== 'voting') return;

        // target: socketId of voted player, or null for abstain
        room.votes[socketId] = msg.target || null;

        sendTo(ws, { type: 'vote_received' });

        // 检查是否所有存活玩家都投票了
        const alive = getAlivePlayers(room);
        const allVoted = alive.every(p => room.votes[p.id] !== undefined);
        if (allVoted) {
          processVotes(room);
        }
        break;
      }

      case 'next_round': {
        // 法官触发下一轮（平安夜后或结果公布后）
        if (!currentRoom || !isJudge) return;
        // 重置为 started 状态让法官可以再次点「开始本轮描述」
        currentRoom.phase = 'started';
        broadcast(currentRoom, { type: 'round_ready', round: currentRoom.round + 1 });
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
      // judge disconnected - broadcast to players
      broadcast(currentRoom, { type: 'error', message: '法官已断开连接' });
    } else if (currentRoom.players[socketId]) {
      delete currentRoom.players[socketId];
      broadcast(currentRoom, getRoomState(currentRoom));
    }
  });
});

// 通知下一个该描述的玩家
function notifyNextDescribe(room) {
  const nextId = room.describeOrder[room.describeIndex];
  const nextPlayer = room.players[nextId];
  if (!nextPlayer) return;

  // 广播当前轮到谁
  broadcast(room, {
    type: 'turn_to_describe',
    seq: nextPlayer.seq,
    name: nextPlayer.name,
    socketId: nextId,
    index: room.describeIndex,
    total: room.describeOrder.length
  });

  // 单独通知该玩家
  sendTo(nextPlayer.ws, {
    type: 'your_turn_describe',
    seq: nextPlayer.seq,
    round: room.round,
    descIndex: room.describeIndex,
    descTotal: room.describeOrder.length
  });
}

// 开始投票环节
function startVoting(room, tiePlayerIds) {
  room.phase = 'voting';
  room.votes = {};
  const alive = getAlivePlayers(room);

  // 如果是加时投票，只有平票的人
  const voteCandidates = tiePlayerIds
    ? alive.filter(p => tiePlayerIds.includes(p.id))
    : alive;

  // 广播投票开始
  broadcast(room, {
    type: 'vote_started',
    round: room.round,
    isTie: !!tiePlayerIds,
    alivePlayers: alive.map(p => ({ id: p.id, name: p.name, seq: p.seq })),
    voteCandidates: voteCandidates.map(p => ({ id: p.id, name: p.name, seq: p.seq }))
  });
}

// 处理投票结果
function processVotes(room) {
  const alive = getAlivePlayers(room);
  const voteCounts = {};
  const voteDetails = {};

  alive.forEach(p => {
    const target = room.votes[p.id];
    voteDetails[p.id] = {
      voterSeq: p.seq,
      voterName: p.name,
      targetId: target,
      targetName: target && room.players[target] ? room.players[target].name : null,
      targetSeq: target && room.players[target] ? room.players[target].seq : null
    };
    if (target) {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    }
  });

  const maxVotes = Math.max(0, ...Object.values(voteCounts));
  const topPlayers = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes);

  if (topPlayers.length === 1 && maxVotes > 0) {
    // 唯一最高票，淘汰该玩家
    const eliminatedId = topPlayers[0];
    const eliminatedPlayer = room.players[eliminatedId];
    eliminatedPlayer.alive = false;
    room.eliminated.push(eliminatedId);
    room.lastEliminatedSocketId = eliminatedId;
    room.lastPeaceNight = false;

    // 广播投票结果
    broadcast(room, {
      type: 'vote_result',
      round: room.round,
      voteDetails: Object.values(voteDetails),
      eliminatedId,
      eliminatedName: eliminatedPlayer.name,
      eliminatedSeq: eliminatedPlayer.seq,
      eliminatedRole: eliminatedPlayer.role,
      isTie: false
    });

    // 通知被淘汰玩家
    sendTo(eliminatedPlayer.ws, {
      type: 'eliminated',
      name: eliminatedPlayer.name,
      role: eliminatedPlayer.role,
      word: eliminatedPlayer.role === 'A' ? room.wordA :
            eliminatedPlayer.role === 'B' ? room.wordB : `（${room.wordLength}字）`
    });

    // 检查游戏结束
    const gameOver = checkGameOver(room);
    if (gameOver.over) {
      handleGameOver(room, gameOver.winner);
    } else {
      room.phase = 'started';
    }

  } else if (topPlayers.length > 1 && room.tieRound === 0) {
    // 第一次平票，进入加时描述
    room.tieRound = 1;
    room.tieSocketIds = topPlayers;
    // 描述顺序：只有平票的人
    room.describeOrder = topPlayers.filter(id => room.players[id] && room.players[id].alive);
    room.describeIndex = 0;
    room.descriptions = []; // 清空本轮描述（加时独立）

    broadcast(room, {
      type: 'tie_vote',
      round: room.round,
      tiePlayerIds: topPlayers,
      tiePlayerNames: topPlayers.map(id => room.players[id]?.name),
      tiePlayerSeqs: topPlayers.map(id => room.players[id]?.seq),
      voteDetails: Object.values(voteDetails)
    });

    room.phase = 'describing';
    // 通知第一个平票玩家描述
    notifyNextDescribe(room);

  } else if (topPlayers.length > 1 && room.tieRound === 1) {
    // 第二次还是平票 → 平安夜
    room.lastPeaceNight = true;
    room.lastEliminatedSocketId = null;
    room.tieSocketIds = [];
    room.tieRound = 0;

    broadcast(room, {
      type: 'peace_night',
      round: room.round,
      voteDetails: Object.values(voteDetails)
    });

    // 检查游戏结束（平安夜也需要检查）
    const gameOver = checkGameOver(room);
    if (gameOver.over) {
      handleGameOver(room, gameOver.winner);
    } else {
      room.phase = 'started';
    }

  } else {
    // 所有人都弃票 → 平安夜
    room.lastPeaceNight = true;
    room.lastEliminatedSocketId = null;
    room.tieRound = 0;

    broadcast(room, {
      type: 'peace_night',
      round: room.round,
      voteDetails: Object.values(voteDetails),
      reason: 'all_abstain'
    });

    const gameOver = checkGameOver(room);
    if (gameOver.over) {
      handleGameOver(room, gameOver.winner);
    } else {
      room.phase = 'started';
    }
  }
}

// 处理游戏结束
function handleGameOver(room, winner) {
  const alive = getAlivePlayers(room);
  const allPlayers = Object.values(room.players);

  if (winner === 'undercover') {
    room.phase = 'ended';
    // 卧底胜：直接公布结果，无需结算
    broadcast(room, {
      type: 'game_over_undercover_wins',
      wordA: room.wordA,
      wordB: room.wordB,
      winner: 'undercover',
      playerDetails: allPlayers.map(p => ({
        id: p.id, name: p.name, seq: p.seq, role: p.role, alive: p.alive
      }))
    });
  } else {
    // 平民胜：进入结算
    room.phase = 'settlement';
    room.submissions = {};
    broadcast(room, {
      type: 'game_ended_civilian_wins',
      message: '所有卧底已淘汰！进入结算环节'
    });
    broadcast(room, { type: 'settlement_started' });
    // 通知法官进入结算
    if (room.judge) {
      sendTo(room.judge.ws, {
        type: 'settlement_started',
        alivePlayers: alive.map(p => ({ id: p.id, name: p.name, seq: p.seq, role: p.role }))
      });
    }
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});