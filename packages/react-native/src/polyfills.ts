/**
 * Side-effect polyfills required before `@signalwire/js` loads.
 *
 * Import this as the very first line of your app entry file:
 *
 * ```ts
 * import '@signalwire/react-native/polyfills';
 * ```
 *
 * Order matters. `react-native-get-random-values` must install
 * `crypto.getRandomValues` before the SDK's bundled `uuid` reads it, and
 * `react-native-url-polyfill` must replace `URL` before the SDK parses a
 * dial destination with a custom scheme.
 */
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';

export {};
