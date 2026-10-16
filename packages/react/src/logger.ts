import { getLogger } from '@signalwire/js';

/**
 * Shared by the React bindings (this universal core, which runs in the
 * browser too, @signalwire/react-native and the UI kits), so it names none of
 * them by platform. The SDK's own lines say `[SignalWire]`.
 */
const PREFIX = '[SignalWire React]';

/** Logger that routes through the SDK's logger so app-level log config applies. */
export const logger = {
  debug: (...args: unknown[]): void => getLogger().debug(PREFIX, ...args),
  info: (...args: unknown[]): void => getLogger().info(PREFIX, ...args),
  warn: (...args: unknown[]): void => getLogger().warn(PREFIX, ...args),
  error: (...args: unknown[]): void => getLogger().error(PREFIX, ...args)
};
