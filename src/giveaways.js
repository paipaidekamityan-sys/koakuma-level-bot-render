const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const config = require("../config.json");
const { levelFromXp } = require("./levels");
const {
  getUser,
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
  scheduleSave
} = require("./store");

const PREFIX = "giveaway:";
const MAX_TICKETS_PER_USE = 1000;

function parseJstDateTime(text) {
  const m = String(text).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h - 9, mi, 0, 0);
  const check = new Date(utc + 9 * 60 * 60 * 1000);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null;
  return utc;
}

function rows(id, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}join:${id}`).setLabel("参加").setEmoji("🎉").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${PREFIX}leave:${id}`).setLabel("参加取り消し").setEmoji("↩️").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${PREFIX}list:${id}`).setLabel("参加者一覧").setEmoji("👥").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}chance:${id}`).setLabel("当選確率").setEmoji("🎯").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}tickets:${id}`).setLabel("チケットで確率を上げる").setEmoji("🎫").setStyle(ButtonStyle.Success).setDisabled(disabled)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}cancel:${id}`).setLabel("企画中止（管理者のみ）").setEmoji("🛑").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function giveawayEmbed(g, statusText = "参加受付中") {
  const deadlineUnix = Math.floor(g.deadlineAt / 1000);
  return new EmbedBuilder()
    .setTitle("🎁 小悪魔鯖 プレゼント企画")
    .setDescription("下のボタンから参加できます！")
    .addFields(
      { name: "景品", value: g.prize },
      { name: "締め切り", value: `<t:${deadlineUnix}:F>\n<t:${deadlineUnix}:R>`, inline: true },
      { name: "参加最低レベル", value: `Lv.${g.minimumLevel}`, inline: true },
      { name: "抽選方法", value: `通常1口＋使用した${config.ticketName}1枚につき1口` },
      { name: "状態", value: statusText }
    )
    .setFooter({ text: `企画ID: ${g.id}` })
    .setTimestamp(g.createdAt);
}

async function updateMessage(client, g, statusText, disable = false) {
  if (!g.messageId) return;
  const guild = client.guilds.cache.get(g.guildId);
  const channel = guild?.channels.cache.get(g.channelId);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(g.messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [giveawayEmbed(g, statusText)], components: rows(g.id, disable) }).catch(() => {});
}

async function drawGiveaway(client, id) {
  const g = getGiveaway(id);
  if (!g || g.status !== "active") return;
  const entries = getGiveawayEntries(id);
  if (!entries.length) {
    finishGiveaway(id, "finished", null);
    await updateMessage(client, g, "終了（参加者なし）", true);
    const channel = client.guilds.cache.get(g.guildId)?.channels.cache.get(g.channelId);
    await channel?.send({ content: "🎁 プレゼント企画は終了しましたが、参加者はいませんでした。" }).catch(() => {});
    return;
  }

  const totalWeight = entries.reduce((n, e) => n + 1 + e.usedTickets, 0);
  let pick = Math.floor(Math.random() * totalWeight);
  let winner = entries[0];
  for (const e of entries) {
    pick -= 1 + e.usedTickets;
    if (pick < 0) { winner = e; break; }
  }

  finishGiveaway(id, "finished", winner.userId);
  const guild = client.guilds.cache.get(g.guildId);
  const channel = guild?.channels.cache.get(g.channelId);
  const user = await client.users.fetch(winner.userId).catch(() => null);
  await updateMessage(client, g, `抽選終了 — 当選者: <@${winner.userId}>`, true);
  await channel?.send({ content: `🎊 当選者は <@${winner.userId}> さんです！\n景品：**${g.prize}**` }).catch(() => {});
  if (user) {
    await user.send(`小悪魔鯖のギフト企画抽選結果、、、当選おめでとうございます！当選内容は「${g.prize}」です！鯖主から連絡があるまでお待ちください！`).catch(async () => {
      await channel?.send({ content: `⚠️ <@${winner.userId}> さんへDMを送れませんでした。DM受信設定をご確認ください。` }).catch(() => {});
    });
  }
}

function startScheduler(client) {
  const check = async () => {
    const now = Date.now();
    for (const g of getActiveGiveaways()) {
      if (g.deadlineAt <= now) await drawGiveaway(client, g.id);
    }
  };
  check().catch(console.error);
  setInterval(() => check().catch(console.error), 30_000);
}

async function handleCommand(interaction) {
  if (interaction.commandName !== "giveaway-create") return false;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "管理者のみ企画を作成できます。", ephemeral: true });
    return true;
  }
  const prize = interaction.options.getString("prize", true);
  const deadlineText = interaction.options.getString("deadline", true);
  const minimumLevel = interaction.options.getInteger("minimum-level", true);
  const deadlineAt = parseJstDateTime(deadlineText);
  if (!deadlineAt || deadlineAt <= Date.now()) {
    await interaction.reply({ content: "締め切り日時は未来の日時を `2026/08/01 21:00` の形式（日本時間）で入力してください。", ephemeral: true });
    return true;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const g = { id, guildId: interaction.guild.id, channelId: interaction.channel.id, prize, minimumLevel, deadlineAt, createdBy: interaction.user.id, createdAt: Date.now(), status: "active" };
  createGiveaway(g);
  await interaction.reply({ embeds: [giveawayEmbed(g)], components: rows(id) });
  const message = await interaction.fetchReply();
  setGiveawayMessageId(id, message.id);
  return true;
}

