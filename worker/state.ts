/**
 * OAuth state / session 的加解密。
 *
 * 语义与 `lib/oauth/state.ts` 一致（AES-GCM + 过期时间），但实现不依赖 `Buffer`
 * （Workers 里只有 nodejs_compat 才有）与 `lib/utils` 的 crypto 竞态。
 * 该格式只在服务端自用（authorize 编码 → authorized / token 解码），
 * 客户端从不解析，因此换实现不影响兼容性。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_VALIDITY_PERIOD = 5 * 60 * 1000; // 5 分钟

interface State {
  value: string;
  expires: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(password));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encodeState(
  value: string,
  password: string,
  expires = Date.now() + DEFAULT_VALIDITY_PERIOD,
): Promise<string> {
  if (!password) throw new Error('ENCRYPTION_PASSWORD is not configured.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const state: State = { value, expires };
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await deriveKey(password),
    encoder.encode(JSON.stringify(state)),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decodeState(encryptedState: string, password: string): Promise<string> {
  if (!password) throw new Error('ENCRYPTION_PASSWORD is not configured.');

  const [ivPart, cipherPart] = (encryptedState || '').split('.');
  if (!ivPart || !cipherPart) throw new Error('Invalid state value.');

  let state: State;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(ivPart) },
      await deriveKey(password),
      fromBase64Url(cipherPart),
    );
    state = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('Invalid state value.');
  }

  if (Date.now() > state.expires) throw new Error('State has expired.');
  return state.value;
}
