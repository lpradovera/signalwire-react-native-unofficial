import InCallManager from 'react-native-incall-manager';

import { AudioRouteController } from './AudioRouteController';

describe('AudioRouteController', () => {
  let controller: AudioRouteController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AudioRouteController();
  });

  afterEach(() => controller.destroy());

  it('defaults to earpiece before a session starts', () => {
    expect(controller.route).toBe('earpiece');
  });

  it('start("audio") begins an audio session on the earpiece', () => {
    controller.start('audio');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    expect(controller.route).toBe('earpiece');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(false);
  });

  it('start("video") defaults to speaker', () => {
    controller.start('video');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
    expect(controller.route).toBe('speaker');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(true);
  });

  it('setRoute("speaker") forces speakerphone on', () => {
    controller.start('audio');
    controller.setRoute('speaker');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(true);
    expect(controller.route).toBe('speaker');
  });

  it('setRoute("earpiece") forces speakerphone off', () => {
    controller.start('video');
    controller.setRoute('earpiece');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
    expect(controller.route).toBe('earpiece');
  });

  it('setRoute("bluetooth") asks InCallManager to choose the Bluetooth route', () => {
    controller.start('audio');
    controller.setRoute('bluetooth');
    expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
    expect(controller.route).toBe('bluetooth');
  });

  it('emits every route change on route$', () => {
    const seen: string[] = [];
    const subscription = controller.route$.subscribe((route) => seen.push(route));

    controller.start('audio');
    controller.setRoute('speaker');
    controller.setRoute('earpiece');

    subscription.unsubscribe();
    expect(seen).toEqual(['earpiece', 'earpiece', 'speaker', 'earpiece']);
  });

  it('does not re-emit when the route is unchanged', () => {
    const seen: string[] = [];
    const subscription = controller.route$.subscribe((route) => seen.push(route));

    controller.setRoute('speaker');
    controller.setRoute('speaker');

    subscription.unsubscribe();
    expect(seen).toEqual(['earpiece', 'speaker']);
  });

  it('stop ends the session and resets to earpiece', () => {
    controller.start('video');
    controller.stop();
    expect(InCallManager.stop).toHaveBeenCalled();
    expect(controller.route).toBe('earpiece');
  });

  it('stop without start does not throw', () => {
    expect(() => controller.stop()).not.toThrow();
  });

  it('survives InCallManager throwing', () => {
    (InCallManager.setForceSpeakerphoneOn as jest.Mock).mockImplementationOnce(() => {
      throw new Error('audio session busy');
    });
    expect(() => controller.setRoute('speaker')).not.toThrow();
  });
});
