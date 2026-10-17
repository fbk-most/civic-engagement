import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The backend, for both the dev server and the production preview.
const proxy = {
  '/api': 'http://localhost:8000',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy },
  // `npm run preview` serves the production build: what to use for
  // workshops, demos and performance measurements — the development build
  // is several times slower (React's development mode alone adds seconds
  // to a date change in the 3D view, see the README).
  preview: { proxy },
  // maplibre-gl loads its tiling logic in a worker via a relative URL that
  // breaks under Vite's dependency pre-bundling (the worker chunk goes
  // missing, so sources silently never finish loading) — exclude it so Vite
  // serves it as native ESM instead.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
})
