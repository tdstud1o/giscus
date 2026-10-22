import { useCallback, useContext, useEffect, useState } from 'react';
import Giscus from '../components/Giscus';
import { AuthContext, ConfigContext, getLoginUrl } from '../lib/context';
import { getTdIdentity, subscribeTdIdentity } from '../lib/anon';
import { emitData } from '../lib/messages';
import { IErrorMessage, IResizeHeightMessage, ISignOutMessage } from '../lib/types/giscus';
import { cleanAnchor } from '../lib/utils';
import { createDiscussion } from '../services/giscus/createDiscussion';
import { getToken } from '../services/giscus/token';

interface IWidgetProps {
  origin: string;
  session: string;
}

export default function Widget({ origin, session }: IWidgetProps) {
  // 两条 GitHub 令牌来源，优先用平台那条：
  //   tdToken —— 读者在 TD 平台绑定过 GitHub，博客后端把令牌换回来下发（一次授权全站通用）；
  //   ownToken —— giscus 自己的 OAuth 授权（老路径，上游行为，没有平台时才会用到）。
  const [ownToken, setOwnToken] = useState('');
  const [tdToken, setTdToken] = useState('');
  const token = tdToken || ownToken;
  const [createDiscussionPromise, setCreateDiscussionPromise] = useState<Promise<string>>();
  const { repo, repoId, categoryId, description, backLink, term, number } =
    useContext(ConfigContext);

  const handleDiscussionCreateRequest = async () => {
    if (createDiscussionPromise) return createDiscussionPromise;

    const promise = createDiscussion(token, repo, {
      repositoryId: repoId,
      categoryId,
      title: term,
      body: `# ${term}\n\n${description || ''}\n\n${cleanAnchor(backLink || origin)}`,
    });
    setCreateDiscussionPromise(promise);

    return promise;
  };

  const handleError = useCallback(
    (message: string) => {
      emitData<IErrorMessage>({ error: message }, origin);
    },
    [origin],
  );

  const handleSignOut = useCallback(() => {
    emitData<ISignOutMessage & IErrorMessage>(
      {
        signOut: true,
        // HACK: For client scripts that haven't been updated to support sign out,
        // use the error message handler to sign out. Remove this after a reasonable
        // period of time.
        error: 'State has expired (user signed out).',
      },
      origin,
    );
  }, [origin]);

  useEffect(() => {
    if (session && !ownToken) {
      getToken(session)
        .then(setOwnToken)
        .catch((err) => handleError(err?.message));
    }
  }, [handleError, session, ownToken]);

  // TD 平台下发的 GitHub 令牌：父页面 postMessage 送来会话后异步换到，到了就接管。
  // 读者退登 / 换账号时这里跟着变空，不会留着上一个人的令牌。
  useEffect(() => {
    const sync = () => setTdToken(getTdIdentity()?.ghToken || '');
    sync();
    return subscribeTdIdentity(sync);
  }, []);

  // 父页（博客）的 iframe 高度全靠这里回传。两条通道：
  //   1. ResizeObserver —— 常规通道，尺寸一变就报；
  //   2. MutationObserver —— 兜底。跨域 iframe 在视口外时，Chromium 会挂起它的渲染更新，
  //      ResizeObserver 的回调不再投递（连 observe() 的初始回调都收不到），但 JS 与布局照跑，
  //      DOM 变更照样通知。没有这条兜底，离屏的评论框会一直停在父页 CSS 的 min-height，
  //      直到用户把它滚进视口才「突然长出来」。
  useEffect(() => {
    let lastHeight = 0;
    const report = (height: number) => {
      const value = Math.ceil(height);
      if (!value || value === lastHeight) return;
      lastHeight = value;
      emitData<IResizeHeightMessage>({ resizeHeight: value }, origin);
    };

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) report(entry.contentRect.height);
    });

    let mutationTimer = 0;
    const mutationObserver = new MutationObserver(() => {
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(
        () => report(document.body.getBoundingClientRect().height),
        150,
      );
    });

    const body = document.body;
    resizeObserver.observe(body);
    mutationObserver.observe(body, { childList: true, subtree: true, characterData: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.clearTimeout(mutationTimer);
    };
  }, [origin]);

  const ready = (!session || token) && repo && (term || number);

  return ready ? (
    <AuthContext.Provider value={{ token, origin, getLoginUrl, onSignOut: handleSignOut }}>
      <Giscus onDiscussionCreateRequest={handleDiscussionCreateRequest} onError={handleError} />
    </AuthContext.Provider>
  ) : null;
}
