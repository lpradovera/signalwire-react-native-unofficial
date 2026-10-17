#import <AVKit/AVKit.h>
#import <React/RCTViewManager.h>

/**
 * The route picker as one accessibility element. AVRoutePickerView itself is
 * not an element; VoiceOver reaches AVKit's inner button, labelled "AirPlay",
 * so the label React Native sets on this view was never read. As an element,
 * it hides that button. Under the New Architecture React Native's interop
 * container around this view becomes the element (it answers with this view's
 * isAccessibilityElement) and takes its label and traits from the JS props,
 * which is why AudioRoutePickerButton passes accessibilityRole "button"; the
 * traits here serve a host that asks this view itself. VoiceOver's
 * activation, a tap at the centre, lands on AVKit's button and opens the menu.
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

/**
 * A tap anywhere in the view around the picker opens the menu. The interop
 * container frames this view to its content box, so its padding (the icon's
 * inset), its border and its hitSlop lie outside this view, and a tap there
 * hit the container, which opens nothing. The container hit-tests each
 * subview for every point inside its own hit area (RCTViewComponentView's
 * betterHitTest); answering YES for those points makes this view the hit
 * view, and AVRoutePickerView's own tap recognizer opens the menu, as it
 * already did for a tap inside this view but outside AVKit's button.
 */
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event
{
  if ([super pointInside:point withEvent:event]) {
    return YES;
  }
  UIView *container = self.superview;
  return container != nil && [container pointInside:[self convertPoint:point toView:container] withEvent:event];
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

/**
 * A style prop the interop container draws itself, made a no-op on the
 * picker. The New Architecture's interop container applies the style
 * (background, border, radius, opacity, transform, shadow) to itself and then
 * hands every raw prop, the flattened style included, to this manager for the
 * picker, whose inherited RCTViewManager setters applied it a second time: a
 * translucent background doubled, a border drew a second ring, opacity was
 * squared, transforms compounded. Only the props whose RCTViewManager setter
 * writes a plain UIView are listed (the per-side and per-corner border props,
 * borderStyle, filter, boxShadow and mixBlendMode already do nothing on a
 * view that isn't an RCTView). The types are RCTViewManager's, so the view
 * config JS sees is unchanged.
 */
#define SW_DRAWN_BY_CONTAINER(name, type) \
  RCT_CUSTOM_VIEW_PROPERTY(name, type, SWAudioRoutePickerView) {}

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

SW_DRAWN_BY_CONTAINER(backgroundColor, UIColor)
SW_DRAWN_BY_CONTAINER(opacity, CGFloat)
SW_DRAWN_BY_CONTAINER(transform, CATransform3D)
SW_DRAWN_BY_CONTAINER(transformOrigin, RCTTransformOrigin)
SW_DRAWN_BY_CONTAINER(backfaceVisibility, css_backface_visibility_t)
SW_DRAWN_BY_CONTAINER(shadowColor, CGColor)
SW_DRAWN_BY_CONTAINER(shadowOffset, CGSize)
SW_DRAWN_BY_CONTAINER(shadowOpacity, float)
SW_DRAWN_BY_CONTAINER(shadowRadius, CGFloat)
SW_DRAWN_BY_CONTAINER(borderRadius, CGFloat)
SW_DRAWN_BY_CONTAINER(borderColor, UIColor)
SW_DRAWN_BY_CONTAINER(borderWidth, float)
SW_DRAWN_BY_CONTAINER(borderCurve, RCTBorderCurve)

@end
