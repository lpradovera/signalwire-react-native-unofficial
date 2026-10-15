#import <AVKit/AVKit.h>
#import <React/RCTViewManager.h>

/**
 * The system audio route button (AVRoutePickerView): tapping it opens iOS's own
 * output menu, listing the receiver, speaker, and each connected headset or car
 * by name. The OS performs the switch, so nothing needs reporting back; the
 * route-change event of SWAudioRoutes reflects it.
 */
@interface SWAudioRoutePickerManager : RCTViewManager
@end

@implementation SWAudioRoutePickerManager

RCT_EXPORT_MODULE(SWAudioRoutePicker)

- (UIView *)view
{
  AVRoutePickerView *picker = [[AVRoutePickerView alloc] init];
  picker.prioritizesVideoDevices = NO;
  return picker;
}

RCT_EXPORT_VIEW_PROPERTY(tintColor, UIColor)
RCT_EXPORT_VIEW_PROPERTY(activeTintColor, UIColor)

@end
