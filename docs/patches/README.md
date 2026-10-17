# Patches

`react-native-incall-manager+4.3.0.patch` is the incall-manager change that adds
iOS audio routes (`chooseAudioRoute`, `getAudioDeviceStatus`,
`onAudioDeviceChanged`), as a [patch-package](https://github.com/ds300/patch-package)
patch over incall-manager 4.3.0. The README's "Audio routes on iOS" section says
how to apply it.

It is generated, not edited. Source: branch `ios-audio-routes` of
https://github.com/mjerris/react-native-incall-manager (proposed upstream), at:

    source-commit: ad7ca22941c7bf8c00bb73dc8f6f1c10a6d631fe

To regenerate it after a change on that branch, or to check that it still
matches, point the script at a clone of that repository:

    node scripts/check-incall-patch.mjs /path/to/react-native-incall-manager                # check
    node scripts/check-incall-patch.mjs /path/to/react-native-incall-manager --write        # regenerate
    node scripts/check-incall-patch.mjs /path/to/react-native-incall-manager --write <ref>  # from <ref>

It diffs the commit above (or, with `--write`, the head of `ios-audio-routes`,
recording that commit here) against its merge-base with the `4.3.0` tag, so an
upstream `master` that has moved past the release changes nothing. The branch
is the local one if the clone has it, else `origin/ios-audio-routes` (a fresh
clone has only that), else the one remote that has it; pass a ref to choose.
The diff ignores your git config (global and system config are not read, and
every diff setting a repository's config could change is given explicitly),
so the bytes are the same for everyone. It is not part of `npm run verify`,
which has no incall-manager clone to compare against.

## `@signalwire+js+4.0.0-rc.5.patch` (repository root `patches/`)

Two fixes to `WebRTCCall` in @signalwire/js 4.0.0-rc.5 (`dist/index.mjs` and
`dist/index.cjs`), found while building call waiting, applied to this
repository by the root `postinstall` (patch-package). Apps that hold calls
need it too (see the README, "Call waiting"). Reported to the SDK owner.

- `toggleHold()` only sent `verto.modify`: the server stopped its media to the
  held call, but the device kept sending its microphone. The patch sets
  `RTCRtpEncodingParameters.active = false` on the main peer connection's
  senders while held (no RTP, no renegotiation; `replaceTrack(null)` was not
  enough, an audio sender without a track still sends silence), and back on
  unhold.
- The stats monitor reports `no_inbound_audio` for a held call, and the
  recovery manager ran ICE restarts against it. The patch drops recovery
  triggers while held and for 5 s after unhold.

`scripts/sdk-hold-patch.test.mjs` (in `npm test`) checks that the installed
SDK is rc.5 with both fixes, and runs the patched `toggleHold()` against a
stub peer connection. It fails if the patch did not apply. Drop the patch once
the SDK fixes both.
