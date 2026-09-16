import coreWebVitals from 'eslint-config-next/core-web-vitals'

const eslintConfig = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...coreWebVitals,
]

export default eslintConfig
