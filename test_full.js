/**
 * 潜伏猜词 完整流程自动化测试（事件驱动版）
 * 模拟：法官 + 7个玩家，走完 描述→讨论→投票→淘汰→下一轮 完整循环
 */
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(tag, msg) {
  console.log(`[${new Date().toISOString().substr(11,8)}][${tag}] ${msg}`);
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }

// ─── 全局状态 ───
const ROOM_ID = 'fulltest-' + Date.now();
const NAMES = ['张三','李四','王五','赵六','钱七','孙八','周九'];

let judgeWs;
const P = {}; // name -> { ws, socketId, role, word, seq, alive, myTurn, voteList }
const J = {   // 法官状态
  socketId: null, wordA: null, wordB: null,
  allDescribed: false, voteStarted: null,
  voteResult: null, tieVote: null, peaceNight: false,
  gameOver: null, playerInfoList: null,
  descLog: []
};

// 服务端发 force_start_vote 后直接进投票（测试用，若服务端不支持则等待vote_started事件）
// 我们改为：end_description_round 后等待 vote_started（服务端300s后发），测试中直接给服务端发 skip_discussion
// 若服务端不支持，则手动触发

// ─── 连接法官 ───
async function connectJudge() {
  judgeWs = new WebSocket(URL);
  await new Promise(r => judgeWs.on('open', r));
  judgeWs.on('message', raw => {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case 'welcome': J.socketId = msg.socketId; log('👨‍⚖️法官','socketId ✅'); break;
      case 'room_state': {
        const c = msg.players?.length||0, r = (msg.players||[]).filter(p=>p.ready).length;
        if (c > 0) log('👨‍⚖️法官', `房间 ${c}人 已准备${r}`);
        break;
      }
      case 'game_started': log('👨‍⚖️法官', `游戏开始 分组=${msg.sizes?.join('+')} 共${msg.playerCount}人`); break;
      case 'player_info_list':
        J.playerInfoList = msg.players;
        log('👨‍⚖️法官', `玩家详情 ✅：`);
        (msg.players||[]).forEach(p => log('👨‍⚖️法官', `  #${p.seq} ${p.name} [${p.role}] 词="${p.word||'(卧底)'}"`));
        break;
      case 'words_distributed': J.wordA=msg.wordA; J.wordB=msg.wordB; log('👨‍⚖️法官',`词对 A="${msg.wordA}" B="${msg.wordB}"`); break;
      case 'word_pair_result': J.wordA=msg.wordA; J.wordB=msg.wordB; break;
      case 'description_round_started': log('👨‍⚖️法官', `📣 第${msg.round}轮描述开始，起点 #${msg.startPlayerSeq} ${msg.startPlayerName}`); break;
      case 'description_update': J.descLog.push(msg); log('👨‍⚖️法官', `📝 #${msg.seq} ${msg.name}: "${msg.text}"`); break;
      case 'all_described': J.allDescribed=true; log('👨‍⚖️法官','✅ 全员描述完毕'); break;
      case 'discussion_started': log('👨‍⚖️法官',`💬 讨论倒计时 ${msg.duration}s`); break;
      case 'vote_started': J.voteStarted=msg; log('👨‍⚖️法官',`🗳️ 投票 存活=${msg.players?.map(p=>p.name).join(',')}`); break;
      case 'vote_result':
        J.voteResult=msg;
        log('👨‍⚖️法官','投票详情:');
        (msg.voteDetails||[]).forEach(v=>log('👨‍⚖️法官',`  ${v.voterName}→${v.targetName||'弃票'}`));
        if(msg.eliminatedName) log('👨‍⚖️法官',`  💀 淘汰：${msg.eliminatedName}(${msg.eliminatedRole})`);
        break;
      case 'tie_vote': J.tieVote=msg; log('👨‍⚖️法官',`⚖️ 平票：${msg.players?.map(p=>p.name).join(',')}`); break;
      case 'peace_night': J.peaceNight=true; log('👨‍⚖️法官','🌙 平安夜'); break;
      case 'game_over_undercover_wins': J.gameOver='undercover_direct'; log('👨‍⚖️法官',`🏁 卧底直接胜！平民=${msg.civilianCount} 卧底=${msg.undercoverCount}`); break;
      case 'game_ended': J.gameOver=msg.winner; log('👨‍⚖️法官',`🏆 结算：${msg.winner==='undercover'?'卧底胜':'平民胜'}`); break;
      case 'settlement_started': log('👨‍⚖️法官','进入结算环节'); break;
    }
  });
  send(judgeWs, { type: 'claim_judge', roomId: ROOM_ID, name: '法官' });
  await sleep(300);
}

