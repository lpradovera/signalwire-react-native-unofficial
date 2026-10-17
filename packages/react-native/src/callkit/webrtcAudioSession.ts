import { NativeModules, Platform } from 'react-native';

import { logger } from '@signalwire/react';

/** react-native-webrtc's iOS module: the two CallKit hooks (124+). */
interface WebRTCModuleAudio {
  audioSessionDidActivate?: () => unknown;
  audioSessionDidDeactivate?: () => unknown;
}

/** This package's iOS module (ios/SWWebRTCAudioSession.m). */
interface SWWebRTCAudioSessionModule {
  useManualAudio: () => boolean;
  setAudioEnabled: (enabled: boolean) => boolean;
  useAutomaticAudio: () => boolean;
}

function modules(): Record<string, unknown> {
  return (NativeModules as Record<string, unknown> | undefined) ?? {};
}

function webrtcModule(): WebRTCModuleAudio | null {
  const module = modules().WebRTCModule as WebRTCModuleAudio | null | undefined;
  return module ?? null;
}

function swModule(): SWWebRTCAudioSessionModule | null {
  const module = modules().SWWebRTCAudioSession as Partial<SWWebRTCAudioSessionModule> | null | undefined;
  if (
    typeof module?.useManualAudio !== 'function' ||
    typeof module.setAudioEnabled !== 'function' ||
    typeof module.useAutomaticAudio !== 'function'
  ) {
    return null;
  }
  return module as SWWebRTCAudioSessionModule;
}

/**
 * Tells WebRTC's audio unit when CallKit activates and deactivates the audio
 * session (iOS only; every method is a no-op elsewhere).
 *
 * CallKit owns a call's audio session. It deactivates and reactivates it
 * whenever the calls change: Hold & Accept, End & Accept, a second outbound
 * call holding the first, a swap or a resume. Deactivation stops the
 * voice-processing I/O unit WebRTC records and plays through, and iOS sends
 * WebRTC no interruption-began notification for it, so WebRTC still had the
 * unit as started: the "interruption ended" that follows found it "Started"
 * and changed nothing (audio_device_ios.mm HandleInterruptionEnd /
 * UpdateAudioUnit), and every later StartRecording was a no-op on a stopped
 * unit. The new call sent no audio for its whole life, and a resumed call's
 * outbound stayed frozen.
 *
 * WebRTC's documented CallKit integration is manual audio: with
 * `RTCAudioSession.useManualAudio` set, WebRTC runs its audio unit only while
 * `isAudioEnabled` is set, and turning that off stops and uninitializes the
 * unit, turning it on initializes and starts it again. So:
 *
 * - activation: `audioSessionDidActivate` (react-native-webrtc's hook, which
 *   counts the activation and clears a stale interruption), then audio off
 *   and on. The off half matters: Hold & Accept activates the session for
 *   the new call with no deactivation before it, while audio is still on, so
 *   only a restart brings the unit back.
 * - deactivation: `audioSessionDidDeactivate`, then audio off.
 * - setup: manual audio, off until CallKit's first activation (a session
 *   already active when the bridge is built, after a JavaScript reload mid
 *   call, keeps its audio on; see the native module).
 *
 * The 44.1 kHz preferred sample rate the old callkeep set on every start and
 * answer hid this: WebRTC runs at 48 kHz, so each call change was also a
 * sample-rate change, and WebRTC restarts its unit for one of those. The
 * fork dropped that setting (callkeep #858), and the missing integration
 * showed.
 *
 * Without this package's native module (an app not rebuilt since it was
 * added) WebRTC keeps its automatic audio and only the two hooks are called.
 */
export class WebRTCAudioSessionLink {
  private manual = false;
  /** Whether WebRTC was last told the session is active. */
  private active = false;
  private warnedMissing = false;

  /** Puts WebRTC's audio under CallKit's activations. Call once, before the first event. */
  adopt(): void {
    if (Platform.OS !== 'ios' || this.manual) {
      return;
    }
    const sw = swModule();
    if (!sw) {
      this.warnMissing();
      return;
    }
    this.manual = this.call('useManualAudio', () => sw.useManualAudio()) === true;
    if (!this.manual) {
      logger.warn('WebRTC audio session not found; call switches may leave a call without audio');
    }
  }

  /** CallKit activated the audio session. */
  didActivate(): void {
    if (Platform.OS !== 'ios') {
      return;
    }
    this.active = true;
    const webrtc = webrtcModule();
    if (typeof webrtc?.audioSessionDidActivate === 'function') {
      this.call('audioSessionDidActivate', () => webrtc.audioSessionDidActivate?.());
    }
    this.restartAudio();
  }

  /** CallKit deactivated the audio session. A second deactivation is ignored. */
  didDeactivate(): void {
    if (Platform.OS !== 'ios' || !this.active) {
      return;
    }
    this.active = false;
    const webrtc = webrtcModule();
    if (typeof webrtc?.audioSessionDidDeactivate === 'function') {
      this.call('audioSessionDidDeactivate', () => webrtc.audioSessionDidDeactivate?.());
    }
    this.setAudioEnabled(false);
  }

  /**
   * CallKit never activated the session for a call (the bridge's fallback
   * timeout): let WebRTC run its audio anyway rather than leave the call silent.
   */
  enableWithoutActivation(): void {
    if (Platform.OS !== 'ios') {
      return;
    }
    this.setAudioEnabled(true);
  }

  /** Hands WebRTC its automatic audio back (the bridge is destroyed). */
  release(): void {
    if (!this.manual) {
      return;
    }
    this.manual = false;
    this.active = false;
    const sw = swModule();
    if (sw) {
      this.call('useAutomaticAudio', () => sw.useAutomaticAudio());
    }
  }

  private restartAudio(): void {
    if (!this.manual) {
      return;
    }
    this.setAudioEnabled(false);
    this.setAudioEnabled(true);
  }

  private setAudioEnabled(enabled: boolean): void {
    if (!this.manual) {
      return;
    }
    const sw = swModule();
    if (sw) {
      this.call('setAudioEnabled', () => sw.setAudioEnabled(enabled));
    }
  }

  private call<T>(name: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (error: unknown) {
      logger.warn(`WebRTC audio session: ${name} failed:`, error);
      return undefined;
    }
  }

  private warnMissing(): void {
    if (this.warnedMissing) {
      return;
    }
    this.warnedMissing = true;
    logger.warn(
      'SWWebRTCAudioSession native module missing (rebuild the app): call switches may leave a call without audio'
    );
  }
}
