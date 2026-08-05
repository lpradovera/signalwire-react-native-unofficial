import { createComponent } from '@lit/react';
import React from 'react';

import type { EventName } from '@lit/react';

/**
 * Thin, consistent wrapper around `@lit/react`'s `createComponent`.
 *
 * A wrapper is still the right call on React 19. React 19 can set custom
 * element properties, but `createComponent` additionally gives typed props from
 * the element class, maps `CustomEvent`s to `on*` props, and keeps imports
 * discoverable to editors and unused-import lint rules.
 */
export function createSwComponent<
  Element extends HTMLElement,
  Events extends Record<string, EventName | string>
>(options: {
  tagName: string;
  elementClass: { new (): Element; prototype: Element };
  events: Events;
}): ReturnType<typeof createComponent<Element, Events>> {
  return createComponent({
    react: React,
    tagName: options.tagName,
    elementClass: options.elementClass,
    events: options.events
  });
}