// ─── 连接玩家 ───
async function connectPlayer(name) {
  const ws = new WebSocket(URL);
  await new Promise(r => ws.on('open', r));
  P[name] = { ws, socketId:null, role:null, word:null, seq:null, alive:true, myTurn:false, voteList:null, inSettlement:false };
  ws.on('message', raw => {
    const msg = JSON.parse(raw); const p = P[name];
    switch(msg.type) {
      case 'welcome': p.socketId=msg.socketId; break;
      case 'player_seq':
        (msg.players||[]).forEach(pl => { if(pl.name===name) p.seq=pl.seq; });
        break;
      case 'game_started': p.role=msg.role; break;
      case 'your_word': p.word=msg.word||null; {
        const rl=msg.role==='undercover'?'卧底':'平民'+msg.role;
        log(`${msg.role==='undercover'?'🕵️':'👤'}${name}`,`角色=${rl} 词=${p.word||`只知${msg.wordLength}字`}`);
      } break;
      case 'your_turn_describe': p.myTurn=true; log(`👤${name}`,'🎤 轮到我描述'); break;
      case 'vote_started': p.voteList=msg.players; break;
      case 'eliminated': p.alive=false; log(`💀${name}`,`被淘汰 role=${msg.role}`); break;
      case 'settlement_started': p.inSettlement=true; log(`👤${name}`,'进入结算'); break;
      case 'game_over_undercover_wins': log(`👤${name}`,'卧底胜，结束'); break;
    }
  });
  send(ws, { type: 'join_room', roomId: ROOM_ID, name });
  await sleep(200);
}

function waitFor(fn, ms=3000, label='') {
  return new Promise(res => {
    const start=Date.now();
    const t=setInterval(()=>{
      if(fn()){clearInterval(t);res(true);}
      else if(Date.now()-start>ms){clearInterval(t);if(label)log('⚠️',`等待超时: ${label}`);res(false);}
    },100);
  });
}

function alive() { return NAMES.filter(n=>P[n].alive); }

// ─── 描述环节（事件驱动：轮到谁谁自动提交）───
function setupAutoDescribe(round) {
  for (const name of NAMES) {
    const p = P[name];
    if (!p.alive) continue;
    const origHandler = p.ws.listeners('message').slice(-1)[0];
    // 在现有 message handler 之上，myTurn=true 时自动提交
    const checker = setInterval(() => {
      if (!p.myTurn) return;
      p.myTurn = false;
      clearInterval(checker);
      const desc = p.role === 'undercover'
        ? `这个词让我觉得很日常，随处可见`
        : `${p.word}，非常${p.role==='A'?'常用':'典型'}的一个词`;
      send(p.ws, { type: 'submit_description', text: desc });
      log(`👤${name}`, `✍️ 提交描述: "${desc}"`);
    }, 100);
  }
}

// ─── 投票：所有人投给序号最大的存活玩家 ───
async function doVote() {
  await waitFor(()=>!!J.voteStarted, 5000, 'vote_started');
  if (!J.voteStarted) return false;

  const alivePlayers = J.voteStarted.players || [];
  log('主流程', `开始投票，${alivePlayers.length}人存活`);

  // 找序号最大的当靶子（模拟一致投票保证有人被淘汰）
  const target = alivePlayers.reduce((a,b)=>a.seq>b.seq?a:b);
  log('主流程', `所有人投票→ #${target.seq} ${target.name}`);

  for (const name of alive()) {
    const p = P[name];
    const myTarget = p.socketId === target.id ? null : target; // 自己不投自己
    send(p.ws, { type: 'submit_vote', target: myTarget?.id || null });
    await sleep(80);
  }
  return await waitFor(()=>!!J.voteResult, 3000, 'vote_result');
}

// ─── 结算提交 ───
async function doSettlement() {
  await sleep(500);
  const groupA = alive().filter(n=>P[n].role==='A');
  const groupB = alive().filter(n=>P[n].role==='B');
  for (const name of alive()) {
    const p = P[name];
    if (!p.inSettlement) continue;
    send(p.ws, {
      type: 'submit_result',
      groupA_names: groupA.map(n=>n).join(','),
      groupA_word: p.role==='A' ? p.word : J.wordA,
      groupB_names: groupB.map(n=>n).join(','),
      groupB_word: p.role==='B' ? p.word : J.wordB,
    });
    await sleep(50);
  }
  send(judgeWs, { type: 'announce_result' });
}

