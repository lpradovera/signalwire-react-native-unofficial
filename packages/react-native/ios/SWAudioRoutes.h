#import <React/RCTEventEmitter.h>

/**
 * Audio routes on iOS, with the names, promise results and event that
 * react-native-incall-manager uses on Android: EARPIECE, SPEAKER_PHONE,
 * WIRED_HEADSET, BLUETOOTH, and `onAudioDeviceChanged` carrying
 * { availableAudioDeviceList (a JSON array), selectedAudioDevice,
 *   selectedAudioDeviceName }.
 *
 * incall-manager has no iOS routes (through 4.3.0); this exists for that, and
 * can go if it gains them.
 */
@interface SWAudioRoutes : RCTEventEmitter
@end
