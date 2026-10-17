import { DeviceEventEmitter, NativeModules } from 'react-native';

/**
 * Telecom as a self-managed callkeep call sees it: callkeep's native
 * `setAudioRoute` (Connection.setAudioRoute), its `didChangeAudioRoute`
 * event (RNCallKeepDidChangeAudioRoute through DeviceEventEmitter), and the
 * package's CallAudioState reader (SignalWireCallAudio).
 *
 * Telecom names: EARPIECE, SPEAKER, WIRED_HEADSET, BLUETOOTH.
 */
export interface TelecomCallState {
  route: string;
  available: string[];
  bluetoothName?: string | null;
}

const modules = NativeModules as Record<string, unknown>;
const states = new Map<string, TelecomCallState>();

/** Whether a setAudioRoute moves the call (and reports it), as Telecom does for a route it offers. */
let follows = true;
/**
 * Whether didChangeAudioRoute carries the CallAudioState (the SignalWire
 * callkeep fork: supportedRoutes, bluetoothDevice) or only the route (4.3.16).
 */
let fullReports = false;

/** callkeep's names to Telecom's, as RNCallKeepModule.setAudioRoute maps them. */
function telecomRoute(callkeep: string, state: TelecomCallState): string {
  switch (callkeep) {
    case 'Bluetooth':
      return 'BLUETOOTH';
    case 'Headset':
      return 'WIRED_HEADSET';
    case 'Speaker':
      return 'SPEAKER';
    default:
      // ROUTE_WIRED_OR_EARPIECE
      return state.available.includes('WIRED_HEADSET') ? 'WIRED_HEADSET' : 'EARPIECE';
  }
}

export const callkeepNative = {
  setAudioRoute: jest.fn(async (uuid: string, route: string) => {
    const state = states.get(uuid);
    if (!state || !follows) {
      return true;
    }
    const next = telecomRoute(route, state);
    if (state.available.includes(next) && next !== state.route) {
      // Telecom takes requests in order and reports each switch on its own
      // thread, after the request returns.
      const moved = { ...state, route: next };
      states.set(uuid, moved);
      setTimeout(() => reportTelecom(uuid, moved), 0);
    }
    return true;
  })
};

export const callAudioNative = {
  getCallAudioState: jest.fn(async (uuid: string) => {
    const state = states.get(uuid);
    return state ? { route: state.route, available: [...state.available], bluetoothName: state.bluetoothName ?? null } : null;
  })
};

/**
 * Links callkeep's native module and, unless `reader` is false, the package's
 * reader. `fullReports`: callkeep's reports carry the routes and the Bluetooth
 * device, as the fork's do.
 */
export function installTelecom({ reader = true, fullReports: full = false }: { reader?: boolean; fullReports?: boolean } = {}): void {
  modules.RNCallKeep = callkeepNative;
  fullReports = full;
  if (reader) {
    modules.SignalWireCallAudio = callAudioNative;
  } else {
    delete modules.SignalWireCallAudio;
  }
  follows = true;
}

export function uninstallTelecom(): void {
  delete modules.RNCallKeep;
  delete modules.SignalWireCallAudio;
  states.clear();
  follows = true;
  fullReports = false;
  callkeepNative.setAudioRoute.mockClear();
  callAudioNative.getCallAudioState.mockClear();
}

/** Sets a call's state without a report (the state before JavaScript subscribed). */
export function setTelecomState(uuid: string, state: TelecomCallState): void {
  states.set(uuid, state);
}

/** Telecom changes the call's state and callkeep forwards it. */
export function reportTelecom(uuid: string, state: TelecomCallState): void {
  states.set(uuid, state);
  const event: Record<string, unknown> = { callUUID: uuid, handle: '+15551234', output: state.route };
  if (fullReports) {
    event.supportedRoutes = [...state.available];
    event.bluetoothDevices = [];
    if (state.route === 'BLUETOOTH') {
      const device = { address: '00:11:22:33:44:55', name: state.bluetoothName ?? null };
      event.bluetoothDevice = device;
      event.bluetoothDevices = [device];
    }
  }
  DeviceEventEmitter.emit('RNCallKeepDidChangeAudioRoute', event);
}

/** Telecom ignores route requests (a route it doesn't offer, say), reporting nothing. */
export function telecomIgnoresRequests(): void {
  follows = false;
}
