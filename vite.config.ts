import { defineConfig, loadEnv, type Connect, type Plugin, type ViteDevServer, type PreviewServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves the api/ functions (Web-standard `GET`/`POST` exports, same as on Vercel) from the Vite
 * dev and preview servers, so `npm run dev` runs app + API together with no separate Express server.
 */
function apiRoutes(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer, load: (path: string) => Promise<Record<string, unknown>>) => {
    const handler: Connect.NextHandleFunction = async (req: IncomingMessage, res: ServerResponse, next) => {
      const name = /^\/api\/([a-z]+)(?:\?|$)/.exec(req.url || '')?.[1];
      if (!name || name.startsWith('_')) return next();
      let mod: Record<string, unknown>;
      try {
        mod = await load(`/api/${name}.ts`);
      } catch {
        return next();
      }
      const fn = mod[req.method || 'GET'] as ((r: Request) => Promise<Response> | Response) | undefined;
      if (!fn) {
        res.statusCode = 405;
        return res.end();
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const ctl = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ctl.abort();
      });
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        signal: ctl.signal,
      });
      const out = await fn(request);
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await out.arrayBuffer()));
    };
    server.middlewares.use(handler);
  };
  return {
    name: 'raasta-api',
    configureServer(server) {
      // Step-counter calibration (see logMotion in src/actions.ts): dev server only, never deployed.
      server.middlewares.use('/__motionlog', async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync('.data', { recursive: true });
        writeFileSync(`.data/motion-${Date.now()}.json`, Buffer.concat(chunks).subarray(0, 5_000_000));
        res.end('ok');
      });
      mount(server, (p) => server.ssrLoadModule(p));
    },
    async configurePreviewServer(server) {
      // ponytail: preview reuses a throwaway Vite SSR loader; fine for local checks, Vercel runs api/ itself.
      const { createServer } = await import('vite');
      const loader = await createServer({ server: { middlewareMode: true }, appType: 'custom', configFile: false });
      mount(server, (p) => loader.ssrLoadModule(p));
    },
  };
}

export default defineConfig(({ mode }) => {
  // Make .env (GEMMA_MODEL, OLLAMA_URL…) visible to the api handlers; never exposed to the browser.
  Object.assign(process.env, { ...loadEnv(mode, process.cwd(), ''), ...process.env });
  return {
    plugins: [apiRoutes()],
    // Two pages: the app and the staff admin panel.
    // Older phones: lower the output to what Chrome / Android WebView 61+, Safari 11+ parse (polyfills: src/compat.ts).
    build: {
      target: ['chrome61', 'safari11', 'firefox60', 'edge16'],
      rollupOptions: { input: { landing: 'index.html', app: 'app/index.html', admin: 'admin.html' } },
    },
    // Allow sharing through a Cloudflare quick tunnel (cloudflared tunnel --url ...).
    server: { allowedHosts: ['.trycloudflare.com'] },
    preview: { allowedHosts: ['.trycloudflare.com'] },
    test: { include: ['tests/**/*.test.ts'] },
  };
});
