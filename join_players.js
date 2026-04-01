/**
 * 模拟7个AI玩家加入指定房间，等待法官操作
 * 玩家加入后保持连接，响应游戏事件（描述、投票等）
 */
const WebSocket = require('ws');
const BASE_URL = process.env.WS_URL || 'wss://web-production-dba7f.up.railway.app';
const ROOM_ID = process.env.ROOM_ID || 'JRKXTG';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(tag, msg) { console.log(`[${new Date().toISOString().substr(11,8)}][${tag}] ${msg}`); }
function send(ws, obj) { ws.send(JSON.stringify(obj)); }

const NAMES = ['小明','小红','小刚','小丽','小强','小美','小华'];
const P = {};

// 描述模板（稍微有变化，不那么机械）
const CIVILIAN_DESCS = [
  n => `${n}，这个词我很熟悉，生活中常见`,
  n => `想到${n}，感觉挺日常的`,
  n => `${n}这个概念很普遍，大家都知道`,
  n => `我觉得${n}跟我们的日常生活很贴近`,
];
const UNDERCOVER_DESCS = [
  () => `这个东西嘛，感觉用途挺广的`,
  () => `日常生活里随处可见的东西`,
  () => `大家应该都接触过，很普通`,
  () => `说实话这个我也挺熟悉的`,
];

function getDesc(p, idx) {
  if (p.role === 'undercover') return UNDERCOVER_DESCS[idx % UNDERCOVER_DESCS.length]();
  const word = p.word || '';
  return CIVILIAN_DESCS[idx % CIVILIAN_DESCS.length](word);
}

let globalDescIdx = 0;

async function connectPlayer(name, index) {
  const ws = new WebSocket(BASE_URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  P[name] = { ws, socketId: null, role: null, word: null, seq: null, alive: true, descCount: 0 };
  const p = P[name];

  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case 'welcome':
        p.socketId = msg.socketId;
        log(name, `已连接 socketId=${msg.socketId.substr(0,8)}...`);
        break;
      case 'room_state':
        // 静默
        break;
      case 'game_started':
        p.role = msg.role;
        const roleLabel = msg.role === 'undercover' ? '🕵️卧底' : `平民${msg.role}`;
        log(name, `身份=${roleLabel}`);
        break;
      case 'player_seq':
        (msg.players || []).forEach(pl => { if (pl.name === name) p.seq = pl.seq; });
        break;
      case 'your_word':
        p.word = msg.word || null;
        if (msg.word) log(name, `词语="${msg.word}"`);
        else log(name, `词语=(保密，只知${msg.wordLength}字)`);
        break;
      case 'your_turn_describe':
        log(name, `🎤 轮到我描述...`);
        setTimeout(() => {
          const desc = getDesc(p, globalDescIdx++);
          send(ws, { type: 'submit_description', text: desc });
          log(name, `✍️ "${desc}"`);
        }, 1000 + Math.random() * 1500); // 1-2.5秒延迟，模拟真人思考
        break;
      case 'description_update':
        // 静默（法官端会显示）
        break;
      case 'all_described':
        log('系统', `✅ 全员描述完毕，等待法官结束讨论`);
        break;
      case 'discussion_started':
        log('系统', `💬 讨论环节开始（${msg.duration}秒），等待法官触发投票`);
        break;
      case 'vote_started': {
        p.voteList = msg.players;
        const alivePlayers = msg.players || [];
        log(name, `🗳️ 投票开始，${alivePlayers.length}人存活`);
        // 随机投票（模拟真人投票）
        setTimeout(() => {
          const candidates = alivePlayers.filter(pl => pl.id !== p.socketId);
          if (candidates.length === 0) {
            send(ws, { type: 'submit_vote', target: null });
            log(name, `投票→弃票`);
            return;
          }
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          send(ws, { type: 'submit_vote', target: target.id });
          log(name, `投票→${target.name}`);
        }, 1500 + Math.random() * 2000);
        break;
      }
      case 'vote_result':
        if (msg.eliminatedName) log('系统', `💀 ${msg.eliminatedName}(${msg.eliminatedRole})被淘汰`);
        break;
      case 'tie_vote':
        log('系统', `⚖️ 平票！加时描述中...`);
        break;
      case 'peace_night':
        log('系统', `🌙 平安夜，无人淘汰`);
        break;
      case 'eliminated':
        p.alive = false;
        log(name, `💀 我被淘汰了！`);
        break;
      case 'game_over_undercover_wins':
        log('系统', `🏁 游戏结束：卧底胜！词A="${msg.wordA}" 词B="${msg.wordB}"`);
        break;
      case 'settlement_started':
        log('系统', `📋 进入结算，等待法官公布结果`);
        break;
      case 'game_ended':
        log('系统', `🏆 游戏结束：${msg.winner === 'undercover' ? '卧底胜' : '平民胜'}`);
        process.exit(0);
        break;
      case 'error':
        log(name, `⚠️ 错误：${msg.message}`);
        break;
    }
  });

  ws.on('close', () => {
    if (p.alive) log(name, '连接断开');
  });

  // 加入房间
  send(ws, { type: 'join_room', roomId: ROOM_ID, name });
  await sleep(300);
  // 自动准备
  send(ws, { type: 'player_ready' });
  log(name, `已加入房间 ${ROOM_ID} 并准备`);
}

async function main() {
  console.log('='.repeat(60));
  console.log(`🤖 AI玩家 连接到房间 ${ROOM_ID}`);
  console.log(`📡 服务器: ${BASE_URL}`);
  console.log('='.repeat(60));
  console.log('等待法官（真实玩家）开始游戏...\n');

  for (let i = 0; i < NAMES.length; i++) {
    await connectPlayer(NAMES[i], i);
    await sleep(200);
  }

  log('系统', `✅ 7个AI玩家全部就位，等待法官开始游戏`);
  log('系统', `法官操作：分发词语 → 开始描述 → 结束描述 → 等待/触发投票`);
  console.log('\n按 Ctrl+C 结束\n');

  // 保持进程运行
  await new Promise(() => {});
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
