/**
 * Minimal Node declarations for the config plugin.
 *
 * The plugin is the one part of this package that runs in Node — Expo's CLI
 * loads it at prebuild time — while everything else runs in Hermes. Pulling in
 * `@types/node` would make `process`, `Buffer` and friends appear valid inside
 * React Native code, where they do not exist, so only what the plugin actually
 * uses is declared here.
 */

declare module 'node:fs' {
  export const promises: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
    writeFile(path: string, data: string, encoding: string): Promise<void>;
  };
}

declare module 'node:path' {
  const path: {
    join(...segments: string[]): string;
    dirname(target: string): string;
  };
  export default path;
}
