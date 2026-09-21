# Render無料Web Service + UptimeRobot対応

この版はRenderの無料Web ServiceでDiscord BOTを動かし、`/health` エンドポイントをUptimeRobotから定期的に監視する構成です。

## 重要な注意
- Render無料Web Serviceは無料枠の仕様・制限により、24時間365日の稼働が保証されるわけではありません。UptimeRobotによる定期アクセスも、Renderの仕様や利用条件によってはスリープを防げない場合があります。
- 無料Web Serviceでは永続ディスクを利用しないため、SQLiteのデータはサービス再起動・再デプロイ等で失われる可能性があります。大切なデータはバックアップしてください。
- Discord BOTトークンはGitHubに保存しないでください。

## Render
1. GitHubにこのフォルダの中身をアップロード。
2. Render → New → Web Service。
3. GitHubリポジトリを選択。
4. Runtime: Node、Build Command: `npm install`、Start Command: `npm start`、Plan: Free。
5. Environment Variablesに `DISCORD_TOKEN` と `CLIENT_ID` を追加。
6. Deploy。
7. Deploy完了後、Renderが表示するURLに `/health` を付けてブラウザで開き、`OK` が表示されることを確認。

## UptimeRobot
1. UptimeRobotでアカウントを作成。
2. Add New Monitor。
3. Monitor Type: HTTP(s)。
4. URLに `https://あなたのRenderサービス名.onrender.com/health` を入力。
5. 監視間隔を選択して作成。

## PC
Render上でBOTが動いていることを確認したら、PCのBOT起動バッチは不要です。
