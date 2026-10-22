import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/post.mjs";
import { pickNext } from "../src/queue.mjs";
import { createClient } from "../src/threads.mjs";

async function setup(posts, state) {
  const root = await mkdtemp(path.join(tmpdir(), "tap-"));
  const postsDir = path.join(root, "accounts", "donut", "posts");
  await mkdir(postsDir, { recursive: true });
  for (const [name, files] of Object.entries(posts)) {
    await mkdir(path.join(postsDir, name));
    for (const [file, body] of Object.entries(files)) await writeFile(path.join(postsDir, name, file), body);
  }
  if (state) await writeFile(path.join(root, "accounts", "donut", "state.json"), JSON.stringify(state));
  return root;
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    async me() {
      return { id: "42" };
    },
    async publish(userId, post) {
      calls.push({ userId, ...post });
      return "post-1";
    },
  };
}

const env = { IMAGE_BASE_URL: "https://example.test/base/" };
const quiet = () => {};

test("pickNext は名前順で次を選び、最後の次は最初に戻る", () => {
  const folders = ["001", "002", "010"];
  assert.equal(pickNext(folders, null), "001");
  assert.equal(pickNext(folders, "002"), "010");
  assert.equal(pickNext(folders, "010"), "001");
  assert.equal(pickNext(folders, "005"), "010"); // 前回のフォルダが削除されていても続きから
  assert.equal(pickNext([], null), null);
});

test("順番に投稿し、位置を state.json に保存する", async () => {
  const root = await setup({
    "001": { "text.txt": "おはようございます\n" },
    "002": { "text.txt": "本日もオープン", "b.jpg": "x", "a.png": "x", "memo.md": "x" },
  });
  const client = fakeClient();
  const now = () => new Date("2026-10-22T02:00:00Z");

  const first = await run({ account: "donut", env, root, client, log: quiet, now });
  assert.equal(first.name, "001");
  assert.deepEqual(client.calls[0], { userId: "42", text: "おはようございます", imageUrls: [] });

  const second = await run({ account: "donut", env, root, client, log: quiet, now });
  assert.equal(second.name, "002");
  assert.deepEqual(client.calls[1].imageUrls, [
    "https://example.test/base/accounts/donut/posts/002/a.png",
    "https://example.test/base/accounts/donut/posts/002/b.jpg",
  ]);

  await run({ account: "donut", env, root, client, log: quiet, now });
  assert.equal(client.calls[2].text, "おはようございます");

  const state = JSON.parse(await readFile(path.join(root, "accounts/donut/state.json"), "utf8"));
  assert.deepEqual(state, { last: "001", postedAt: "2026-10-22T02:00:00.000Z", postId: "post-1" });
});

test("日本語のフォルダ名や写真名はURLエンコードする", async () => {
  const root = await setup({ "01_新作": { "写真 1.jpg": "x" } });
  const client = fakeClient();
  await run({ account: "donut", env, root, client, log: quiet });
  assert.equal(
    client.calls[0].imageUrls[0],
    `https://example.test/base/accounts/donut/posts/${encodeURIComponent("01_新作")}/${encodeURIComponent("写真 1.jpg")}`,
  );
});

test("DRY_RUN では投稿も保存もしない", async () => {
  const root = await setup({ "001": { "text.txt": "a" } });
  const client = fakeClient();
  const result = await run({ account: "donut", env: { ...env, DRY_RUN: "1" }, root, client, log: quiet });
  assert.equal(result.posted, false);
  assert.equal(client.calls.length, 0);
  await assert.rejects(readFile(path.join(root, "accounts/donut/state.json")));
});

test("投稿がなければ何もしない", async () => {
  const root = await setup({});
  const result = await run({ account: "donut", env, root, client: fakeClient(), log: quiet });
  assert.equal(result.posted, false);
});

test("500文字を超える文章や空の投稿はエラーにして、位置を進めない", async () => {
  const root = await setup({ "001": { "text.txt": "あ".repeat(501) } }, { last: null });
  await assert.rejects(run({ account: "donut", env, root, client: fakeClient(), log: quiet }), /500文字/);
  const root2 = await setup({ "001": { "memo.md": "x" } });
  await assert.rejects(run({ account: "donut", env, root: root2, client: fakeClient(), log: quiet }), /text\.txt も写真も/);
});

