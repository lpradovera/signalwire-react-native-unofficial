import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

jest.mock('../platform/createReactNativePlatform');
jest.mock('../callkit/observer');

// The core provider is exercised by its own package. Here we only care that
// the RN wrapper hands it the right platform and observer.
jest.mock('@signalwire/react', () => ({
  SignalWireProvider: jest.fn(() => null)
}));

import { SignalWireProvider as CoreProvider } from '@signalwire/react';

import { createCallKitObserver } from '../callkit/observer';
import { createReactNativePlatform } from '../platform/createReactNativePlatform';
import { SignalWireProvider } from './SignalWireProvider';

const core = CoreProvider as unknown as jest.Mock;
const createPlatform = createReactNativePlatform as jest.MockedFunction<
  typeof createReactNativePlatform
>;
const createObserver = createCallKitObserver as jest.MockedFunction<typeof createCallKitObserver>;

const credentialProvider = { authenticate: jest.fn(async () => ({ token: 't' })) };
const platform = { options: { skipDeviceMonitoring: true }, dispose: jest.fn() };
const observer = { bindClient: jest.fn(), onOutgoingCall: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  createPlatform.mockReturnValue(platform);
  createObserver.mockReturnValue(observer);
});

async function renderProvider(props: Record<string, unknown> = {}): Promise<void> {
  await render(
    <SignalWireProvider credentialProvider={credentialProvider as never} {...props}>
      <Text>child</Text>
    </SignalWireProvider>
  );
}

describe('React Native SignalWireProvider', () => {
  it('supplies the platform so callers never have to', async () => {
    await renderProvider();
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(core.mock.calls[0]?.[0]).toMatchObject({ platform });
  });

  it('forwards platform options through', async () => {
    await renderProvider({ platform: { netInfo: false } });
    expect(createPlatform).toHaveBeenCalledWith({ netInfo: false });
  });

  it('omits the observer when callKit is off', async () => {
    await renderProvider();
    expect(createObserver).not.toHaveBeenCalled();
    expect(core.mock.calls[0]?.[0]).toMatchObject({ observer: undefined });
  });

  it('supplies a CallKit observer when callKit is on', async () => {
    await renderProvider({ callKit: true });
    expect(createObserver).toHaveBeenCalledTimes(1);
    expect(core.mock.calls[0]?.[0]).toMatchObject({ observer });
  });

  it('passes the credential provider and options through untouched', async () => {
    const options = { skipConnection: true };
    await renderProvider({ options });
    expect(core.mock.calls[0]?.[0]).toMatchObject({ credentialProvider, options });
  });

  it('builds the platform once across re-renders', async () => {
    const view = await render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <Text>child</Text>
      </SignalWireProvider>
    );
    await view.rerender(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <Text>child</Text>
      </SignalWireProvider>
    );
    // A fresh platform identity would tear down and rebuild the client.
    expect(createPlatform).toHaveBeenCalledTimes(1);
  });
});
