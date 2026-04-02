/**
 * 6个机器人玩家
 * 用法：node bot_players.js <ROOM_ID>
 * 
 * 真人法官在浏览器里主持，真人玩家也在浏览器里加入
 * 机器人自动：加入房间 → 准备 → 发言 → 投票
 */
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');

const ROOM_ID = process.argv[2];
if (!ROOM_ID) {
  console.error('用法: node bot_players.js <ROOM_ID>');
  process.exit(1);
}

const BASE_URL = 'wss://web-production-dba7f.up.railway.app';
const PROXY = process.env.https_proxy || process.env.HTTPS_PROXY || 'http://127.0.0.1:8118';
const agent = new HttpsProxyAgent(PROXY);

const BOT_NAMES = process.env.BOT_COUNT
  ? ['阿猫', '阿狗', '小明', '小红', '老王', '阿强'].slice(0, parseInt(process.env.BOT_COUNT))
  : ['阿猫', '阿狗', '小明', '小红', '老王', '阿强'];

// 卧底发言库
const UNDERCOVER_DESCS = [
  '嗯…我觉得它挺特别的，说不清楚',
  '这个东西很有意思，大家都知道的',
  '我觉得它比较常见，生活中经常见到',
  '感觉跟大家描述的差不多，都是日常的',
  '这个嘛…颜色很鲜艳，很好看',
  '我不太会描述，但我知道它是啥',
];

// 平民发言库
const CIVILIAN_DESCS = [
  '这个东西很常见，大家应该都用过',
  '生活中经常能见到，很实用',
  '感觉跟大家说的类似，非常日常',
  '我觉得它是一种很普通的东西',
  '大家平时都会接触到的东西',
  '非常常见，我经常用',
  '生活必需品，很多人都有',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().substr(11, 8); }
function log(tag, msg) { console.log(`[${ts()}][${tag}] ${msg}`); }

function makeBot(name) {
  return {
    name,
    ws: null,
    socketId: null,
    role: null,
    word: null,
    wordLength: null,
    alive: true,
  };
}

function connect(bot) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE_URL, {
      agent,
      headers: { 'Origin': 'https://web-production-dba7f.up.railway.app' }
    });
    bot.ws = ws;
    ws.on('open', () => {
      log(bot.name, '已连接');
      resolve();
    });
    ws.on('error', e => {
      log(bot.name, `❌ 连接错误: ${e.message}`);
      reject(e);
    });
    ws.on('close', () => {
      log(bot.name, '连接关闭');
    });
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      handleMessage(bot, msg);
    });
  });
}

function send(bot, obj) {
  if (bot.ws && bot.ws.readyState === WebSocket.OPEN) {
    bot.ws.send(JSON.stringify(obj));
  }
}

function handleMessage(bot, msg) {
  switch (msg.type) {

    case 'welcome':
      bot.socketId = msg.socketId;
      log(bot.name, `socketId: ${msg.socketId}`);
      // 加入房间
      send(bot, { type: 'join_room', roomId: ROOM_ID, name: bot.name });
      log(bot.name, `加入房间 ${ROOM_ID}`);
      break;

    case 'room_state':
      // 加入后自动准备（如果还没准备）
      {
        const me = (msg.players || []).find(p => p.id === bot.socketId);
        if (me && !me.ready) {
          setTimeout(() => {
            send(bot, { type: 'player_ready' });
            log(bot.name, '已准备');
          }, 300 + Math.random() * 300);
        }
      }
      break;

    case 'game_started':
      bot.role = msg.role;
      log(bot.name, `游戏开始，身份: ${msg.role}`);
      break;

    case 'your_word':
      bot.word = msg.word || null;
      bot.wordLength = msg.wordLength || null;
      if (bot.role === 'undercover') {
        log(bot.name, `🕵️ 我是卧底，词语字数: ${msg.wordLength}`);
      } else {
        log(bot.name, `📖 我的词: ${msg.word}`);
      }
      break;

    case 'your_turn_describe':
      {
        const round = msg.round || '?';
        log(bot.name, `📢 轮到我发言，第${round}轮`);
        setTimeout(() => {
          const descs = bot.role === 'undercover' ? UNDERCOVER_DESCS : CIVILIAN_DESCS;
          const desc = descs[Math.floor(Math.random() * descs.length)];
          send(bot, { type: 'submit_description', text: desc });
          log(bot.name, `✍️ 发言: "${desc}"`);
        }, 500 + Math.random() * 800);
      }
      break;

    case 'vote_started':
      {
        if (!bot.alive) break;
        const candidates = msg.voteCandidates || msg.players || [];
        if (!candidates.length) {
          send(bot, { type: 'submit_vote', target: null });
          break;
        }
        // 随机投票，但不投自己
        const others = candidates.filter(p => p.id !== bot.socketId);
        const pool = others.length ? others : candidates;
        const target = pool[Math.floor(Math.random() * pool.length)];
        setTimeout(() => {
          send(bot, { type: 'submit_vote', target: target.id });
          log(bot.name, `🗳️ 投票给 ${target.name}`);
        }, 500 + Math.random() * 600);
      }
      break;

    case 'eliminated':
      bot.alive = false;
      log(bot.name, `💀 被淘汰，身份: ${msg.role}，词: ${msg.word || '?'}`);
      break;

    case 'game_ended':
      log(bot.name, `🎉 游戏结束！胜利方: ${msg.winner === 'undercover' ? '卧底' : '平民'}`);
      break;

    case 'error':
      log(bot.name, `⚠️ 错误: ${msg.message}`);
      break;
  }
}

(async () => {
  log('系统', `正在连接 ${BASE_URL}，房间: ${ROOM_ID}`);
  log('系统', `将加入 ${BOT_NAMES.length} 个机器人: ${BOT_NAMES.join(', ')}`);

  const bots = BOT_NAMES.map(makeBot);

  for (const bot of bots) {
    try {
      await connect(bot);
    } catch (e) {
      log(bot.name, `❌ 连接失败，跳过`);
    }
    await sleep(200);
  }

  log('系统', `✅ 所有机器人已连接，等待法官开始游戏...`);
  log('系统', `提示：法官在浏览器操作开始游戏后，机器人会自动响应`);

  // 保持进程运行
  process.on('SIGINT', () => {
    log('系统', '正在关闭...');
    bots.forEach(b => { try { b.ws.close(); } catch(e){} });
    process.exit(0);
  });
})();
