import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

// eslint-config-next ships flat configs directly; going through FlatCompat
// pulls in the legacy loader and fails on a circular `react` reference.
const config = [
  ...coreWebVitals,
  ...typescript,
  { ignores: ['.next/**', 'node_modules/**'] },
];

export default config;