test("投稿に失敗したら位置を進めない", async () => {
  const root = await setup({ "001": { "text.txt": "a" } }, { last: null });
  const client = { ...fakeClient(), publish: async () => { throw new Error("失敗"); } };
  await assert.rejects(run({ account: "donut", env, root, client, log: quiet }), /失敗/);
  const state = JSON.parse(await readFile(path.join(root, "accounts/donut/state.json"), "utf8"));
  assert.equal(state.last, null);
});

test("不正なアカウント名は拒否する", async () => {
  await assert.rejects(run({ account: "../x", env, log: quiet }), /アカウント名/);
});

// --- Threads API クライアント ---

function fakeFetch(responses) {
  const requests = [];
  const fetch = async (url, init) => {
    const params = init.body ? Object.fromEntries(init.body) : Object.fromEntries(url.searchParams);
    requests.push({ method: init.method, path: url.pathname, params });
    const next = responses.shift();
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body };
  };
  return { fetch, requests };
}

test("写真1枚: IMAGE コンテナを作り、準備完了を待ってから公開する", async () => {
  const { fetch, requests } = fakeFetch([
    { body: { id: "c1" } },
    { body: { status: "IN_PROGRESS" } },
    { body: { status: "FINISHED" } },
    { body: { id: "p1" } },
  ]);
  const client = createClient({ token: "secret-token", fetch, sleep: async () => {} });
  const id = await client.publish("42", { text: "hi", imageUrls: ["https://x/a.jpg"] });
  assert.equal(id, "p1");
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
    "POST /v1.0/42/threads",
    "GET /v1.0/c1",
    "GET /v1.0/c1",
    "POST /v1.0/42/threads_publish",
  ]);
  assert.equal(requests[0].params.media_type, "IMAGE");
  assert.equal(requests[0].params.image_url, "https://x/a.jpg");
  assert.equal(requests[3].params.creation_id, "c1");
});

test("写真2枚以上: カルーセルとして投稿する", async () => {
  const { fetch, requests } = fakeFetch([
    { body: { id: "i1" } },
    { body: { status: "FINISHED" } },
    { body: { id: "i2" } },
    { body: { status: "FINISHED" } },
    { body: { id: "car" } },
    { body: { status: "FINISHED" } },
    { body: { id: "p1" } },
  ]);
  const client = createClient({ token: "t", fetch, sleep: async () => {} });
  await client.publish("42", { text: "hi", imageUrls: ["https://x/1.jpg", "https://x/2.jpg"] });
  assert.equal(requests[0].params.is_carousel_item, "true");
  assert.equal(requests[4].params.media_type, "CAROUSEL");
  assert.equal(requests[4].params.children, "i1,i2");
  assert.equal(requests[4].params.text, "hi");
});

test("文章のみ: TEXT として投稿する", async () => {
  const { fetch, requests } = fakeFetch([{ body: { id: "c1" } }, { body: { status: "FINISHED" } }, { body: { id: "p1" } }]);
  const client = createClient({ token: "t", fetch, sleep: async () => {} });
  await client.publish("42", { text: "hi", imageUrls: [] });
  assert.equal(requests[0].params.media_type, "TEXT");
  assert.equal(requests[0].params.text, "hi");
});

test("APIエラーのメッセージにトークンを含めない", async () => {
  const { fetch } = fakeFetch([{ ok: false, status: 400, body: { error: { message: "Invalid OAuth access token" } } }]);
  const client = createClient({ token: "secret-token", fetch });
  await assert.rejects(client.me(), (err) => {
    assert.match(err.message, /Invalid OAuth/);
    assert.doesNotMatch(err.message, /secret-token/);
    return true;
  });
});

test("準備が ERROR になったら公開しない", async () => {
  const { fetch, requests } = fakeFetch([{ body: { id: "c1" } }, { body: { status: "ERROR", error_message: "bad image" } }]);
  const client = createClient({ token: "t", fetch, sleep: async () => {} });
  await assert.rejects(client.publish("42", { text: "", imageUrls: ["https://x/a.jpg"] }), /bad image/);
  assert.equal(requests.length, 2);
});

test("トークンの更新", async () => {
  const { fetch, requests } = fakeFetch([{ body: { access_token: "new", expires_in: 5184000 } }]);
  const client = createClient({ token: "old", fetch });
  assert.deepEqual(await client.refreshToken(), { token: "new", expiresIn: 5184000 });
  assert.equal(requests[0].path, "/refresh_access_token");
  assert.equal(requests[0].params.grant_type, "th_refresh_token");
});
