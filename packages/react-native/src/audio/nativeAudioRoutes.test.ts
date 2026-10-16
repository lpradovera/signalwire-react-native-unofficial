import { NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';

import {
  deviceStatus,
  incallIosRoutes,
  installIncallIosRoutes,
  reportDevice,
  uninstallIncallIosRoutes
} from '../../jest/mocks/incallIosRoutes';
import {
  audioDevices$,
  getAudioDeviceStatus,
  hasIosAudioRoutes,
  parseAudioDeviceStatus,
  resetAudioDevicesForTesting
} from './nativeAudioRoutes';

const wrapper = InCallManager as unknown as { addListener: jest.Mock; getAudioDeviceStatus: jest.Mock };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  // restoreAllMocks puts back a replaced Platform.OS even when a test failed.
  jest.restoreAllMocks();
  jest.useRealTimers();
  resetAudioDevicesForTesting();
  uninstallIncallIosRoutes();
  jest.clearAllMocks();
});

describe('parseAudioDeviceStatus', () => {
  it('parses the status incall-manager sends, list as a JSON string', () => {
    expect(parseAudioDeviceStatus(deviceStatus('BLUETOOTH', undefined, 'KENWOOD'))).toEqual({
      available: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
      selected: 'BLUETOOTH',
      selectedName: 'KENWOOD'
    });
  });

  it("drops what it does not recognise, including Android's NONE", () => {
    expect(parseAudioDeviceStatus(deviceStatus('NONE', '["EARPIECE","AIRPLAY"]', ''))).toEqual({
      available: ['EARPIECE'],
      selected: null,
      selectedName: ''
    });
    expect(parseAudioDeviceStatus({ availableAudioDeviceList: 'not json' }).available).toEqual([]);
    expect(parseAudioDeviceStatus(null)).toEqual({ available: [], selected: null, selectedName: '' });
  });
});

describe('incall-manager iOS routes', () => {
  it('are absent from released incall-manager, which has no iOS getAudioDeviceStatus', async () => {
    expect(hasIosAudioRoutes()).toBe(false);
    await expect(getAudioDeviceStatus()).resolves.toBeNull();
  });

  it('are found from the native method, and read', async () => {
    installIncallIosRoutes(deviceStatus('BLUETOOTH'));
    expect(hasIosAudioRoutes()).toBe(true);
    await expect(getAudioDeviceStatus()).resolves.toMatchObject({ selected: 'BLUETOOTH' });
  });

  it('are iOS only', async () => {
    installIncallIosRoutes();
    jest.replaceProperty(Platform, 'OS', 'android');
    expect(hasIosAudioRoutes()).toBe(false);
    await expect(getAudioDeviceStatus()).resolves.toBeNull();
  });

  it('need the JS half too: an older JS bundle over a rebuilt app has no routes', () => {
    installIncallIosRoutes();
    delete (InCallManager as unknown as Record<string, unknown>).addListener;
    expect(hasIosAudioRoutes()).toBe(false);
  });

  it('need the native half too: a JS bundle with the routes over an app not rebuilt has none', () => {
    installIncallIosRoutes();
    (NativeModules as Record<string, unknown>).InCallManager = { start: jest.fn() };
    expect(hasIosAudioRoutes()).toBe(false);
  });
});

