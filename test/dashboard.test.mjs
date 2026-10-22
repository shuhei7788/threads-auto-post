import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAccount, computeChanges, folderEntries, lastFor, nextFolderName, pickNext,
  swapEntries, textFromBase64, base64FromBytes, validatePost,
} from "../dashboard/lib.js";
import { listPostFolders, loadPost, pickNext as serverPickNext } from "../src/queue.mjs";

const blob = (p, sha = p) => ({ path: p, type: "blob", sha });

test("ツリーから投稿一覧を組み立てる", () => {
  const tree = [
    blob("accounts/donut/posts/.gitkeep"),
    blob("accounts/donut/posts/010/text.txt"),
    blob("accounts/donut/posts/002/text.txt"),
    blob("accounts/donut/posts/002/10.jpg"),
    blob("accounts/donut/posts/002/02.png"),
    blob("accounts/donut/posts/002/memo.md"),
    blob("accounts/donut/state.json"),
    blob("accounts/ice/posts/001/text.txt"),
    { path: "accounts/donut/posts/002", type: "tree", sha: "t" },
  ];
  const { posts, stateSha } = buildAccount(tree, "donut");
  assert.deepEqual(posts.map((p) => p.folder), ["002", "010"]);
  assert.deepEqual(posts[0].images.map((i) => i.name), ["02.png", "10.jpg"]);
  assert.equal(posts[0].textSha, "accounts/donut/posts/002/text.txt");
  assert.equal(posts[0].files.length, 4);
  assert.equal(stateSha, "accounts/donut/state.json");
});

test("次に投稿させる state.last を計算する（サーバーの選び方と一致）", () => {
  const folders = ["001", "002", "003"];
  for (const f of folders) assert.equal(serverPickNext(folders, lastFor(folders, f)), f);
  assert.equal(pickNext(folders, "003"), "001");
});

test("新しいフォルダ名は最大の番号 + 1", () => {
  assert.equal(nextFolderName([]), "001");
  assert.equal(nextFolderName(["001", "009", "メモ"]), "010");
});

test("入力チェック", () => {
  assert.deepEqual(validatePost("こんにちは", 0), []);
  assert.deepEqual(validatePost("", 1), []);
  assert.match(validatePost("  ", 0)[0], /どちらか/);
  assert.match(validatePost("あ".repeat(501), 0)[0], /500文字/);
  assert.match(validatePost("a", 21)[0], /20枚/);
});

test("編集: 写真の並べ替え・削除・追加を、残すファイルは再アップロードせずに反映する", () => {
  const post = {
    folder: "002",
    files: [
      { path: "accounts/donut/posts/002/text.txt", sha: "t" },
      { path: "accounts/donut/posts/002/01.jpg", sha: "a" },
      { path: "accounts/donut/posts/002/02.jpg", sha: "b" },
      { path: "accounts/donut/posts/002/03.jpg", sha: "c" },
    ],
  };
  // b を先頭に、a はそのまま、c は削除、新しい PNG を追加。文章は空に。
  const images = [{ sha: "b", name: "02.jpg" }, { sha: "a", name: "01.jpg" }, { content: "QUJD", ext: "png" }];
  const changes = computeChanges(post.files.map((f) => f.path), folderEntries("donut", "002", "", images));
  assert.deepEqual(changes, [
    { path: "accounts/donut/posts/002/01.jpg", sha: "b" },
    { path: "accounts/donut/posts/002/02.jpg", sha: "a" },
    { path: "accounts/donut/posts/002/03.png", content: "QUJD" },
    { path: "accounts/donut/posts/002/text.txt", delete: true },
    { path: "accounts/donut/posts/002/03.jpg", delete: true },
  ]);
});

test("並べ替え: 2つのフォルダの中身を入れ替える", () => {
  const a = { folder: "001", files: [{ path: "accounts/ice/posts/001/text.txt", sha: "ta" }, { path: "accounts/ice/posts/001/01.jpg", sha: "ia" }] };
  const b = { folder: "002", files: [{ path: "accounts/ice/posts/002/text.txt", sha: "tb" }] };
  assert.deepEqual(swapEntries(a, b), [
    { path: "accounts/ice/posts/002/text.txt", sha: "ta" },
    { path: "accounts/ice/posts/002/01.jpg", sha: "ia" },
    { path: "accounts/ice/posts/001/text.txt", sha: "tb" },
    { path: "accounts/ice/posts/001/01.jpg", delete: true },
  ]);
});

test("日本語の文章を base64 で読み書きできる", () => {
  const s = "本日のおすすめ🍩\n2行目";
  assert.equal(textFromBase64(base64FromBytes(new TextEncoder().encode(s))), s);
});

test("ダッシュボードで作った投稿を、投稿プログラムが同じ内容・順番で読める", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dash-"));
  const images = Array.from({ length: 11 }, (_, i) => ({ content: "x", ext: i === 10 ? "png" : "jpg" }));
  const entries = folderEntries("donut", "001", "  こんにちは  ", images);
  for (const [p, e] of entries) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), e.text ?? e.content);
  }
  const postsDir = path.join(root, "accounts/donut/posts");
  assert.deepEqual(await listPostFolders(postsDir), ["001"]);
  const post = await loadPost(path.join(postsDir, "001"));
  assert.equal(post.text, "こんにちは");
  assert.deepEqual(post.images, [...entries.keys()].filter((p) => !p.endsWith(".txt")).map((p) => path.basename(p)));
  assert.equal(post.images.at(-1), "11.png");
});
