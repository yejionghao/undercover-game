/**
 * 潜伏猜词 多人局完整测试（7/8/9人）
 * 模拟完整流程：加入→准备→开始→分词→描述→讨论→投票→淘汰→下一轮→直到游戏结束
 */
const WebSocket = require('ws');
const BASE_URL = 'ws://localhost:3000';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ALL_NAMES = ['张三','李四','王五','赵六','钱七','孙八','周九','吴十','郑一'];

function log(tag, msg) {
  console.log(`[${new Date().toISOString().substr(11,8)}][${tag}] ${msg}`);
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitFor(fn, ms = 4000, label = '') {
  return new Promise(res => {
    const start = Date.now();
    const t = setInterval(() => {
      if (fn()) { clearInterval(t); res(true); }
      else if (Date.now() - start > ms) { clearInterval(t); if (label) log('⚠️', `超时: ${label}`); res(false); }
    }, 80);
  });
}

// ──────────────────────────────────────────────
async function runGame(totalPlayers) {
  const ROOM_ID = `test${totalPlayers}-${Date.now()}`;
  const names = ALL_NAMES.slice(0, totalPlayers);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🎮 ${totalPlayers}人局测试 [${names.join(' ')}]`);
  console.log('═'.repeat(60));

  let judgeWs;
  const J = { socketId: null, wordA: null, wordB: null, allDescribed: false,
               voteStarted: null, voteResult: null, peaceNight: false,
               gameOver: null, playerInfoList: null, descLog: [], tieVote: null };
  const P = {};

  // ─ 连接法官 ─
  judgeWs = new WebSocket(BASE_URL);
  await new Promise(r => judgeWs.on('open', r));
  judgeWs.on('message', raw => {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case 'welcome': J.socketId = msg.socketId; break;
      case 'game_started': log(`👨‍⚖️法官`, `游戏开始 分组=${msg.sizes?.join('+')} 共${msg.playerCount}人`); break;
      case 'player_info_list': J.playerInfoList = msg.players; break;
      case 'words_distributed': J.wordA = msg.wordA; J.wordB = msg.wordB; break;
      case 'word_pair_result': J.wordA = msg.wordA; J.wordB = msg.wordB; break;
      case 'description_update': J.descLog.push(msg); break;
      case 'all_described': J.allDescribed = true; break;
      case 'discussion_started': break;
      case 'vote_started': J.voteStarted = msg; break;
      case 'vote_result': J.voteResult = msg; break;
      case 'tie_vote': J.tieVote = msg; break;
      case 'peace_night': J.peaceNight = true; break;
      case 'game_over_undercover_wins': J.gameOver = 'undercover_direct'; break;
      case 'game_ended': J.gameOver = msg.winner; break;
    }
  });
  send(judgeWs, { type: 'claim_judge', roomId: ROOM_ID, name: '法官' });
  await sleep(200);

  // ─ 连接玩家 ─
  for (const name of names) {
    const ws = new WebSocket(BASE_URL);
    await new Promise(r => ws.on('open', r));
    P[name] = { ws, socketId: null, role: null, word: null, seq: null, alive: true, myTurn: false, voteList: null };
    ws.on('message', raw => {
      const msg = JSON.parse(raw); const p = P[name];
      switch (msg.type) {
        case 'welcome': p.socketId = msg.socketId; break;
        case 'player_seq': (msg.players || []).forEach(pl => { if (pl.name === name) p.seq = pl.seq; }); break;
        case 'game_started': p.role = msg.role; break;
        case 'your_word': p.word = msg.word || null; break;
        case 'your_turn_describe': p.myTurn = true; break;
        case 'vote_started': p.voteList = msg.players; break;
        case 'eliminated': p.alive = false; break;
        case 'game_over_undercover_wins': break;
      }
    });
    send(ws, { type: 'join_room', roomId: ROOM_ID, name });
    await sleep(150);
  }
  await sleep(400);

  // ─ 全员准备 ─
  for (const name of names) { send(P[name].ws, { type: 'player_ready' }); await sleep(40); }
  await sleep(400);

  // ─ 开始游戏 + 分词 ─
  send(judgeWs, { type: 'start_game' });
  await sleep(600);
  send(judgeWs, { type: 'get_word_pair', wordLength: 2 });
  await sleep(300);
  const wA = J.wordA || '苹果', wB = J.wordB || '梨子';
  send(judgeWs, { type: 'distribute_words', wordA: wA, wordB: wB, wordLength: wA.length });
  await sleep(500);

  // 输出分组
  const alive = () => names.filter(n => P[n].alive);
  const undercoverAlive = () => alive().filter(n => P[n].role === 'undercover');
  const civilianAlive = () => alive().filter(n => P[n].role !== 'undercover');
  console.log('\n📊 分组：');
  names.forEach(n => {
    const p = P[n];
    console.log(`  #${p.seq} ${n} [${p.role}] 词=${p.word || `(只知${wA.length}字)`} socketId=${p.socketId ? '✅' : '❌'}`);
  });

  // 自动描述处理器（轮到谁谁自动提交）
  function setupAutoDescribe() {
    const intervals = {};
    for (const name of names) {
      const p = P[name];
      intervals[name] = setInterval(() => {
        if (!p.alive || !p.myTurn) return;
        p.myTurn = false;
        const desc = p.role === 'undercover'
          ? `这个词我有自己的理解，比较特别`
          : `${p.word}在日常生活中很常见，大家都熟悉`;
        send(p.ws, { type: 'submit_description', text: desc });
      }, 80);
    }
    return () => Object.values(intervals).forEach(clearInterval);
  }

  let round = 0;
  const maxRounds = 10; // 最多10轮防死循环

  while (!J.gameOver && round < maxRounds) {
    round++;
    J.allDescribed = false;
    J.voteResult = null;
    J.voteStarted = null;
    J.tieVote = null;
    J.peaceNight = false;
    J.descLog = [];

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🔄 第${round}轮 | 存活 ${alive().length}人（平民${civilianAlive().length} 卧底${undercoverAlive().length}）`);

    // 描述环节
    const stopDescribe = setupAutoDescribe();
    send(judgeWs, { type: 'start_description_round' });
    const descOk = await waitFor(() => J.allDescribed, 12000, `第${round}轮 all_described`);
    stopDescribe();

    if (!descOk) {
      log('⚠️', `第${round}轮描述未完成，检查 describeOrder`);
      // 打印谁没提交
      const missing = alive().filter(n => !J.descLog.find(d => d.name === n));
      if (missing.length) log('⚠️', `未提交描述：${missing.join(',')}`);
    }

    // 结束描述 → 跳过讨论 → 投票
    send(judgeWs, { type: 'end_description_round' });
    await sleep(300);
    send(judgeWs, { type: 'skip_discussion' });
    await waitFor(() => !!J.voteStarted, 3000, `第${round}轮 vote_started`);

    if (!J.voteStarted) {
      log('⚠️', `vote_started 未收到，跳过本轮投票`);
      break;
    }

    // 投票：集中投序号最大的存活玩家（保证不平票）
    const votePlayers = J.voteStarted.players || [];
    if (votePlayers.length === 0) { log('⚠️', '投票玩家列表为空'); break; }
    const target = votePlayers.reduce((a, b) => a.seq > b.seq ? a : b);
    log('主流程', `投票目标 → #${target.seq} ${target.name}`);

    for (const name of alive()) {
      const p = P[name];
      const myTarget = p.socketId === target.id ? null : target;
      send(p.ws, { type: 'submit_vote', target: myTarget?.id || null });
      await sleep(60);
    }

    // 等待结果（可能是 vote_result 或 peace_night）
    const resultOk = await waitFor(() => !!J.voteResult || J.peaceNight || !!J.gameOver, 4000, `第${round}轮结果`);

    if (J.gameOver) {
      log('主流程', `游戏结束 → ${J.gameOver}`);
      break;
    }
    if (J.peaceNight) {
      log('主流程', `🌙 平安夜（异常：所有人集中投一人不该出现平安夜）`);
    }
    if (J.voteResult) {
      if (J.voteResult.eliminatedName) {
        log('主流程', `💀 淘汰 ${J.voteResult.eliminatedName}(${J.voteResult.eliminatedRole}) 第${round}轮`);
      }
      // 检查游戏是否自动结束（卧底全灭时服务端会发 game_over_undercover_wins 或 settlement_started）
      await sleep(400);
    }
  }

  if (!J.gameOver) {
    // 检查是否有卧底全灭的情况（结算入口）
    if (undercoverAlive().length === 0) {
      log('主流程', '卧底全灭，等待结算...');
      await waitFor(() => !!J.gameOver, 2000, 'game_over');
    }
  }

  // ──────── 评估 ────────
  const civilianTotal = names.filter(n => P[n].role !== 'undercover').length;
  const undercoverTotal = names.filter(n => P[n].role === 'undercover').length;
  const [aCount, bCount, uCount] = [
    names.filter(n => P[n].role === 'A').length,
    names.filter(n => P[n].role === 'B').length,
    undercoverTotal
  ];

  // 预期分组（按 getGroupSizes 规则）
  const expectedSizes = {
    7: [2,3,2], 8: [2,3,3], 9: [3,3,3], 10: [3,4,3]
  }[totalPlayers] || [];
  const groupMatch = expectedSizes.length === 0 || (
    aCount === expectedSizes[0] && bCount === expectedSizes[1] && uCount === expectedSizes[2]
  );

  const checks = [
    [`法官 socketId`, !!J.socketId],
    [`玩家 socketId 全注入`, names.every(n => !!P[n].socketId)],
    [`玩家序号分配`, names.every(n => P[n].seq !== null)],
    [`角色分配`, names.every(n => !!P[n].role)],
    [`分组规则 A+B+U=${expectedSizes.join('+')}`, groupMatch],
    [`平民有词`, names.filter(n=>P[n].role!=='undercover').every(n=>!!P[n].word)],
    [`卧底无词`, names.filter(n=>P[n].role==='undercover').every(n=>!P[n].word)],
    [`法官收到 player_info_list`, !!J.playerInfoList],
    [`描述环节正常`, J.descLog.length > 0],
    [`投票/淘汰流程`, !!J.voteResult],
    [`游戏有明确结束状态`, !!J.gameOver],
  ];

  let pass = 0, fails = [];
  for (const [name, ok] of checks) {
    if (ok) pass++;
    else fails.push(name);
  }

  console.log(`\n📋 ${totalPlayers}人局评估：${pass}/${checks.length} 通过${fails.length ? '，❌ '+fails.join(' | ') : ' ✅'}`);
  console.log(`   分组：A=${aCount} B=${bCount} 卧底=${uCount}（期望${expectedSizes.join('+')}）`);
  console.log(`   词对：A="${wA}" B="${wB}" | 共${round}轮 | 结果：${J.gameOver || '未结束'}`);

  // 关闭所有连接
  judgeWs.close();
  for (const n of names) P[n].ws.close();
  await sleep(300);

  return { totalPlayers, pass, total: checks.length, fails, rounds: round, gameOver: J.gameOver };
}

// ──────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('🎮 潜伏猜词 多人局批量测试 (7/8/9人)');
  console.log('='.repeat(60));

  const results = [];
  for (const n of [7, 8, 9]) {
    const r = await runGame(n);
    results.push(r);
    await sleep(800); // 等服务端清理房间
  }

  console.log('\n' + '═'.repeat(60));
  console.log('🏁 总结');
  console.log('═'.repeat(60));
  let allPass = true;
  for (const r of results) {
    const status = r.fails.length === 0 ? '✅' : '❌';
    if (r.fails.length) allPass = false;
    console.log(`  ${status} ${r.totalPlayers}人局：${r.pass}/${r.total}，${r.rounds}轮，${r.gameOver || '未结束'}`);
    if (r.fails.length) console.log(`     ❌ ${r.fails.join(' | ')}`);
  }
  if (allPass) console.log('\n🎉 全部通过！游戏可以正常运行。');
  else console.log('\n⚠️ 存在问题，请查看上方详情。');

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message, '\n', e.stack); process.exit(1); });
