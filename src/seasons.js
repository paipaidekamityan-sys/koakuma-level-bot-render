const { EmbedBuilder } = require("discord.js");
const { getGuild, allUsersForGuild, resetSeasonForGuild, saveNow } = require("./store");
const { levelFromXp } = require("./levels");

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
let running = false;

function jstParts(date = new Date()) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours()
  };
}

function seasonKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function previousSeasonKey(now = new Date()) {
  const { year, month } = jstParts(now);
  if (month === 1) return seasonKey(year - 1, 12);
  return seasonKey(year, month - 1);
}

function formatVoice(seconds) {
  const totalMinutes = Math.floor(Number(seconds || 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}

async function userName(client, userId) {
  const user = await client.users.fetch(userId).catch(() => null);
  return user?.displayName ?? user?.username ?? `不明なユーザー (${userId})`;
}

async function rankingLines(client, users, valueText, sorter) {
  const ranked = [...users].filter(sorter.filter).sort(sorter.compare).slice(0, 10);
  if (!ranked.length) return "記録なし";
  const lines = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const user = ranked[i];
    lines.push(`**${i + 1}位** ${await userName(client, user.userId)} — ${valueText(user)}`);
  }
  return lines.join("\n");
}

async function announceAndReset(client, guild, completedSeason) {
  const guildData = getGuild(guild.id);
  if (!guildData.seasonChannelId) return false;
  if (guildData.lastResetSeason === completedSeason) return false;

  const channel = guild.channels.cache.get(guildData.seasonChannelId)
    ?? await guild.channels.fetch(guildData.seasonChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  saveNow();
  const users = allUsersForGuild(guild.id);
  const chat = await rankingLines(client, users, u => `${u.messages}回`, {
    filter: u => u.messages > 0,
    compare: (a, b) => b.messages - a.messages || b.xp - a.xp
  });
  const voice = await rankingLines(client, users, u => formatVoice(u.voiceSeconds), {
    filter: u => u.voiceSeconds > 0,
    compare: (a, b) => b.voiceSeconds - a.voiceSeconds || b.xp - a.xp
  });
  const overall = await rankingLines(client, users, u => `Lv.${levelFromXp(u.xp).level} / ${u.xp} XP`, {
    filter: u => u.xp > 0,
    compare: (a, b) => b.xp - a.xp || b.messages - a.messages
  });

  await channel.send("月末になりました。レベルのリセットを行います");
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`📅 ${completedSeason} シーズン結果`)
        .addFields(
          { name: "💬 今月のチャット数ランキング", value: chat },
          { name: "🎙️ 今月のVC時間ランキング", value: voice },
          { name: "🏆 今月の総合ランキング", value: overall }
        )
        .setFooter({ text: "小悪魔チケットの所持数は引き継がれます" })
        .setTimestamp()
    ]
  });

  resetSeasonForGuild(guild.id, completedSeason);
  console.log(`[SEASON] ${guild.name} (${guild.id}) の ${completedSeason} を集計・リセットしました。`);
  return true;
}

async function checkSeasons(client) {
  if (running) return;
  running = true;
  try {
    const parts = jstParts();
    if (parts.day !== 1) return;
    const completed = previousSeasonKey();
    for (const guild of client.guilds.cache.values()) {
      await announceAndReset(client, guild, completed).catch(error =>
        console.error(`[SEASON] ${guild.id} の処理に失敗:`, error)
      );
    }
  } finally {
    running = false;
  }
}

function startSeasonScheduler(client) {
  checkSeasons(client);
  setInterval(() => checkSeasons(client), 5 * 60 * 1000);
}

module.exports = { startSeasonScheduler, checkSeasons };
