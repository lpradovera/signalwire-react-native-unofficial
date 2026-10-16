import { isPlaceholderName, readableAddress } from './displayName';

describe('readableAddress', () => {
  it.each([
    ['/private/rn-device-test', 'Rn Device Test'],
    ['/public/support_agent', 'Support Agent'],
    ['/private/sales?channel=audio', 'Sales'],
    ['/private/caf%C3%A9-front-desk', 'Café Front Desk'],
    ['sip:rn-example@0f1e.call.signalwire.com;context=private', 'Rn Example'],
    ['sips:alice.smith@example.com', 'Alice Smith']
  ])('names the Fabric or SIP address %s as %s', (address, name) => {
    expect(readableAddress(address)).toBe(name);
  });

  it.each(['+15551234', 'Ada Lovelace', 'support'])('leaves %s as it is', (value) => {
    expect(readableAddress(value)).toBe(value);
  });

  it.each(['/private/', '/public/---', 'sip:@example.com'])('has no name for %s', (address) => {
    expect(readableAddress(address)).toBeNull();
  });
});

describe('isPlaceholderName', () => {
  it.each(['_undef_', ' _undef_ ', '', '   '])('takes %p for a placeholder', (name) => {
    expect(isPlaceholderName(name)).toBe(true);
  });

  it.each(['Ada', 'Undef', '+15551234'])('takes %p for a name', (name) => {
    expect(isPlaceholderName(name)).toBe(false);
  });
});

describe('displayableName on the public entries', () => {
  it('is exported from the main entry and from ./ringing, and needs no context', () => {
    const { displayableName: fromMain } = require('../index') as typeof import('../index');
    const { displayableName: fromRinging } = require('../ringing') as typeof import('../ringing');
    expect(fromRinging).toBe(fromMain);
    expect(fromMain('_undef_')).toBeNull();
    expect(fromMain('')).toBeNull();
    expect(fromMain('/private/rn-device-test')).toBe('Rn Device Test');
    expect(fromMain('Ada Lovelace')).toBe('Ada Lovelace');
    expect(fromMain(undefined)).toBeNull();
  });
});
