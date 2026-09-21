const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "koakuma-level.db");
const OLD_JSON_FILE = path.join(DATA_DIR, "data.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    tickets INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    voice_seconds INTEGER NOT NULL DEFAULT 0,
    last_chat_xp_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    notify_channel_id TEXT,
    exchange_channel_id TEXT,
    season_channel_id TEXT,
    join_leave_channel_id TEXT,
    last_reset_season TEXT
  );

  CREATE TABLE IF NOT EXISTS excluded_voice_channels (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    used_tickets INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS giveaways (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    prize TEXT NOT NULL,
    minimum_level INTEGER NOT NULL DEFAULT 0,
    deadline_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    winner_user_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    used_tickets INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id),
    FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
  );


  CREATE TABLE IF NOT EXISTS ticket_shop_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    required_tickets INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`);

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn("guilds", "season_channel_id", "TEXT");
ensureColumn("guilds", "join_leave_channel_id", "TEXT");
ensureColumn("guilds", "last_reset_season", "TEXT");
ensureColumn("applications", "product_id", "INTEGER");
ensureColumn("applications", "product_name", "TEXT");

const getUserStmt = db.prepare(`
  SELECT
    guild_id AS guildId,
    user_id AS userId,
    xp,
    level,
    tickets,
    messages,
    voice_seconds AS voiceSeconds,
    last_chat_xp_at AS lastChatXpAt
  FROM users
  WHERE guild_id = ? AND user_id = ?
`);

const insertUserStmt = db.prepare(`
  INSERT OR IGNORE INTO users (guild_id, user_id)
  VALUES (?, ?)
`);

const updateUserStmt = db.prepare(`
  UPDATE users SET
    xp = ?,
    level = ?,
    tickets = ?,
    messages = ?,
    voice_seconds = ?,
    last_chat_xp_at = ?
  WHERE guild_id = ? AND user_id = ?
`);

const userCache = new Map();
const guildCache = new Map();
let saveTimer = null;

function userKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getUser(guildId, userId) {
  const key = userKey(guildId, userId);
  if (userCache.has(key)) return userCache.get(key);

  insertUserStmt.run(guildId, userId);
  const row = getUserStmt.get(guildId, userId);

  const user = {
    guildId: row.guildId,
    userId: row.userId,
    xp: Number(row.xp),
    level: Number(row.level),
    tickets: Number(row.tickets),
    messages: Number(row.messages),
    voiceSeconds: Number(row.voiceSeconds),
    lastChatXpAt: Number(row.lastChatXpAt)
  };

  userCache.set(key, user);
  return user;
}

function loadGuild(guildId) {
  db.prepare(`
    INSERT OR IGNORE INTO guilds (guild_id)
    VALUES (?)
  `).run(guildId);

  const row = db.prepare(`
    SELECT guild_id, notify_channel_id, exchange_channel_id,
      season_channel_id, join_leave_channel_id, last_reset_season
    FROM guilds
    WHERE guild_id = ?
  `).get(guildId);

  const excluded = db.prepare(`
    SELECT channel_id
    FROM excluded_voice_channels
    WHERE guild_id = ?
  `).all(guildId).map(r => r.channel_id);

  return {
    notifyChannelId: row.notify_channel_id ?? null,
    exchangeChannelId: row.exchange_channel_id ?? null,
    seasonChannelId: row.season_channel_id ?? null,
    joinLeaveChannelId: row.join_leave_channel_id ?? null,
    lastResetSeason: row.last_reset_season ?? null,
    excludedVoiceChannelIds: excluded
  };
}

function getGuild(guildId) {
  if (!guildCache.has(guildId)) {
    guildCache.set(guildId, loadGuild(guildId));
  }
  return guildCache.get(guildId);
}

function saveUser(user) {
  updateUserStmt.run(
    Math.max(0, Math.floor(user.xp)),
    Math.max(0, Math.floor(user.level)),
    Math.max(0, Math.floor(user.tickets)),
    Math.max(0, Math.floor(user.messages)),
    Math.max(0, Math.floor(user.voiceSeconds)),
    Math.max(0, Math.floor(user.lastChatXpAt)),
    user.guildId,
    user.userId
  );
}

function saveGuild(guildId, guild) {
  db.prepare(`
    INSERT INTO guilds (
      guild_id, notify_channel_id, exchange_channel_id, season_channel_id, join_leave_channel_id, last_reset_season
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      notify_channel_id = excluded.notify_channel_id,
      exchange_channel_id = excluded.exchange_channel_id,
      season_channel_id = excluded.season_channel_id,
      join_leave_channel_id = excluded.join_leave_channel_id,
      last_reset_season = excluded.last_reset_season
  `).run(
    guildId,
    guild.notifyChannelId ?? null,
    guild.exchangeChannelId ?? null,
    guild.seasonChannelId ?? null,
    guild.joinLeaveChannelId ?? null,
    guild.lastResetSeason ?? null
  );

  db.prepare(`
    DELETE FROM excluded_voice_channels
    WHERE guild_id = ?
  `).run(guildId);

  const insertExcluded = db.prepare(`
    INSERT OR IGNORE INTO excluded_voice_channels (guild_id, channel_id)
    VALUES (?, ?)
  `);

  for (const channelId of guild.excludedVoiceChannelIds ?? []) {
    insertExcluded.run(guildId, channelId);
  }
}

function saveNow() {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const user of userCache.values()) saveUser(user);
    for (const [guildId, guild] of guildCache.entries()) saveGuild(guildId, guild);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      saveNow();
    } catch (error) {
      console.error("SQLite保存失敗:", error);
    }
  }, 300);
}

function allUsersForGuild(guildId) {
  saveNow();
  return db.prepare(`
    SELECT
      guild_id AS guildId,
      user_id AS userId,
      xp,
      level,
      tickets,
      messages,
      voice_seconds AS voiceSeconds,
      last_chat_xp_at AS lastChatXpAt
    FROM users
    WHERE guild_id = ?
  `).all(guildId).map(row => ({
    ...row,
    xp: Number(row.xp),
    level: Number(row.level),
    tickets: Number(row.tickets),
    messages: Number(row.messages),
    voiceSeconds: Number(row.voiceSeconds),
    lastChatXpAt: Number(row.lastChatXpAt)
  }));
}

function addApplication(app) {
  db.prepare(`
    INSERT INTO applications (
      id, guild_id, user_id, note, used_tickets, created_at, status, product_id, product_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    app.id,
    app.guildId,
    app.userId,
    app.note ?? "",
    app.usedTickets,
    app.createdAt,
    app.status ?? "pending",
    app.productId ?? null,
    app.productName ?? null
  );
}

