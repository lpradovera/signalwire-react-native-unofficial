require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# iOS audio routes and the system route picker. Autolinked: an app picks this up
# on its next `pod install` (Expo: `expo prebuild` / `expo run:ios`).
Pod::Spec.new do |s|
  s.name         = 'SignalWireReactNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']
  s.homepage     = package['homepage']
  s.author       = 'signalwire-react-native contributors'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :git => package['repository']['url'], :tag => "v#{s.version}" }
  s.source_files = 'ios/**/*.{h,m}'
  s.frameworks   = 'AVFoundation', 'AVKit'

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end
end
