/**
 * Expo's own helpers for the tagged blocks a config plugin writes into native
 * files (`# @generated begin <tag> ... # @generated end <tag>`): mergeContents
 * inserts a block, and replaces it when its contents change, so a re-run of
 * `expo prebuild` without --clean leaves one current copy.
 *
 * @expo/config-plugins exports them as CodeGenerator from 54.0.0 on; 9.x and
 * 10.x (Expo SDK 52 and 53) have them only at this path.
 */
const configPlugins = require('@expo/config-plugins');

const generateCode = configPlugins.CodeGenerator ?? require('@expo/config-plugins/build/utils/generateCode');

/**
 * Runs `edit` on `contents` with LF line endings, then restores CRLF if the
 * file used it: Expo's helpers split on '\n' and match `end <tag>$`, which a
 * trailing '\r' defeats.
 */
function withLf(contents, edit) {
  const crlf = contents.includes('\r\n');
  const result = edit(crlf ? contents.replace(/\r\n/g, '\n') : contents);
  return crlf ? result.replace(/\n/g, '\r\n') : result;
}

module.exports = { ...generateCode, withLf };
