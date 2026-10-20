/* eslint-disable @typescript-eslint/no-explicit-any */
import './polyfill';
import { adaptDiscussion } from '../lib/adapter';
import { createDiscussion } from '../services/github/createDiscussion';
import { getDiscussion } from '../services/github/getDiscussion';
import { getDiscussionCategories } from '../services/github/getDiscussionCategories';
import { getAppAccessToken } from './appToken';
import type { Env } from './env';
import { decodeState, encodeState } from './state';

/**
 * giscus fork 的服务端。
 *
 * 上游是 Next.js 12 + Pages Router + getServerSideProps + API routes，
 * 在 Cloudflare 免费版上跑不起来（next-on-pages 已废弃；OpenNext 只支持 Next 14+；
 * vinext 要求 React ≥19）。这里把它拆成：
 *   - 页面：构建期按 locale 预渲染成静态 HTML（见 scripts/export-static.mjs）
 *   - 接口：本文件按上游 pages/api/* 的契约逐个重写（纯 fetch + WebCrypto）
 *
 * 接口契约与上游保持一致，客户端不需要任何适配。
 */

const GITHUB_OAUTH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_OAUTH_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_HOST = 'https://api.github.com';

const TOKEN_VALIDITY_PERIOD = 1000 * 60 * 60 * 24 * 365; // 1 年
const DEFAULT_LOCALE = 'en';

type Json = Record<string, unknown>;

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token || undefined;
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  const allowed = allowedOrigins(env);
  if (origin && (allowed.length === 0 || allowed.includes(origin))) {
    return { 'access-control-allow-origin': origin, vary: 'origin' };
  }
  if (allowed.length) return { 'access-control-allow-origin': allowed[0], vary: 'origin' };
  return { 'access-control-allow-origin': '*' };
}

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 校验用户 token 是否属于本 App（上游 services/github/oauth.ts 的 check） */
async function checkUserToken(env: Env, token?: string): Promise<boolean> {
  if (!token || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return false;
  const basic = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);

  try {
    const response = await fetch(`${GITHUB_API_HOST}/applications/${env.GITHUB_CLIENT_ID}/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${basic}`,
        'User-Agent': 'giscus',
      },
      body: JSON.stringify({ access_token: token }),
    });
    const data = (await response.json()) as { app?: { client_id?: string } };
    return data?.app?.client_id === env.GITHUB_CLIENT_ID;
  } catch {
    return false;
  }
}

// ───────────────────────────── /api/discussions ─────────────────────────────

async function discussionsGet(request: Request, url: URL, env: Env) {
  const query = url.searchParams;
  const first = query.get('first');
  const last = query.get('last');

  const params = {
    repo: query.get('repo') || '',
    term: query.get('term') || '',
    number: +(query.get('number') || 0),
    category: query.get('category') || '',
    strict: query.get('strict') === 'true',
    // undefined 会被 JSON.stringify 丢掉；传 0 会被 GraphQL 当成「同时给了 first 和 last」
    first: first ? +first : undefined,
    last: last ? +last : undefined,
    after: query.get('after') || undefined,
    before: query.get('before') || undefined,
  } as Json;

  if (!params.first && !params.last) params.first = 20;

  const userToken = bearerToken(request);
  let token = userToken;
  if (!token) {
    try {
      token = await getAppAccessToken(env, String(params.repo));
    } catch (error) {
      return json({ error: errorMessage(error) }, 403);
    }
  }

  const response: any = await getDiscussion(params as any, token);

  if (response?.message) {
    const status = String(response.message).includes('Bad credentials') ? 403 : 500;
    return json({ error: response.message }, status);
  }

  if (response?.errors) {
    const first = response.errors[0];
    if (first?.message?.includes('API rate limit exceeded')) {
      let message = `API rate limit exceeded for ${params.repo}`;
      if (!userToken) message += '. Sign in to increase the rate limit';
      return json({ error: message }, 429);
    }
    const message =
      response.errors.map?.((error: Json) => error.message).join('. ') || 'Unknown error';
    return json({ error: message }, 500);
  }

  const { data } = response;
  if (!data) return json({ error: 'Unable to fetch discussion' }, 500);

  const { viewer } = data;
  const discussion =
    'search' in data
      ? data.search.discussionCount > 0
        ? data.search.nodes[0]
        : null
      : data.repository.discussion;

  if (!discussion) return json({ error: 'Discussion not found' }, 404);

  return json(adaptDiscussion({ viewer, discussion }));
}

