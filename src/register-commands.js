require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType
} = require("discord.js");

const admin = PermissionFlagsBits.Administrator;

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("レベル・XP・VC時間・チケットを表示")
    .addUserOption(o => o.setName("user").setDescription("確認するユーザー")),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("レベルランキングを表示"),

  new SlashCommandBuilder()
    .setName("ticket-shop")
    .setDescription("チケットショップを開く"),

  new SlashCommandBuilder()
    .setName("ticket-shop-add")
    .setDescription("チケットショップへ商品を追加")
    .setDefaultMemberPermissions(admin)
    .addStringOption(o =>
      o.setName("name").setDescription("商品名").setMaxLength(100).setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("tickets").setDescription("必要チケット枚数").setMinValue(1).setMaxValue(100000).setRequired(true)
    )
    .addStringOption(o =>
      o.setName("description").setDescription("商品の説明").setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("ticket-shop-edit")
    .setDescription("チケットショップの商品設定を変更")
    .setDefaultMemberPermissions(admin)
    .addIntegerOption(o =>
      o.setName("product-id").setDescription("商品ID").setMinValue(1).setRequired(true)
    )
    .addStringOption(o =>
      o.setName("name").setDescription("新しい商品名").setMaxLength(100)
    )
    .addIntegerOption(o =>
      o.setName("tickets").setDescription("新しい必要チケット枚数").setMinValue(1).setMaxValue(100000)
    )
    .addStringOption(o =>
      o.setName("description").setDescription("新しい説明").setMaxLength(500)
    )
    .addBooleanOption(o =>
      o.setName("available").setDescription("ショップに表示するか")
    ),

  new SlashCommandBuilder()
    .setName("ticket-shop-remove")
    .setDescription("チケットショップから商品を削除")
    .setDefaultMemberPermissions(admin)
    .addIntegerOption(o =>
      o.setName("product-id").setDescription("商品ID").setMinValue(1).setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ticket-shop-list")
    .setDescription("登録されている商品と商品IDを表示")
    .setDefaultMemberPermissions(admin),

  new SlashCommandBuilder()
    .setName("setup-level-notify")
    .setDescription("レベルアップ通知チャンネルを設定")
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("通知チャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setup-exchange-channel")
    .setDescription("交換申請を送るチャンネルを設定")
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("申請受付チャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setup-season-channel")
    .setDescription("月末ランキングとシーズンリセットのお知らせ先を設定")
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("シーズン結果を送るチャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setup-join-leave-channel")
    .setDescription("メンバーの入室・退出通知チャンネルを設定")
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("入室・退出を表示するチャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setup-beginner-help")
    .setDescription("初心者ヘルプ案内パネルを設置")
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("初心者ヘルプパネルを設置するチャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ticket-add")
    .setDescription("管理者がチケットを付与")
    .setDefaultMemberPermissions(admin)
    .addUserOption(o =>
      o.setName("user").setDescription("対象ユーザー").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("amount").setDescription("付与枚数").setMinValue(1).setMaxValue(100000).setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ticket-remove")
    .setDescription("管理者がチケットを削除")
    .setDefaultMemberPermissions(admin)
    .addUserOption(o =>
      o.setName("user").setDescription("対象ユーザー").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("amount").setDescription("削除枚数").setMinValue(1).setMaxValue(100000).setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("vc-exclude-add")
    .setDescription("VC経験値の除外チャンネルを追加")
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("除外するVC")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("vc-exclude-remove")
    .setDescription("VC経験値の除外チャンネルを解除")
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("解除するVC")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("vc-exclude-list")
    .setDescription("VC経験値の除外設定を表示")
    .setDefaultMemberPermissions(admin),

  new SlashCommandBuilder()
    .setName("giveaway-create")
    .setDescription("プレゼント企画を作成")
    .setDefaultMemberPermissions(admin)
    .addStringOption(o =>
      o.setName("prize").setDescription("景品").setMaxLength(500).setRequired(true)
    )
    .addStringOption(o =>
      o.setName("deadline").setDescription("締め切り（例: 2026/08/01 21:00、日本時間）").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("minimum-level").setDescription("参加できる最低レベル").setMinValue(0).setMaxValue(100000).setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("bot-settings")
    .setDescription("現在のBOT設定を表示")
    .setDefaultMemberPermissions(admin)
].map(c => c.toJSON());

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

function fail(message) {
  console.error("\n[ERROR] " + message + "\n");
  process.exit(1);
}

if (!DISCORD_TOKEN || !CLIENT_ID) {
  fail(".env の DISCORD_TOKEN / CLIENT_ID を設定してください。GUILD_ID は不要です。");
}

if (!/^\d{17,20}$/.test(CLIENT_ID)) {
  fail("CLIENT_ID が正しくありません。Developer Portal の Application ID を入力してください。");
}

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    const app = await rest.get(Routes.oauth2CurrentApplication());

    if (String(app.id) !== String(CLIENT_ID)) {
      fail(
        "DISCORD_TOKEN と CLIENT_ID が別のBOTです。\n" +
        `トークン側のApplication ID: ${app.id}\n` +
        `入力されたCLIENT_ID: ${CLIENT_ID}`
      );
    }

    // グローバルコマンドとして登録することで、BOTを招待した全サーバーで利用できます。
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );

    // BOTが参加している全サーバーから、旧版のサーバー専用コマンドを削除します。
    // これにより、グローバルコマンドとの二重表示を防ぎます。
    try {
      const guilds = await rest.get("/users/@me/guilds");
      let cleaned = 0;

      for (const guild of guilds) {
        try {
          await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, guild.id),
            { body: [] }
          );
          cleaned += 1;
          console.log(`旧サーバー専用コマンドを削除: ${guild.name} (${guild.id})`);
        } catch (guildCleanupError) {
          console.warn(`削除できませんでした: ${guild.name} (${guild.id})`, guildCleanupError.message);
        }
      }

      console.log(`${cleaned}個のサーバーを確認しました。`);
    } catch (cleanupError) {
      // 念のため、旧.envにGUILD_IDが残っている場合はそのサーバーだけでも削除します。
      if (GUILD_ID && /^\d{17,20}$/.test(GUILD_ID)) {
        await rest.put(
          Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
          { body: [] }
        );
        console.log("旧GUILD_IDのサーバー専用コマンドを削除しました。");
      } else {
        console.warn("サーバー専用コマンドの一括確認をスキップしました:", cleanupError.message);
      }
    }

    console.log("\n[SUCCESS] 全サーバー共通のスラッシュコマンドを登録しました。\n");
    console.log("反映には少し時間がかかる場合があります。BOTを招待した各サーバーで利用できます。\n");
    process.exit(0);
  } catch (error) {
    if (error?.code === 50013) {
      fail("Missing Permissions: BOTの権限が不足しています。");
    }

    if (error?.code === 0 || error?.status === 401) {
      fail("BOTトークンが無効です。Developer Portalでトークンを再発行してください。");
    }

    console.error("コマンド登録エラー:", error);
    process.exit(1);
  }
})();
