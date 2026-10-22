import { useContext, useEffect, useState } from 'react';
import { AuthContext, ConfigContext } from '../lib/context';
import { Trans, useGiscusTranslation } from '../lib/i18n';
import { emitData } from '../lib/messages';
import { CommentOrder, IMetadataMessage } from '../lib/types/giscus';
import { useFrontBackDiscussion } from '../services/giscus/discussions';
import Comment from './Comment';
import CommentBox from './CommentBox';
import ReactButtons from './ReactButtons';

interface IGiscusProps {
  onDiscussionCreateRequest?: () => Promise<string>;
  onError?: (message: string) => void;
}

export default function Giscus({ onDiscussionCreateRequest, onError }: IGiscusProps) {
  const { token, origin } = useContext(AuthContext);
  const { t } = useGiscusTranslation();
  const {
    repo,
    term,
    number,
    category,
    strict,
    reactionsEnabled,
    emitMetadata,
    inputPosition,
    defaultCommentOrder,
  } = useContext(ConfigContext);
  const [orderBy, setOrderBy] = useState<CommentOrder>(defaultCommentOrder);
  const query = { repo, term, category, number, strict };

  const { addNewComment, updateReactions, increaseSize, backMutators, frontMutators, ...data } =
    useFrontBackDiscussion(query, token, orderBy);

  useEffect(() => {
    if (data.error && onError) {
      onError(data.error?.message);
    }
  }, [data.error, onError]);

  useEffect(() => {
    if (!emitMetadata || !data.discussion.id) return;
    const message: IMetadataMessage = {
      discussion: data.discussion,
      viewer: data.viewer,
    };
    emitData(message, origin);
  }, [data.discussion, data.viewer, emitMetadata, origin]);

  useEffect(() => {
    import('../lib/vendor/math-renderer-element');
  }, []);

  const handleDiscussionCreateRequest = async () => {
    const id = await onDiscussionCreateRequest();
    // Force revalidate
    frontMutators.mutate();
    backMutators.mutate();
    return id;
  };

  // 匿名入口仅对 pathname/url 之外的普通 term 生效；term 是 Discussion 标题（无前导斜杠），
  // 站方 Worker 要求以 "/" 开头的站内路径，这里补齐。URL 型 term 直接不启用匿名。
  const anonArticle = !term || /^https?:/i.test(term) ? '' : `/${term.replace(/^\/+/, '')}`;

  // GitHub 那一档要显示自己的头像与昵称：viewer 由 GraphQL 一起查回来（未授权时为空）。
  const viewer = data.viewer
    ? { login: data.viewer.login, avatarUrl: data.viewer.avatarUrl }
    : undefined;

  // 站方 Worker 代发的评论（TD 账号 / 匿名）绕过了本地 mutator，写完统一重新拉一遍。
  // GitHub 侧刚写入的评论，列表查询要过几秒才反映出来 —— 补几次延时重拉，
  // 否则读者以为没发出去、手动刷新才看到。
  const revalidate = () => {
    const pull = () => {
      frontMutators.mutate();
      backMutators.mutate();
    };
    pull();
    [1200, 3000, 6000].forEach((ms) => window.setTimeout(pull, ms));
  };

  const mainCommentBox = (
    <CommentBox
      discussionId={data.discussion.id}
      context={repo}
      onSubmit={addNewComment}
      onDiscussionCreateRequest={handleDiscussionCreateRequest}
      anonArticle={anonArticle}
      onAnonSubmitted={revalidate}
      viewer={viewer}
    />
  );

  const shouldCreateDiscussion = data.isNotFound && !number;
  const shouldShowBranding = !!data.discussion.url;

  const shouldShowReplyCount =
    !data.error && !data.isNotFound && !data.isLoading && data.totalReplyCount > 0;

  const shouldShowCommentBox =
    (data.isRateLimited && !token) ||
    (!data.isLoading && !data.isLocked && (!data.error || (data.isNotFound && !number)));

  if (data.isLoading) {
    return (
      <div className="gsc-loading">
        <div className="gsc-loading-image" />
        <span className="gsc-loading-text color-fg-muted">{t('loadingComments')}</span>
      </div>
    );
  }

  return (
    <div className="color-text-primary gsc-main">
      {reactionsEnabled && !data.isLoading && (shouldCreateDiscussion || !data.error) ? (
        <div className="gsc-reactions">
          <h4 className="gsc-reactions-count">
            {shouldCreateDiscussion && !data.reactionCount ? (
              t('reactions', { count: 0 })
            ) : (
              <a
                href={data.discussion.url}
                target="_blank"
                rel="noreferrer noopener nofollow"
                className="color-text-primary"
              >
                {t('reactions', { count: data.reactionCount || 0 })}
              </a>
            )}
          </h4>
          <div className="flex flex-auto items-center justify-center gap-2 text-sm mt-2">
            <ReactButtons
              subjectId={data.discussion.id}
              reactionGroups={data.discussion.reactions}
              onReact={updateReactions}
              onDiscussionCreateRequest={handleDiscussionCreateRequest}
            />
          </div>
        </div>
      ) : null}

      <div className="gsc-comments">
        <div className="gsc-header">
          <div className="gsc-left-header">
            <h4 className="gsc-comments-count">
              {shouldCreateDiscussion && !data.totalCommentCount ? (
                t('comments', { count: 0 })
              ) : data.error && !data.backData ? (
                t('genericError', { message: data.error?.message || '' })
              ) : (
                <a
                  href={data.discussion.url}
                  target="_blank"
                  rel="noreferrer noopener nofollow"
                  className="color-text-primary underline"
                >
                  {t('comments', { count: data.totalCommentCount })}
                </a>
              )}
            </h4>
            {shouldShowReplyCount ? (
              <>
                <h4 className="gsc-comments-count-separator">·</h4>
                <h4 className="gsc-replies-count">
                  {t('replies', {
                    count: data.totalReplyCount,
                    plus: data.numHidden > 0 ? '+' : '',
                  })}
                </h4>
              </>
            ) : null}
            {shouldShowBranding ? (
              <em className="color-text-secondary text-sm">
                <Trans
                  i18nKey="common:poweredBy"
                  components={{
                    a: (
                      <a
                        href="https://giscus.app"
                        target="_blank"
                        rel="noreferrer noopener nofollow"
                        className="link-secondary"
                      />
                    ),
                  }}
                />
              </em>
            ) : null}
          </div>
          {data.totalCommentCount > 0 ? (
            <ul className="gsc-right-header BtnGroup">
              <li
                className={`BtnGroup-item ${orderBy === 'oldest' ? 'BtnGroup-item--selected' : ''}`}
                aria-current={orderBy === 'oldest'}
              >
                <button className="btn" onClick={() => setOrderBy('oldest')}>
                  {t('oldest')}
                </button>
              </li>
              <li
                className={`BtnGroup-item ${orderBy === 'newest' ? 'BtnGroup-item--selected' : ''}`}
                aria-current={orderBy === 'newest'}
              >
                <button className="btn" onClick={() => setOrderBy('newest')}>
                  {t('newest')}
                </button>
              </li>
            </ul>
          ) : null}
        </div>

        {shouldShowCommentBox && inputPosition === 'top' ? mainCommentBox : null}

        <div className={`gsc-timeline ${!data.totalCommentCount ? 'hidden' : ''}`}>
          {!data.isLoading
            ? data.frontComments.map((comment) => (
                <Comment
                  key={comment.id}
                  comment={comment}
                  replyBox={
                    // 回复不再强制 giscus 自己的 GitHub 授权：博客已登录（TD 账号）或
                    // 愿意填昵称的读者都能回复，内容由站方 Worker 带 reply_to 代发
                    !data.isLocked && (token || anonArticle) ? (
                      <CommentBox
                        discussionId={data.discussion.id}
                        context={repo}
                        onSubmit={frontMutators.addNewReply}
                        replyToId={comment.id}
                        anonArticle={anonArticle}
                        onAnonSubmitted={revalidate}
                        viewer={viewer}
                      />
                    ) : undefined
                  }
                  onCommentUpdate={frontMutators.updateComment}
                  onReplyUpdate={frontMutators.updateReply}
                />
              ))
            : null}

          {data.numHidden > 0 ? (
            <div className="pagination-loader-container gsc-pagination">
              <button
                className="gsc-pagination-button color-border-primary"
                onClick={increaseSize}
                disabled={data.isLoadingMore}
              >
                <span className="color-text-secondary">
                  {t('hiddenItems', { count: data.numHidden })}
                </span>
                <span className="color-text-link font-semibold">
                  {data.isLoadingMore ? t('loading') : t('loadMore')}…
                </span>
              </button>
            </div>
          ) : null}

          {!data.isLoading
            ? data.backComments.map((comment) => (
                <Comment
                  key={comment.id}
                  comment={comment}
                  replyBox={
                    !data.isLocked && (token || anonArticle) ? (
                      <CommentBox
                        discussionId={data.discussion.id}
                        context={repo}
                        onSubmit={backMutators.addNewReply}
                        replyToId={comment.id}
                        anonArticle={anonArticle}
                        onAnonSubmitted={revalidate}
                      />
                    ) : undefined
                  }
                  onCommentUpdate={backMutators.updateComment}
                  onReplyUpdate={backMutators.updateReply}
                />
              ))
            : null}
        </div>

        {shouldShowCommentBox && inputPosition !== 'top' ? mainCommentBox : null}
      </div>
    </div>
  );
}
