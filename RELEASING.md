# Releasing

The four packages, `@signalwire/react`, `@signalwire/react-ui`,
`@signalwire/react-native` and `@signalwire/react-native-ui`, are released
together at one version. Where one needs another it names it at
`^<that version>`: `@signalwire/react-native` depends on `@signalwire/react`,
and `@signalwire/react-native-ui` has both as peers; `@signalwire/react` and
`@signalwire/react-ui` name none of the others.
They publish under npm's `alpha` dist-tag (`publishConfig.tag` in each
package.json). Publishing needs an owner of the `@signalwire` npm
organization.

`@signalwire/react-native` is already on npm, as SignalWire's 1.x SDK
(signalwire-node), with these dist-tags:

| dist-tag | version (October 2026) |
|---|---|
| `latest` | 1.0.4 |
| `next` | 1.0.4 |
| `alpha` | 1.1.0-alpha.4 |

The first 2.0 alpha publish moves `alpha` from the 1.x line's 1.1.0-alpha.4
to 2.0.0-alpha.0. That is deliberate: the 1.x line is no longer in use, and
`npm install @signalwire/react-native@alpha` should get this SDK. `latest`
and `next` stay on 1.x until 2.0.0. The other three package names are not on
npm yet. `verify:package` fails if any package's `publishConfig.tag` is
`latest` or `next`, or is a semver range (npm refuses a tag such as `v2`, and
`npm install …@v2` would read it as the range `>=2.0.0 <3.0.0-0`, which no
alpha satisfies). Check the tags before a release:
`npm view @signalwire/react-native dist-tags`.

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
   `latest` and `next` are unchanged.
4. At the first 2.0 alpha publish only: point 1.x users at the new SDK
   (1.1.0-alpha.4 no longer has a tag after step 3):

   ```bash
   npm deprecate @signalwire/react-native@"<2" "Replaced by @signalwire/react-native 2.x (npm i @signalwire/react-native@alpha)"
   ```
5. Tag the commit (`git tag v<version>`) and push the tag.

## Later: 2.0.0

When the APIs are settled:

1. Set the version to `2.0.0` (ranges `^2.0.0`), and change
   `publishConfig.tag` to `"latest"` in all four packages, together with
   `TAG` in `scripts/verify-packages.mjs` (and take `latest` out of its
   `RESERVED_TAGS`). This moves `latest` on `@signalwire/react-native` from
   1.0.4 to 2.0.0.
2. If the repository has moved to the `signalwire` GitHub organization by
   then, point `homepage`, `repository.url` and `bugs.url` in
   `packages/react-native/package.json` at it, and the links to the
   repository in the READMEs. The podspec
   (`packages/react-native/SignalWireReactNative.podspec`) takes `homepage`
   and its `:git` source from those fields, so check that it resolves to the
   new repository and that the `v<version>` tag is pushed there. Until the
   move they name the repository the code is in today,
   `lpradovera/signalwire-react-native-unofficial`.
3. Run the checks above, then publish in the same order, with `--tag latest`
   in place of the alpha steps' `--tag alpha`. A `--tag` on the command line
   overrides `publishConfig.tag`, so the alpha commands as written would put
   2.0.0 on `alpha`:

   ```bash
   npm publish -w @signalwire/react --tag latest
   npm publish -w @signalwire/react-ui --tag latest
   npm publish -w @signalwire/react-native --tag latest
   npm publish -w @signalwire/react-native-ui --tag latest
   ```
4. Check `npm view <package> dist-tags` for each of the four: `latest` must be
   2.0.0. Move it on any package where it isn't, for example
   `npm dist-tag add @signalwire/react-ui@2.0.0 latest`.
5. If it wasn't done at the first alpha, point users of the old SDK at the new one:

   ```bash
   npm deprecate @signalwire/react-native@"<2" "Replaced by 2.x"
   ```
