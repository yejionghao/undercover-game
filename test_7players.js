/**
 * 7人完整局测试
 * 法官 + 6玩家，自动走完：创房→加入→准备→选词→描述→讨论→投票→直至胜利
 */
const WebSocket = require('ws');
const BASE_URL = 'ws://localhost:3000';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().substr(11,8); }
function log(tag, msg) { console.log(`[${ts()}][${tag}] ${msg}`); }

// ─── 每个 WS 客户端的状态 ───────────────────────────────────────
function makeClient(name, isJudge) {
  return {
    name, isJudge,
    ws: null,
    socketId: null,
    role: null,       // A / B / undercover
    word: null,
    wordLength: null,
    seq: null,
    alive: true,
    state: 'idle',    // idle|joined|ready|playing|eliminated|done
    msgs: [],         // 收到的所有消息
  };
}

function connect(client, onMsg) {
  return new Promise(resolve => {
    const ws = new WebSocket(BASE_URL);
    client.ws = ws;
    ws.on('open', () => resolve());
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      client.msgs.push(msg);
      onMsg(msg);
    });
    ws.on('error', e => log(client.name, `❌ WS错误: ${e.message}`));
    ws.on('close', () => {
      if (client.state !== 'done') log(client.name, '连接关闭');
    });
  });
}

function send(client, obj) {
  if (client.ws && client.ws.readyState === WebSocket.OPEN)
    client.ws.send(JSON.stringify(obj));
}

