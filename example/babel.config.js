module.exports = (api) => {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // @signalwire/js ships ES2022 static class blocks in its ESM build
      // (`static { this.defaultMaxRetries = 3 }`). babel-preset-expo does not
      // transform those, so Metro fails to parse the SDK without this plugin.
      '@babel/plugin-transform-class-static-block'
    ]
  };
};
