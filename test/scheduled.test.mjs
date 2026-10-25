import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDue, runScheduled } from "../src/scheduled.mjs";

// 日本時間の時刻を Date にする
const jst = (s) => new Date(`${s}+09:00`);

test("投稿時刻の15分前から5時間後までで、今日まだ投稿していなければ投稿する", () => {
  const none = { last: null };
  assert.equal(isDue("11:00", none, jst("2026-10-23T10:44")), false);
  assert.equal(isDue("11:00", none, jst("2026-10-23T10:50")), true);
  assert.equal(isDue("11:00", none, jst("2026-10-23T15:59")), true); // 取りこぼしを拾う
  assert.equal(isDue("11:00", none, jst("2026-10-23T16:01")), false);
});

test("今日すでに投稿していれば投稿しない（日付は日本時間で判定）", () => {
  const today = { postedAt: jst("2026-10-23T10:52").toISOString() };
  assert.equal(isDue("11:00", today, jst("2026-10-23T11:50")), false);
  const yesterday = { postedAt: jst("2026-10-22T10:52").toISOString() };
  assert.equal(isDue("11:00", yesterday, jst("2026-10-23T10:50")), true);
  // 日本時間 10/23 08:00 は UTC では 10/22 なので、日付のずれで誤判定しない
  const earlyMorning = { postedAt: jst("2026-10-23T08:00").toISOString() };
  assert.equal(isDue("11:00", earlyMorning, jst("2026-10-23T10:50")), false);
});

test("時刻になっていて今日まだ投稿していないアカウントだけ、そのアカウントのトークンで投稿する", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sched-"));
  for (const a of ["donut", "ice"]) await mkdir(path.join(root, "accounts", a), { recursive: true });
  // ドーナツは今日もう投稿済み
  await writeFile(path.join(root, "accounts/donut/state.json"), JSON.stringify({ postedAt: jst("2026-10-23T10:50").toISOString() }));
  const calls = [];
  const post = async ({ account, env }) => calls.push([account, env.THREADS_TOKEN]);
  const env = { THREADS_TOKEN_DONUT: "d", THREADS_TOKEN_ICE: "i" };

  assert.equal(await runScheduled({ env, root, post, now: () => jst("2026-10-23T14:50") }), true);
  assert.deepEqual(calls, [["ice", "i"]]);
});

test("投稿に失敗したら、エラーを出して失敗を返す", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sched-"));
  for (const a of ["donut", "ice"]) await mkdir(path.join(root, "accounts", a), { recursive: true });
  const calls = [];
  const post = async ({ account }) => {
    calls.push(account);
    if (account === "donut") throw new Error("失敗");
  };
  const errors = [];
  const origError = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.equal(await runScheduled({ env: {}, root, post, now: () => jst("2026-10-23T10:55") }), false);
    assert.equal(await runScheduled({ env: {}, root, post, now: () => jst("2026-10-23T16:30") }), true);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(calls, ["donut", "ice"]);
  assert.match(errors[0], /\[donut\] 失敗/);
});

test("ドーナツを取りこぼしたまま15時台になったら、ドーナツとアイスの両方を投稿する", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sched-"));
  for (const a of ["donut", "ice"]) await mkdir(path.join(root, "accounts", a), { recursive: true });
  const calls = [];
  await runScheduled({ env: {}, root, post: async ({ account }) => calls.push(account), now: () => jst("2026-10-23T14:50") });
  assert.deepEqual(calls, ["donut", "ice"]);
});
