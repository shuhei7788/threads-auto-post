// ダッシュボードの画面に依存しない処理。src/queue.mjs と同じ並び順・選び方にそろえる。
export const MAX_TEXT_LENGTH = 500;
export const MAX_IMAGES = 20;
const IMAGE_RE = /\.(jpe?g|png)$/i;

export const byName = (a, b) => a.localeCompare(b, "ja", { numeric: true });

export function pickNext(folders, last) {
  if (folders.length === 0) return null;
  if (last == null) return folders[0];
  return folders.find((f) => byName(f, last) > 0) ?? folders[0];
}

// folder を次に投稿させるための state.last（直前のフォルダ。先頭なら末尾にして一周させる）
export function lastFor(folders, folder) {
  const i = folders.indexOf(folder);
  if (i < 0) throw new Error(`投稿が見つかりません: ${folder}`);
  return folders[(i - 1 + folders.length) % folders.length];
}

// Git ツリーの一覧から、アカウントごとの投稿を組み立てる
export function buildAccount(tree, account) {
  const prefix = `accounts/${account}/posts/`;
  const posts = new Map();
  for (const e of tree) {
    if (e.type !== "blob" || !e.path.startsWith(prefix)) continue;
    const [folder, file, ...rest] = e.path.slice(prefix.length).split("/");
    if (!file || rest.length || folder.startsWith(".")) continue;
    if (!posts.has(folder)) posts.set(folder, { folder, files: [], textSha: null, images: [] });
    const post = posts.get(folder);
    post.files.push({ path: e.path, sha: e.sha });
    if (file === "text.txt") post.textSha = e.sha;
    else if (IMAGE_RE.test(file)) post.images.push({ name: file, path: e.path, sha: e.sha });
  }
  const list = [...posts.values()].sort((a, b) => byName(a.folder, b.folder));
  for (const p of list) p.images.sort((a, b) => byName(a.name, b.name));
  const stateEntry = tree.find((e) => e.path === `accounts/${account}/state.json`);
  return { posts: list, stateSha: stateEntry?.sha ?? null };
}

export function nextFolderName(folders) {
  const max = folders.reduce((m, f) => {
    const n = parseInt(f, 10);
    return Number.isNaN(n) ? m : Math.max(m, n);
  }, 0);
  return String(max + 1).padStart(3, "0");
}

export function validatePost(text, imageCount) {
  const errors = [];
  if (!text.trim() && imageCount === 0) errors.push("文章か写真のどちらかを入れてください");
  const len = [...text.trim()].length;
  if (len > MAX_TEXT_LENGTH) errors.push(`文章は${MAX_TEXT_LENGTH}文字までです（今は${len}文字）`);
  if (imageCount > MAX_IMAGES) errors.push(`写真は${MAX_IMAGES}枚までです（今は${imageCount}枚）`);
  return errors;
}

export function imageFileName(index, ext) {
  return `${String(index + 1).padStart(2, "0")}.${ext}`;
}

// 1つの投稿フォルダの中身を作る。images は { sha } か { content(base64), ext } の配列。
export function folderEntries(account, folder, text, images) {
  const base = `accounts/${account}/posts/${folder}`;
  const entries = new Map();
  if (text.trim()) entries.set(`${base}/text.txt`, { text: text.trim() + "\n" });
  images.forEach((img, i) => {
    const ext = img.ext ?? (img.name?.match(/\.(\w+)$/)?.[1].toLowerCase() || "jpg");
    entries.set(`${base}/${imageFileName(i, ext)}`, img.sha ? { sha: img.sha } : { content: img.content });
  });
  return entries;
}

// 古いファイル一覧と新しい中身から、Git ツリーに渡す変更を作る（消えたファイルは削除）
export function computeChanges(oldPaths, newEntries) {
  const changes = [];
  for (const [path, entry] of newEntries) changes.push({ path, ...entry });
  for (const path of oldPaths) if (!newEntries.has(path)) changes.push({ path, delete: true });
  return changes;
}

// 2つの投稿の順番を入れ替える（フォルダ名を交換する）
export function swapEntries(a, b) {
  const entries = new Map();
  const move = (from, toFolder) => {
    for (const f of from.files) {
      const parts = f.path.split("/");
      parts[parts.length - 2] = toFolder;
      entries.set(parts.join("/"), { sha: f.sha });
    }
  };
  move(a, b.folder);
  move(b, a.folder);
  return computeChanges([...a.files, ...b.files].map((f) => f.path), entries);
}

export function base64FromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function textFromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
