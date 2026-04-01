/**
 * 加入指定 Room 的 7 个模拟玩家，并全部准备好
 * Usage: node join_room.js <roomId>
 */
const WebSocket = require('ws');
const ROOM_ID = process.argv[2] || '78MSAU';
const BASE_URL = 'wss://web-production-dba7f.up.railway.app';

const NAMES = ['阿猫','阿狗','小明','小红','老王','阿强','小美'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(name, msg) { console.log(`[${new Date().toISOString().substr(11,8)}][${name}] ${msg}`); }

async function joinPlayer(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE_URL);
    let joined = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join_room', roomId: ROOM_ID, name }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'joined') {
        log(name, `✅ 已加入房间 ${msg.roomId}`);
        joined = true;
        // 稍等一下再准备
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'player_ready' }));
          log(name, '✅ 已准备');
        }, 500 + Math.random() * 300);
      }
      if (msg.type === 'error') {
        log(name, `❌ 错误: ${msg.message}`);
      }
    });

    ws.on('error', (e) => log(name, `❌ 连接错误: ${e.message}`));
    ws.on('close', () => {
      if (joined) log(name, '连接关闭（正常）');
    });

    // 2 秒后 resolve（留 WS 连接保持存活）
    setTimeout(() => resolve(ws), 2000);
  });
}

(async () => {
  console.log(`\n📡 连接到房间 ${ROOM_ID}，加入 ${NAMES.length} 个玩家...\n`);
  const sockets = [];
  for (const name of NAMES) {
    const ws = await joinPlayer(name);
    sockets.push(ws);
    await sleep(300);
  }
  console.log(`\n✅ 全部 ${NAMES.length} 人已加入并准备，WS 保持连接中...`);
  console.log('按 Ctrl+C 断开\n');
  // 保持进程存活
  await new Promise(() => {});
})();
