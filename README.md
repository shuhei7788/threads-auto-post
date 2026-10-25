# Threads 自動投稿

「ドーナツ食べたい」と「アイス食べたい」の2つのThreadsアカウントに、用意した投稿を毎日1件ずつ順番に投稿します。

| アカウント | フォルダ | 投稿時刻（目安） |
|---|---|---|
| ドーナツ食べたい | `accounts/donut/posts/` | 毎日 11:00 ごろ |
| アイス食べたい | `accounts/ice/posts/` | 毎日 15:00 ごろ |

毎時50分に起動して、投稿時刻を過ぎていて今日まだ投稿していなければ投稿します。GitHubの混雑で起動が遅れたり飛ばされたりしても、投稿時刻から2時間以内なら次の回で投稿されます。投稿時刻は `src/scheduled.mjs` の `SCHEDULE` で変えられます。

## ダッシュボード

https://shuhei7788.github.io/threads-auto-post/

スマホやパソコンのブラウザで、投稿の追加・編集・削除・並べ替えと、次に投稿するものの指定ができます。
最初に GitHub のトークン（このリポジトリの Contents を Read and write にしたもの）を入力します。トークンはそのブラウザの中にだけ保存されます。

写真は長い辺が2048pxを超える場合、自動で縮小されます。

## 投稿の追加のしかた（GitHub で直接編集する場合）

1投稿につき1つのフォルダを作り、その中に文章と写真を入れます。

```
accounts/donut/posts/
  001_定番/
    text.txt     ← 投稿する文章（500文字まで）
    1.jpg        ← 写真（JPEG か PNG、20枚まで。名前順に並びます）
    2.jpg
  002_新作/
    text.txt
    photo.jpg
```

- フォルダ名の順に1件ずつ投稿し、最後まで行ったら最初に戻ります。
- 順番が分かりやすいように、フォルダ名の先頭に `001_` のような番号を付けてください。
- 文章だけ、写真だけの投稿もできます。
- 写真が2枚以上あるときは、まとめて1つの投稿（スライド形式）になります。
- 投稿を途中に追加しても、前回投稿したフォルダの次から続きます。

**注意：このリポジトリは公開されるので、Threadsに載せてよいものだけを置いてください。**

## 動作の確認（投稿はしない）

GitHub の「Actions」→「自動投稿」→「Run workflow」で、アカウントを選んで実行します。
「投稿せずに内容だけ確認する」にチェックが入っていれば、次に投稿される内容が表示されるだけで、実際には投稿されません。

## 最初の設定

1. Meta for Developers でアプリを作り、Threads API を使えるようにする
2. 2つのアカウントそれぞれのアクセストークンを発行する（権限: `threads_basic`, `threads_content_publish`）
3. GitHub のリポジトリの Settings → Secrets and variables → Actions に、次の3つを登録する

| 名前 | 中身 |
|---|---|
| `THREADS_TOKEN_DONUT` | ドーナツ食べたい のアクセストークン（60日間有効なもの） |
| `THREADS_TOKEN_ICE` | アイス食べたい のアクセストークン（60日間有効なもの） |
| `SECRETS_PAT` | このリポジトリの Secrets を書き換えられる GitHub のトークン（トークンの自動更新に使用） |

アクセストークンは60日で切れますが、「トークン更新」の仕組みが毎週月曜に自動で更新します。

## 毎時の起動（cron-job.org）

GitHub の定時実行は3〜5時間おきになることがあるので、[cron-job.org](https://cron-job.org) から毎時45分に「自動投稿」を `account=auto` で起動しています。
GitHub の定時実行と重なっても、同じ日に2回投稿されることはありません。

| 項目 | 設定 |
|---|---|
| URL | `https://api.github.com/repos/shuhei7788/threads-auto-post/actions/workflows/post.yml/dispatches` |
| 方法 | POST |
| ヘッダー | `Accept: application/vnd.github+json` / `Authorization: Bearer <トークン>` / `X-GitHub-Api-Version: 2022-11-28` / `Content-Type: application/json` |
| 本文 | `{"ref":"main","inputs":{"account":"auto","dry_run":"false"}}` |
| 実行 | 毎時45分（Asia/Tokyo） |

トークンは、このリポジトリだけを対象に **Actions** を「Read and write」にした GitHub のトークンです（期限が切れたら作り直して差し替えます）。

## うまく動かないとき

- 「Actions」の画面で失敗した実行（赤い×）を開くと、原因が日本語で表示されます。
- トークンの期限が切れた場合は、新しく発行して Secrets に登録し直してください。
- 投稿に失敗したときは位置が進まないので、2時間以内の次の回、それでもだめなら次の日に同じ投稿が再挑戦されます。
- 「Actions」→「自動投稿」→「Run workflow」で「投稿せずに内容だけ確認する」のチェックを外すと、今すぐ次の投稿を投稿できます。

## 開発者向け

```
npm test                         # テスト
DRY_RUN=1 node src/post.mjs donut  # 次に投稿する内容を表示
```
