import { fireEvent, render, screen } from '@testing-library/react-native';
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

  describe('a label that wraps (Hold & Accept in the call-waiting row)', () => {
    it('is one accessibility element: the button, named by its label; the text is not a node of its own', async () => {
      await render(<ControlButton testID="b" label="Hold & Accept" onPress={() => undefined} />);
      const button = screen.getByRole('button', { name: 'Hold & Accept' });
      expect(button.props.testID).toBe('b');
      const text = screen.getByText('Hold & Accept');
      expect(text.props.importantForAccessibility).toBe('no');
      expect(text.props.accessible).toBe(false);
      expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('presses the button from anywhere on its label', async () => {
      const onPress = jest.fn();
      await render(<ControlButton testID="b" label="Hold & Accept" onPress={onPress} />);
      fireEvent.press(screen.getByText('Hold & Accept'));
      expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('centres its lines in the pill', async () => {
      await render(<ControlButton testID="b" label="Hold & Accept" onPress={() => undefined} />);
      expect(StyleSheet.flatten(screen.getByText('Hold & Accept').props.style).textAlign).toBe('center');
    });
  });
});
