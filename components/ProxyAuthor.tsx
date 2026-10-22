import type { ProxiedIdentity } from '../lib/proxied';

/**
 * 「代谁发的」头部：站方机器人代发的评论不显示机器人，而是显示真正的委托人 ——
 * 头像 + 昵称 + 身份标记（TD 蓝 / 匿名 黄）。颜色和评论框底部那条身份条完全同源，
 * 读者在输入时选的身份，和发出去之后看到的标记是同一个东西。
 *
 * 名字全程当纯文本渲染（React 自动转义），不拼任何 HTML。
 */
export function ProxyAvatar({ proxied, size = 30 }: { proxied: ProxiedIdentity; size?: number }) {
  if (proxied.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="gsc-proxy-avatar-img"
        src={proxied.avatar}
        width={size}
        height={size}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  // 匿名没有平台头像：用固定占位（黄底「匿」），和评论框身份条里的占位一致
  return (
    <span
      className={`gsc-proxy-avatar gsc-proxy-${proxied.kind}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {proxied.kind === 'anon' ? '匿' : Array.from(proxied.name)[0] || 'T'}
    </span>
  );
}

export function ProxyName({ proxied }: { proxied: ProxiedIdentity }) {
  return (
    <span className="gsc-proxy-name">
      <span className="link-primary overflow-hidden text-ellipsis font-semibold">
        {proxied.name}
      </span>
      <span className={`gsc-proxy-badge gsc-proxy-${proxied.kind}`}>
        {proxied.kind === 'td' ? 'TD' : '匿名'}
      </span>
      {proxied.role ? <span className="gsc-proxy-role">{proxied.role}</span> : null}
    </span>
  );
}

/** 头像 + 名字 + 标记，整块（主评论头用）。 */
export function ProxyAuthor({ proxied }: { proxied: ProxiedIdentity }) {
  return (
    <span className="gsc-proxy-who">
      <ProxyAvatar proxied={proxied} />
      <ProxyName proxied={proxied} />
    </span>
  );
}
