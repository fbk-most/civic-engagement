import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The core alone isn't an app (each domain pack's app is, in the pack's
// repository): its dev server (`npm run dev`, at the repository root) only
// serves the dev tools, the tree lab (/tree-lab.html).
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
