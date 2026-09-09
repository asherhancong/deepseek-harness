// Build signed updater-ready applications; the release workflow owns notarization.
const config = require('./electron-builder.config.cjs')

module.exports = {
  ...config,
  mac: { ...config.mac, notarize: false },
}
