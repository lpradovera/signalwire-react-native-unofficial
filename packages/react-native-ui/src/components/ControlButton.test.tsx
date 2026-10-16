import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { ControlButton } from './ControlButton';

describe('ControlButton', () => {
  it('is at least the 44-pt minimum touch target', async () => {
    await render(<ControlButton testID="b" label="End" onPress={() => undefined} />);
    const style = StyleSheet.flatten(screen.getByTestId('b').props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
  });

  it('takes an accessible name apart from the visible text', async () => {
    await render(
      <ControlButton testID="b" label="Unmute" accessibilityLabel="Mute" active onPress={() => undefined} />
    );
    expect(screen.getByText('Unmute')).toBeTruthy();
    expect(screen.getByTestId('b').props.accessibilityLabel).toBe('Mute');
  });

  it('uses the visible text as the accessible name by default', async () => {
    await render(<ControlButton testID="b" label="End" onPress={() => undefined} />);
    expect(screen.getByTestId('b').props.accessibilityLabel).toBe('End');
  });
});
