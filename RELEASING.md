# Releasing

The four packages, `@signalwire/react`, `@signalwire/react-ui`,
`@signalwire/react-native` and `@signalwire/react-native-ui`, are released
together at one version, and each depends on the others at `^<that version>`.
They publish under npm's `alpha` dist-tag (`publishConfig.tag` in each
package.json), so a publish can't move `latest`, which still points at
SignalWire's 1.x SDK (signalwire-node). Publishing needs an owner of the
`@signalwire` npm organization.

## An alpha release

1. Bump the version in all four `packages/*/package.json` (for example
   `2.0.0-alpha.0` to `2.0.0-alpha.1`), every inter-package dependency and
   peer to `^<new version>`, the `@signalwire/*` ranges in `example/` and
   `examples/web/`, and the same fields in `package-lock.json`. Move the
   CHANGELOG's Unreleased section under the new version.
2. Build and check:

   ```bash
   npm ci
   npm run verify
   npm run verify:package
   ```

   `verify:package` packs each package and fails unless every tarball has
   the same version, inter-package ranges of `^<version>`, and
   `publishConfig.tag` `"alpha"`.
3. Publish, dependencies first:

   ```bash
   npm publish -w @signalwire/react --tag alpha
   npm publish -w @signalwire/react-ui --tag alpha
   npm publish -w @signalwire/react-native --tag alpha
   npm publish -w @signalwire/react-native-ui --tag alpha
   ```

   `--tag alpha` repeats `publishConfig.tag` on purpose. Check with
   `npm view @signalwire/react-native dist-tags`: `alpha` is the new version,
   `latest` is unchanged.
4. Tag the commit (`git tag v<version>`) and push the tag.

## Later: 2.0.0

When the APIs are settled:

1. Set the version to `2.0.0` (ranges `^2.0.0`), and change
   `publishConfig.tag` to `"latest"` in all four packages, together with
   `TAG` in `scripts/verify-packages.mjs`.
2. Run the checks above, then publish in the same order.
3. If any package was published without moving `latest`, move it:
   `npm dist-tag add @signalwire/react-native@2.0.0 latest`.
4. Point users of the old SDK at the new one:

   ```bash
   npm deprecate @signalwire/react-native@"<2" "Replaced by 2.x"
   ```
