import { MarkdownIcon, MarkGithubIcon, PersonIcon, SignOutIcon } from '@primer/octicons-react';
import { ChangeEvent, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { adaptComment, adaptReply, handleCommentClick, processCommentBody } from '../lib/adapter';
import {
  ANON_ENABLED,
  ANON_NICKNAME_KEY,
  TdIdentity,
  getTdIdentity,
  getTdLoginUrl,
  subscribeTdIdentity,
  submitComment,
} from '../lib/anon';
import { AuthContext } from '../lib/context';
import { useGiscusTranslation } from '../lib/i18n';
import { IComment, IReply } from '../lib/types/adapter';
import { resizeTextArea } from '../lib/utils';
import { addDiscussionComment } from '../services/github/addDiscussionComment';
import { addDiscussionReply } from '../services/github/addDiscussionReply';
import { renderMarkdown } from '../services/github/markdown';

// github = 上游 GitHub 账号（写 GraphQL，可回复/点赞）
// account = 博客的 TD 统一平台账号（交给站方 Worker 代发，按 github_login 署名）
// anon    = 不登录，自填昵称
type CommentMode = 'github' | 'account' | 'anon';

interface CommentBoxProps {
  discussionId?: string;
  context?: string;
  replyToId?: string;
  className?: string;
  onSubmit: (comment: IComment | IReply) => void;
  onDiscussionCreateRequest?: () => Promise<string>;
  // 匿名入口：只有主评论框传入（回复框不进匿名模式）
  anonArticle?: string;
  onAnonSubmitted?: () => void;
  // giscus 自己的 GitHub 授权身份（用于「GitHub」那档的头像与昵称）。
  // 没有授权时是 undefined —— 那一档就不可选。
  viewer?: { login: string; avatarUrl: string };
}

export default function CommentBox({
  discussionId,
  context,
  replyToId,
  className = '',
  onSubmit,
  onDiscussionCreateRequest,
  anonArticle,
  onAnonSubmitted,
  viewer,
}: CommentBoxProps) {
  const { t } = useGiscusTranslation();
  const { token, origin, getLoginUrl, onSignOut } = useContext(AuthContext);
  const [isPreview, setIsPreview] = useState(false);
  const [input, setInput] = useState('');
  const [lastInput, setLastInput] = useState('');
  const [preview, setPreview] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReplyOpen, setIsReplyOpen] = useState(false);
  const [lastHeight, setLastHeight] = useState('');
  // 配了站方评论通道时，未登录读者初始就落在「匿名」，等 identity 到了再切「TD 账号」——
  // 否则会先看到一瞬「使用 GitHub 登录」再被替换，观感割裂。
  // 已经有 giscus GitHub 授权（token）的人仍默认走 GitHub，不夺走他们的既有习惯。
  const [mode, setMode] = useState<CommentMode>(() =>
    ANON_ENABLED && anonArticle && !token ? 'anon' : 'github',
  );
  // 用户自己点过滑块之后，identity 异步到达就不再改他的选择 ——
  // 否则「我明确选了匿名」会被登录态悄悄顶成 TD 账号。
  const pickedMode = useRef(false);
  const [nickname, setNickname] = useState('');
  const [anonError, setAnonError] = useState('');
  const [identity, setIdentity] = useState<TdIdentity | null>(null);
  const [tdLogin, setTdLogin] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const loginUrl = getLoginUrl(origin);
  const isReply = !!replyToId;
  const placeHolderText = isReply ? t('writeAReply') : t('writeAComment');
  const allowAnon = ANON_ENABLED && !!anonArticle;
  // 走站方 Worker 代发的两种模式（TD 账号 / 匿名）：主评论框与回复框都支持
  const isWorker = allowAnon && mode !== 'github';
  const isAnon = allowAnon && mode === 'anon';
  const isAccount = allowAnon && mode === 'account';
  // 有 GitHub 关联时 login 是用户名（补 @）；没有的话服务端退的是邮箱，不加 @ 前缀
  const whoLabel = identity
    ? identity.login.includes('@')
      ? identity.login
      : '@' + identity.login
    : '';
  // 三档是否可选：TD 要平台会话（服务端验签得来），GitHub 要 giscus 自己的授权
  const canTd = !!identity;
  const canGh = !!token;
  // 用户自己拨过滑块之后，identity 异步到达就不改他的选择
  const switchMode = (next: CommentMode) => {
    pickedMode.current = true;
    setMode(next);
    setAnonError('');
  };
  // 底部「以谁的身份发表」预览：头像 + 昵称 + 颜色标记。
  // 三档颜色是身份语义 —— TD 蓝 / GitHub 紫黑 / 匿名 黄，评论正文顶部的署名标记同源。
  const who =
    isAccount && identity
      ? {
          kind: 'account' as const,
          name: whoLabel,
          avatar: identity.avatarUrl,
          extra: identity.isAdmin ? '站主' : identity.isFriend ? '好友' : '',
        }
      : mode === 'github'
        ? {
            kind: 'github' as const,
            name: viewer?.login || 'GitHub 账号',
            avatar: viewer?.avatarUrl || '',
            extra: '',
          }
        : {
            kind: 'anon' as const,
            name: nickname.trim() || '未填昵称',
            avatar: '',
            extra: '',
          };
  const whoBadge = who.kind === 'account' ? 'TD' : who.kind === 'github' ? 'GitHub' : '匿名';

  // 订阅父页面下发的博客登录态：登录了就默认用 TD 账号发表，没登录默认匿名。
  // identity 是异步换来的（服务端解密校验），期间先显示「正在识别…」。
  useEffect(() => {
    if (!allowAnon) return;
    const apply = () => {
      const id = getTdIdentity();
      setIdentity(id);
      setTdLogin(getTdLoginUrl());
      setMode((prev) => {
        // 用户已经自己选过就尊重选择；否则 TD 登录态优先（这就是 TD 的权威性：
        // 有会话时默认身份就是账号，匿名只是他主动切过去的选项）。
        if (pickedMode.current) return prev;
        if (id) return 'account';
        return prev === 'account' ? 'anon' : prev;
      });
    };
    apply();
    return subscribeTdIdentity(apply);
  }, [allowAnon]);

  // 昵称记住即可，不必联网；localStorage 只在客户端读，避免 SSR 不一致
  useEffect(() => {
    if (!allowAnon) return;
    try {
      setNickname(window.localStorage.getItem(ANON_NICKNAME_KEY) || '');
    } catch {
      /* 隐私模式下 localStorage 可能抛错，忽略 */
    }
  }, [allowAnon]);

  useEffect(() => {
    if (isPreview && input !== lastInput) {
      if (input) {
        setIsLoading(true);
        renderMarkdown(input, token, context).then((value) => {
          const processed = processCommentBody(value);
          setPreview(processed);
          setIsLoading(false);
        });
      }
      setLastInput(input);
    }
  }, [isPreview, input, lastInput, token, context]);

  const reset = useCallback(() => {
    setInput('');
    setPreview('');
    setIsPreview(false);
    setIsSubmitting(false);
    setIsReplyOpen(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;

    // TD 账号 / 匿名：不走 GitHub GraphQL，交给站方 Worker（GitHub App 代发 Discussion 评论）。
    // 账号模式下昵称由服务端从会话里取（前端传了也不认），匿名模式必须自填。
    if (isWorker) {
      if (!anonArticle) return;
      const nick = nickname.trim();
      if (isAnon && !nick) {
        setAnonError('请先填写昵称');
        return;
      }
      if (!input.trim()) return;
      setIsSubmitting(true);
      setAnonError('');
      try {
        await submitComment({
          article: anonArticle,
          nickname: isAnon ? nick : undefined,
          body: input,
          replyTo: replyToId,
          // 明确匿名：不带 x-session，服务端就不会把这条署名成 TD 账号
          asAnonymous: isAnon,
        });
        if (isAnon) {
          try {
            window.localStorage.setItem(ANON_NICKNAME_KEY, nick);
          } catch {
            /* 隐私模式下 localStorage 不可写，忽略 */
          }
        }
        reset();
        onAnonSubmitted?.();
      } catch (e) {
        const code = e instanceof Error ? e.message : String(e);
        const friendly: Record<string, string> = {
          session_expired: '博客登录已过期，刷新页面重新登录，或改用匿名昵称',
          rate_limited: '发得太快了，歇几分钟再试',
          bad_nickname: '昵称长度需在 1–24 字之间',
          bad_body: '正文为空或超过 5000 字',
          bad_reply_to: '要回复的评论已不存在（可能已被删除），刷新后再试',
          anon_disabled: '评论功能暂未开放',
        };
        setAnonError(`发布失败：${friendly[code] || code}`);
        setIsSubmitting(false);
      }
      return;
    }

    if (!discussionId && !onDiscussionCreateRequest) return;
    setIsSubmitting(true);

    const id = discussionId ? discussionId : await onDiscussionCreateRequest();
    const payload = { body: input, discussionId: id, replyToId };

    if (!id) {
      window.alert('Unable to create discussion.');
      setIsSubmitting(false);
      return;
    }

    if (replyToId) {
      addDiscussionReply(payload, token).then(({ data: { addDiscussionReply } }) => {
        const { reply } = addDiscussionReply;
        const adapted = adaptReply(reply);

        onSubmit(adapted);
        reset();
      });
    } else {
      addDiscussionComment(payload, token).then(({ data: { addDiscussionComment } }) => {
        const { comment } = addDiscussionComment;
        const adapted = adaptComment(comment);

        onSubmit(adapted);
        reset();
      });
    }
  }, [
    isSubmitting,
    isWorker,
    isAnon,
    anonArticle,
    nickname,
    onAnonSubmitted,
    discussionId,
    input,
    replyToId,
    onDiscussionCreateRequest,
    token,
    onSubmit,
    reset,
  ]);

  const handleReplyOpen = () => {
    setIsReplyOpen(true);
  };

  const handleTextAreaChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setInput(event.target.value);
      // Only resize if it hasn't been resized manually.
      if (!lastHeight || lastHeight === textarea.current.style.height) {
        resizeTextArea(textarea.current);
        setLastHeight(textarea.current.style.height);
      }
    },
    [lastHeight],
  );

  useEffect(() => {
    if (!textarea.current) return;
    if (isReplyOpen) textarea.current.focus();
  }, [isReplyOpen]);

  return !isReply || isReplyOpen ? (
    <form
      className={`color-bg-primary color-border-primary gsc-comment-box ${
        isReply ? 'gsc-comment-box-is-reply' : ''
      } ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="color-bg-tertiary color-border-primary gsc-comment-box-tabs">
        <div className="mx-2 mb-[-1px] mt-2">
          <button
            className={`rounded-t border border-b-0 px-4 py-2 ${
              !isPreview
                ? 'color-text-primary color-bg-canvas color-border-primary'
                : 'color-text-secondary border-transparent'
            }`}
            onClick={() => setIsPreview(false)}
            type="button"
          >
            {t('write')}
          </button>
          <button
            className={`ml-1 rounded-t border border-b-0 px-4 py-2 ${
              isPreview
                ? 'color-text-primary color-bg-canvas color-border-primary'
                : 'color-text-secondary border-transparent'
            }`}
            onClick={() => setIsPreview(true)}
            type="button"
          >
            {t('preview')}
          </button>
        </div>
      </div>
      <div className="gsc-comment-box-main">
        {isAnon ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input
              className="form-control input-contrast color-bg-primary color-border-primary w-40 rounded border px-2 py-1 text-sm"
              type="text"
              maxLength={24}
              placeholder="昵称（必填）"
              aria-label="匿名评论昵称"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              disabled={isSubmitting}
            />
            <span className="color-text-secondary text-xs">匿名评论不带 TD 标记，只署这个昵称</span>
            {!identity && tdLogin ? (
              <a
                className="link-secondary inline-flex items-center gap-1 text-xs"
                href={tdLogin}
                target="_blank"
                rel="noopener noreferrer"
                title="登录后以 TD 统一账号身份署名，不用每次手填昵称"
              >
                <PersonIcon fill="currentColor" /> 用 TD 账号登录
              </a>
            ) : null}
          </div>
        ) : null}
        {isPreview ? (
          // The <div> element *might* have a child <button> element from
          // GitHub's markdown renderer result that allows keyboard interaction.
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
          <div
            className="markdown color-border-primary gsc-comment-box-preview"
            dangerouslySetInnerHTML={
              isLoading ? undefined : { __html: preview || t('nothingToPreview') }
            }
            onClick={handleCommentClick}
          >
            {isLoading ? t('loadingPreview') : undefined}
          </div>
        ) : (
          <div className="gsc-comment-box-write">
            <textarea
              className="form-control input-contrast gsc-comment-box-textarea"
              dir="auto"
              placeholder={
                isAccount
                  ? `以 ${whoLabel || 'TD 账号'} 身份${isReply ? '回复' : '发表'}…（Ctrl/⌘+Enter 发送）`
                  : isAnon
                    ? isReply
                      ? '匿名回复：写点什么…（Ctrl/⌘+Enter 发送）'
                      : '匿名模式：写点什么…（Ctrl/⌘+Enter 发送）'
                    : token
                      ? placeHolderText
                      : t('signInToComment')
              }
              onChange={handleTextAreaChange}
              value={input}
              disabled={(!token && !isWorker) || isSubmitting}
              ref={textarea}
              onKeyDown={(event) =>
                (event.ctrlKey || event.metaKey) && event.key === 'Enter' && handleSubmit()
              }
            ></textarea>
            <div className="form-control input-contrast gsc-comment-box-textarea-extras">
              <a
                className="link-secondary gsc-comment-box-markdown-hint flex gap-2"
                rel="nofollow noopener noreferrer"
                target="_blank"
                href="https://guides.github.com/features/mastering-markdown/"
                title={t('stylingWithMarkdownIsSupported')}
              >
                <MarkdownIcon className="mr-1" />
              </a>
            </div>
          </div>
        )}
      </div>
      {allowAnon ? (
        // 身份条：左边「以谁的身份发」（头像 + 昵称 + 颜色标记），右边三档滑块。
        // 头像/昵称全部来自已经验过的身份（TD 会话由服务端解密、GitHub 来自自己的 token），
        // 匿名这一档没有头像、标记固定是黄色「匿名」—— 任何人填什么昵称都冒充不了 TD。
        <div className="gsc-id-bar">
          <div className="gsc-id-who">
            {who.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="gsc-id-avatar"
                src={who.avatar}
                alt=""
                width={20}
                height={20}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span
                className={`gsc-id-avatar gsc-id-avatar-text gsc-id-${who.kind}`}
                aria-hidden="true"
              >
                {(who.kind === 'anon' ? nickname.trim() : who.name.replace(/^@/, '')).charAt(0) ||
                  (who.kind === 'anon' ? '匿' : 'T')}
              </span>
            )}
            <span className="gsc-id-name" title={who.name}>
              {who.name}
            </span>
            <span className={`gsc-id-badge gsc-id-${who.kind}`}>{whoBadge}</span>
            {who.extra ? <span className="gsc-id-extra">{who.extra}</span> : null}
          </div>
          <div
            className="gsc-id-switch"
            data-mode={mode}
            role="radiogroup"
            aria-label="以什么身份发表"
          >
            <span className="gsc-id-switch-thumb" aria-hidden="true" />
            <button
              type="button"
              role="radio"
              aria-checked={isAccount}
              aria-disabled={!canTd}
              title={
                canTd
                  ? '以 TD 统一账号发表（身份由服务端验签，前端伪造不了）'
                  : tdLogin
                    ? '先登录 TD，登录后这里会自动变成账号身份'
                    : '未接入 TD 登录'
              }
              onClick={() => {
                if (canTd) switchMode('account');
                else if (tdLogin) window.open(tdLogin, '_blank', 'noopener,noreferrer');
              }}
            >
              TD
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'github'}
              aria-disabled={!canGh}
              title={
                canGh
                  ? '以 giscus 授权的 GitHub 账号发表（可回复、点赞）'
                  : '要先在评论区授权 GitHub 才能用这一档'
              }
              onClick={() => {
                if (canGh) switchMode('github');
              }}
            >
              GitHub
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isAnon}
              title="匿名发表：自填昵称，不带 TD 标记"
              onClick={() => switchMode('anon')}
            >
              匿名
            </button>
          </div>
        </div>
      ) : null}
      <div className="gsc-comment-box-bottom">
        {token && !isReply ? (
          <button type="button" className="link-secondary text-sm" onClick={onSignOut}>
            <SignOutIcon className="mr-2" />
            {t('signOut')}
          </button>
        ) : null}
        <div className="gsc-comment-box-buttons">
          {anonError ? <span className="mr-2 text-xs text-red-500">{anonError}</span> : null}
          {isReply ? (
            <button
              className="btn ml-1 rounded-md border"
              onClick={() => setIsReplyOpen(false)}
              type="button"
            >
              {t('cancel')}
            </button>
          ) : null}
          {token || isWorker ? (
            <button
              className="btn btn-primary items-center ml-1 rounded-md border"
              type="submit"
              disabled={!input.trim() || isSubmitting}
            >
              {isWorker
                ? isSubmitting
                  ? '发布中…'
                  : isAccount
                    ? isReply
                      ? '回复'
                      : '发表'
                    : isReply
                      ? '匿名回复'
                      : '匿名发布'
                : isReply
                  ? t('reply')
                  : t('comment')}
            </button>
          ) : tdLogin ? (
            // 博客已接入 TD 统一平台：未登录时优先引导走平台，一次登录全站通用
            <a
              className="btn btn-primary inline-flex items-center ml-1 rounded-md border hover:no-underline"
              target="_blank"
              rel="noopener noreferrer"
              href={tdLogin}
            >
              <PersonIcon className="mr-2" fill="currentColor" /> 用 TD 账号登录
            </a>
          ) : (
            <a
              className="btn btn-primary inline-flex items-center ml-1 rounded-md border hover:no-underline"
              target="_top"
              href={loginUrl}
            >
              <MarkGithubIcon className="mr-2" fill="currentColor" /> {t('signInWithGitHub')}
            </a>
          )}
        </div>
      </div>
    </form>
  ) : (
    <div className="color-bg-tertiary gsc-reply-box">
      <button
        className="form-control color-text-secondary color-border-primary w-full cursor-text rounded border px-2 py-1 text-left focus:border-transparent"
        onClick={handleReplyOpen}
        type="button"
      >
        {t('writeAReply')}
      </button>
    </div>
  );
}
