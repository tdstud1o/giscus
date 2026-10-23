(function () {
  const GISCUS_SESSION_KEY = 'giscus-session';
  const script = document.currentScript as HTMLScriptElement;
  const giscusOrigin = new URL(script.src).origin;

  // 宿主站点可选提供的钩子（博客侧 comments.html / extend_footer.html 定义了这两个）：
  //   __tdSignOut       —— 站点自己的登出（清头部身份、背景图池回 normal）
  //   __giscusRefresh   —— 让站点把「当前登录态」重新下发给重载后的 iframe
  // 都不是必需的：别的站点引这套 client 时它们不存在，行为退回原样。
  const tdHooks = window as unknown as {
    __tdSignOut?: () => void;
    __giscusRefresh?: () => void;
  };

  function formatError(message: string) {
    return `[giscus] An error occurred. Error message: "${message}".`;
  }

  function getMetaContent(property: string, og = false) {
    const ogSelector = og ? `meta[property='og:${property}'],` : '';
    const element = document.querySelector<HTMLMetaElement>(
      ogSelector + `meta[name='${property}']`,
    );

    return element ? element.content : '';
  }

  // Set up session and clear the session param on load
  const url = new URL(location.href);
  let session = url.searchParams.get('giscus') || '';
  const savedSession = localStorage.getItem(GISCUS_SESSION_KEY);
  url.searchParams.delete('giscus');
  url.hash = '';
  const cleanedLocation = url.toString();

  if (session) {
    localStorage.setItem(GISCUS_SESSION_KEY, JSON.stringify(session));
    history.replaceState(undefined, document.title, cleanedLocation);
  } else if (savedSession) {
    try {
      session = JSON.parse(savedSession);
    } catch (e) {
      localStorage.removeItem(GISCUS_SESSION_KEY);
      console.warn(`${formatError(e?.message)} Session has been cleared.`);
    }
  }

  const attributes = script.dataset;
  const params: Record<string, string> = {};

  params.origin = cleanedLocation;
  params.session = session as string;
  params.theme = attributes.theme as string;
  params.reactionsEnabled = attributes.reactionsEnabled || '1';
  params.emitMetadata = attributes.emitMetadata || '0';
  params.inputPosition = attributes.inputPosition || 'bottom';
  params.repo = attributes.repo as string;
  params.repoId = attributes.repoId as string;
  params.category = attributes.category || '';
  params.categoryId = attributes.categoryId as string;
  params.strict = attributes.strict || '0';
  params.description = getMetaContent('description', true);
  params.backLink = getMetaContent('giscus:backlink') || cleanedLocation;

  switch (attributes.mapping) {
    case 'url':
      params.term = cleanedLocation;
      break;
    case 'title':
      params.term = document.title;
      break;
    case 'og:title':
      params.term = getMetaContent('title', true);
      break;
    case 'specific':
      params.term = attributes.term as string;
      break;
    case 'number':
      params.number = attributes.term as string;
      break;
    case 'pathname':
    default:
      params.term =
        location.pathname.length < 2
          ? 'index'
          : location.pathname.substring(1).replace(/\.\w+$/, '');
      break;
  }

  // Check anchor of the existing container and append it to origin URL
  const existingContainer = document.querySelector<HTMLElement>('.giscus');
  const id = existingContainer && existingContainer.id;
  if (id) {
    params.origin = `${cleanedLocation}#${id}`;
  }

  // Set up iframe src and loading attribute
  const locale = attributes.lang ? `/${attributes.lang}` : '';
  const src = `${giscusOrigin}${locale}/widget?${new URLSearchParams(params)}`;
  const loading = attributes.loading === 'lazy' ? 'lazy' : undefined;

  // Set up iframe element
  const iframeElement = document.createElement('iframe');
  const iframeAttributes = {
    class: 'giscus-frame giscus-frame--loading',
    title: 'Comments',
    scrolling: 'no',
    allow: 'clipboard-write',
    src,
    loading,
  };
  Object.entries(iframeAttributes).forEach(
    ([key, value]) => value && iframeElement.setAttribute(key, value),
  );
  // Prevent white flash on load
  iframeElement.style.opacity = '0';
  iframeElement.addEventListener('load', () => {
    iframeElement.style.removeProperty('opacity');
    iframeElement.classList.remove('giscus-frame--loading');
  });

  // Link default style and prepend as <head>'s first child to make override possible.
  const style =
    (document.getElementById('giscus-css') as HTMLLinkElement) || document.createElement('link');
  style.id = 'giscus-css';
  style.rel = 'stylesheet';
  style.href = `${giscusOrigin}/default.css`;
  document.head.prepend(style);

  // Insert iframe element
  let container: HTMLElement;
  if (!existingContainer) {
    const iframeContainer = document.createElement('div');
    iframeContainer.setAttribute('class', 'giscus');
    iframeContainer.appendChild(iframeElement);

    script.insertAdjacentElement('afterend', iframeContainer);
    container = iframeContainer;
  } else {
    while (existingContainer.firstChild) existingContainer.firstChild.remove();
    existingContainer.appendChild(iframeElement);
    container = existingContainer;
  }
  const suggestion = `Please consider reporting this error at https://github.com/giscus/giscus/issues/new.`;

  // —— iframe 高度策略 ——
  // 移动端的铁律：**文档一变矮，浏览器立刻把 scrollY 夹到新的上限**。
  // 读者在评论区里一滑，iframe 高度这时只要缩几百像素，页面就被「弹」到评论区外面，
  // 缩多少跳多少，而且夹紧之后再也回不到原来的位置（实测 881→380 会跳 501px）。
  //
  // 所以：iframe 如实跟随内容（内容永远完整显示，不留裁切），但**外层容器只记住
  // 见过的最大高度**并作为 min-height。变矮时由容器撑住，文档总高度不缩，
  // 滚动位置就永远不会被抢走。转屏 / 改窗口时重置，让新布局重新决定高度。
  let maxFrameHeight = 0;

  function applyHeight(next: number) {
    if (!next) return;
    iframeElement.style.height = `${next}px`;
    if (next > maxFrameHeight) {
      maxFrameHeight = next;
      container.style.minHeight = `${next}px`;
    }
  }

  window.addEventListener('resize', () => {
    maxFrameHeight = 0;
    container.style.minHeight = '';
  });

  function signOut() {
    delete params.session;
    const src = `${giscusOrigin}${locale}/widget?${new URLSearchParams(params)}`;
    iframeElement.src = src; // Force reload
  }

  // Listen to messages
  window.addEventListener('message', (event) => {
    if (event.origin !== giscusOrigin) return;

    const { data } = event;
    if (!(typeof data === 'object' && data.giscus)) return;

    if (data.giscus.resizeHeight) {
      applyHeight(Number(data.giscus.resizeHeight) || 0);
    }

    if (data.giscus.signOut) {
      // TD 会话（博客自己的登录态 blog_session）存在父页 localStorage 里，iframe
      // 读不到也删不掉。只清 giscus 自己的 GitHub 会话 = 假登出：父页一下发身份，
      // 评论框又变回 TD，刷新更是直接「自动登录」。
      if (data.giscus.tdSignOut) {
        try {
          localStorage.removeItem('blog_session');
          localStorage.removeItem('tmoc_bg_me');
        } catch {
          // localStorage 被禁用：没什么可清的，继续走下面的 iframe 重建
        }
        // 博客头部的头像卡片 / 背景图池跟着回到未登录（站点没提供钩子就只能等刷新）
        tdHooks.__tdSignOut?.();
      }
      localStorage.removeItem(GISCUS_SESSION_KEY);
      console.log(`[giscus] User has logged out. Session has been cleared.`);
      signOut();
      // iframe 被重建了，让它重新问父页要一次身份（这时拿到的会是空串 = 未登录）
      tdHooks.__giscusRefresh?.();
      return;
    }

    if (!data.giscus.error) return;

    const message: string = data.giscus.error;

    if (
      message.includes('Bad credentials') ||
      message.includes('Invalid state value') ||
      message.includes('State has expired')
    ) {
      // Might be because token is expired or other causes
      if (localStorage.getItem(GISCUS_SESSION_KEY) !== null) {
        localStorage.removeItem(GISCUS_SESSION_KEY);
        console.warn(`${formatError(message)} Session has been cleared.`);
        signOut();
      } else if (!savedSession) {
        console.error(`${formatError(message)} No session is stored initially. ${suggestion}`);
      }
    } else if (message.includes('Discussion not found')) {
      console.warn(
        `[giscus] ${message}. A new discussion will be created if a comment/reaction is submitted.`,
      );
    } else if (message.includes('API rate limit exceeded')) {
      console.warn(formatError(message));
    } else {
      console.error(`${formatError(message)} ${suggestion}`);
    }
  });
})();
