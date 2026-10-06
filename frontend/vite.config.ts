import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins:[react()],
  server:{
    host:'0.0.0.0',
    port:5173,
    proxy:{
      '/health':'http://localhost:8000',
      '/api':'http://localhost:8000',
      '/ws':'ws://localhost:8000'
    }
  }
});
