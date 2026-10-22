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
  /** 平台账号的显示名（userinfo.preferred_username，如「Timmoc」）。没有就退回 login。 */
  name: string;
  /** GitHub 登录名（没有关联 GitHub 时是邮箱）。只在需要 @ 前缀或兜底时用。 */
  login: string;
  isAdmin: boolean;
  isFriend: boolean;
  level: string;
  // 平台下发的头像（OIDC picture，老会话没有就退回 github.com/<login>.png）。
  // 空串表示这个账号没有头像，UI 退化成首字母。
  avatarUrl: string;
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
      name?: string;
      github_login?: string;
      github_id?: string;
      is_admin?: boolean;
      is_friend?: boolean;
      id_level?: string;
      avatar_url?: string;
    };
    if (session !== tdSession) return tdIdentity; // 期间会话被换掉了，丢弃本次结果
    tdIdentity = json?.logged_in
      ? {
          name: json.name || '',
          login: json.github_login || json.github_id || '',
          isAdmin: !!json.is_admin,
          isFriend: !!json.is_friend,
          level: json.id_level || '',
          avatarUrl: json.avatar_url || '',
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
  // 父评论 node id（DC_xxx）：填了就是回复，服务端校验它属于本文对应的 Discussion
  replyTo?: string;
  // true = 明确以匿名身份发。即使浏览器里存着 TD 会话也**不带** x-session，
  // 否则服务端会把这条当 TD 账号发的（署名与蓝色 TD 标记来自会话，不是前端能选的）。
  asAnonymous?: boolean;
}

interface CommentResponse {
  ok?: boolean;
  url?: string;
  error?: string;
}

export async function submitComment(params: CommentParams): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // 只有「以 TD 账号发」才带会话。匿名模式下带上去 = 匿名被账号顶掉，
  // 蓝色 TD 标记也就失去意义了（服务端只认会话，不认前端声明的身份）。
  if (tdSession && !params.asAnonymous) headers['x-session'] = tdSession;

  const payload = {
    article: params.article,
    nickname: params.nickname,
    body: params.body,
    ...(params.replyTo ? { reply_to: params.replyTo } : {}),
  };

  const res = await fetch(ANON_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
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