async function discussionsPost(request: Request, env: Env) {
  const userToken = bearerToken(request);
  if (!(await checkUserToken(env, userToken))) {
    return json({ error: 'Invalid or missing access token.' }, 403);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Unable to parse request body.' }, 400);
  }

  const { repo, input } = body || {};
  if (!repo || !input?.title) return json({ error: 'Invalid request body.' }, 400);

  const hashTag = `<!-- sha1: ${await sha1Hex(input.title)} -->`;
  input.body = `${input.body}\n\n${hashTag}`;

  let token: string;
  try {
    token = await getAppAccessToken(env, repo);
  } catch (error) {
    return json({ error: errorMessage(error) }, 403);
  }

  const response: any = await createDiscussion(token, { input });
  const id = response?.data?.createDiscussion?.discussion?.id;
  if (!id) return json({ error: 'Unable to create discussion with request body.' }, 400);

  return json({ id });
}

// ──────────────────────── /api/discussions/categories ───────────────────────

async function categoriesGet(request: Request, url: URL, env: Env) {
  const repo = url.searchParams.get('repo') || '';
  let token = bearerToken(request);
  if (!token) {
    try {
      token = await getAppAccessToken(env, repo);
    } catch (error) {
      return json({ error: errorMessage(error) }, 403);
    }
  }

  const response: any = await getDiscussionCategories({ repo }, token);
  if (response?.message) return json({ error: response.message }, 500);

  const repository = response?.data?.search?.nodes?.[0];
  if (!repository) return json({ repositoryId: '', categories: [] }, 404);

  const categories = repository.discussionCategories.nodes.map(({ emojiHTML, ...rest }: any) => ({
    emoji: emojiHTML?.match(/">(.*?)<\/g-emoji/)?.[1] || '',
    ...rest,
  }));

  return json({ repositoryId: repository.id, categories });
}

// ─────────────────────────────── /api/oauth/* ───────────────────────────────

async function oauthAuthorize(request: Request, url: URL, env: Env) {
  const appReturnUrl = url.searchParams.get('redirect_uri');
  if (!appReturnUrl) return json({ error: '`redirect_uri` is required.' }, 400);

  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const redirectUri = `${proto}://${url.host}/api/oauth/authorized`;
  const state = await encodeState(appReturnUrl, env.ENCRYPTION_PASSWORD);

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });
  return Response.redirect(`${GITHUB_OAUTH_AUTHORIZE_URL}?${params}`, 302);
}

async function oauthAuthorized(url: URL, env: Env) {
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';

  let appReturnUrl: string;
  try {
    appReturnUrl = await decodeState(state, env.ENCRYPTION_PASSWORD);
  } catch (decodeError) {
    return json({ error: errorMessage(decodeError) }, 400);
  }

  const returnUrl = new URL(appReturnUrl);

  if (error === 'access_denied') return Response.redirect(returnUrl.href, 302);
  if (!code || !state) return json({ error: '`code` and `state` are required.' }, 400);

  if (!env.GITHUB_CLIENT_SECRET) {
    return json(
      {
        error:
          'GitHub 登录未配置：缺少 GITHUB_CLIENT_SECRET。匿名评论不受影响，' +
          '把它填进 Worker secret 后即可启用 GitHub 登录。',
      },
      503,
    );
  }

  let accessToken: string;
  try {
    const response = await fetch(GITHUB_OAUTH_ACCESS_TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        state,
      }),
      headers: { Accept: 'application/json', 'User-Agent': 'giscus' },
    });
    if (!response.ok) throw new Error(`Access token response had status ${response.status}.`);

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) throw new Error('Access token response did not contain a token.');
    accessToken = data.access_token;
  } catch (exchangeError) {
    return json({ error: errorMessage(exchangeError) }, 503);
  }

  const session = await encodeState(
    accessToken,
    env.ENCRYPTION_PASSWORD,
    Date.now() + TOKEN_VALIDITY_PERIOD,
  );
  returnUrl.searchParams.set('giscus', session);

  return Response.redirect(returnUrl.href, 302);
}

