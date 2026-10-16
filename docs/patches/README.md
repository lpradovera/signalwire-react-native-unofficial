# Patches

`react-native-incall-manager+4.3.0.patch` is the incall-manager change that adds
iOS audio routes (`chooseAudioRoute`, `getAudioDeviceStatus`,
`onAudioDeviceChanged`), as a [patch-package](https://github.com/ds300/patch-package)
patch over incall-manager 4.3.0. The README's "Audio routes on iOS" section says
how to apply it.

It is generated, not edited. Source: branch `ios-audio-routes` of
https://github.com/mjerris/react-native-incall-manager (proposed upstream), at:

    source-commit: 79e3c4209bf5affd4c054d2116151c98e7d8264e

To regenerate it after a change on that branch, or to check that it still
matches, point the script at a clone of that repository:

    node scripts/check-incall-patch.mjs /path/to/react-native-incall-manager          # check
    node scripts/check-incall-patch.mjs /path/to/react-native-incall-manager --write  # regenerate

It diffs the commit above (or, with `--write`, the branch head, recording that
commit here) against its merge-base with the `4.3.0` tag, so an upstream
`master` that has moved past the release changes nothing. It is not part of `npm run
verify`, which has no incall-manager clone to compare against.
