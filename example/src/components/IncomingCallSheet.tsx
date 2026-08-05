import { IncomingCallSheet as UiIncomingCallSheet } from '@signalwire/react-native-ui';
import React from 'react';

import type { Call } from '@signalwire/js';

/**
 * The kit's sheet, re-exported so the app can swap in its own later without
 * touching call sites.
 */
export function IncomingCallSheet({
  onAnswered
}: {
  onAnswered: (call: Call) => void;
}): React.JSX.Element | null {
  return <UiIncomingCallSheet onAnswered={onAnswered} />;
}
