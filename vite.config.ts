import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = `http://127.0.0.1:${process.env.API_PORT || 3001}`;

// Development uses the same public document renderer as production. Vite then
// adds its normal development entry points; public content never depends on a
// previous build in dist or a client-side redirect back to the same route.
function publicLibraryDocuments(): Plugin {
  return {
    name: 'public-library-documents',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://vite.local');
        if (
          !/^\/library(?:\/|$)/i.test(url.pathname) ||
          !['GET', 'HEAD'].includes(req.method || '')
        )
          return next();
        try {
          const response = await fetch(`${apiTarget}${url.pathname}${url.search}`, {
            headers: { Accept: 'text/html' },
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
          });
          const source = await response.text();
          const html = response.headers.get('content-type')?.includes('text/html')
            ? await server.transformIndexHtml(`${url.pathname}${url.search}`, source)
            : source;
          res.statusCode = response.status;
          // Production CSP is applied by Express. The Vite development document
          // uses Vite's standard script policy for its refresh preamble and HMR.
          for (const name of [
            'content-type',
            'cache-control',
            'x-robots-tag',
            'location',
            'referrer-policy',
            'x-content-type-options',
            'x-frame-options',
            'permissions-policy',
          ]) {
            const value = response.headers.get(name);
            if (value) res.setHeader(name, value);
          }
          res.end(req.method === 'HEAD' ? undefined : html);
        } catch {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Robots-Tag', 'noindex, nofollow');
          res.end(
            req.method === 'HEAD'
              ? undefined
              : 'The clinic library is temporarily unavailable. Please try again.',
          );
        }
      });
    },
  };
}
export default defineConfig({
  plugins: [react(), publicLibraryDocuments()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '^/(?:robots\\.txt|sitemap\\.xml)(?:\\?|$)': { target: apiTarget, changeOrigin: false },
    },
  },
});
