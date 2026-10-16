#import <AVKit/AVKit.h>
#import <React/RCTViewManager.h>

/**
 * The route picker as one accessibility element. AVRoutePickerView itself is
 * not an element; VoiceOver reaches AVKit's inner button, labelled "AirPlay",
 * so the label React Native sets on this view (accessibilityLabel applies to
 * the view itself for a non-RCTView) was never read. As the element, it is
 * read with that label as a button, and VoiceOver's activation, a tap at its
 * centre, lands on AVKit's button and opens the menu.
 */
@interface SWAudioRoutePickerView : AVRoutePickerView
@end

@implementation SWAudioRoutePickerView

- (BOOL)isAccessibilityElement
{
  return YES;
}

- (UIAccessibilityTraits)accessibilityTraits
{
  return UIAccessibilityTraitButton;
}

@end

/**
 * The system audio route button (AVRoutePickerView): tapping it opens iOS's own
 * output menu, listing the receiver, speaker, and each connected headset or car
 * by name. The OS performs the switch, and nothing here writes the audio
 * session: react-native-incall-manager (with iOS routes) sees the route change,
 * keeps its speaker setting in step and reports it, and useAudioRoute() follows.
 */
@interface SWAudioRoutePickerManager : RCTViewManager
@end

@implementation SWAudioRoutePickerManager

RCT_EXPORT_MODULE(SWAudioRoutePicker)

- (UIView *)view
{
  SWAudioRoutePickerView *picker = [[SWAudioRoutePickerView alloc] init];
  picker.prioritizesVideoDevices = NO;
  return picker;
}

RCT_EXPORT_VIEW_PROPERTY(tintColor, UIColor)
RCT_EXPORT_VIEW_PROPERTY(activeTintColor, UIColor)

@end
