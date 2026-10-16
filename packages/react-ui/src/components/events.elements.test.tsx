/**
 * The wrappers' event props against the REAL Lit elements (the `elements`
 * jest project loads @signalwire/web-components itself, not the stub), driven
 * by clicks on the elements' real buttons.
 */
import '@signalwire/web-components';

import { act, render } from '@testing-library/react';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { CallControls } from './CallControls';
import { CallDialpad } from './CallDialpad';
import { CallWidget } from './CallWidget';
import { ClickToCall } from './ClickToCall';

type LitHost = HTMLElement & { updateComplete?: Promise<unknown> };

// jsdom has no constructable stylesheets (replaceSync, adoptedStyleSheets);
// <sw-call-widget> uses them on connect to install its theme, once per page.
CSSStyleSheet.prototype.replaceSync ??= function replaceSync() {};
if (!Array.isArray(document.adoptedStyleSheets)) {
  Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true });
}

function fakeCall() {
  return {
    id: 'c1',
    self$: new BehaviorSubject(null).asObservable(),
    status$: new BehaviorSubject('connected').asObservable(),
    hangup: jest.fn(async () => undefined),
    sendDigits: jest.fn(async () => undefined)
  };
}

/** Every element under `root`, descending into open shadow roots. */
function composed(root: Element | ShadowRoot): Element[] {
  const out: Element[] = [];
  const walk = (node: Element | ShadowRoot): void => {
    for (const el of Array.from(node.children)) {
      out.push(el);
      walk(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

/** Waits until every Lit element in the tree has rendered. */
async function settle(host: LitHost): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      for (const el of [host, ...composed(host.shadowRoot ?? host)] as LitHost[]) {
        if (el.updateComplete) await el.updateComplete;
      }
    });
  }
}

/** The real <button> inside a <sw-call-controls>' hang-up split button. */
function hangupButton(controls: Element): HTMLButtonElement {
  const bar = controls.shadowRoot!.querySelector('sw-ui-control-bar')!;
  const split = bar.shadowRoot!.querySelector('sw-ui-split-button.hangup')!;
  return split.shadowRoot!.querySelector('button')!;
}

/** Puts a real <sw-call-controls> inside `shadowRoot`, as the call widget renders it. */
async function mountControls(shadowRoot: ShadowRoot, call: ReturnType<typeof fakeCall>) {
  const controls = document.createElement('sw-call-controls') as LitHost & { call?: unknown };
  controls.call = call;
  shadowRoot.appendChild(controls);
  await settle(controls);
  return controls;
}

describe('event props on the real elements', () => {
  it('CallControls: one hang-up click runs onCallHangup once', async () => {
    const call = fakeCall();
    const onCallHangup = jest.fn();
    const view = render(
      <CallControls data-testid="cc" call={call as never} onCallHangup={onCallHangup} />
    );
    const host = view.getByTestId('cc') as LitHost;
    await settle(host);

    await act(async () => hangupButton(host).click());

    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(onCallHangup).toHaveBeenCalledTimes(1);
  });

  it('CallControls: the handler of the latest render is the one that runs', async () => {
    const call = fakeCall();
    const first = jest.fn();
    const second = jest.fn();
    const view = render(<CallControls data-testid="cc" call={call as never} onCallHangup={first} />);
    view.rerender(<CallControls data-testid="cc" call={call as never} onCallHangup={second} />);
    const host = view.getByTestId('cc') as LitHost;
    await settle(host);

    await act(async () => hangupButton(host).click());

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('CallWidget: one hang-up click on its controls runs onCallHangup once', async () => {
    const onCallHangup = jest.fn();
    const view = render(<CallWidget data-testid="w" onCallHangup={onCallHangup} />);
    const host = view.getByTestId('w') as LitHost;
    await settle(host);
    const controls = await mountControls(host.shadowRoot!, fakeCall());

    await act(async () => hangupButton(controls).click());

    expect(onCallHangup).toHaveBeenCalledTimes(1);
  });

  it("ClickToCall: one hang-up click on its widget's controls runs onCallHangup once", async () => {
    const onCallHangup = jest.fn();
    const view = render(<ClickToCall data-testid="c2c" onCallHangup={onCallHangup} />);
    const host = view.getByTestId('c2c') as LitHost;
    await settle(host);
    const widget = host.shadowRoot!.querySelector('sw-call-widget') as LitHost;
    const controls = await mountControls(widget.shadowRoot!, fakeCall());

    await act(async () => hangupButton(controls).click());

    expect(onCallHangup).toHaveBeenCalledTimes(1);
  });

  it("ClickToCall: onDial and onCallEnded receive its widget's sw-dial and sw-call-ended", async () => {
    const onDial = jest.fn();
    const onCallEnded = jest.fn();
    const view = render(
      <ClickToCall data-testid="c2c" onDial={onDial} onCallEnded={onCallEnded} />
    );
    const host = view.getByTestId('c2c') as LitHost;
    await settle(host);
    const widget = host.shadowRoot!.querySelector('sw-call-widget')!;

    // Dispatched as the widget itself does (bubbles, composed): a real dial needs a server.
    await act(async () => {
      widget.dispatchEvent(
        new CustomEvent('sw-dial', { detail: { destination: '/x' }, bubbles: true, composed: true })
      );
      widget.dispatchEvent(
        new CustomEvent('sw-call-ended', {
          detail: { status: 'destroyed' },
          bubbles: true,
          composed: true
        })
      );
    });

    expect(onDial).toHaveBeenCalledTimes(1);
    expect(onDial.mock.calls[0][0].detail).toEqual({ destination: '/x' });
    expect(onCallEnded).toHaveBeenCalledTimes(1);
    expect(onCallEnded.mock.calls[0][0].detail).toEqual({ status: 'destroyed' });
  });

  it('CallDialpad: a key and the call button run onDigitPress and onDial once each', async () => {
    const onDigitPress = jest.fn();
    const onDial = jest.fn();
    const view = render(
      <CallDialpad data-testid="dp" showCallButton onDigitPress={onDigitPress} onDial={onDial} />
    );
    const host = view.getByTestId('dp') as LitHost;
    await settle(host);
    const one = composed(host.shadowRoot!).find(
      (el) => el.tagName === 'BUTTON' && el.querySelector('.key-digit')?.textContent === '1'
    ) as HTMLButtonElement;

    await act(async () => one.click());
    await settle(host);
    const callButton = composed(host.shadowRoot!).find((el) =>
      el.classList.contains('call-button')
    ) as HTMLButtonElement;
    await act(async () => callButton.click());

    expect(onDigitPress).toHaveBeenCalledTimes(1);
    expect(onDigitPress.mock.calls[0][0].detail).toMatchObject({ digit: '1' });
    expect(onDial).toHaveBeenCalledTimes(1);
    expect(onDial.mock.calls[0][0].detail).toEqual({ digits: '1' });
  });
});
