/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript source rather than a build artifact,
  // so Next has to compile it alongside the app.
  transpilePackages: ['@precu/shared'],
  experimental: {
    optimizePackageImports: ['@react-three/drei', 'recharts'],
  },
  webpack(config) {
    // `@precu/shared` is ESM TypeScript and imports siblings with the required
    // `.js` specifier. Webpack resolves that literally and cannot find the
    // `.ts` source, so map the extension back.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
