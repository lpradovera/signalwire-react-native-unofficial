/**
 * What @signalwire/js 4.0.0-rc.2 needs from the WebRTC provider beyond the
 * WebRTCApiProvider slots:
 *
 * - It constructs the bare global `MediaStream` (index.cjs:4561, 4648, 4676,
 *   4710, 5731, 6842: a dial with inputAudioStream, a track restored after a
 *   receive-only start, a remote track without a stream). React Native
 *   defines none, and react-native-webrtc installs one only through
 *   registerGlobals(), which this package does not call.
 * - Its MediaAccessError reports a permission denial (`denied`, the 'denied'
 *   message, `cause`) only for an `Error` whose name is a denial name.
 *   react-native-webrtc rejects getUserMedia with a MediaStreamError, a plain
 *   class that does not extend Error.
 */
import { MediaAccessError } from '@signalwire/js';
import { mediaDevices, MediaStream as RNMediaStream } from 'react-native-webrtc';

import { createWebRTCApiProvider } from './webrtc';

type Root = { MediaStream?: unknown };
const root = globalThis as Root;

/** react-native-webrtc's MediaStreamError: no Error in its prototype chain. */
class MediaStreamError {
  name: string;
  message?: string;
  constraintName?: string;
  constructor(error: { name: string; message?: string; constraintName?: string }) {
    this.name = error.name;
    this.message = error.message;
    this.constraintName = error.constraintName;
  }
}

describe('createWebRTCApiProvider: what the SDK reads besides the provider', () => {
  const original = root.MediaStream;

  afterEach(() => {
    if (original === undefined) {
      delete root.MediaStream;
    } else {
      root.MediaStream = original;
    }
  });

  it("installs react-native-webrtc's MediaStream as the global the SDK constructs", () => {
    delete root.MediaStream;
    createWebRTCApiProvider();
    expect(root.MediaStream).toBe(RNMediaStream);
    const Ctor = root.MediaStream as new (tracks?: unknown[]) => unknown;
    expect(new Ctor([])).toBeInstanceOf(RNMediaStream);
  });

  it('leaves a MediaStream global that is already there', () => {
    const existing = class {};
    root.MediaStream = existing;
    createWebRTCApiProvider();
    expect(root.MediaStream).toBe(existing);
  });

  it('turns a denied permission into an Error the SDK reports as denied', async () => {
    (mediaDevices.getUserMedia as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new MediaStreamError({ name: 'SecurityError', message: 'Permission denied.' }))
    );
    const provider = createWebRTCApiProvider();

    const failure = await provider.mediaDevices.getUserMedia({ audio: true }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('SecurityError');
    expect((failure as Error).message).toBe('Permission denied.');
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(MediaStreamError);
    const wrapped = new MediaAccessError('acquireLocalMedia', 'audio', failure);
    expect(wrapped.denied).toBe(true);
    expect(wrapped.message).toContain('denied');
    expect((wrapped as Error & { cause?: unknown }).cause).toBe(failure);
  });

  it('passes an Error rejection through untouched', async () => {
    const original = new TypeError('constraints is not a dictionary');
    (mediaDevices.getUserMedia as jest.Mock).mockImplementationOnce(() => Promise.reject(original));
    const provider = createWebRTCApiProvider();

    await expect(provider.mediaDevices.getUserMedia({ audio: true })).rejects.toBe(original);
  });
});
