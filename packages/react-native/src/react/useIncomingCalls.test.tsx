import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import { BehaviorSubject } from 'rxjs';

import { SignalWireContext } from './SignalWireProvider';
import { useIncomingCalls } from './useIncomingCalls';

const incomingCalls$ = new BehaviorSubject<unknown[]>([]);
const client = { session: { incomingCalls$, incomingCalls: [] } };

let result: ReturnType<typeof useIncomingCalls> | undefined;

function Probe(): React.JSX.Element {
  result = useIncomingCalls();
  return <Text testID="count">{String(result.calls.length)}</Text>;
}

function renderWithClient(value: unknown = client): ReturnType<typeof render> {
  return render(
    <SignalWireContext.Provider
      value={{ client: value as never, error: null, callKitEnabled: false }}
    >
      <Probe />
    </SignalWireContext.Provider>
  );
}

describe('useIncomingCalls', () => {
  beforeEach(() => incomingCalls$.next([]));

  it('starts empty', () => {
    const { getByTestId } = renderWithClient();
    expect(getByTestId('count').props.children).toBe('0');
  });

  it('tracks the session incoming call list', () => {
    const { getByTestId } = renderWithClient();
    act(() => incomingCalls$.next([{ id: 'a' }, { id: 'b' }]));
    expect(getByTestId('count').props.children).toBe('2');
  });

  it('returns an empty list when the client is null', () => {
    const { getByTestId } = renderWithClient(null);
    expect(getByTestId('count').props.children).toBe('0');
  });

  it('answer delegates to the call', async () => {
    renderWithClient();
    const call = { answer: jest.fn(async () => undefined) };
    await act(async () => {
      await result?.answer(call as never);
    });
    expect(call.answer).toHaveBeenCalledWith(undefined);
  });

  it('answer forwards media options', async () => {
    renderWithClient();
    const call = { answer: jest.fn(async () => undefined) };
    await act(async () => {
      await result?.answer(call as never, { audio: true, video: false });
    });
    expect(call.answer).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('reject delegates to the call', async () => {
    renderWithClient();
    const call = { reject: jest.fn(async () => undefined) };
    await act(async () => {
      await result?.reject(call as never);
    });
    expect(call.reject).toHaveBeenCalled();
  });

  it('reject swallows an already-ended call', async () => {
    renderWithClient();
    const call = {
      reject: jest.fn(() => {
        throw new Error('already ended');
      })
    };
    await expect(result?.reject(call as never)).resolves.toBeUndefined();
  });
});
