import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 loopback explicitly. Vite's default binds only `::1` here, and
    // a browser that resolves `localhost` to 127.0.0.1 first gets connection
    // refused — the page looks down while the server is serving fine.
    host: '127.0.0.1',
    // Proxy the support server so the page can mint a subscriber token without
    // pasting one. Going through the dev server rather than calling port 3000
    // directly keeps it same-origin, so the token endpoint needs no CORS
    // headers — it is a scaffold, and a permissive CORS policy on something
    // that mints credentials is a bad habit to bake in.
    proxy: {
      '/token': {
        target: process.env.SW_TOKEN_SERVER ?? 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  }
});
