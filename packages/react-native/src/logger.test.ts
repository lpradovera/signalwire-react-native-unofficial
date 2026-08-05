jest.mock('@signalwire/js', () => {
  const instance = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: jest.fn(() => instance) };
});

import { getLogger } from '@signalwire/js';

import { logger } from './logger';

describe('logger', () => {
  it('prefixes every level with [SignalWireRN]', () => {
    const sdkLogger = (getLogger as jest.Mock)();
    logger.warn('storage unavailable', 42);
    expect(sdkLogger.warn).toHaveBeenCalledWith('[SignalWireRN]', 'storage unavailable', 42);
  });

  it('forwards debug, info and error too', () => {
    const sdkLogger = (getLogger as jest.Mock)();
    logger.debug('d');
    logger.info('i');
    logger.error('e');
    expect(sdkLogger.debug).toHaveBeenCalledWith('[SignalWireRN]', 'd');
    expect(sdkLogger.info).toHaveBeenCalledWith('[SignalWireRN]', 'i');
    expect(sdkLogger.error).toHaveBeenCalledWith('[SignalWireRN]', 'e');
  });
});
