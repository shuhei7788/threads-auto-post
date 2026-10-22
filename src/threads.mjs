// Threads API クライアント。アクセストークンはログやエラーメッセージに出さない。
const API = "https://graph.threads.net";
const VERSION = "v1.0";

export class ThreadsError extends Error {}

export function createClient({ token, fetch = globalThis.fetch, sleep = defaultSleep, pollIntervalMs = 5000, pollTimeoutMs = 300000 }) {
  if (!token) throw new ThreadsError("アクセストークンが設定されていません");

  async function call(method, pathname, params = {}) {
    const url = new URL(`${API}/${pathname}`);
    const body = new URLSearchParams({ ...params, access_token: token });
    let res;
    if (method === "GET") {
      url.search = body.toString();
      res = await fetch(url, { method });
    } else {
      res = await fetch(url, { method, body });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const message = data.error?.message ?? `HTTP ${res.status}`;
      throw new ThreadsError(`Threads API エラー (${method} ${pathname.replace(/\d{6,}/g, "<id>")}): ${message}`);
    }
    return data;
  }

  async function waitUntilReady(containerId) {
    const deadline = Date.now() + pollTimeoutMs;
    for (;;) {
      const { status, error_message } = await call("GET", `${VERSION}/${containerId}`, { fields: "status,error_message" });
      if (status === "FINISHED") return;
      if (status === "ERROR" || status === "EXPIRED") {
        throw new ThreadsError(`投稿の準備に失敗しました: ${status} ${error_message ?? ""}`.trim());
      }
      if (Date.now() >= deadline) throw new ThreadsError("投稿の準備がタイムアウトしました");
      await sleep(pollIntervalMs);
    }
  }

  return {
    async me() {
      return call("GET", `${VERSION}/me`, { fields: "id,username" });
    },

    // text と imageUrls（0枚以上）から投稿を作って公開し、投稿IDを返す。
    async publish(userId, { text, imageUrls }) {
      let containerId;
      if (imageUrls.length === 0) {
        ({ id: containerId } = await call("POST", `${VERSION}/${userId}/threads`, { media_type: "TEXT", text }));
      } else if (imageUrls.length === 1) {
        ({ id: containerId } = await call("POST", `${VERSION}/${userId}/threads`, {
          media_type: "IMAGE",
          image_url: imageUrls[0],
          ...(text && { text }),
        }));
      } else {
        const children = [];
        for (const image_url of imageUrls) {
          const { id } = await call("POST", `${VERSION}/${userId}/threads`, {
            media_type: "IMAGE",
            image_url,
            is_carousel_item: "true",
          });
          await waitUntilReady(id);
          children.push(id);
        }
        ({ id: containerId } = await call("POST", `${VERSION}/${userId}/threads`, {
          media_type: "CAROUSEL",
          children: children.join(","),
          ...(text && { text }),
        }));
      }
      await waitUntilReady(containerId);
      const { id } = await call("POST", `${VERSION}/${userId}/threads_publish`, { creation_id: containerId });
      return id;
    },

    // 長期トークン（60日）を更新する。発行から24時間以上経ち、期限内のトークンが対象。
    async refreshToken() {
      const data = await call("GET", "refresh_access_token", { grant_type: "th_refresh_token" });
      return { token: data.access_token, expiresIn: data.expires_in };
    },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
