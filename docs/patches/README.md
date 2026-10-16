# Patches

`react-native-incall-manager+4.3.0.patch` is the incall-manager change that adds
iOS audio routes (`chooseAudioRoute`, `getAudioDeviceStatus`,
`onAudioDeviceChanged`), as a [patch-package](https://github.com/ds300/patch-package)
patch over incall-manager 4.3.0. The README's "Audio routes on iOS" section says
how to apply it.

It is generated, not edited. Source: branch `ios-audio-routes` of
https://github.com/mjerris/react-native-incall-manager (proposed upstream), at:

    source-commit: 57eda21159ca2de8611c48cb9af3ce6a3ae1df6a

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