async function handleComponent(interaction, client) {
  if (!(interaction.isButton() || interaction.isModalSubmit()) || !interaction.customId.startsWith(PREFIX)) return false;
  const [kind, id] = interaction.customId.slice(PREFIX.length).split(":");
  const g = getGiveaway(id);
  if (!g) { await interaction.reply({ content: "この企画は見つかりません。", ephemeral: true }); return true; }

  if (kind === "list") {
    const entries = getGiveawayEntries(id);
    const text = entries.length ? entries.slice(0, 50).map((e, i) => `${i + 1}. <@${e.userId}>（${1 + e.usedTickets}口）`).join("\n") : "まだ参加者はいません。";
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`👥 参加者一覧（${entries.length}人）`).setDescription(text)], ephemeral: true });
    return true;
  }

  if (kind === "chance") {
    const entries = getGiveawayEntries(id);
    const mine = entries.find(e => e.userId === interaction.user.id);
    if (!mine) { await interaction.reply({ content: "先に企画へ参加してください。", ephemeral: true }); return true; }
    const total = entries.reduce((n, e) => n + 1 + e.usedTickets, 0);
    const myWeight = 1 + mine.usedTickets;
    await interaction.reply({ content: `あなたは **${myWeight}口 / 全${total}口**、現在の当選確率は **${((myWeight / total) * 100).toFixed(2)}%** です。`, ephemeral: true });
    return true;
  }

  if (g.status !== "active" || g.deadlineAt <= Date.now()) {
    if (g.status === "active") await drawGiveaway(client, id);
    await interaction.reply({ content: "この企画の受付は終了しています。", ephemeral: true });
    return true;
  }

  if (kind === "join") {
    const level = levelFromXp(getUser(g.guildId, interaction.user.id).xp).level;
    if (level < g.minimumLevel) { await interaction.reply({ content: `参加には **Lv.${g.minimumLevel}** 以上が必要です。あなたは現在 **Lv.${level}** です。`, ephemeral: true }); return true; }
    if (getGiveawayEntry(id, interaction.user.id)) { await interaction.reply({ content: "すでに参加しています。", ephemeral: true }); return true; }
    addGiveawayEntry(id, interaction.user.id);
    await interaction.reply({ content: "✅ プレゼント企画に参加しました！", ephemeral: true });
    return true;
  }

  if (kind === "leave") {
    const entry = getGiveawayEntry(id, interaction.user.id);
    if (!entry) { await interaction.reply({ content: "この企画には参加していません。", ephemeral: true }); return true; }
    const user = getUser(g.guildId, interaction.user.id);
    user.tickets += entry.usedTickets;
    removeGiveawayEntry(id, interaction.user.id);
    scheduleSave();
    await interaction.reply({ content: `参加を取り消しました。使用済みの${config.ticketName} ${entry.usedTickets}枚は返却しました。`, ephemeral: true });
    return true;
  }

  if (kind === "tickets") {
    if (!getGiveawayEntry(id, interaction.user.id)) { await interaction.reply({ content: "先に企画へ参加してください。", ephemeral: true }); return true; }
    const modal = new ModalBuilder().setCustomId(`${PREFIX}ticketmodal:${id}`).setTitle("チケットで当選確率アップ");
    const input = new TextInputBuilder().setCustomId("amount").setLabel(`使用する${config.ticketName}の枚数`).setPlaceholder("例: 3").setRequired(true).setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(4);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return true;
  }

  if (kind === "ticketmodal") {
    const amount = Number(interaction.fields.getTextInputValue("amount"));
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_TICKETS_PER_USE) { await interaction.reply({ content: `1〜${MAX_TICKETS_PER_USE}の整数を入力してください。`, ephemeral: true }); return true; }
    const entry = getGiveawayEntry(id, interaction.user.id);
    if (!entry) { await interaction.reply({ content: "企画へ参加していません。", ephemeral: true }); return true; }
    const user = getUser(g.guildId, interaction.user.id);
    if (user.tickets < amount) { await interaction.reply({ content: `${config.ticketName}が足りません。所持数: ${user.tickets}枚`, ephemeral: true }); return true; }
    user.tickets -= amount;
    addGiveawayTickets(id, interaction.user.id, amount);
    scheduleSave();
    await interaction.reply({ content: `✅ ${config.ticketName}を${amount}枚使用しました。あなたの抽選口数は **${1 + entry.usedTickets + amount}口** です。残り: ${user.tickets}枚`, ephemeral: true });
    return true;
  }

  if (kind === "cancel") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) { await interaction.reply({ content: "企画中止は管理者のみ実行できます。", ephemeral: true }); return true; }
    for (const e of getGiveawayEntries(id)) {
      const user = getUser(g.guildId, e.userId);
      user.tickets += e.usedTickets;
    }
    scheduleSave();
    finishGiveaway(id, "cancelled", null);
    await updateMessage(client, g, "管理者により中止", true);
    await interaction.reply({ content: "🛑 企画を中止しました。使用されたチケットはすべて返却しました。" });
    return true;
  }
  return false;
}

module.exports = { handleCommand, handleComponent, startScheduler };