function getApplication(id) {
  const row = db.prepare(`
    SELECT id, guild_id AS guildId, user_id AS userId, note,
      used_tickets AS usedTickets, created_at AS createdAt, status,
      product_id AS productId, product_name AS productName
    FROM applications WHERE id = ?
  `).get(id);
  return row ? { ...row, usedTickets: Number(row.usedTickets) } : null;
}

function updateApplicationStatus(id, status) {
  return db.prepare(`UPDATE applications SET status = ? WHERE id = ?`).run(status, id);
}

function createGiveaway(g) {
  db.prepare(`
    INSERT INTO giveaways (
      id, guild_id, channel_id, message_id, prize, minimum_level,
      deadline_at, created_by, status, winner_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    g.id, g.guildId, g.channelId, g.messageId ?? null, g.prize,
    g.minimumLevel, g.deadlineAt, g.createdBy, g.status ?? "active",
    g.winnerUserId ?? null, g.createdAt ?? Date.now()
  );
}

function setGiveawayMessageId(id, messageId) {
  db.prepare(`UPDATE giveaways SET message_id = ? WHERE id = ?`).run(messageId, id);
}

function getGiveaway(id) {
  const row = db.prepare(`
    SELECT id, guild_id AS guildId, channel_id AS channelId,
      message_id AS messageId, prize, minimum_level AS minimumLevel,
      deadline_at AS deadlineAt, created_by AS createdBy, status,
      winner_user_id AS winnerUserId, created_at AS createdAt
    FROM giveaways WHERE id = ?
  `).get(id);
  return row ? { ...row, minimumLevel: Number(row.minimumLevel), deadlineAt: Number(row.deadlineAt), createdAt: Number(row.createdAt) } : null;
}

function getActiveGiveaways() {
  return db.prepare(`
    SELECT id, guild_id AS guildId, channel_id AS channelId,
      message_id AS messageId, prize, minimum_level AS minimumLevel,
      deadline_at AS deadlineAt, created_by AS createdBy, status,
      winner_user_id AS winnerUserId, created_at AS createdAt
    FROM giveaways WHERE status = 'active'
  `).all().map(r => ({ ...r, minimumLevel: Number(r.minimumLevel), deadlineAt: Number(r.deadlineAt), createdAt: Number(r.createdAt) }));
}

function getGiveawayEntries(giveawayId) {
  return db.prepare(`
    SELECT giveaway_id AS giveawayId, user_id AS userId,
      used_tickets AS usedTickets, joined_at AS joinedAt
    FROM giveaway_entries WHERE giveaway_id = ? ORDER BY joined_at ASC
  `).all(giveawayId).map(r => ({ ...r, usedTickets: Number(r.usedTickets), joinedAt: Number(r.joinedAt) }));
}

function getGiveawayEntry(giveawayId, userId) {
  const r = db.prepare(`
    SELECT giveaway_id AS giveawayId, user_id AS userId,
      used_tickets AS usedTickets, joined_at AS joinedAt
    FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?
  `).get(giveawayId, userId);
  return r ? { ...r, usedTickets: Number(r.usedTickets), joinedAt: Number(r.joinedAt) } : null;
}

function addGiveawayEntry(giveawayId, userId) {
  db.prepare(`INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, used_tickets, joined_at) VALUES (?, ?, 0, ?)`).run(giveawayId, userId, Date.now());
}

function removeGiveawayEntry(giveawayId, userId) {
  return db.prepare(`DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`).run(giveawayId, userId);
}

function addGiveawayTickets(giveawayId, userId, amount) {
  db.prepare(`UPDATE giveaway_entries SET used_tickets = used_tickets + ? WHERE giveaway_id = ? AND user_id = ?`).run(amount, giveawayId, userId);
}

function finishGiveaway(id, status, winnerUserId = null) {
  db.prepare(`UPDATE giveaways SET status = ?, winner_user_id = ? WHERE id = ?`).run(status, winnerUserId, id);
}

function resetSeasonForGuild(guildId, completedSeasonKey) {
  saveNow();
  const snapshot = allUsersForGuild(guildId);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE users SET
        xp = 0,
        level = 0,
        messages = 0,
        voice_seconds = 0,
        last_chat_xp_at = 0
      WHERE guild_id = ?
    `).run(guildId);

    db.prepare(`
      INSERT INTO guilds (guild_id, last_reset_season)
      VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        last_reset_season = excluded.last_reset_season
    `).run(guildId, completedSeasonKey);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  for (const user of snapshot) {
    const cached = userCache.get(userKey(guildId, user.userId));
    if (cached) {
      cached.xp = 0;
      cached.level = 0;
      cached.messages = 0;
      cached.voiceSeconds = 0;
      cached.lastChatXpAt = 0;
    }
  }

  const guild = getGuild(guildId);
  guild.lastResetSeason = completedSeasonKey;
  return snapshot;
}


