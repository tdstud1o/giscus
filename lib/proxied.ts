// 「这条评论是谁让站方机器人代发的」——自托管扩展，非上游功能。
//
// 站方机器人（GitHub App `td-studio-app`）替读者发 Discussion 评论，所以在 GitHub 看来
// 所有这类评论都署同一个机器人账号。为了让读者分辨「代谁发的」，blog-server 在正文第 0 行
// 埋了一个 HTML 注释（GitHub 渲染时不可见），紧跟着一行人可见的署名。本模块负责把它读回来。
//
// 安全边界（这几条是硬的，缺一条就能被冒名）：
//   1. **只解析作者是站方机器人**的评论。普通读者哪怕把标记原样抄进正文，作者也不是机器人，
//      直接当作普通评论 —— 这正是「匿名用户改昵称改正文也冒充不了别人」的根。
//   2. **只认第 0 行**（`^`）。服务端永远把自己的标记写在最前，用户正文里的同款标记只能排在
//      后面，永远匹配不到。
//   3. 字段全部白名单校验：kind 只认 td/anon，名字去结构字符并截断，头像只认 https + GitHub/
//      自家域主机。渲染层一律当纯文本（JSX 自动转义），全程不拼 HTML。
//   4. 反过来的情况（机器人发的评论里出现假名字）也不成立：名字由服务端从会话/清洗后的昵称
//      写入，用户改不了已经发出去的正文。

export const PROXY_BOT_LOGIN = 'td-studio-app';

export interface ProxiedIdentity {
  kind: 'td' | 'anon';
  /** 显示名。服务端已清洗：单行、不含 md/html 结构字符、≤32 字。 */
  name: string;
  /** 头像地址；匿名或没有头像时是空串，UI 退化成字母块。 */
  avatar: string;
  /** 附加身份：站主 / 好友 / ''（匿名恒为空）。 */
  role: '' | '站主' | '好友';
}

/** 标记只允许出现在 body 的最开头，且整段 JSON 不含换行。 */
const MARKER = /^<!-- td:v1 (\{[^\n]{0,600}\}) -->\n/;

const AVATAR_HOSTS = new Set(['avatars.githubusercontent.com', 'github.com', 'tmoc.qzz.io']);

/** 头像白名单：https + 已知主机。杜绝 data: / javascript: / 任意第三方追踪像素。 */
function safeAvatar(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 300) return '';
  if (!/^https:\/\/[^\s"'<>\\]+$/.test(raw)) return '';
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (AVATAR_HOSTS.has(host) || host.endsWith('.tmoc.qzz.io')) return raw;
  } catch {
    /* 不是合法 URL，当作没有头像 */
  }
  return '';
}

/** 与服务端同款清洗：压成单行、去掉能破坏结构或伪装成标题的字符。 */
function safeName(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return (
    raw
      // eslint-disable-next-line no-control-regex -- 就是要匹配控制字符（换行/零宽等）
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
      .replace(/[\s\u00a0]+/g, ' ')
      .replace(/[`<>|*_~[\]()#!\\]/g, '')
      .trim()
      .slice(0, max)
      .trim()
  );
}

/**
 * 从「作者 + 原始 markdown」里读出代发身份。
 * 不是站方机器人发的、格式对不上、字段非法 —— 一律返回 null（等于普通评论）。
 */
export function parseProxied(
  authorLogin: string | undefined,
  body: string | undefined,
): ProxiedIdentity | null {
  if (authorLogin !== PROXY_BOT_LOGIN) return null;
  if (typeof body !== 'string') return null;

  const matched = MARKER.exec(body);
  if (!matched) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(matched[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || (raw.k !== 'td' && raw.k !== 'anon')) return null;

  const kind = raw.k;
  const name = safeName(raw.n, 32);
  if (!name) return null;
  const role: ProxiedIdentity['role'] =
    kind === 'td' ? (raw.r === 'admin' ? '站主' : raw.r === 'friend' ? '好友' : '') : '';

  return { kind, name, avatar: kind === 'td' ? safeAvatar(raw.a) : '', role };
}

/**
 * 去掉正文开头的署名块（机器人写的那段 blockquote），因为头部卡片已经把同样的信息
 * 显示得更清楚了。只在认出代发身份时调用 —— 用户自己写的引用块一个字都不动。
 */
export function stripProxiedHeader(bodyHTML: string): string {
  // 机器人写的署名一定是渲染结果里的第一个 blockquote；用户正文里的引用排在它后面
  const matched = /^\s*<blockquote>[\s\S]*?<\/blockquote>\s*/.exec(bodyHTML);
  return matched ? bodyHTML.slice(matched[0].length) : bodyHTML;
}
