/**
 * React Native call UI for the SignalWire SDK.
 *
 * Every component is driven by the hooks in `@signalwire/react`, so they hold
 * no state of their own and always agree with the SDK — including changes that
 * came from the native call UI or the remote side.
 */

export { SignalWireThemeProvider, useSignalWireTheme } from './theme/ThemeProvider';
export type { SignalWireThemeProviderProps } from './theme/ThemeProvider';
export { defaultTheme, mergeTheme } from './theme/theme';
export type { SignalWireTheme, SignalWireThemeOverride } from './theme/theme';

export { ControlButton } from './components/ControlButton';
export type { ControlButtonProps } from './components/ControlButton';
export { CallControls } from './components/CallControls';
export type { CallControlsProps } from './components/CallControls';
export { CallStatus } from './components/CallStatus';
export type { CallStatusProps } from './components/CallStatus';
export { Dialpad } from './components/Dialpad';
export type { DialpadProps } from './components/Dialpad';
export { ParticipantList } from './components/ParticipantList';
export type { ParticipantListProps } from './components/ParticipantList';
export { DeviceSelector } from './components/DeviceSelector';
export type { DeviceSelectorProps } from './components/DeviceSelector';
export { IncomingCallSheet } from './components/IncomingCallSheet';
export type { IncomingCallSheetProps } from './components/IncomingCallSheet';
