// 匿名评论（自托管扩展，非上游功能）
//
// 提交到站方 Worker，由 GitHub App 以机器人身份把正文写成 Discussion 评论，
// 所以匿名评论与 GitHub 登录评论共用同一条数据流，giscus 列表里原样可见。
// endpoint 由构建期环境变量注入；未配置时整个匿名入口不渲染（上游行为不变）。

export const ANON_ENDPOINT = (process.env.NEXT_PUBLIC_ANON_ENDPOINT || '').trim();

export const ANON_ENABLED = ANON_ENDPOINT.length > 0;

export const ANON_NICKNAME_KEY = 'giscus-anon-nickname';

export interface AnonCommentParams {
  // 文章路径，与 giscus 的 Discussion 标题一致（pathname 映射，无前导斜杠 → 这里补上）
  article: string;
  nickname: string;
  body: string;
}

interface AnonCommentResponse {
  ok?: boolean;
  url?: string;
  error?: string;
}

export async function addAnonymousComment(params: AnonCommentParams): Promise<string> {
  const res = await fetch(ANON_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  let json: AnonCommentResponse | null = null;
  try {
    json = (await res.json()) as AnonCommentResponse;
  } catch {
    json = null;
  }

  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `http_${res.status}`);
  }

  return json.url || '';
}
