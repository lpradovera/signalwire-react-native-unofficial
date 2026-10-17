#!/usr/bin/env bash
# apply-fcm-harness.sh <example/android>: adds the simulated FCM receiver to a
# freshly prebuilt example (suite builds only, never a shipped app). It stands
# in for Google Play services delivering a high-priority data message and
# hands it to React Native Firebase's own receiver.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; A="$1"
PKG=$(sed -n "s/.*namespace[ =]*[\"']\([^\"']*\)[\"'].*/\1/p" "$A/app/build.gradle" | head -1)
[ -n "$PKG" ] || { echo "no namespace in $A/app/build.gradle"; exit 1; }
dest="$A/app/src/main/java/$(echo "$PKG" | tr . /)/harness"; mkdir -p "$dest"
sed "s/__PKG__/$PKG/" "$HERE/android/fcm-harness/SimulatedFcmReceiver.java.in" > "$dest/SimulatedFcmReceiver.java"
M="$A/app/src/main/AndroidManifest.xml"
grep -q SimulatedFcmReceiver "$M" || perl -0pi -e "s#</application>#  <receiver android:name=\"$PKG.harness.SimulatedFcmReceiver\" android:exported=\"true\"/>\n  </application>#" "$M"