async function oauthToken(request: Request, env: Env) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Unable to parse request body.' }, 400);
  }

  const session = body?.session;
  if (!session) return json({ error: 'Unable to parse request body.' }, 400);

  try {
    return json({ token: await decodeState(session, env.ENCRYPTION_PASSWORD) });
  } catch (decodeError) {
    return json({ error: errorMessage(decodeError) }, 400);
  }
}

// ────────────────────────────── 静态资源 ──────────────────────────────

async function fetchAsset(env: Env, request: Request, url: URL, pathname: string) {
  const assetUrl = new URL(pathname, url.origin);
  assetUrl.search = url.search;
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

async function serveAssets(request: Request, url: URL, env: Env) {
  const { pathname } = url;
  const candidates: string[] = [];

  if (pathname === '/') candidates.push('/index.html');
  if (pathname === '/widget') candidates.push(`/${DEFAULT_LOCALE}/widget.html`);

  candidates.push(pathname);

  // 无扩展名路径按 Next 的静态导出习惯回退：/x → /x.html → /x/index.html
  if (!/\.[a-z0-9]+$/i.test(pathname) && pathname !== '/') {
    candidates.push(`${pathname}.html`, `${pathname}/index.html`);
  }

  let response: Response | undefined;
  for (const candidate of candidates) {
    response = await fetchAsset(env, request, url, candidate);
    if (response.status !== 404) break;
  }

  const notFound = !response || response.status === 404;
  if (notFound) response = await fetchAsset(env, request, url, '/404.html');

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // 嵌入方用 <script crossorigin="anonymous"> 和 <link crossorigin> 加载 client.js / themes，
  // 缺 ACAO 会被浏览器按 CORS 失败处理（表现为评论框永远不出现）。
  headers.set('Access-Control-Allow-Origin', '*');

  const isHtml = (headers.get('content-type') || '').includes('text/html');
  if (isHtml) {
    const allowed = allowedOrigins(env);
    if (allowed.length) {
      headers.set('Content-Security-Policy', `frame-ancestors 'self' ${allowed.join(' ')};`);
    }
  }

  // 与上游 next.config.js 的 headers() 对齐
  if (pathname === '/client.js' || pathname.startsWith('/themes/')) {
    headers.set('Cache-Control', 'public, max-age=0, stale-while-revalidate=604800');
  }

  return new Response(response.body, {
    status: notFound ? 404 : response.status,
    statusText: response.statusText,
    headers,
  });
}

// ──────────────────────────────── 路由 ────────────────────────────────

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) return serveAssets(request, url, env);

    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    const withCors = (response: Response) => {
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    try {
      if (pathname === '/api/webhook') return withCors(json({ success: true }));

      if (pathname === '/api/discussions') {
        return withCors(
          request.method === 'POST'
            ? await discussionsPost(request, env)
            : await discussionsGet(request, url, env),
        );
      }

      if (pathname === '/api/discussions/categories') {
        return withCors(await categoriesGet(request, url, env));
      }

      if (pathname === '/api/oauth/authorize')
        return withCors(await oauthAuthorize(request, url, env));
      if (pathname === '/api/oauth/authorized') return await oauthAuthorized(url, env);
      if (pathname === '/api/oauth/token') return withCors(await oauthToken(request, env));

      return withCors(json({ error: 'Not found.' }, 404));
    } catch (error) {
      console.error(error);
      return withCors(json({ error: errorMessage(error) }, 500));
    }
  },
};

export default worker;
