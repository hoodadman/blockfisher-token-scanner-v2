import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { scanPlugin } from './scanPlugin';
import { summarisePlugin } from './summarisePlugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const twitterBearer = env.TWITTER_BEARER_TOKEN ? decodeURIComponent(env.TWITTER_BEARER_TOKEN) : '';

  // Keys stay on the dev server so they never reach the browser.
  const proxy: Record<string, ProxyOptions> = {
    '/api/insightx': {
      target: 'https://api.insightx.network',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/insightx/, ''),
      headers: env.INSIGHTX_API_KEY ? { 'X-API-Key': env.INSIGHTX_API_KEY } : {},
    },
    '/api/twitter': {
      target: 'https://api.twitter.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/twitter/, ''),
      headers: twitterBearer ? { Authorization: `Bearer ${twitterBearer}` } : {},
    },
    '/api/coingecko': {
      target: 'https://api.coingecko.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/coingecko/, ''),
    },
  };

  return {
    plugins: [react(), summarisePlugin(env), scanPlugin()],
    server: { proxy },
    preview: { proxy },
  };
});
