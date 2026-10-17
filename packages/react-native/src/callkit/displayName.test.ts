import { displayableName, isPlaceholderName, readableAddress } from './displayName';

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

  it.each(['/private/', '/public/---', 'sip:@example.com', 'sip:', 'sips: '])('has no name for %s', (address) => {
    expect(readableAddress(address)).toBeNull();
  });

  // A caller name the backend prefixed with a scheme, although what follows is
  // not a URI user part: REST caller_id "Android Test" arrived as
  // fromName "sip:Android Test", and was shown as that.
  it.each([
    ['sip:Android Test', 'Android Test'],
    ['SIP:Android Test', 'Android Test'],
    ['sips:Front Desk', 'Front Desk'],
    ['sip:Android%20Test', 'Android Test'],
    ['sip:Front Desk;transport=tls', 'Front Desk'],
    ['sip:+15551234567', '+15551234567'],
    [' sip: Ada Lovelace ', 'Ada Lovelace']
  ])('drops the scheme from %p, keeping the rest as it is: %p', (value, name) => {
    expect(readableAddress(value)).toBe(name);
  });
});

describe('displayableName', () => {
  it('shows "sip:Android Test" as "Android Test"', () => {
    expect(displayableName('sip:Android Test', 'test')).toBe('Android Test');
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
