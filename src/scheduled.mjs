// 定時実行用: 毎時起動し、投稿時刻を過ぎていて今日まだ投稿していないアカウントだけ投稿する。
// GitHub の定時実行は遅れたり飛ばされたりするので、1回飛ばされても次の回で投稿できるようにしている。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readState } from "./queue.mjs";
import { run } from "./post.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 投稿時刻（日本時間）
export const SCHEDULE = { donut: "11:00", ice: "15:00" };
const EARLY_MINUTES = 15; // この分だけ早く起動した回でも投稿する
// 投稿時刻からこの分までは、取りこぼしを投稿する。GitHub の定時実行は3〜5時間おきになることもあるので広めにとる
const CATCH_UP_MINUTES = 300;

const JST_OFFSET = 9 * 60 * 60 * 1000;
const jstDate = (d) => new Date(d.getTime() + JST_OFFSET).toISOString().slice(0, 10);

export function isDue(time, state, now) {
  const [h, m] = time.split(":").map(Number);
  const jst = new Date(now.getTime() + JST_OFFSET);
  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const target = h * 60 + m;
  if (minutes < target - EARLY_MINUTES || minutes > target + CATCH_UP_MINUTES) return false;
  return !(state.postedAt && jstDate(new Date(state.postedAt)) === jstDate(now));
}

export async function runScheduled({ env = process.env, root = ROOT, now = () => new Date(), post = run, log = console.log }) {
  let failed = false;
  for (const [account, time] of Object.entries(SCHEDULE)) {
    const state = await readState(path.join(root, "accounts", account, "state.json"));
    if (!isDue(time, state, now())) continue;
    try {
      await post({ account, root, now, log, env: { ...env, THREADS_TOKEN: env[`THREADS_TOKEN_${account.toUpperCase()}`] } });
    } catch (err) {
      failed = true;
      console.error(`[${account}] ${err.message}`);
    }
  }
  return !failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runScheduled({}).then((ok) => process.exit(ok ? 0 : 1));
}
