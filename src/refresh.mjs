// 使い方: node src/refresh.mjs
// THREADS_TOKEN を更新し、新しいトークンを NEW_TOKEN_FILE に書き出す（標準出力には出さない）。
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "./threads.mjs";

export async function refresh({ env = process.env, client, write = writeFile }) {
  if (!env.NEW_TOKEN_FILE) throw new Error("NEW_TOKEN_FILE が設定されていません");
  client ??= createClient({ token: env.THREADS_TOKEN });
  const { token, expiresIn } = await client.refreshToken();
  if (!token) throw new Error("新しいトークンを受け取れませんでした");
  await write(env.NEW_TOKEN_FILE, token, { mode: 0o600 });
  console.log(`トークンを更新しました（有効期限: 約${Math.round(expiresIn / 86400)}日）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  refresh({}).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
