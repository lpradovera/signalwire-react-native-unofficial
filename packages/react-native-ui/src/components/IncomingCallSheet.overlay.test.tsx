import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import React, { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BehaviorSubject } from 'rxjs';

import { SignalWireContext } from '@signalwire/react';

import { SignalWireThemeProvider } from '../theme/ThemeProvider';
import { defaultTheme } from '../theme/theme';
import { CallOverlayHost } from './CallOverlayHost';
import { IncomingCallSheet } from './IncomingCallSheet';

jest.mock('@signalwire/react-native/ringing', () => ({
  displayableName: jest.requireActual('@signalwire/react-native/ringing').displayableName,
  useRingingPushes: () => ({ ringing: [], answer: jest.fn(), reject: jest.fn() })
}));

const incomingCalls$ = new BehaviorSubject<unknown[]>([]);
const context = {
  client: { session: { incomingCalls$, incomingCalls: [] } },
  error: null,
  observer: undefined
} as never;

function ringing(id: string): unknown {
  return {
    id,
    fromName: 'Ada Lovelace',
    status: 'ringing',
    status$: new BehaviorSubject('ringing'),
    answer: jest.fn(async () => undefined),
    reject: jest.fn(async () => undefined)
  };
}

beforeEach(() => {
  incomingCalls$.next([]);
  (useSafeAreaInsets as jest.Mock).mockClear();
});

describe('IncomingCallSheet placement', () => {
  it('falls back to a Modal when no CallOverlayHost is mounted', async () => {
    incomingCalls$.next([ringing('a')]);
    await render(
      <SignalWireContext.Provider value={context}>
        <IncomingCallSheet testID="sheet" />
      </SignalWireContext.Provider>
    );
    expect(screen.getByTestId('sheet').type).toBe('Modal');
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  });

  it('renders into a mounted CallOverlayHost instead of a Modal', async () => {
    incomingCalls$.next([ringing('a')]);
    await render(
      <SignalWireContext.Provider value={context}>
        <View testID="app">
          <IncomingCallSheet testID="sheet" />
        </View>
        <CallOverlayHost />
      </SignalWireContext.Provider>
    );
    expect(screen.getByTestId('sheet').type).not.toBe('Modal');
    // Inside the host, not where the sheet element sits.
    expect(within(screen.getByTestId('sw-call-overlay')).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(screen.getByTestId('app')).queryByTestId('sw-answer')).toBeNull();
  });

  it('keeps working inside the host: answering hides it', async () => {
    const call = ringing('a') as { answer: jest.Mock };
    incomingCalls$.next([call]);
    await render(
      <SignalWireContext.Provider value={context}>
        <IncomingCallSheet />
        <CallOverlayHost />
      </SignalWireContext.Provider>
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('sw-answer'));
    });
    expect(call.answer).toHaveBeenCalled();
    expect(screen.queryByTestId('sw-answer')).toBeNull();
  });

  it('draws over an app Modal through the host mounted inside it, and moves back when it closes', async () => {
    incomingCalls$.next([ringing('a')]);
    function AppWithModal(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Pressable testID="open" onPress={() => setOpen(true)}>
            <Text>Open</Text>
          </Pressable>
          <Modal visible={open} testID="app-modal">
            <Pressable testID="close" onPress={() => setOpen(false)}>
              <Text>Close</Text>
            </Pressable>
            {open ? <CallOverlayHost testID="modal-host" /> : null}
          </Modal>
          <IncomingCallSheet />
          <CallOverlayHost testID="root-host" />
        </>
      );
    }
    await render(
      <SignalWireContext.Provider value={context}>
        <AppWithModal />
      </SignalWireContext.Provider>
    );

    const inHost = (id: string): number =>
      within(screen.getByTestId(id)).queryAllByTestId('sw-answer').length;
    expect(inHost('root-host')).toBe(1);

    await act(async () => {
      fireEvent.press(screen.getByTestId('open'));
    });
    expect(inHost('modal-host')).toBe(1);
    expect(inHost('root-host')).toBe(0);

    await act(async () => {
      fireEvent.press(screen.getByTestId('close'));
    });
    expect(inHost('root-host')).toBe(1);
  });

  it('carries the app theme into the host', async () => {
    incomingCalls$.next([ringing('a')]);
    await render(
      <SignalWireContext.Provider value={context}>
        <SignalWireThemeProvider theme={{ colors: { background: '#123456' } }}>
          <IncomingCallSheet />
        </SignalWireThemeProvider>
        <CallOverlayHost />
      </SignalWireContext.Provider>
    );
    const sheet = screen.getByTestId('sw-incoming-sheet');
    expect(sheet).toHaveStyle({ backgroundColor: '#123456' });
  });

  it.each([
    ['in a Modal', false],
    ['in the host', true]
  ])('pads the sheet by the bottom inset %s', async (_label, withHost) => {
    (useSafeAreaInsets as jest.Mock).mockReturnValue({ top: 0, left: 0, right: 0, bottom: 34 });
    incomingCalls$.next([ringing('a')]);
    await render(
      <SignalWireContext.Provider value={context}>
        <IncomingCallSheet />
        {withHost ? <CallOverlayHost /> : null}
      </SignalWireContext.Provider>
    );
    expect(screen.getByTestId('sw-incoming-sheet')).toHaveStyle({
      paddingBottom: defaultTheme.spacing.xl + 34
    });
    (useSafeAreaInsets as jest.Mock).mockReset();
  });
});
