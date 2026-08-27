const releaseBuild = process.env.DSH_DESKTOP_RELEASE === '1'
const electronCache = process.env.ELECTRON_BUILDER_CACHE?.trim()

module.exports = {
  appId: 'io.github.asherhancong.dsh',
  productName: 'DSH',
  executableName: 'DSH',
  artifactName: '${productName}-${version}-${arch}.${ext}',
  extraMetadata: {
    main: 'lib/index.js',
  },
  ...(electronCache === undefined || electronCache === ''
    ? {}
    : { electronDownload: { cache: electronCache } }),
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: [
    'lib/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: 'resources/backend-bootstrap.cjs',
      to: 'backend-bootstrap.cjs',
    },
    {
      from: 'resources/desktop.cordis.patch.yml',
      to: 'desktop.cordis.patch.yml',
    },
    {
      from: 'runtime',
      to: 'dsh-runtime',
      filter: ['**/*'],
    },
    // electron-builder deliberately skips a node_modules directory at a
    // matcher root. Copy the deployed dependency tree from inside that root
    // so the portable pnpm closure remains available to the packaged CLI.
    {
      from: 'runtime/node_modules',
      to: 'dsh-runtime/node_modules',
      filter: ['**/*'],
    },
  ],
  asar: true,
  forceCodeSigning: releaseBuild,
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'resources/icon.icns',
    identity: releaseBuild ? undefined : null,
    minimumSystemVersion: '13.0',
    hardenedRuntime: releaseBuild,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    notarize: releaseBuild,
    target: [
      {
        target: 'dmg',
        arch: ['arm64', 'x64'],
      },
      {
        target: 'zip',
        arch: ['arm64', 'x64'],
      },
    ],
  },
  dmg: {
    sign: false,
  },
  publish: {
    provider: 'github',
    owner: 'asherhancong',
    repo: 'deepseek-harness',
    channel: 'latest',
    releaseType: 'draft',
    tagNamePrefix: 'desktop-v',
  },
}
