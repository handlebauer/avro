// import { nodeResolve } from '@rollup/plugin-node-resolve'
// import commonjs from '@rollup/plugin-commonjs'
// import { terser } from 'rollup-plugin-terser'

import pkg from './package.json'

const input = './src/index.js'

// eslint-disable-next-line import/no-default-export
export default [
  {
    input,
    output: { file: './lib/index.js', format: 'iife', name: 'avro' },
  },
  {
    input,
    output: [
      { file: pkg.main, format: 'cjs' },
      { file: pkg.module, format: 'esm' },
    ],
  },
]