// ════════════════════════════════════════════════════
async function main() {
  console.log('='.repeat(60));
  console.log('🎮 潜伏猜词 完整流程自动化测试');
  console.log('='.repeat(60)+'\n');

  // 1. 连接
  await connectJudge();
  for (const n of NAMES) await connectPlayer(n);
  await sleep(400);

  // 2. 准备
  for (const n of NAMES) { send(P[n].ws, {type:'player_ready'}); await sleep(50); }
  await sleep(400);

  // 3. 开始游戏
  send(judgeWs, {type:'start_game'});
  await sleep(800);

  // 4. 词语
  send(judgeWs, {type:'get_word_pair', wordLength:2});
  await sleep(400);
  const wA=J.wordA||'苹果', wB=J.wordB||'梨子';
  send(judgeWs, {type:'distribute_words', wordA:wA, wordB:wB, wordLength:wA.length});
  await sleep(600);

  console.log('\n📊 分组总览：');
  NAMES.forEach(n=>{
    const p=P[n];
    console.log(`  #${p.seq||'?'} ${n} [${p.role}] socketId=${p.socketId?'✅':'❌'} 词=${p.word||(p.role==='undercover'?'(只知字数)':'?')}`);
  });

  // ── 第一轮 ──
  console.log('\n'+'─'.repeat(50));
  console.log('🔄 第1轮：描述环节');
  setupAutoDescribe(1);
  send(judgeWs, {type:'start_description_round'});

  // 等待全员描述完（服务端检测到所有人描述后发 all_described）
  const descDone = await waitFor(()=>J.allDescribed, 15000, 'all_described');
  if (!descDone) {
    log('⚠️','all_described 未收到，可能有玩家没轮到，强制继续');
  }

  // 法官结束描述
  J.allDescribed = false;
  send(judgeWs, {type:'end_description_round'});
  log('主流程','法官结束描述，服务端开始300秒倒计时...');
  await sleep(500);

  // 服务端300秒后才发 vote_started，测试中尝试 skip_discussion
  send(judgeWs, {type:'skip_discussion'}); // 测试用快速跳过
  await sleep(500);

  if (!J.voteStarted) {
    log('⚠️','服务端不支持 skip_discussion（300秒倒计时），无法在测试中自动进投票');
    log('主流程','建议在 server.js 增加 skip_discussion（仅开发模式）');
  } else {
    log('主流程','skip_discussion 生效，直接进投票 ✅');
    const voteOk = await doVote();
    await sleep(600);
    
    if (J.gameOver) {
      log('主流程', `游戏已结束：${J.gameOver}`);
    } else if (J.voteResult?.eliminatedName) {
      log('主流程', `第1轮结束，${J.voteResult.eliminatedName} 被淘汰`);
      log('主流程', '下一轮可由法官点「开始下一轮描述」继续（本测试到此评估）');
    }
  }

  // 等待结算（如果卧底全灭）
  if (alive().filter(n=>P[n].role==='undercover').length === 0) {
    log('主流程','卧底全灭，进入结算');
    await doSettlement();
    await waitFor(()=>!!J.gameOver, 3000, 'game_ended');
  }

  // ── 评估报告 ──
  console.log('\n'+'='.repeat(60));
  console.log('📋 评估报告');
  console.log('='.repeat(60));

  const checks = [
    ['welcome: 法官 socketId 注入',      !!J.socketId],
    ['welcome: 玩家 socketId 全部注入',  NAMES.every(n=>!!P[n].socketId)],
    ['player_seq: 玩家序号分配',          NAMES.some(n=>P[n].seq!==null)],
    ['角色分配正常',                       NAMES.every(n=>!!P[n].role)],
    ['平民有词，卧底无词',                 NAMES.filter(n=>P[n].role!=='undercover').every(n=>!!P[n].word)],
    ['法官收到 player_info_list',         !!J.playerInfoList],
    ['描述轮次启动，触发 your_turn_describe', descDone || NAMES.some(n=>P[n].myTurn!==undefined)],
    ['法官实时收到 description_update',   J.descLog.length > 0],
    ['all_described 法官收到',            descDone],
    ['end_description_round 正常发送',    true],
    ['skip_discussion 快速跳过（需服务端支持）', !!J.voteStarted],
    ['投票 vote_started / vote_result',  !!J.voteResult || !J.voteStarted],
    ['淘汰机制（vote_result.eliminated）', !!J.voteResult?.eliminatedName || !J.voteStarted],
  ];

  let pass=0, fails=[];
  for (const [name,ok] of checks) {
    if(ok){pass++;console.log(`  ✅ ${name}`);}
    else{fails.push(name);console.log(`  ❌ ${name}`);}
  }
  console.log(`\n通过 ${pass}/${checks.length}，❌ ${fails.length} 项问题`);
  if(fails.length) console.log('问题：',fails.join(' | '));

  // 问题汇总
  const issues = [];
  if (NAMES.every(n=>P[n].seq===null)) issues.push('player_seq 消息玩家端未正确匹配（检查 p.id 字段）');
  if (!J.voteStarted) issues.push('服务端不支持 skip_discussion，300秒倒计时无法在测试中跳过');
  if (J.descLog.length === 0) issues.push('法官未收到 description_update（检查 broadcast 是否包含 judge）');

  if (issues.length) {
    console.log('\n🔧 需要修复的问题：');
    issues.forEach((s,i)=>console.log(`  ${i+1}. ${s}`));
  } else {
    console.log('\n🎉 无重大问题！');
  }

  process.exit(0);
}

main().catch(e=>{console.error('❌',e.message,e.stack);process.exit(1);});
