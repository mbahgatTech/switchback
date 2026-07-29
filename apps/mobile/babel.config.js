/**
 * Babel for Metro.
 *
 * `babel-preset-expo` is the whole configuration — it carries the React Native transforms,
 * TypeScript stripping (which is what lets the app import the shared packages as sources),
 * and the JSX runtime. `expo-router` needs no plugin of its own since SDK 50; its route
 * discovery happens in the Metro serializer, not here.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
  };
};
