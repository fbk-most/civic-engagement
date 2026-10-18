import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The rural backend (`uvicorn rural_digital_twin.main:app --port 8001`), for
// both the dev server and the production preview. Ports apart from the
// urban app's, so that both can run at once.
const proxy = {
  '/api': 'http://localhost:8001',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The core's static files (textures, tree foliage): not split between the
  // core and the packs yet, see the README.
  publicDir: fileURLToPath(new URL('../../../frontend/public', import.meta.url)),
  server: { port: 5174, proxy },
  preview: { port: 4174, proxy },
  // See the urban app's vite.config.ts.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
})
