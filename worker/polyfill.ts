/**
 * Workers 运行时补丁。
 *
 * `lib/utils.ts` 用 `typeof window === 'undefined'` 决定 crypto 来源：
 * 有 window 时同步取 `window.crypto`，否则动态 `import('crypto')`。
 * Worker 里没有 window，动态 import 是异步的，`webcrypto` 会在模块初始化后
 * 一小段时间内仍是 undefined —— `getDiscussion(strict)` 之类的调用会踩到竞态。
 *
 * 这里在其它模块求值之前（本文件是入口的第一个 import）挂一个最小 window，
 * 让 utils 走同步分支。只对 Worker 有效，不影响浏览器构建。
 */
const g = globalThis as Record<string, unknown>;
if (typeof g.window === 'undefined') {
  g.window = { crypto: g.crypto };
}

/**
 * GitHub API 强制要求 User-Agent，缺了会直接返回
 * "Request forbidden by administrative rules"。
 * Node 的 fetch 会自带 UA，Workers 的不会，所以这里全局补一层。
 */
const originalFetch = globalThis.fetch;
if (!(originalFetch as unknown as { __giscusPatched?: boolean }).__giscusPatched) {
  const patched = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has('user-agent')) headers.set('user-agent', 'giscus');

    if (input instanceof Request) {
      return originalFetch(new Request(input, { ...init, headers }));
    }
    return originalFetch(input, { ...init, headers });
  };
  (patched as unknown as { __giscusPatched?: boolean }).__giscusPatched = true;
  globalThis.fetch = patched as typeof globalThis.fetch;
}

export {};
