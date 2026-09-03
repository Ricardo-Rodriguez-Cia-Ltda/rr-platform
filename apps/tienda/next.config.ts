import type { NextConfig } from 'next';

// El codigo fuente importa modulos locales con extension `.js` (convencion
// TS-ESM del monorepo) apuntando a archivos `.ts`. Webpack no resuelve eso
// por si solo (a diferencia del resolver de Vitest/Vite), asi que se le
// agrega el alias de extension explicito.
const config: NextConfig = {
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};
export default config;