describe('audioDevices$', () => {
  it('reads once and shares one native subscription between subscribers', async () => {
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const a: (string | null)[] = [];
    const b: (string | null)[] = [];
    const first = audioDevices$.subscribe((status) => a.push(status.selected));
    const second = audioDevices$.subscribe((status) => b.push(status.selected));
    await Promise.resolve();
    await Promise.resolve();
    reportDevice('BLUETOOTH');

    expect(a).toEqual(['EARPIECE', 'BLUETOOTH']);
    expect(b).toEqual(['EARPIECE', 'BLUETOOTH']);
    expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);
    expect(wrapper.addListener).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    second.unsubscribe();
  });

  it('drops the native subscription as soon as the last subscriber leaves', async () => {
    // useAudioDevices subscribes once per mount (no render-time peek), so
    // nothing needs the subscription kept past its last subscriber.
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const first = audioDevices$.subscribe(() => undefined);
    const second = audioDevices$.subscribe(() => undefined);
    await flush();
    expect(wrapper.addListener).toHaveBeenCalledTimes(1);
    const remove = jest.spyOn(wrapper.addListener.mock.results[0]!.value as { remove(): void }, 'remove');

    first.unsubscribe();
    expect(remove).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('shares one native subscription and one read between two bundle copies of the package', async () => {
    // tsup builds each subpath entry as its own bundle; an app importing
    // dist/audio.mjs and, through a dependency, dist/audio.js loads two
    // copies of this module. Two isolated module registries stand for them.
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const load = (): typeof import('./nativeAudioRoutes') => {
      let copy: typeof import('./nativeAudioRoutes') | undefined;
      jest.isolateModules(() => {
        // Each registry has its own incall-manager wrapper; give it the routes.
        const own = jest.requireActual<{ default: Record<string, unknown> }>('react-native-incall-manager').default;
        own.addListener = wrapper.addListener;
        own.getAudioDeviceStatus = wrapper.getAudioDeviceStatus;
        copy = jest.requireActual<typeof import('./nativeAudioRoutes')>('./nativeAudioRoutes');
      });
      return copy!;
    };
    const one = load();
    const two = load();
    const a: (string | null)[] = [];
    const b: (string | null)[] = [];
    const first = one.audioDevices$.subscribe((status) => a.push(status.selected));
    const second = two.audioDevices$.subscribe((status) => b.push(status.selected));
    await flush();
    reportDevice('BLUETOOTH');

    expect(wrapper.addListener).toHaveBeenCalledTimes(1);
    expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);
    expect(a).toEqual(['EARPIECE', 'BLUETOOTH']);
    expect(b).toEqual(['EARPIECE', 'BLUETOOTH']);
    first.unsubscribe();
    second.unsubscribe();
  });

  it('keeps a read made while one connection lived out of the next one', async () => {
    jest.useFakeTimers();
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const first = audioDevices$.subscribe(() => undefined);
    await jest.advanceTimersByTimeAsync(0);
    let resolve: (status: unknown) => void = () => undefined;
    incallIosRoutes.getAudioDeviceStatus.mockImplementationOnce(() => new Promise((done) => (resolve = done)) as never);
    const late = getAudioDeviceStatus();
    first.unsubscribe();
    await jest.advanceTimersByTimeAsync(5000);

    const seen: (string | null)[] = [];
    const next = audioDevices$.subscribe((status) => seen.push(status.selected));
    await jest.advanceTimersByTimeAsync(0);
    resolve(deviceStatus('BLUETOOTH'));
    await expect(late).resolves.toMatchObject({ selected: 'BLUETOOTH' });

    expect(seen).toEqual(['EARPIECE']);
    next.unsubscribe();
  });

  it('hands a later subscriber nothing stale once it has disconnected', async () => {
    jest.useFakeTimers();
    installIncallIosRoutes(deviceStatus('BLUETOOTH'));
    audioDevices$.subscribe(() => undefined).unsubscribe();
    await jest.advanceTimersByTimeAsync(5000);
    incallIosRoutes.getAudioDeviceStatus.mockImplementation(() => new Promise(() => undefined) as never);

    const seen = jest.fn();
    audioDevices$.subscribe(seen);
    await jest.advanceTimersByTimeAsync(0);

    expect(seen).not.toHaveBeenCalled();
  });

  it("takes a read over the reports that reached it first, as incall-manager's one queue orders them", async () => {
    let resolve: (status: unknown) => void = () => undefined;
    installIncallIosRoutes();
    incallIosRoutes.getAudioDeviceStatus.mockImplementation(() => new Promise((done) => (resolve = done)) as never);
    const seen: (string | null)[] = [];
    audioDevices$.subscribe((status) => seen.push(status.selected));

    reportDevice('EARPIECE');
    resolve(deviceStatus('BLUETOOTH'));
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual(['EARPIECE', 'BLUETOOTH']);
  });

  it('getAudioDeviceStatus hands a fresh read to the subscribers', async () => {
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const seen: (string | null)[] = [];
    audioDevices$.subscribe((status) => seen.push(status.selected));
    await Promise.resolve();
    await Promise.resolve();
    incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => deviceStatus('BLUETOOTH'));

    await getAudioDeviceStatus();

    expect(seen).toEqual(['EARPIECE', 'BLUETOOTH']);
  });

  it('never emits without iOS routes', () => {
    const seen = jest.fn();
    audioDevices$.subscribe(seen).unsubscribe();
    expect(seen).not.toHaveBeenCalled();
  });
});
