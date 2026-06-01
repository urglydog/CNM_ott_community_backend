const Redis = require("ioredis");

const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = Number(process.env.REDIS_PORT || 6379);
const redisRequired =
  String(process.env.REDIS_REQUIRED || "false").toLowerCase() === "true";

const memoryStore = new Map();
const memoryTimers = new Map();

function clearMemoryTimer(key) {
  const timer = memoryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    memoryTimers.delete(key);
  }
}

function setMemoryValue(key, value, ttlSeconds) {
  memoryStore.set(key, value);
  clearMemoryTimer(key);

  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    const timer = setTimeout(() => {
      memoryStore.delete(key);
      memoryTimers.delete(key);
    }, ttlSeconds * 1000);

    memoryTimers.set(key, timer);
  }
}

function createMemoryRedisClient() {
  return {
    mode: "memory",
    status: "ready",
    async get(key) {
      return memoryStore.has(key) ? memoryStore.get(key) : null;
    },
    async set(key, value, ...args) {
      let ttlSeconds = null;

      for (let index = 0; index < args.length; index += 1) {
        if (String(args[index]).toUpperCase() === "EX") {
          ttlSeconds = Number(args[index + 1] || 0);
          break;
        }
      }

      setMemoryValue(key, value, ttlSeconds);
      return "OK";
    },
    async del(key) {
      clearMemoryTimer(key);
      const existed = memoryStore.delete(key);
      return existed ? 1 : 0;
    },
    async expire(key, seconds) {
      if (!memoryStore.has(key)) {
        return 0;
      }

      setMemoryValue(key, memoryStore.get(key), Number(seconds || 0));
      return 1;
    },
    on() {
      return this;
    },
    async quit() {
      return "OK";
    },
  };
}

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy(times) {
    if (times > 2) {
      return null;
    }

    return Math.min(times * 200, 500);
  },
});

const memoryRedis = createMemoryRedisClient();
let fallbackWarned = false;
let modeLogged = false;

function warnMemoryFallback(message) {
  if (fallbackWarned) {
    return;
  }

  fallbackWarned = true;
  console.warn(message);
}

function logRedisMode(mode, detail) {
  if (modeLogged) {
    return;
  }

  modeLogged = true;
  console.log(`[BOOT] Redis mode: ${mode}${detail ? ` (${detail})` : ""}`);
}

async function getActiveRedisClient() {
  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }

    logRedisMode("real", `${redisHost}:${redisPort}`);
    return redis;
  } catch (error) {
    if (redisRequired) {
      throw error;
    }

    warnMemoryFallback(
      `[redisConfig] Redis unavailable at ${redisHost}:${redisPort}. Falling back to in-memory store for dev.`,
    );
    logRedisMode("memory fallback", "dev-only in-process store");
    return memoryRedis;
  }
}

redis.on("connect", () => {
  console.log(`Connected to Redis at ${redisHost}:${redisPort}`);
});

redis.on("error", (err) => {
  if (redisRequired) {
    console.error("Redis error:", err);
    return;
  }

  warnMemoryFallback(
    `[redisConfig] Redis connection failed (${err.message}). Using in-memory fallback.`,
  );
});

getActiveRedisClient().catch((error) => {
  if (redisRequired) {
    console.error("[BOOT] Redis startup check failed:", error.message);
  }
});

const redisClient = {
  mode: "hybrid",
  async get(key) {
    const client = await getActiveRedisClient();
    return client.get(key);
  },
  async set(key, value, ...args) {
    const client = await getActiveRedisClient();
    return client.set(key, value, ...args);
  },
  async del(key) {
    const client = await getActiveRedisClient();
    return client.del(key);
  },
  async expire(key, seconds) {
    const client = await getActiveRedisClient();
    return client.expire(key, seconds);
  },
  on(event, handler) {
    redis.on(event, handler);
    return this;
  },
  async quit() {
    if (redis.status === "ready" || redis.status === "connecting") {
      return redis.quit();
    }

    return memoryRedis.quit();
  },
};

module.exports = redisClient;
