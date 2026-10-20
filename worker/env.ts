/** Cloudflare Worker 绑定（wrangler.toml 的 [vars] / secrets） */
export interface Env {
  /** 静态资源绑定，指向 out/ */
  ASSETS: { fetch: (request: Request) => Promise<Response> };

  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_PRIVATE_KEY: string;
  ENCRYPTION_PASSWORD: string;

  /** 允许 iframe 嵌入的站点，逗号分隔；留空则不写 frame-ancestors */
  ALLOWED_ORIGINS?: string;
}
