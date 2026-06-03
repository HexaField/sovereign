import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'dist',
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  unbundle: true
})
