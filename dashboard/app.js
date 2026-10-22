import {
  MAX_IMAGES, base64FromBytes, buildAccount, computeChanges, folderEntries, lastFor,
  nextFolderName, pickNext, swapEntries, textFromBase64, validatePost,
} from "./lib.js";

const OWNER = "shuhei7788";
const REPO = "threads-auto-post";
const BRANCH = "main";
const ACCOUNTS = [
  { key: "donut", label: "ドーナツ食べたい", time: "毎日 11:00 ごろ" },
  { key: "ice", label: "アイス食べたい", time: "毎日 15:00 ごろ" },
];
const MAX_IMAGE_EDGE = 2048;
const TOKEN_KEY = "threads-dashboard-token";
const TAB_KEY = "threads-dashboard-tab";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let token = store.get(TOKEN_KEY);
let current = ACCOUNTS.some((a) => a.key === store.get(TAB_KEY)) ? store.get(TAB_KEY) : ACCOUNTS[0].key;
let repo = null; // { commitSha, tree }
let view = null; // buildAccount の結果 + state + texts
const textCache = new Map();

// --- GitHub API ---

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body && { "Content-Type": "application/json" }),
    },
    cache: "no-store",
  });
  if (res.status === 401) throw Object.assign(new Error("トークンが無効か、期限が切れています"), { auth: true });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const message = res.status === 403 || res.status === 404
      ? "このトークンでは編集できません（Contents の権限を確認してください）"
      : data?.message ?? `GitHub エラー (${res.status})`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return data;
}

async function headSha() {
  return (await gh(`git/ref/heads/${BRANCH}`)).object.sha;
}

async function loadRepo() {
  const commitSha = await headSha();
  const commit = await gh(`git/commits/${commitSha}`);
  const { tree } = await gh(`git/trees/${commit.tree.sha}?recursive=1`);
  repo = { commitSha, tree };
}

async function blobText(sha) {
  if (!textCache.has(sha)) textCache.set(sha, gh(`git/blobs/${sha}`).then((b) => textFromBase64(b.content)));
  return textCache.get(sha);
}

// changes をひとつのコミットにまとめて main に反映する。自動投稿のコミットと重なったら作り直す。
async function commit(message, changes) {
  const blobs = await Promise.all(changes.map(async (c) => {
    if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
    if (c.sha) return { path: c.path, mode: "100644", type: "blob", sha: c.sha };
    const body = c.text != null ? { content: c.text, encoding: "utf-8" } : { content: c.content, encoding: "base64" };
    const { sha } = await gh("git/blobs", { method: "POST", body: JSON.stringify(body) });
    return { path: c.path, mode: "100644", type: "blob", sha };
  }));
  for (let attempt = 0; ; attempt++) {
    const parent = await headSha();
    const base = await gh(`git/commits/${parent}`);
    const tree = await gh("git/trees", { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree: blobs }) });
    const created = await gh("git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `${message}（ダッシュボード）`, tree: tree.sha, parents: [parent] }),
    });
    try {
      await gh(`git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: created.sha }) });
      return;
    } catch (err) {
      if (err.status !== 422 || attempt >= 2) throw err;
    }
  }
}

// --- 画面 ---

function account() {
  return ACCOUNTS.find((a) => a.key === current);
}

function rawUrl(path) {
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${repo.commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

async function busy(text, fn) {
  $("busy-text").textContent = text;
  $("busy").hidden = false;
  try {
    return await fn();
  } catch (err) {
    if (err.auth) return logout(err.message);
    alert(err.message);
  } finally {
    $("busy").hidden = true;
  }
}

async function refresh() {
  await loadRepo();
  const built = buildAccount(repo.tree, current);
  const state = built.stateSha ? JSON.parse(await blobText(built.stateSha)) : { last: null };
  const texts = await Promise.all(built.posts.map((p) => (p.textSha ? blobText(p.textSha) : "")));
  built.posts.forEach((p, i) => (p.text = texts[i].trim()));
  view = { ...built, state };
  render();
}

function render() {
  const acc = account();
  $("tabs").replaceChildren(...ACCOUNTS.map((a) =>
    el("button", { className: a.key === current ? "tab active" : "tab", textContent: a.label, onclick: () => switchTab(a.key) })));

  const folders = view.posts.map((p) => p.folder);
  const next = pickNext(folders, view.state.last);
  $("sum-time").textContent = acc.time;
  $("sum-count").textContent = `${view.posts.length}件`;
  $("sum-last").textContent = view.state.postedAt
    ? new Date(view.state.postedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "まだありません";

  $("empty").hidden = view.posts.length > 0;
  $("posts").replaceChildren(...view.posts.map((p, i) => {
    const isNext = p.folder === next;
    const badges = el("div", { className: "badges" },
      el("span", { className: "num", textContent: `#${i + 1}` }),
      isNext ? el("span", { className: "next", textContent: "次に投稿" }) : null);
    const text = el("p", { className: p.text ? "text" : "text muted", textContent: p.text || "（文章なし）" });
    const thumbs = p.images.length
      ? el("div", { className: "thumbs" }, ...p.images.map((img) => el("img", { src: rawUrl(img.path), alt: "", loading: "lazy" })))
      : null;
    const actions = el("div", { className: "row-actions" },
      el("button", { textContent: "編集", onclick: () => openEditor(p) }),
      el("button", { textContent: "↑", title: "上へ", disabled: i === 0, onclick: () => move(i, -1) }),
      el("button", { textContent: "↓", title: "下へ", disabled: i === view.posts.length - 1, onclick: () => move(i, 1) }),
      isNext ? null : el("button", { textContent: "次にこれを投稿", onclick: () => setNext(p) }),
      el("button", { className: "danger", textContent: "削除", onclick: () => remove(p) }));
    return el("li", { className: isNext ? "card post is-next" : "card post" }, badges, text, thumbs, actions);
  }));
}

