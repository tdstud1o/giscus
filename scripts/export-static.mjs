/**
 * 把 `next build` 的预渲染结果装配成可直接静态托管的目录（等价于 next export，
 * 但 next export 在 i18n 场景被 Next 明确禁用，所以自己拼）。
 *
 * 产物：
 *   out/_next/static/**          → 客户端 chunk
 *   out/<locale>/widget.html     → iframe 里的评论框页面（每个 locale 一份）
 *   out/<locale>/index.html      → 首页（每个 locale 一份）
 *   out/index.html, out/widget.html → 默认语言 en 的无前缀副本
 *   out/**                       → public/ 原样（client.js、themes/、图标）
 */

import { cp, mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pagesDir = join(root, '.next', 'server', 'pages');
const outDir = join(root, 'out');

const DEFAULT_LOCALE = 'en';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!existsSync(pagesDir)) {
    throw new Error('缺少 .next/server/pages，先跑 next build');
  }

  try {
    await rm(outDir, { recursive: true, force: true });
  } catch (error) {
    // 本机沙箱会拦截批量删除，残留旧文件不影响 CI 部署
    console.warn(`[export] 清理 out 失败（可忽略）：${error.message}`);
  }
  await mkdir(outDir, { recursive: true });

  // 1. 客户端 chunk
  await cp(join(root, '.next', 'static'), join(outDir, '_next', 'static'), { recursive: true });

  // 2. 各 locale 的 HTML
  const locales = (await readdir(pagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(pagesDir, name, 'widget.html')));

  if (!locales.length) throw new Error('没有找到任何 locale 的 widget.html');

  for (const locale of locales) {
    const target = join(outDir, locale);
    await mkdir(target, { recursive: true });

    for (const file of await readdir(join(pagesDir, locale))) {
      if (!file.endsWith('.html')) continue;
      const name = file === 'widget.html' ? 'widget.html' : file;
      await copyFile(join(pagesDir, locale, file), join(target, name));
    }

    const homepage = join(pagesDir, `${locale}.html`);
    if (existsSync(homepage)) await copyFile(homepage, join(target, 'index.html'));
  }

  // 3. 默认语言的无前缀副本（/widget、/ 直接可用）
  await copyFile(join(pagesDir, DEFAULT_LOCALE, 'widget.html'), join(outDir, 'widget.html'));
  await copyFile(join(pagesDir, `${DEFAULT_LOCALE}.html`), join(outDir, 'index.html'));

  const notFound = join(pagesDir, DEFAULT_LOCALE, '404.html');
  if (existsSync(notFound)) await copyFile(notFound, join(outDir, '404.html'));

  // 4. public/ 原样带过去
  await cp(join(root, 'public'), outDir, { recursive: true });

  // 5. _next/data（首页切语言时的客户端跳转要用）
  const dataDir = join(root, '.next', 'data');
  if (existsSync(dataDir)) await cp(dataDir, join(outDir, '_next', 'data'), { recursive: true });

  console.log(`[export] 完成：${locales.length} 个 locale → ${outDir}`);
}

main().catch((error) => {
  console.error(`[export] 失败：${error.message}`);
  process.exit(1);
});
