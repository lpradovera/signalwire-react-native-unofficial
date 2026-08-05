import { render, screen } from '@testing-library/react';
import React from 'react';

import { CallControls } from './CallControls';

/**
 * One component is enough to prove the wrapper mechanism, since all fourteen
 * are generated from the same template. What matters is that `createComponent`
 * is wired correctly: the element upgrades, object props reach *properties*
 * rather than attributes, and CustomEvents surface as `on*` props.
 */
describe('CallControls', () => {
  it('registers and renders the underlying custom element', () => {
    render(<CallControls data-testid="controls" />);
    const element = screen.getByTestId('controls');
    expect(element.tagName.toLowerCase()).toBe('sw-call-controls');
  });

  it('defines the custom element on import', () => {
    expect(customElements.get('sw-call-controls')).toBeDefined();
  });

  it('passes an object prop as a property, not an attribute', () => {
    // This is the whole reason a wrapper exists: React would otherwise
    // stringify `call` into an attribute and the element would see "[object Object]".
    const call = { id: 'call-1' };
    render(<CallControls data-testid="controls" call={call as never} />);

    const element = screen.getByTestId('controls') as HTMLElement & { call?: unknown };
    expect(element.call).toBe(call);
    expect(element.getAttribute('call')).toBeNull();
  });

  it('surfaces a CustomEvent as an on* prop', () => {
    const onCallHangup = jest.fn();
    render(<CallControls data-testid="controls" onCallHangup={onCallHangup} />);

    screen
      .getByTestId('controls')
      .dispatchEvent(new CustomEvent('sw-call-hangup', { detail: { reason: 'user' } }));

    expect(onCallHangup).toHaveBeenCalledTimes(1);
  });

  it('does not fire the handler for unrelated events', () => {
    const onCallHangup = jest.fn();
    render(<CallControls data-testid="controls" onCallHangup={onCallHangup} />);

    screen.getByTestId('controls').dispatchEvent(new CustomEvent('sw-dial'));

    expect(onCallHangup).not.toHaveBeenCalled();
  });
});