// ─── 主流程 ──────────────────────────────────────────────────────
(async () => {
  const ROOM_ID = 'T7' + Date.now().toString(36).toUpperCase().slice(-4);
  const PLAYER_NAMES = ['阿猫','阿狗','小明','小红','老王','阿强','小李'];

  const judge = makeClient('法官', true);
  const players = PLAYER_NAMES.map(n => makeClient(n, false));
  const all = [judge, ...players];

  // 全局游戏状态（法官视角）
  let wordA = '', wordB = '', wordLen = 4;
  let judgePlayerDetails = [];
  let descRound = 0;
  let gameOver = false;
  let phase = 'waiting'; // waiting|word|describing|discussing|voting|result|ended

  // 事件回调注册
  const handlers = {}; // type -> [fn]
  function on(type, fn) {
    handlers[type] = handlers[type] || [];
    handlers[type].push(fn);
  }
  function emit(client, msg) {
    (handlers[msg.type] || []).forEach(fn => fn(client, msg));
  }

  // ─── 连接并注册消息处理 ─────────────────────────────────────────
  for (const c of all) {
    await connect(c, msg => emit(c, msg));
    await sleep(80);
  }
  log('系统', `✅ ${all.length} 个连接建立完成`);

  // ─── 处理 welcome（获取 socketId）────────────────────────────
  on('welcome', (c, msg) => { c.socketId = msg.socketId; });

  // ─── 处理 room_state ─────────────────────────────────────────
  on('room_state', (c, msg) => {
    if (c === judge) {
      log('法官', `房间人数: ${msg.players.length}，全部准备: ${msg.players.every(p=>p.ready)}`);
    }
  });

  // ─── 处理 game_started ───────────────────────────────────────
  on('game_started', (c, msg) => {
    c.role = msg.role;
    if (msg.seq) c.seq = msg.seq;
    if (c === judge) {
      judgePlayerDetails = msg.playerDetails || [];
      log('法官', `游戏开始！玩家分组: ${JSON.stringify(judgePlayerDetails.map(p=>p.role+p.name))}`);
      phase = 'word';
    } else {
      log(c.name, `我的身份: ${msg.role}`);
    }
  });

  // ─── 处理 player_seq ─────────────────────────────────────────
  on('player_seq', (c, msg) => {
    msg.players.forEach(p => {
      const found = all.find(a => a.socketId === p.id);
      if (found) { found.seq = p.seq; }
    });
  });

  // ─── 处理 your_word ──────────────────────────────────────────
  on('your_word', (c, msg) => {
    c.word = msg.word || null;
    c.wordLength = msg.wordLength || null;
    if (c.role === 'undercover') {
      log(c.name, `🕵️ 我是卧底，词语字数: ${msg.wordLength}`);
    } else {
      log(c.name, `📖 我的词: ${msg.word}`);
    }
  });

  // ─── 处理 words_distributed ──────────────────────────────────
  on('words_distributed', (c, msg) => {
    if (c === judge) {
      wordA = msg.wordA; wordB = msg.wordB; wordLen = msg.wordLength;
      log('法官', `✅ 词语已下发: A=${wordA} B=${wordB}`);
      phase = 'ready_to_desc';
    }
  });

  // ─── 处理 player_info_list ───────────────────────────────────
  on('player_info_list', (c, msg) => {
    if (c === judge) {
      judgePlayerDetails = msg.players;
      log('法官', `玩家详情表已收到，共 ${msg.players.length} 人`);
      judgePlayerDetails.forEach(p => log('法官', `  #${p.seq} ${p.name} [${p.role}] 词:${p.word||'?字'}`));
    }
  });

  // ─── 处理 your_turn_describe ─────────────────────────────────
  on('your_turn_describe', (c, msg) => {
    if (c === judge) return;
    log(c.name, `📢 轮到我发言了！第${msg.round}轮，第${msg.descIndex+1}个`);
    setTimeout(() => {
      const desc = c.role === 'undercover'
        ? `嗯…我觉得它很特别，说不清楚`
        : `这个东西很常见，大家应该都用过`;
      send(c, { type: 'submit_description', text: desc });
      log(c.name, `✍️ 发言: "${desc}"`);
    }, 300 + Math.random()*200);
  });

  // ─── 处理 start_description_round ────────────────────────────
  on('start_description_round', (c, msg) => {
    descRound = msg.round;
    if (c === judge) {
      log('法官', `📣 第${msg.round}轮描述开始`);
    }
  });

  // ─── 处理 all_described ──────────────────────────────────────
  on('all_described', (c, msg) => {
    if (c === judge) {
      log('法官', `✅ 本轮所有人发言完毕，触发结束本轮`);
      setTimeout(() => send(judge, { type: 'end_description_round' }), 500);
    }
  });

  // ─── 处理 discussion_started ─────────────────────────────────
  on('discussion_started', (c, msg) => {
    if (c === judge) {
      log('法官', `💬 讨论开始，发送跳过讨论指令`);
      setTimeout(() => send(judge, { type: 'skip_discussion' }), 800);
    }
  });

  // ─── 处理 vote_started ───────────────────────────────────────
  on('vote_started', (c, msg) => {
    if (c === judge) return;
    if (!c.alive) return;
    log(c.name, `🗳️ 收到投票请求，候选人: ${(msg.players||[]).map(p=>p.name).join(',')}`);
    // 随机投票（卧底会被猜测）
    const candidates = msg.voteCandidates || msg.players || [];
    if (!candidates.length) {
      send(c, { type: 'submit_vote', target: null });
      return;
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    setTimeout(() => {
      send(c, { type: 'submit_vote', target: target.id });
      log(c.name, `投票给 ${target.name}`);
    }, 300 + Math.random()*400);
  });

  // ─── 处理 vote_result ────────────────────────────────────────
  on('vote_result', (c, msg) => {
    if (c === judge) {
      if (msg.eliminatedId) {
        log('法官', `💀 ${msg.eliminatedName} 被淘汰（${msg.eliminatedRole}）`);
        const ec = all.find(a => a.socketId === msg.eliminatedId);
        if (ec) ec.alive = false;
      }
    }
  });

  // ─── 处理 round_ready ────────────────────────────────────────
  on('round_ready', (c, msg) => {
    if (c === judge) {
      log('法官', `🔁 第${msg.round}轮就绪，开始下一轮描述`);
      setTimeout(() => send(judge, { type: 'start_description_round' }), 500);
    }
  });

  // ─── 处理 eliminated ─────────────────────────────────────────
  on('eliminated', (c, msg) => {
    c.alive = false;
    log(c.name, `💀 我被淘汰了，身份: ${msg.role}，词: ${msg.word}`);
  });

  // ─── 处理 game_over_undercover_wins ──────────────────────────
  on('game_over_undercover_wins', (c, msg) => {
    if (c === judge) {
      log('法官', `🕵️ 游戏结束！卧底胜利！词语: A=${msg.wordA} B=${msg.wordB}`);
      gameOver = true;
    }
  });

  // ─── 处理 game_ended ─────────────────────────────────────────
  on('game_ended', (c, msg) => {
    if (c === judge) {
      log('法官', `🎉 游戏结束！${msg.winner === 'undercover' ? '卧底' : '平民'}胜利！`);
      gameOver = true;
    }
  });

  // ─── 处理 settlement_started ─────────────────────────────────
  on('settlement_started', (c, msg) => {
    if (c === judge) return;
    if (!c.alive) return;
    log(c.name, `📝 进入结算，提交猜测`);
    setTimeout(() => {
      send(c, {
        type: 'submit_result',
        groupA_names: '小明,小红',
        groupA_word: wordA || '猜词',
        groupB_names: '老王,阿强',
        groupB_word: wordB || '猜词',
      });
    }, 500);
  });

  // ─── 处理 submissions_update ─────────────────────────────────
  on('submissions_update', (c, msg) => {
    if (c !== judge) return;
    log('法官', `📊 结算进度: ${msg.submissions.length}/${msg.total}`);
    if (msg.submissions.length >= msg.total) {
      setTimeout(() => {
        log('法官', `📢 宣布游戏结束`);
        send(judge, { type: 'announce_result' });
      }, 800);
    }
  });

  // ─── 开始流程 ────────────────────────────────────────────────
  await sleep(300);

  // 法官创建房间
  send(judge, { type: 'claim_judge', roomId: ROOM_ID, name: '法官' });
  log('法官', `创建房间 ${ROOM_ID}`);
  await sleep(500);

  // 玩家逐一加入
  for (const p of players) {
    send(p, { type: 'join_room', roomId: ROOM_ID, name: p.name });
    log(p.name, `加入房间`);
    await sleep(200);
  }
  await sleep(800);

  // 全部准备
  for (const p of players) {
    send(p, { type: 'player_ready' });
    log(p.name, '准备！');
    await sleep(100);
  }
  await sleep(800);

  // 法官开始游戏
  log('法官', '触发开始游戏');
  send(judge, { type: 'start_game' });
  await sleep(800);

  // 法官下发词语（自动模式，字数4）
  log('法官', '获取词对（4字）');
  send(judge, { type: 'get_word_pair', wordLength: 4 });
  await sleep(1000);

  // 从 word_pair_result 消息取词
  const wpr = judge.msgs.find(m => m.type === 'word_pair_result');
  if (!wpr) {
    log('法官', '⚠️ 未收到词对，用默认词语');
    wordA = '珍珠奶茶'; wordB = '抹茶拿铁';
  } else {
    wordA = wpr.wordA; wordB = wpr.wordB;
  }
  log('法官', `下发词语: A=${wordA} B=${wordB}`);
  send(judge, { type: 'distribute_words', wordA, wordB, wordLength: 4 });
  await sleep(800);

  // 法官开始第一轮描述
  log('法官', '开始第一轮描述');
  send(judge, { type: 'start_description_round' });

  // 等待游戏结束（最多90秒）
  let waited = 0;
  while (!gameOver && waited < 90000) {
    await sleep(500);
    waited += 500;
  }

  if (gameOver) {
    log('系统', '✅ 游戏正常结束！');
  } else {
    log('系统', '⚠️ 超时，游戏未结束');
  }

  // 打印存活情况
  log('系统', '─── 最终状态 ───');
  all.forEach(c => {
    if (!c.isJudge) log(c.name, `身份:${c.role||'?'} 存活:${c.alive} 词:${c.word||c.wordLength+'字'}`);
  });

  // 延迟关闭
  await sleep(1000);
  all.forEach(c => { try { c.ws.close(); } catch(e){} });
  process.exit(0);
})();
