require("dotenv").config();

const net = require("net");
const http = require("http");

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const config = require("../config.json");
const {
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
  scheduleSave,
  saveNow,
  closeDatabase
} = require("./store");
const { levelFromXp, progressBar } = require("./levels");
const { handleCommand: handleGiveawayCommand, handleComponent: handleGiveawayComponent, startScheduler: startGiveawayScheduler } = require("./giveaways");
const { startSeasonScheduler } = require("./seasons");

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error(".env に DISCORD_TOKEN を設定してください。");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ]
});

// Windows上で同じBOTが二重起動しないようにするための単一起動ロック。
// 2個目のプロセスは終了コード42で終了し、BOT_START.bat側でも再起動しません。
const SINGLE_INSTANCE_PIPE = "\\\\.\\pipe\\koakuma-level-bot-single-instance";
// Renderでは1サービス=1プロセスなのでWindows用の名前付きパイプロックは使わない。
const instanceLock = process.platform === "win32" ? net.createServer() : null;

const voiceProgress = new Map();
const voiceEligibleStreak = new Map();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}時間 ${minutes}分` : `${minutes}分`;
}

async function notifyLevelUp(member, newLevel, gainedTickets, source) {
  const guildData = getGuild(member.guild.id);
  const channel =
    member.guild.channels.cache.get(guildData.notifyChannelId) ??
    member.guild.systemChannel;

  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle("🎉 レベルアップ！")
    .setDescription(`${member} が **レベル ${newLevel}** になりました！`)
    .addFields(
      {
        name: "獲得",
        value: `🎫 ${config.ticketName} × ${gainedTickets}`,
        inline: true
      },
      {
        name: "獲得方法",
        value: source,
        inline: true
      }
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(e =>
    console.error("通知失敗:", e.message)
  );
}

async function addXp(member, amount, source) {
  const user = getUser(member.guild.id, member.id);
  const before = levelFromXp(user.xp).level;

  user.xp += Math.max(0, Math.floor(amount));

  const after = levelFromXp(user.xp).level;
  const gainedLevels = after - before;

  if (gainedLevels > 0) {
    user.level = after;
    user.tickets += gainedLevels;
    await notifyLevelUp(member, after, gainedLevels, source);
  } else {
    user.level = after;
  }

  scheduleSave();
}

function voiceEligible(member) {
  if (!member || member.user.bot) return false;

  const voice = member.voice;
  if (!voice.channelId || !voice.channel) return false;

  if (voice.selfMute || voice.serverMute) return false;
  if (voice.selfDeaf || voice.serverDeaf) return false;

  const afkChannelId = member.guild.afkChannelId;
  if (afkChannelId && voice.channelId === afkChannelId) return false;

  const guildData = getGuild(member.guild.id);
  if (guildData.excludedVoiceChannelIds.includes(voice.channelId)) return false;

  const humanCount = voice.channel.members.filter(m => !m.user.bot).size;
  if (humanCount < config.voiceXp.minimumHumanMembers) return false;

  return true;
}

function startVoiceLoop() {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const activeMemberIds = new Set();

      for (const voiceState of guild.voiceStates.cache.values()) {
        const member = voiceState.member;
        if (!member) continue;

        const key = `${guild.id}:${member.id}`;
        activeMemberIds.add(key);

        if (!voiceEligible(member)) {
          voiceProgress.delete(key);
          voiceEligibleStreak.delete(key);
          continue;
        }

        const streakSeconds = (voiceEligibleStreak.get(key) ?? 0) + 60;
        voiceEligibleStreak.set(key, streakSeconds);

        const current = (voiceProgress.get(key) ?? 0) + 60;
        const intervalSeconds = config.voiceXp.intervalMinutes * 60;

        if (current >= intervalSeconds) {
          voiceProgress.set(key, current - intervalSeconds);

          const user = getUser(guild.id, member.id);
          user.voiceSeconds += intervalSeconds;

          const increaseEverySeconds =
            Math.max(1, config.voiceXp.increaseEveryMinutes ?? 30) * 60;
          const increaseSteps = Math.floor(streakSeconds / increaseEverySeconds);
          const xpIncrease = increaseSteps * (config.voiceXp.increaseAmount ?? 1);
          const maxXp = config.voiceXp.maxXpPerInterval ?? 20;
          const earnedXp = Math.min(
            maxXp,
            config.voiceXp.xpPerInterval + xpIncrease
          );

          await addXp(member, earnedXp, "ボイスチャット");
        } else {
          voiceProgress.set(key, current);
        }
      }

      for (const key of [...voiceProgress.keys()]) {
        if (key.startsWith(`${guild.id}:`) && !activeMemberIds.has(key)) {
          voiceProgress.delete(key);
          voiceEligibleStreak.delete(key);
        }
      }
    }
  }, 60_000);
}

client.on("guildMemberAdd", async member => {
  const guildData = getGuild(member.guild.id);
  const channel = member.guild.channels.cache.get(guildData.joinLeaveChannelId);
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle("📥 入室")
    .setDescription(`${member} さんがサーバーに参加しました！`)
    .addFields({ name: "現在のメンバー数", value: `${member.guild.memberCount}人`, inline: true })
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(e =>
    console.error("入室通知失敗:", e.message)
  );
});

client.on("guildMemberRemove", async member => {
  const guildData = getGuild(member.guild.id);
  const channel = member.guild.channels.cache.get(guildData.joinLeaveChannelId);
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle("📤 退出")
    .setDescription(`**${member.user.tag}** さんがサーバーから退出しました。`)
    .addFields({ name: "現在のメンバー数", value: `${member.guild.memberCount}人`, inline: true })
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(e =>
    console.error("退出通知失敗:", e.message)
  );
});

client.once("clientReady", () => {
  console.log(`ログインしました: ${client.user.tag}`);
  client.user.setActivity("レベルとVC XPを計測中");
  startVoiceLoop();
  startGiveawayScheduler(client);
  startSeasonScheduler(client);
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot || !message.member) return;

  const user = getUser(message.guild.id, message.author.id);
  user.messages += 1;

  const now = Date.now();
  const cooldown = config.chatXp.cooldownSeconds * 1000;

  if (now - user.lastChatXpAt < cooldown) {
    scheduleSave();
    return;
  }

  user.lastChatXpAt = now;
  await addXp(
    message.member,
    randomInt(config.chatXp.min, config.chatXp.max),
    "チャット"
  );
});

client.on("interactionCreate", async interaction => {
  if (!interaction.guild) return;

  try {
    if (interaction.isButton() && interaction.customId.startsWith("exchange-complete:")) {
      const applicationId = interaction.customId.slice("exchange-complete:".length);
      const application = getApplication(applicationId);

      if (!application) {
        await interaction.reply({ content: "この交換申請は見つかりませんでした。", ephemeral: true });
        return;
      }

      if (application.userId !== interaction.user.id) {
        await interaction.reply({ content: "このボタンは申請した本人だけが使用できます。", ephemeral: true });
        return;
      }

      if (application.status === "completed") {
        await interaction.reply({ content: "この交換申請はすでに交換完了になっています。", ephemeral: true });
        return;
      }

      updateApplicationStatus(applicationId, "completed");
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`exchange-complete:${applicationId}`)
          .setLabel("交換できた")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true)
      );

      await interaction.update({
        content: "✅ 交換できたことを記録しました。ご報告ありがとうございます！",
        components: [disabledRow]
      });

      const guildData = getGuild(interaction.guild.id);
      const channel = interaction.guild.channels.cache.get(guildData.exchangeChannelId);
      if (channel?.isTextBased()) {
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ ギフト交換完了")
              .setDescription(`${interaction.user} さんが「交換できた」ボタンを押しました。`)
              .addFields(
                { name: "申請ID", value: applicationId },
                { name: "交換商品", value: application.productName || "旧交換申請" },
                { name: "使用チケット", value: `${application.usedTickets}枚` }
              )
              .setTimestamp()
          ]
        }).catch(error => console.error("交換完了通知失敗:", error.message));
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("beginner-help:")) {
      const topic = interaction.customId.slice("beginner-help:".length);
      const help = {
        server: {
          title: "📖 サーバーの使い方",
          description: "まずは各チャンネルの説明やルールを確認して、気になる場所から参加してみましょう。分からないことがあれば、この初心者ヘルプをいつでも使えます。"
        },
        level: {
          title: "⭐ レベルについて",
          description: `チャットやボイスチャットを利用するとXPを獲得できます。レベルが上がると、1レベルごとに${config.ticketName}を1枚獲得できます。