function addShopProduct({ guildId, name, description = "", requiredTickets }) {
  const result = db.prepare(`
    INSERT INTO ticket_shop_products (
      guild_id, name, description, required_tickets, available, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run(guildId, name, description, requiredTickets, Date.now());
  return Number(result.lastInsertRowid);
}

function getShopProduct(id, guildId) {
  const row = db.prepare(`
    SELECT id, guild_id AS guildId, name, description,
      required_tickets AS requiredTickets, available, created_at AS createdAt
    FROM ticket_shop_products WHERE id = ? AND guild_id = ?
  `).get(id, guildId);
  return row ? { ...row, id: Number(row.id), requiredTickets: Number(row.requiredTickets), available: Boolean(row.available), createdAt: Number(row.createdAt) } : null;
}

function listShopProducts(guildId, onlyAvailable = false) {
  const sql = `
    SELECT id, guild_id AS guildId, name, description,
      required_tickets AS requiredTickets, available, created_at AS createdAt
    FROM ticket_shop_products
    WHERE guild_id = ? ${onlyAvailable ? "AND available = 1" : ""}
    ORDER BY id ASC
  `;
  return db.prepare(sql).all(guildId).map(row => ({
    ...row,
    id: Number(row.id),
    requiredTickets: Number(row.requiredTickets),
    available: Boolean(row.available),
    createdAt: Number(row.createdAt)
  }));
}

function updateShopProduct(id, guildId, changes) {
  const current = getShopProduct(id, guildId);
  if (!current) return false;
  db.prepare(`
    UPDATE ticket_shop_products SET
      name = ?, description = ?, required_tickets = ?, available = ?
    WHERE id = ? AND guild_id = ?
  `).run(
    changes.name ?? current.name,
    changes.description ?? current.description,
    changes.requiredTickets ?? current.requiredTickets,
    changes.available == null ? (current.available ? 1 : 0) : (changes.available ? 1 : 0),
    id,
    guildId
  );
  return true;
}

function removeShopProduct(id, guildId) {
  return db.prepare(`DELETE FROM ticket_shop_products WHERE id = ? AND guild_id = ?`).run(id, guildId).changes > 0;
}

function migrateOldJson() {
  if (!fs.existsSync(OLD_JSON_FILE)) return;

  const migratedMarker = `${OLD_JSON_FILE}.migrated`;
  if (fs.existsSync(migratedMarker)) return;

  try {
    const old = JSON.parse(fs.readFileSync(OLD_JSON_FILE, "utf8"));

    db.exec("BEGIN IMMEDIATE");
    try {
      const upsertUser = db.prepare(`
        INSERT INTO users (
          guild_id, user_id, xp, level, tickets, messages,
          voice_seconds, last_chat_xp_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          xp = MAX(users.xp, excluded.xp),
          level = MAX(users.level, excluded.level),
          tickets = MAX(users.tickets, excluded.tickets),
          messages = MAX(users.messages, excluded.messages),
          voice_seconds = MAX(users.voice_seconds, excluded.voice_seconds),
          last_chat_xp_at = MAX(users.last_chat_xp_at, excluded.last_chat_xp_at)
      `);

      for (const user of Object.values(old.users ?? {})) {
        upsertUser.run(
          user.guildId,
          user.userId,
          user.xp ?? 0,
          user.level ?? 0,
          user.tickets ?? 0,
          user.messages ?? 0,
          user.voiceSeconds ?? 0,
          user.lastChatXpAt ?? 0
        );
      }

      for (const [guildId, guild] of Object.entries(old.guilds ?? {})) {
        db.prepare(`
          INSERT INTO guilds (guild_id, notify_channel_id, exchange_channel_id)
          VALUES (?, ?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET
            notify_channel_id = excluded.notify_channel_id,
            exchange_channel_id = excluded.exchange_channel_id
        `).run(
          guildId,
          guild.notifyChannelId ?? null,
          guild.exchangeChannelId ?? null
        );

        for (const channelId of guild.excludedVoiceChannelIds ?? []) {
          db.prepare(`
            INSERT OR IGNORE INTO excluded_voice_channels (guild_id, channel_id)
            VALUES (?, ?)
          `).run(guildId, channelId);
        }
      }

      const insertApp = db.prepare(`
        INSERT OR IGNORE INTO applications (
          id, guild_id, user_id, note, used_tickets, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const app of old.applications ?? []) {
        insertApp.run(
          app.id,
          app.guildId,
          app.userId,
          app.note ?? "",
          app.usedTickets ?? 0,
          app.createdAt ?? new Date().toISOString(),
          app.status ?? "pending"
        );
      }

      db.exec("COMMIT");
      fs.writeFileSync(migratedMarker, new Date().toISOString(), "utf8");
      console.log("旧JSONデータをSQLiteへ移行しました。");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("旧JSONデータの移行に失敗しました:", error);
  }
}

migrateOldJson();

function closeDatabase() {
  try {
    saveNow();
  } finally {
    db.close();
  }
}

module.exports = {
  getUser,
  getGuild,
  allUsersForGuild,
  addApplication,
  getApplication,
  updateApplicationStatus,
  addShopProduct,
  getShopProduct,
  listShopProducts,
  updateShopProduct,
  removeShopProduct,
  createGiveaway,
  setGiveawayMessageId,
  getGiveaway,
  getActiveGiveaways,
  getGiveawayEntries,
  getGiveawayEntry,
  addGiveawayEntry,
  removeGiveawayEntry,
  addGiveawayTickets,
  finishGiveaway,
  resetSeasonForGuild,
  scheduleSave,
  saveNow,
  closeDatabase
};
