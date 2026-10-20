import type { Env } from './env';

/**
 * GitHub App installation token。
 *
 * 与上游 `services/github/getAppAccessToken.ts` 等价，但：
 * - 用 WebCrypto 签 RS256（不需要 jsonwebtoken / node:crypto 的 Buffer）
 * - 缓存放在模块作用域（同一 isolate 内复用），不做 KV / valkey
 */

const GITHUB_API_HOST = 'https://api.github.com';
const TOKEN_SAFETY_WINDOW = 5 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

function toBase64Url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): ArrayBuffer {
  // 环境变量里常常是字面量 \n，两种都兼容
  const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('GITHUB_PRIVATE_KEY is empty.');

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }),
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(env.GITHUB_PRIVATE_KEY || ''),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${toBase64Url(signature)}`;
}

function appHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'giscus',
  };
}

async function resolveInstallationId(env: Env, repoWithOwner: string): Promise<string> {
  if (env.GITHUB_INSTALLATION_ID) return env.GITHUB_INSTALLATION_ID;

  const jwt = await signAppJwt(env);
  const response = await fetch(`${GITHUB_API_HOST}/repos/${repoWithOwner}/installation`, {
    headers: appHeaders(jwt),
  });

  if (!response.ok) {
    throw new Error(
      `Unable to resolve installation for ${repoWithOwner} (HTTP ${response.status}). ` +
        'Set GITHUB_INSTALLATION_ID or install the app on the repository.',
    );
  }

  const data = (await response.json()) as { id: number };
  return String(data.id);
}

export async function getAppAccessToken(env: Env, repoWithOwner?: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_SAFETY_WINDOW) {
    return cachedToken.token;
  }

  const installationId = await resolveInstallationId(env, repoWithOwner || '');
  const jwt = await signAppJwt(env);

  const response = await fetch(
    `${GITHUB_API_HOST}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: appHeaders(jwt),
    },
  );

  if (!response.ok) {
    throw new Error(`Unable to create installation access token (HTTP ${response.status}).`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  return data.token;
}

/** 单元测试 / 部署后自检用：清掉 isolate 内缓存 */
export function resetTokenCache() {
  cachedToken = null;
}
