// 投稿キュー: accounts/<account>/posts/<フォルダ>/ に text.txt と写真を置く。
// フォルダ名の順に1件ずつ投稿し、最後まで行ったら最初に戻る。
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_TEXT_LENGTH = 500;
export const MAX_IMAGES = 20;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);

const byName = (a, b) => a.localeCompare(b, "ja", { numeric: true });

export async function loadPost(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  const text = files.includes("text.txt")
    ? (await readFile(path.join(dir, "text.txt"), "utf8")).trim()
    : "";
  const images = files
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort(byName);

  return { text, images };
}

export function validatePost(name, post) {
  const errors = [];
  if (!post.text && post.images.length === 0) {
    errors.push(`${name}: text.txt も写真もありません`);
  }
  if ([...post.text].length > MAX_TEXT_LENGTH) {
    errors.push(`${name}: 文章が${MAX_TEXT_LENGTH}文字を超えています（${[...post.text].length}文字）`);
  }
  if (post.images.length > MAX_IMAGES) {
    errors.push(`${name}: 写真は${MAX_IMAGES}枚までです（${post.images.length}枚）`);
  }
  return errors;
}

export async function listPostFolders(postsDir) {
  const entries = await readdir(postsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort(byName);
}

// 前回投稿したフォルダの次を選ぶ。前回のフォルダが消えていても、名前順で次に来るものを選ぶ。
export function pickNext(folders, last) {
  if (folders.length === 0) return null;
  if (last == null) return folders[0];
  return folders.find((f) => byName(f, last) > 0) ?? folders[0];
}

export async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { last: null };
    throw err;
  }
}

export async function writeState(file, state) {
  await writeFile(file, JSON.stringify(state, null, 2) + "\n");
}
