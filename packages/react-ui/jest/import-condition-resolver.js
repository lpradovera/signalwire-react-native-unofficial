/**
 * Resolves '@signalwire/web-components' and its subpaths with the `import`
 * export condition added, the way a bundler resolves an ES module import:
 * those subpaths define only `types` and `import`, so Jest's default
 * (require) conditions can never match them. Everything else resolves as
 * Jest normally does. Used by the `elements` project only.
 */
module.exports = (request, options) =>
  request === '@signalwire/web-components' || request.startsWith('@signalwire/web-components/')
    ? options.defaultResolver(request, {
        ...options,
        conditions: [...(options.conditions ?? []), 'import']
      })
    : options.defaultResolver(request, options);
