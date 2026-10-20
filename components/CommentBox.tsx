import { MarkdownIcon, MarkGithubIcon, SignOutIcon, TypographyIcon } from '@primer/octicons-react';
import { ChangeEvent, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { adaptComment, adaptReply, handleCommentClick, processCommentBody } from '../lib/adapter';
import { ANON_ENABLED, ANON_NICKNAME_KEY, addAnonymousComment } from '../lib/anon';
import { AuthContext } from '../lib/context';
import { useGiscusTranslation } from '../lib/i18n';
import { IComment, IReply } from '../lib/types/adapter';
import { resizeTextArea } from '../lib/utils';
import { addDiscussionComment } from '../services/github/addDiscussionComment';
import { addDiscussionReply } from '../services/github/addDiscussionReply';
import { renderMarkdown } from '../services/github/markdown';

type CommentMode = 'github' | 'anon';

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
}: CommentBoxProps) {
  const { t } = useGiscusTranslation();
  const [isPreview, setIsPreview] = useState(false);
  const [input, setInput] = useState('');
  const [lastInput, setLastInput] = useState('');
  const [preview, setPreview] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReplyOpen, setIsReplyOpen] = useState(false);
  const [isFixedWidth, setIsFixedWidth] = useState(false);
  const [lastHeight, setLastHeight] = useState('');
  const [mode, setMode] = useState<CommentMode>('github');
  const [nickname, setNickname] = useState('');
  const [anonError, setAnonError] = useState('');
  const { token, origin, getLoginUrl, onSignOut } = useContext(AuthContext);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const loginUrl = getLoginUrl(origin);
  const isReply = !!replyToId;
  const placeHolderText = isReply ? t('writeAReply') : t('writeAComment');
  const allowAnon = ANON_ENABLED && !!anonArticle;
  const isAnon = allowAnon && mode === 'anon';

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

    // 匿名模式：不走 GitHub GraphQL，交给站方 Worker（GitHub App 代发 Discussion 评论）
    if (isAnon) {
      if (!anonArticle) return;
      const nick = nickname.trim();
      if (!nick) {
        setAnonError('请先填写昵称');
        return;
      }
      if (!input.trim()) return;
      setIsSubmitting(true);
      setAnonError('');
      try {
        await addAnonymousComment({ article: anonArticle, nickname: nick, body: input });
        try {
          window.localStorage.setItem(ANON_NICKNAME_KEY, nick);
        } catch {
          /* 隐私模式下 localStorage 不可写，忽略 */
        }
        reset();
        onAnonSubmitted?.();
      } catch (e) {
        setAnonError(`发布失败：${e instanceof Error ? e.message : String(e)}`);
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

        <div className="gsc-comment-box-md-toolbar">
          {!isPreview ? (
            <button
              className="gsc-toolbar-item"
              type="button"
              title={isFixedWidth ? t('disableFixedWidth') : t('enableFixedWidth')}
              onClick={() => {
                setIsFixedWidth(!isFixedWidth);
                textarea.current.focus();
              }}
              tabIndex={-1}
            >
              <TypographyIcon />
            </button>
          ) : null}
          {allowAnon ? (
            <button
              type="button"
              className={`ml-1 rounded-md border px-2 py-[3px] text-xs font-medium ${
                isAnon
                  ? 'border-transparent bg-emerald-600 text-white'
                  : 'color-bg-secondary color-border-primary color-text-secondary'
              }`}
              title={isAnon ? '切回 GitHub 账号发帖' : '切换为匿名发帖（无需登录）'}
              aria-pressed={isAnon}
              onClick={() => {
                setMode(isAnon ? 'github' : 'anon');
                setAnonError('');
              }}
            >
              {isAnon ? '🕶️ 匿名' : '🐙 GitHub'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="gsc-comment-box-main">
        {isAnon ? (
          <div className="mb-2 flex items-center gap-2">
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
            <span className="color-text-secondary text-xs">
              匿名发布：以该昵称署名，内容由站方机器人代发
            </span>
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
              className={`form-control input-contrast gsc-comment-box-textarea ${
                isFixedWidth ? 'gsc-is-fixed-width' : ''
              }`}
              dir="auto"
              placeholder={
                isAnon
                  ? '匿名模式：写点什么…（Ctrl/⌘+Enter 发送）'
                  : token
                    ? placeHolderText
                    : t('signInToComment')
              }
              onChange={handleTextAreaChange}
              value={input}
              disabled={(!token && !isAnon) || isSubmitting}
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
          {token || isAnon ? (
            <button
              className="btn btn-primary items-center ml-1 rounded-md border"
              type="submit"
              disabled={((token || isAnon) && !input.trim()) || isSubmitting}
            >
              {isAnon
                ? isSubmitting
                  ? '发布中…'
                  : '匿名发布'
                : isReply
                  ? t('reply')
                  : t('comment')}
            </button>
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
