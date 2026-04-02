/**
 * redis-store.js
 * Redis 持久化封装，用于 undercover-game。
 * - 仅序列化可序列化字段，排除 ws（WebSocket 对象）
 * - Redis 不可用时自动降级为纯内存模式（不崩溃）
 * - TTL 3600 秒（1 小时）
 */

const REDIS_KEY_PREFIX = 'undercover:room:';
const REDIS_ALL_ROOMS_KEY = 'undercover:rooms'; // Set，存所有房间 ID
const TTL = 3600;

let redisClient = null;
let redisAvailable = false;

// 尝试初始化 Redis 连接
function initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[Redis] REDIS_URL 未设置，以纯内存模式运行');
    return;
  }

  let Redis;
  try {
    Redis = require('ioredis');
  } catch (e) {
    console.warn('[Redis] ioredis 未安装，以纯内存模式运行');
    return;
  }

  try {
    redisClient = new Redis(url, {
      lazyConnect: false,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        // 重连策略：最多重试 3 次，之后放弃并降级
        if (times > 3) {
          console.warn('[Redis] 多次重连失败，降级为纯内存模式');
          redisAvailable = false;
          return null; // 停止重连
        }
        return Math.min(times * 500, 2000);
      }
    });

    redisClient.on('connect', () => {
      console.log('[Redis] 连接成功');
      redisAvailable = true;
    });

    redisClient.on('ready', () => {
      redisAvailable = true;
    });

    redisClient.on('error', (err) => {
      if (redisAvailable) {
        console.warn('[Redis] 连接错误，降级为纯内存模式:', err.message);
      }
      redisAvailable = false;
    });

    redisClient.on('close', () => {
      redisAvailable = false;
    });

  } catch (e) {
    console.warn('[Redis] 初始化失败，以纯内存模式运行:', e.message);
    redisClient = null;
    redisAvailable = false;
  }
}

/**
 * 检查 Redis 是否可用
 */
function isAvailable() {
  return redisAvailable && redisClient !== null;
}

/**
 * 序列化房间数据，排除 ws 字段
 * 深度处理 players 和 judge 对象
 */
function serializeRoom(roomData) {
  const serializable = { ...roomData };

  // 处理 judge（排除 ws）
  if (serializable.judge) {
    const { ws: _jws, ...judgeRest } = serializable.judge;
    serializable.judge = judgeRest;
  }

  // 处理 players（每个 player 排除 ws）
  if (serializable.players) {
    const playersClean = {};
    for (const [id, player] of Object.entries(serializable.players)) {
      const { ws: _pws, ...playerRest } = player;
      playersClean[id] = playerRest;
    }
    serializable.players = playersClean;
  }

  // 排除定时器句柄（不可序列化）
  delete serializable._discussTimer;
  delete serializable._discussionTimer;

  return serializable;
}

/**
 * 保存房间状态到 Redis
 * @param {string} roomId
 * @param {object} roomData - 内存中的房间对象（含 ws，会被自动排除）
 */
async function saveRoom(roomId, roomData) {
  if (!isAvailable()) return;
  try {
    const clean = serializeRoom(roomData);
    const json = JSON.stringify(clean);
    const key = REDIS_KEY_PREFIX + roomId;
    await redisClient.set(key, json, 'EX', TTL);
    await redisClient.sadd(REDIS_ALL_ROOMS_KEY, roomId);
    await redisClient.expire(REDIS_ALL_ROOMS_KEY, TTL);
  } catch (e) {
    console.warn(`[Redis] saveRoom(${roomId}) 失败:`, e.message);
    redisAvailable = false;
  }
}

/**
 * 从 Redis 加载房间状态
 * @param {string} roomId
 * @returns {object|null} 反序列化后的房间对象（ws 字段不存在/为 null），失败返回 null
 */
async function loadRoom(roomId) {
  if (!isAvailable()) return null;
  try {
    const key = REDIS_KEY_PREFIX + roomId;
    const json = await redisClient.get(key);
    if (!json) return null;
    const data = JSON.parse(json);
    // 确保 ws 字段为 null（重连时重新绑定）
    if (data.judge) data.judge.ws = null;
    if (data.players) {
      for (const player of Object.values(data.players)) {
        player.ws = null;
        // 补全缺少的字段默认值
        if (player.disconnected === undefined) player.disconnected = false;
        if (player.alive === undefined) player.alive = true;
      }
    }
    // 补全房间缺少的字段默认值
    if (data.descriptions === undefined) data.descriptions = [];
    if (data.allDescriptions === undefined) data.allDescriptions = [];
    if (data.describeOrder === undefined) data.describeOrder = [];
    if (data.describeIndex === undefined) data.describeIndex = 0;
    if (data.eliminated === undefined) data.eliminated = [];
    if (data.votes === undefined) data.votes = {};
    if (data.tieSocketIds === undefined) data.tieSocketIds = [];
    if (data.tieRound === undefined) data.tieRound = 0;
    if (data.playerSeqList === undefined) data.playerSeqList = [];
    if (data.aliveSeqList === undefined) data.aliveSeqList = [];
    if (data.submissions === undefined) data.submissions = {};
    return data;
  } catch (e) {
    console.warn(`[Redis] loadRoom(${roomId}) 失败:`, e.message);
    return null;
  }
}

/**
 * 加载所有房间 ID 列表
 * @returns {string[]}
 */
async function loadAllRoomIds() {
  if (!isAvailable()) return [];
  try {
    return await redisClient.smembers(REDIS_ALL_ROOMS_KEY);
  } catch (e) {
    console.warn('[Redis] loadAllRoomIds 失败:', e.message);
    return [];
  }
}

/**
 * 删除房间（游戏结束时调用）
 * @param {string} roomId
 */
async function deleteRoom(roomId) {
  if (!isAvailable()) return;
  try {
    const key = REDIS_KEY_PREFIX + roomId;
    await redisClient.del(key);
    await redisClient.srem(REDIS_ALL_ROOMS_KEY, roomId);
  } catch (e) {
    console.warn(`[Redis] deleteRoom(${roomId}) 失败:`, e.message);
  }
}

// 模块初始化时建立连接
initRedis();

module.exports = { isAvailable, saveRoom, loadRoom, loadAllRoomIds, deleteRoom };