現在の自分の情報は **/status** で確認できます。`
        },
        ticket: {
          title: `🎫 ${config.ticketName}について`,
          description: `${config.ticketName}はレベルアップやシーズン報酬などで獲得できます。貯めたチケットはショップの商品交換に使えます。`
        },
        shop: {
          title: "🛒 ショップの使い方",
          description: `**/ticket-shop** で交換できる商品を確認できます。商品ボタンを押すと、必要な${config.ticketName}を使って交換申請できます。`
        },
        giveaway: {
          title: "🎁 ギフト企画について",
          description: "開催中のギフト企画では、企画メッセージにある参加ボタンから参加できます。企画ごとに最低レベルや締切が設定される場合があります。"
        },
        season: {
          title: "🏆 シーズンについて",
          description: "シーズンは毎月1日から月末までです。月が変わるとランキング発表後にレベル・XP・チャット数・VC時間がリセットされます。チケットは引き継がれます。"
        },
        trouble: {
          title: "❓ 困ったとき",
          description: "BOTが反応しない、交換について確認したい、サーバーの使い方が分からないなどの場合は、サーバー管理者・モデレーターへ相談してください。"
        }
      }[topic];

      if (!help) {
        await interaction.reply({ content: "このヘルプ項目は見つかりませんでした。", ephemeral: true });
        return;
      }

      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle(help.title).setDescription(help.description)],
        ephemeral: true
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("ticket-shop-buy:")) {
      const productId = Number(interaction.customId.slice("ticket-shop-buy:".length));
      const product = getShopProduct(productId, interaction.guild.id);
      if (!product || !product.available) {
        await interaction.reply({ content: "この商品は現在交換できません。", ephemeral: true });
        return;
      }

      const user = getUser(interaction.guild.id, interaction.user.id);
      if (user.tickets < product.requiredTickets) {
        await interaction.reply({
          content: `チケットが足りません。必要: ${product.requiredTickets}枚 / 所持: ${user.tickets}枚`,
          ephemeral: true
        });
        return;
      }

      const guildData = getGuild(interaction.guild.id);
      const channel = interaction.guild.channels.cache.get(guildData.exchangeChannelId);
      if (!channel?.isTextBased()) {
        await interaction.reply({ content: "交換申請チャンネルが未設定、または確認できません。", ephemeral: true });
        return;
      }

      user.tickets -= product.requiredTickets;
      const applicationId = `${Date.now()}-${interaction.user.id}`;
      addApplication({
        id: applicationId,
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        note: "",
        usedTickets: product.requiredTickets,
        productId: product.id,
        productName: product.name,
        createdAt: new Date().toISOString(),
        status: "pending"
      });
      scheduleSave();

      await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle("🛍️ チケットショップ交換申請")
          .addFields(
            { name: "申請者", value: `${interaction.user} (${interaction.user.id})` },
            { name: "商品", value: product.name },
            { name: "使用チケット", value: `${product.requiredTickets}枚`, inline: true },
            { name: "残り", value: `${user.tickets}枚`, inline: true },
            { name: "申請ID", value: applicationId }
          )
          .setTimestamp()]
      });

      const completeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`exchange-complete:${applicationId}`)
          .setLabel("交換できた")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success)
      );

      await interaction.reply({
        content: `✅ **${product.name}** の交換申請を送りました。${product.requiredTickets}枚を使用し、残りは${user.tickets}枚です。\n実際に商品を受け取ったら「交換できた」を押してください。`,
        components: [completeRow],
        ephemeral: true
      });
      return;
    }

    if (await handleGiveawayComponent(interaction, client)) return;
    if (!interaction.isChatInputCommand()) return;
    if (await handleGiveawayCommand(interaction)) return;
    if (interaction.commandName === "status") {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const user = getUser(interaction.guild.id, target.id);
      const rank = levelFromXp(user.xp);

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${target.displayName} のステータス`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: "レベル", value: `${rank.level}`, inline: true },
          { name: "総XP", value: `${user.xp}`, inline: true },
          { name: config.ticketName, value: `${user.tickets}枚`, inline: true },
          {
            name: "次のレベルまで",
            value: `${progressBar(rank.currentXp, rank.requiredXp)}\n${rank.currentXp} / ${rank.requiredXp} XP`
          },
          { name: "チャット数", value: `${user.messages}`, inline: true },
          { name: "有効VC時間", value: formatDuration(user.voiceSeconds), inline: true }
        );

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === "leaderboard") {
      const users = allUsersForGuild(interaction.guild.id)
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 10);

      if (!users.length) {
        await interaction.reply("まだデータがありません。");
        return;
      }

      const lines = await Promise.all(
        users.map(async (u, i) => {
          const du = await client.users.fetch(u.userId).catch(() => null);
          return `**${i + 1}.** ${du?.displayName ?? "不明"} — Lv.${levelFromXp(u.xp).level} / ${u.xp} XP`;
        })
      );

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🏆 レベルランキング")
            .setDescription(lines.join("\n"))
        ]
      });
      return;
    }

    if (interaction.commandName === "ticket-shop") {
      const products = listShopProducts(interaction.guild.id, true);
      const user = getUser(interaction.guild.id, interaction.user.id);

      if (!products.length) {
        await interaction.reply({ content: "現在、交換できる商品はありません。", ephemeral: true });
        return;
      }

      const visible = products.slice(0, 25);
      const rows = [];
      for (let i = 0; i < visible.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(
          ...visible.slice(i, i + 5).map(product =>
            new ButtonBuilder()
              .setCustomId(`ticket-shop-buy:${product.id}`)
              .setLabel(`${product.name}（${product.requiredTickets}枚）`.slice(0, 80))
              .setStyle(ButtonStyle.Primary)
          )
        ));
      }

      const description = visible.map(p =>
        `**ID ${p.id}｜${p.name}** — ${p.requiredTickets}枚\n${p.description || "説明なし"}`
      ).join("\n\n");

      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle("🛍️ チケットショップ")
          .setDescription(description)
          .addFields({ name: "あなたの所持チケット", value: `${user.tickets}枚` })],
        components: rows,
        ephemeral: true
      });
      return;
    }

    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isAdmin) {
      await interaction.reply({ content: "管理者専用コマンドです。", ephemeral: true });
      return;
    }

    if (interaction.commandName === "setup-beginner-help") {
      const channel = interaction.options.getChannel("channel", true);
      if (!channel?.isTextBased()) {
        await interaction.reply({ content: "テキストチャンネルを指定してください。", ephemeral: true });
        return;
      }

      const rows = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("beginner-help:server").setLabel("サーバーの使い方").setEmoji("📖").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("beginner-help:level").setLabel("レベル").setEmoji("⭐").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("beginner-help:ticket").setLabel("チケット").setEmoji("🎫").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("beginner-help:shop").setLabel("ショップ").setEmoji("🛒").setStyle(ButtonStyle.Success)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("beginner-help:giveaway").setLabel("ギフト企画").setEmoji("🎁").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("beginner-help:season").setLabel("シーズン").setEmoji("🏆").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("beginner-help:trouble").setLabel("困ったとき").setEmoji("❓").setStyle(ButtonStyle.Danger)
        )
      ];

      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔰 初心者ヘルプ")
            .setDescription("知りたい内容のボタンを押してください。説明は押した本人だけに表示されます。")
            .addFields({ name: "はじめての方へ", value: "レベル・チケット・ショップ・ギフト企画・シーズンなどの基本をここから確認できます。" })
        ],
        components: rows
      });

      await interaction.reply({ content: `✅ 初心者ヘルプ案内パネルを ${channel} に設置しました。`, ephemeral: true });
      return;
    }

    if (interaction.commandName === "ticket-shop-add") {
      const name = interaction.options.getString("name", true);
      const requiredTickets = interaction.options.getInteger("tickets", true);
      const description = interaction.options.getString("description") ?? "";
      const id = addShopProduct({ guildId: interaction.guild.id, name, description, requiredTickets });
      await interaction.reply(`✅ 商品を追加しました。\n商品ID: **${id}**\n商品: **${name}**\n必要チケット: **${requiredTickets}枚**`);
      return;
    }

    if (interaction.commandName === "ticket-shop-edit") {
      const id = interaction.options.getInteger("product-id", true);
      const product = getShopProduct(id, interaction.guild.id);
      if (!product) {
        await interaction.reply({ content: "その商品IDは見つかりません。", ephemeral: true });
        return;
      }
      const name = interaction.options.getString("name");
      const requiredTickets = interaction.options.getInteger("tickets");
      const description = interaction.options.getString("description");
      const available = interaction.options.getBoolean("available");
      if (name == null && requiredTickets == null && description == null && available == null) {
        await interaction.reply({ content: "変更する項目を1つ以上入力してください。", ephemeral: true });
        return;
      }
      updateShopProduct(id, interaction.guild.id, { name, requiredTickets, description, available });
      const updated = getShopProduct(id, interaction.guild.id);
      await interaction.reply(`✅ 商品ID **${id}** を更新しました。\n商品: **${updated.name}**\n必要チケット: **${updated.requiredTickets}枚**\n表示: **${updated.available ? "販売中" : "非表示"}**`);
      return;
    }

    if (interaction.commandName === "ticket-shop-remove") {
      const id = interaction.options.getInteger("product-id", true);
      const product = getShopProduct(id, interaction.guild.id);
      if (!product) {
        await interaction.reply({ content: "その商品IDは見つかりません。", ephemeral: true });
        return;
      }
      removeShopProduct(id, interaction.guild.id);
      await interaction.reply(`✅ 商品ID **${id}**「${product.name}」を削除しました。`);
      return;
    }

    if (interaction.commandName === "ticket-shop-list") {
      const products = listShopProducts(interaction.guild.id, false);
      if (!products.length) {
        await interaction.reply({ content: "商品はまだ登録されていません。", ephemeral: true });
        return;
      }
      const lines = products.map(p => `ID **${p.id}**｜${p.name}｜${p.requiredTickets}枚｜${p.available ? "販売中" : "非表示"}`);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("🛠️ チケットショップ商品一覧").setDescription(lines.join("\n").slice(0, 4000))],
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === "setup-level-notify") {
      const channel = interaction.options.getChannel("channel", true);
      getGuild(interaction.guild.id).notifyChannelId = channel.id;
      scheduleSave();
      await interaction.reply(`✅ レベルアップ通知先を ${channel} に設定しました。`);
      return;
    }

    if (interaction.commandName === "setup-exchange-channel") {
      const channel = interaction.options.getChannel("channel", true);
      getGuild(interaction.guild.id).exchangeChannelId = channel.id;
      scheduleSave();
      await interaction.reply(`✅ 交換申請先を ${channel} に設定しました。`);
      return;
    }

    if (interaction.commandName === "setup-season-channel") {
      const channel = interaction.options.getChannel("channel", true);
      getGuild(interaction.guild.id).seasonChannelId = channel.id;
      scheduleSave();
      await interaction.reply(`✅ シーズン結果・レベルリセットのお知らせ先を ${channel} に設定しました。`);
      return;
    }

    if (interaction.commandName === "setup-join-leave-channel") {
      const channel = interaction.options.getChannel("channel", true);
      getGuild(interaction.guild.id).joinLeaveChannelId = channel.id;
      scheduleSave();
      await interaction.reply(`✅ 入室・退出通知先を ${channel} に設定しました。`);
      return;
    }

    if (interaction.commandName === "ticket-add") {
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      const user = getUser(interaction.guild.id, target.id);
      user.tickets += amount;
      scheduleSave();

      await interaction.reply(
        `✅ ${target} に ${config.ticketName}を **${amount}枚** 付与しました。現在: ${user.tickets}枚`
      );
      return;
    }

    if (interaction.commandName === "ticket-remove") {
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      const user = getUser(interaction.guild.id, target.id);
      const removed = Math.min(amount, user.tickets);
      user.tickets -= removed;
      scheduleSave();

      await interaction.reply(
        `✅ ${target} から ${config.ticketName}を **${removed}枚** 削除しました。現在: ${user.tickets}枚`
      );
      return;
    }

    if (interaction.commandName === "vc-exclude-add") {
      const channel = interaction.options.getChannel("channel", true);
      const guildData = getGuild(interaction.guild.id);

      if (!guildData.excludedVoiceChannelIds.includes(channel.id)) {
        guildData.excludedVoiceChannelIds.push(channel.id);
        scheduleSave();
      }

      await interaction.reply(`✅ ${channel} をVC XP除外に追加しました。`);
      return;
    }

    if (interaction.commandName === "vc-exclude-remove") {
      const channel = interaction.options.getChannel("channel", true);
      const guildData = getGuild(interaction.guild.id);

      guildData.excludedVoiceChannelIds =
        guildData.excludedVoiceChannelIds.filter(id => id !== channel.id);
      scheduleSave();

      await interaction.reply(`✅ ${channel} のVC XP除外を解除しました。`);
      return;
    }

    if (interaction.commandName === "vc-exclude-list") {
      const guildData = getGuild(interaction.guild.id);
      const list = guildData.excludedVoiceChannelIds.length
        ? guildData.excludedVoiceChannelIds.map(id => `<#${id}>`).join("\n")
        : "設定なし";

      const afk = interaction.guild.afkChannelId
        ? `<#${interaction.guild.afkChannelId}>（自動除外）`
        : "AFKチャンネル未設定";

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🚫 VC XP除外設定")
            .addFields(
              { name: "手動除外", value: list },
              { name: "AFKチャンネル", value: afk }
            )
        ],
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === "bot-settings") {
      const guildData = getGuild(interaction.guild.id);

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚙️ BOT設定")
            .addFields(
              {
                name: "チャットXP",
                value: `${config.chatXp.cooldownSeconds}秒ごとに ${config.chatXp.min}〜${config.chatXp.max} XP`
              },
              {
                name: "VC XP",
                value: `${config.voiceXp.intervalMinutes}分ごとに基本${config.voiceXp.xpPerInterval} XP（連続${config.voiceXp.increaseEveryMinutes ?? 30}分ごとに+${config.voiceXp.increaseAmount ?? 1} XP、最大${config.voiceXp.maxXpPerInterval ?? 20} XP）`
              },
              {
                name: "VC条件",
                value: `BOT以外が${config.voiceXp.minimumHumanMembers}人以上 / マイク・スピーカーミュート不可 / AFK・除外VC不可`
              },
              {
                name: "レベル報酬",
                value: `1レベルごとに${config.ticketName}1枚`
              },
              {
                name: "交換",
                value: "管理者が登録した商品をチケットで交換"
              },
              {
                name: "通知先",
                value: guildData.notifyChannelId ? `<#${guildData.notifyChannelId}>` : "未設定"
              },
              {
                name: "申請先",
                value: guildData.exchangeChannelId ? `<#${guildData.exchangeChannelId}>` : "未設定"
              },
              {
                name: "シーズン制度",
                value: "毎月1日〜月末。翌月1日にランキング発表後、レベル・XP・チャット数・VC時間をリセット（チケットは引き継ぎ）"
              },
              {
                name: "シーズン通知先",
                value: guildData.seasonChannelId ? `<#${guildData.seasonChannelId}>` : "未設定"
              },
              {
                name: "入室・退出通知先",
                value: guildData.joinLeaveChannelId ? `<#${guildData.joinLeaveChannelId}>` : "未設定"
              }
            )
        ],
        ephemeral: true
      });
    }
  } catch (e) {
    console.error("処理エラー:", e);
    const payload = {
      content: "エラーが発生しました。BOTの黒い画面を確認してください。",
      ephemeral: true
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

async function shutdown() {
  try {
    closeDatabase();
  } catch (error) {
    console.error("終了時のSQLite保存エラー:", error);
  }
  client.destroy();
  try {
    healthServer.close();
  } catch (_) {}
  try {
    instanceLock?.close();
  } catch (_) {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", e => console.error("予期しないエラー:", e));
process.on("unhandledRejection", e => console.error("未処理エラー:", e));

const HEALTH_PORT = Number(process.env.PORT || 10000);
const healthServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
  console.log(`Health server listening on port ${HEALTH_PORT}`);
});

console.log("Discordログイン開始");

function loginBot() {
  console.log("client.login実行直前");
  client.login(token).catch(e => {
    console.error("ログイン失敗:", e);
    process.exit(1);
  });
}

if (instanceLock) {
  instanceLock.on("error", error => {
    if (error && error.code === "EADDRINUSE") {
      console.log("このBOTはすでに起動しています。二重起動を防止したため、この起動処理を終了します。");
      process.exit(42);
    }

    console.error("二重起動防止ロックの作成に失敗しました:", error);
    process.exit(1);
  });

  instanceLock.listen(SINGLE_INSTANCE_PIPE, loginBot);
} else {
  // Linux/RenderではRender側がプロセス数を管理するため、直接ログインする。
  loginBot();
}
