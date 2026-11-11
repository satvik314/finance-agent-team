import { defineConfig } from 'vite';
import { financeApiPlugin } from './server/yahoo.js';

export default defineConfig({
  plugins: [financeApiPlugin()],
});
