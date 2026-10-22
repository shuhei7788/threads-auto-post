// 使い方: node src/post.mjs <account>
// 環境変数:
//   THREADS_TOKEN  そのアカウントのアクセストークン
//   DRY_RUN=1      投稿せず、次に投稿する内容を表示するだけ
//   IMAGE_BASE_URL 写真の公開URLの先頭（GitHub Actions では自動で設定）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPostFolders, loadPost, pickNext, readState, validatePost, writeState } from "./queue.mjs";
import { createClient } from "./threads.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function run({ account, env = process.env, root = ROOT, client, log = console.log, now = () => new Date() }) {
  if (!/^[a-z0-9_-]+$/.test(account ?? "")) throw new Error(`アカウント名が不正です: ${account}`);

  const accountDir = path.join(root, "accounts", account);
  const postsDir = path.join(accountDir, "posts");
  const stateFile = path.join(accountDir, "state.json");

  const folders = await listPostFolders(postsDir);
  const state = await readState(stateFile);
  const name = pickNext(folders, state.last);
  if (!name) {
    log(`[${account}] 投稿がまだ登録されていないので、何もしません`);
    return { posted: false };
  }

  const post = await loadPost(path.join(postsDir, name));
  const errors = validatePost(name, post);
  if (errors.length) throw new Error(errors.join("\n"));

  const baseUrl = env.IMAGE_BASE_URL?.replace(/\/+$/, "");
  if (post.images.length && !baseUrl) throw new Error("IMAGE_BASE_URL が設定されていません");
  const imageUrls = post.images.map((img) =>
    [baseUrl, "accounts", account, "posts", name, img].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join("/"),
  );

  log(`[${account}] 次の投稿: ${name}（写真${post.images.length}枚）`);

  if (env.DRY_RUN === "1") {
    log(post.text || "（文章なし）");
    for (const url of imageUrls) log(`  写真: ${url}`);
    return { posted: false, name };
  }

  client ??= createClient({ token: env.THREADS_TOKEN });
  const { id: userId } = await client.me();
  const postId = await client.publish(userId, { text: post.text, imageUrls });

  await writeState(stateFile, { last: name, postedAt: now().toISOString(), postId });
  log(`[${account}] 投稿しました: ${name}`);
  return { posted: true, name, postId };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run({ account: process.argv[2] }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
