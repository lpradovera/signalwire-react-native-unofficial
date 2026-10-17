require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# The system audio route button (AVRoutePickerView) and WebRTC's manual-audio
# switches for CallKit (SWWebRTCAudioSession). Autolinked: an app picks this up
# on its next `pod install` (Expo: `expo prebuild` / `expo run:ios`).
Pod::Spec.new do |s|
  s.name         = 'SignalWireReactNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']
  s.homepage     = package['homepage']
  s.author       = 'signalwire-react-native contributors'
  # React Native's own minimum when the app's Podfile defines it (it always does
  # through react_native_pods.rb); 15.1 for a standalone `pod spec lint`.
  s.platforms    = { :ios => respond_to?(:min_ios_version_supported, true) ? min_ios_version_supported : '15.1' }
  # package.json's URL is npm's "git+https://..."; git can't clone that form.
  s.source       = { :git => package['repository']['url'].sub(/^git\+/, ''), :tag => "v#{s.version}" }
  s.source_files = 'ios/**/*.{h,m}'
  s.frameworks   = 'AVKit'

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end
end
