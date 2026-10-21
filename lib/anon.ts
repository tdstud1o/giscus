// 评论身份（自托管扩展，非上游功能）
//
// 两条身份通道，最终都落到站方 Worker：
//   1) TD 账号 —— 博客侧已登录时，父页面把 localStorage 里的 blog_session 通过
//      postMessage 交给本 iframe（第三方域读不到别人的 localStorage），提交时放在
//      `x-session` 头里，Worker 解出会话后按平台下发的 github_login 署名。
//   2) 匿名 —— 不登录，自填昵称，Worker 同样代发。
//
// 正文都由 GitHub App 代发成 Discussion 评论，所以两种身份在 giscus 列表里同源可见。
// endpoint 由构建期环境变量注入；未配置时整个扩展入口不渲染（上游行为不变）。

export const ANON_ENDPOINT = (process.env.NEXT_PUBLIC_ANON_ENDPOINT || '').trim();

export const ANON_ENABLED = ANON_ENDPOINT.length > 0;

export const ANON_NICKNAME_KEY = 'giscus-anon-nickname';

// 由评论端点反推博客 API 源（同一 Worker）：https://blog.tmoc.qzz.io/api/comment → https://blog.tmoc.qzz.io
export const BLOG_API_ORIGIN = (() => {
  if (!ANON_ENABLED) return '';
  try {
    return new URL(ANON_ENDPOINT).origin;
  } catch {
    return '';
  }
})();

export interface TdIdentity {
  login: string;
  isAdmin: boolean;
  isFriend: boolean;
  level: string;
}

// —— 父页面下发的会话（模块级，够用且不必穿 React context） ——
let tdSession = '';
let tdIdentity: TdIdentity | null = null;
// 父页面算好的「用 TD 账号登录」入口（带 redirect 回当前文章），未登录时给按钮用
let tdLoginUrl = '';
const listeners = new Set<() => void>();

export function getTdSession(): string {
  return tdSession;
}

export function getTdLoginUrl(): string {
  return tdLoginUrl;
}

export function getTdIdentity(): TdIdentity | null {
  return tdIdentity;
}

export function subscribeTdIdentity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn());
}

// 父页面 postMessage 进来：{ giscus: { tdSession: "<blog_session>", tdLoginUrl?: "..." } }
// 同一会话只处理一次；空串表示「父页面确认未登录」，用来清掉旧身份。
export function setTdSession(session: string, loginUrl?: string) {
  const next = (session || '').trim();
  const urlChanged = !!loginUrl && loginUrl !== tdLoginUrl;
  if (loginUrl) tdLoginUrl = loginUrl;
  if (next === tdSession) {
    if (urlChanged) notify();
    return;
  }
  tdSession = next;
  tdIdentity = null;
  notify();
  if (next) void refreshTdIdentity();
}

// 向博客 Worker 换身份（GET /api/me，带 x-session 头）。
// 会话解密与过期判断都在服务端；过期就当作未登录，不打扰用户。
export async function refreshTdIdentity(): Promise<TdIdentity | null> {
  if (!tdSession || !BLOG_API_ORIGIN) {
    tdIdentity = null;
    notify();
    return null;
  }
  const session = tdSession;
  try {
    const res = await fetch(`${BLOG_API_ORIGIN}/api/me`, {
      headers: { 'x-session': session },
    });
    const json = (await res.json()) as {
      logged_in?: boolean;
      github_login?: string;
      github_id?: string;
      is_admin?: boolean;
      is_friend?: boolean;
      id_level?: string;
    };
    if (session !== tdSession) return tdIdentity; // 期间会话被换掉了，丢弃本次结果
    tdIdentity = json?.logged_in
      ? {
          login: json.github_login || json.github_id || '',
          isAdmin: !!json.is_admin,
          isFriend: !!json.is_friend,
          level: json.id_level || '',
        }
      : null;
  } catch {
    if (session !== tdSession) return tdIdentity;
    tdIdentity = null;
  }
  notify();
  return tdIdentity;
}

export interface CommentParams {
  // 文章路径，与 giscus 的 Discussion 标题一致（pathname 映射，无前导斜杠 → 这里补上）
  article: string;
  // 匿名时才用；TD 账号模式下服务端忽略它
  nickname?: string;
  body: string;
}

interface CommentResponse {
  ok?: boolean;
  url?: string;
  error?: string;
}

export async function submitComment(params: CommentParams): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tdSession) headers['x-session'] = tdSession;

  const res = await fetch(ANON_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });

  let json: CommentResponse | null = null;
  try {
    json = (await res.json()) as CommentResponse;
  } catch {
    json = null;
  }

  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `http_${res.status}`);
  }

  return json.url || '';
}