async function switchTab(key) {
  current = key;
  store.set(TAB_KEY, key);
  await busy("読み込んでいます…", refresh);
}

// --- 操作 ---

async function move(index, delta) {
  const a = view.posts[index];
  const b = view.posts[index + delta];
  await busy("並べ替えています…", async () => {
    await commit(`${current}: 順番を入れ替え`, swapEntries(a, b));
    await refresh();
    toast("順番を入れ替えました");
  });
}

async function setNext(post) {
  const folders = view.posts.map((p) => p.folder);
  const state = { ...view.state, last: lastFor(folders, post.folder) };
  await busy("保存しています…", async () => {
    await commit(`${current}: 次の投稿を変更`, [{ path: `accounts/${current}/state.json`, text: JSON.stringify(state, null, 2) + "\n" }]);
    await refresh();
    toast("次に投稿する内容を変更しました");
  });
}

async function remove(post) {
  const n = view.posts.indexOf(post) + 1;
  if (!confirm(`#${n} の投稿を削除しますか？（元に戻せません）`)) return;
  await busy("削除しています…", async () => {
    await commit(`${current}: 投稿を削除`, computeChanges(post.files.map((f) => f.path), new Map()));
    await refresh();
    toast("削除しました");
  });
}

// --- 編集画面 ---

let editing = null; // { post|null, images: [{ sha?, name?, content?, ext?, url }] }

function openEditor(post) {
  editing = {
    post,
    images: post ? post.images.map((img) => ({ sha: img.sha, name: img.name, url: rawUrl(img.path) })) : [],
  };
  $("editor-title").textContent = post ? `#${view.posts.indexOf(post) + 1} の投稿を編集` : "新しい投稿";
  $("text").value = post?.text ?? "";
  $("editor-error").hidden = true;
  updateCount();
  renderImages();
  $("editor").showModal();
}

function updateCount() {
  const n = [...$("text").value.trim()].length;
  $("count").textContent = n;
  $("count").parentElement.classList.toggle("over", n > 500);
}

function renderImages() {
  const list = editing.images;
  $("images").replaceChildren(...list.map((img, i) => el("li", {},
    el("img", { src: img.url, alt: "" }),
    el("div", { className: "img-actions" },
      el("button", { type: "button", textContent: "←", disabled: i === 0, onclick: () => shift(i, -1) }),
      el("button", { type: "button", textContent: "✕", className: "danger", onclick: () => { list.splice(i, 1); renderImages(); } }),
      el("button", { type: "button", textContent: "→", disabled: i === list.length - 1, onclick: () => shift(i, 1) })))));
}

function shift(i, d) {
  const list = editing.images;
  [list[i], list[i + d]] = [list[i + d], list[i]];
  renderImages();
}

// 写真は長い辺を2048pxまでに縮め、JPEGにそろえる（PNGはそのまま）
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`「${file.name}」は読み込めませんでした。JPEG か PNG の写真を選んでください`));
      i.src = url;
    });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const keepPng = file.type === "image/png";
    if (scale === 1 && (keepPng || file.type === "image/jpeg")) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { content: base64FromBytes(bytes), ext: keepPng ? "png" : "jpg", url: URL.createObjectURL(file) };
    }
    const canvas = Object.assign(document.createElement("canvas"), {
      width: Math.round(img.naturalWidth * scale),
      height: Math.round(img.naturalHeight * scale),
    });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = keepPng ? "image/png" : "image/jpeg";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { content: base64FromBytes(bytes), ext: keepPng ? "png" : "jpg", url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

$("text").addEventListener("input", updateCount);

$("file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (editing.images.length + files.length > MAX_IMAGES) {
    alert(`写真は${MAX_IMAGES}枚までです`);
    return;
  }
  await busy("写真を準備しています…", async () => {
    for (const f of files) editing.images.push(await prepareImage(f));
    renderImages();
  });
});

$("editor-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  const text = $("text").value;
  const errors = validatePost(text, editing.images.length);
  if (errors.length) {
    $("editor-error").textContent = errors.join("\n");
    $("editor-error").hidden = false;
    return;
  }
  const { post } = editing;
  const folder = post?.folder ?? nextFolderName(view.posts.map((p) => p.folder));
  const changes = computeChanges(post ? post.files.map((f) => f.path) : [], folderEntries(current, folder, text, editing.images));
  $("editor").close();
  await busy("保存しています…", async () => {
    await commit(`${current}: ${post ? "投稿を編集" : "投稿を追加"}`, changes);
    await refresh();
    toast(post ? "保存しました" : "追加しました");
  });
});

// --- ログイン ---

function logout(message) {
  token = null;
  store.del(TOKEN_KEY);
  $("app").hidden = true;
  $("logout").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message ?? "";
  $("login-error").hidden = !message;
}

async function start() {
  $("login").hidden = true;
  $("app").hidden = false;
  $("logout").hidden = false;
  await busy("読み込んでいます…", refresh);
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  try {
    const info = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("トークンが正しくありません"))));
    if (!info.permissions?.push) throw new Error("このトークンには編集の権限がありません（Contents を Read and write にしてください）");
    store.set(TOKEN_KEY, token);
    await start();
  } catch (err) {
    logout(err.message);
  }
});

$("logout").addEventListener("click", () => logout());
$("add").addEventListener("click", () => openEditor(null));

if (token) start();
else logout();
