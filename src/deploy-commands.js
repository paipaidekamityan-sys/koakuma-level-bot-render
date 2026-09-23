require("dotenv").config();

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("自分または指定したユーザーのステータスを表示します")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("確認するユーザー")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("レベルランキングTOP10を表示します"),

  new SlashCommandBuilder()
    .setName("ticket-shop")
    .setDescription("チケットショップを表示します"),

  new SlashCommandBuilder()
    .setName("bot-settings")
    .setDescription("BOTの設定を確認します"),

  new SlashCommandBuilder()
    .setName("ticket-shop-list")
    .setDescription("ショップの商品一覧を表示します")
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("スラッシュコマンドを登録しています...");

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands.map(command => command.toJSON()) }
    );

    console.log("スラッシュコマンドの登録が完了しました！");
  } catch (error) {
    console.error("コマンド登録エラー:", error);
  }
})();
