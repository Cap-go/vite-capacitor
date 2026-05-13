export default {
  input: 'dist/esm/index.js',
  output: {
    file: 'dist/index.cjs',
    format: 'cjs',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  external: [
    'vite',
    'fs',
    'fs/promises',
    'node:fs',
    'node:fs/promises',
    'path',
    'node:path',
    'os',
    'node:os',
    'url',
    'node:url',
  ],
};
