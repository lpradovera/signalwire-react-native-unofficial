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
