import Head from 'next/head';
import { useContext, useEffect, useState } from 'react';
import Widget from '../components/Widget';
import { ConfigContext, ThemeContext } from '../lib/context';
import { availableLanguages } from '../lib/i18n';
import { InputPosition, ISetConfigMessage } from '../lib/types/giscus';
import { cleanSessionParam, getOriginHost } from '../lib/utils';
import { Theme } from '../lib/variables';

// 与上游的差异：不再使用 getServerSideProps。
// 自托管部署（Cloudflare Workers 静态资源）无法提供 Node SSR，
// 所需数据原本全部来自 iframe URL 的查询参数，因此改为客户端解析。
// 语言由 Next i18n 的路径前缀 /<locale>/widget 决定，构建期按 locale 预渲染。

interface WidgetQuery {
  origin: string;
  originHost: string;
  session: string;
  theme: Theme;
  backLink: string;
  config: {
    repo: string;
    repoId: string;
    category: string;
    categoryId: string;
    description: string;
    backLink: string;
    term: string;
    number: number;
    strict: boolean;
    reactionsEnabled: boolean;
    emitMetadata: boolean;
    inputPosition: InputPosition;
    defaultCommentOrder: 'oldest' | 'newest';
  };
}

function parseQuery(search: string): WidgetQuery {
  const query = new URLSearchParams(search);
  const { origin, originHost } = getOriginHost(query.get('origin') || '');
  const backLink = query.get('backLink') || origin;

  return {
    origin,
    originHost,
    session: query.get('session') || '',
    theme: (query.get('theme') || 'preferred_color_scheme') as Theme,
    backLink,
    config: {
      repo: query.get('repo') || '',
      repoId: query.get('repoId') || '',
      category: query.get('category') || '',
      categoryId: query.get('categoryId') || '',
      description: query.get('description') || '',
      backLink,
      term: cleanSessionParam(query.get('term') || ''),
      number: +query.get('number') || 0,
      strict: Boolean(+query.get('strict')),
      reactionsEnabled: Boolean(+query.get('reactionsEnabled')),
      emitMetadata: Boolean(+query.get('emitMetadata')),
      inputPosition: (query.get('inputPosition') === 'top' ? 'top' : 'bottom') as InputPosition,
      defaultCommentOrder: (query.get('defaultCommentOrder') === 'newest' ? 'newest' : 'oldest') as
        | 'oldest'
        | 'newest',
    },
  };
}

// 切换语言时直接跳转到对应的 <locale> 路径，避免依赖客户端路由的 i18n 数据。
function navigateToLocale(lang: string) {
  const { pathname, search, hash } = window.location;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 1 && segments[0] in availableLanguages) {
    segments[0] = lang;
  } else {
    segments.unshift(lang);
  }
  window.location.replace(`/${segments.join('/')}${search}${hash}`);
}

export default function WidgetPage() {
  const [query, setQuery] = useState<WidgetQuery | null>(null);
  const [config, setConfig] = useState<WidgetQuery['config']>(() => parseQuery('').config);
  const { theme: resolvedTheme, setTheme } = useContext(ThemeContext);

  useEffect(() => {
    const parsed = parseQuery(window.location.search);
    setConfig(parsed.config);
    setTheme(parsed.theme);
    setQuery(parsed);
  }, [setTheme]);

  const originHost = query?.originHost || '';

  useEffect(() => {
    if (!originHost) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== originHost) return;
      if (typeof event.data !== 'object' || !event.data.giscus) return;

      const giscusData = event.data.giscus;
      if (!('setConfig' in giscusData)) return;

      const { setConfig: newConfig } = giscusData as ISetConfigMessage;

      if ('theme' in newConfig) {
        setTheme(newConfig.theme);
        delete newConfig.theme;
      }

      if (newConfig.lang && newConfig.lang in availableLanguages) {
        const lang = newConfig.lang;
        delete newConfig.lang;
        navigateToLocale(lang);
        return;
      }

      setConfig((prevConfig) => ({ ...prevConfig, ...newConfig }));
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [originHost, setTheme]);

  // 静态导出的 HTML 是空的，等客户端读到 iframe URL 后再渲染，
  // 这样不会出现服务端 / 客户端两套配置导致的 hydration 不一致。
  if (!query) return null;

  return (
    <>
      <Head>
        <base target="_top" />
        <title>giscus</title>
      </Head>

      <main className="w-full mx-auto" data-theme={resolvedTheme}>
        <ConfigContext.Provider value={config}>
          <Widget origin={query.origin} session={query.session} />
        </ConfigContext.Provider>
      </main>
    </>
  );
}
