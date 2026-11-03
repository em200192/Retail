// Expo's default config already understands npm workspaces (watches the repo
// root, resolves hoisted node_modules), so @retail/shared is picked up from
// packages/shared. Its files import each other with explicit `.ts` extensions,
// which Metro resolves as-is.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
