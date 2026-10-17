/**
 * The RN provider with the real core provider and the real platform layer
 * (createReactNativePlatform and its NetInfo/AppState shims); only the SDK
 * client is a stand-in. The client a new credentialProvider builds, and the
 * one React.StrictMode keeps, must run with the shims installed.
 */
import NetInfo from '@react-native-community/netinfo';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

jest.mock('@signalwire/js', () => {
  const { EMPTY } = jest.requireActual('rxjs');
  return {
    SignalWire: class {
      // A started client: the provider destroys it at once (see destroyClient).
      session = {};
      // The SDK client's shape that useCalls() reads (the provider runs it
      // for the Android call service when callKit is off).
      isConnected$ = EMPTY;
      errors$ = EMPTY;
      destroy(): void {}
    },
    getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
  };
});

import { SignalWireProvider } from './SignalWireProvider';

const netInfoAdd = NetInfo.addEventListener as unknown as jest.Mock;
let unsubscribes: jest.Mock[] = [];

/** NetInfo subscriptions still live. */
const live = (): number => unsubscribes.filter((fn) => fn.mock.calls.length === 0).length;

beforeEach(() => {
  unsubscribes = [];
  netInfoAdd.mockReset();
  netInfoAdd.mockImplementation(() => {
    const unsubscribe = jest.fn();
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  });
});

const tree = (credentials: unknown): React.JSX.Element => (
  <SignalWireProvider credentialProvider={credentials as never}>
    <Text>child</Text>
  </SignalWireProvider>
);
const credentials = () => ({ authenticate: jest.fn(async () => ({ token: 't' })) });

it('a new credentialProvider builds its client with the network shim installed', async () => {
  const view = await render(tree(credentials()));
  expect(live()).toBe(1);

  await view.rerender(tree(credentials()));

  expect(live()).toBe(1);
  await view.unmount();
  expect(live()).toBe(0);
});

it('React.StrictMode: the client that stays mounted has the network shim installed', async () => {
  const view = await render(<React.StrictMode>{tree(credentials())}</React.StrictMode>);
  expect(live()).toBe(1);
  await view.unmount();
  expect(live()).toBe(0);
});
