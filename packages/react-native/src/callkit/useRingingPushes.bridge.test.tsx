/**
 * The hook against the real bridge singleton, not a hand-built entry list.
 *
 * The hook reads the bridge off `globalThis` (it must not import callkeep), so
 * the key it reads and the key getCallKit() writes are one constant. Spelled
 * twice, a rename on one side left the hook reading an empty slot: no ringing
 * pushes and no Android sheet, with every other test still passing.
 */
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { CALLKIT_BRIDGE_KEY } from './bridgeKey';
import { getCallKit, resetCallKitForTesting } from './CallKeepBridge';
import { useRingingPushes } from './useRingingPushes';

let ringing: ReturnType<typeof useRingingPushes>['ringing'] = [];

function Probe(): React.JSX.Element {
  ringing = useRingingPushes().ringing;
  return <Text testID="count">{ringing.length}</Text>;
}

describe('useRingingPushes with the real bridge', () => {
  afterEach(() => resetCallKitForTesting());

  it('keeps the bridge under the key the hook reads', () => {
    const bridge = getCallKit();
    expect((globalThis as Record<string, unknown>)[CALLKIT_BRIDGE_KEY]).toBe(bridge);
  });

  it('shows a push reported to getCallKit()', async () => {
    const bridge = getCallKit();
    const { getByTestId } = await render(<Probe />);

    await act(async () => {
      bridge.reportIncomingPush({ callId: 'c1', from: '+15551234567', fromName: 'Ada' });
    });

    expect(getByTestId('count').props.children).toBe(1);
    expect(ringing[0]?.fromName).toBe('Ada');
  });
});
