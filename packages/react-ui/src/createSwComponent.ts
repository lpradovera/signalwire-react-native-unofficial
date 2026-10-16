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
 *
 * `eventOrigins` names, per event prop, the element whose dispatch counts.
 * The elements' events bubble and are composed, so an inner element's event
 * reaches the host too: one hang-up click delivers `sw-call-hangup` from
 * `<sw-ui-control-bar>` and again from `<sw-call-controls>`, which
 * re-dispatches it. Such a prop runs only for events first dispatched by that
 * element.
 */
export function createSwComponent<
  Element extends HTMLElement,
  Events extends Record<string, EventName | string>
>(options: {
  tagName: string;
  elementClass: { new (): Element; prototype: Element };
  events: Events;
  eventOrigins?: Partial<Record<keyof Events, string>>;
}): ReturnType<typeof createComponent<Element, Events>> {
  const Component = createComponent({
    react: React,
    tagName: options.tagName,
    elementClass: options.elementClass,
    events: options.events
  });
  const origins = Object.entries(options.eventOrigins ?? {}) as [string, string][];
  if (origins.length === 0) {
    return Component;
  }

  const Filtered = React.forwardRef<Element, Record<string, unknown>>(
    function Filtered(props, ref) {
      // Handlers are read at dispatch time, so the listeners stay the same
      // across renders.
      const latest = React.useRef(props);
      latest.current = props;
      const filtered = React.useMemo(
        () =>
          Object.fromEntries(
            origins.map(([prop, tag]) => [
              prop,
              (event: Event) => {
                const origin = event.composedPath()[0];
                const handler = latest.current[prop];
                if (
                  origin instanceof HTMLElement &&
                  origin.localName === tag &&
                  typeof handler === 'function'
                ) {
                  handler(event);
                }
              }
            ])
          ),
        []
      );
      const passed: Record<string, unknown> = { ...props, ref };
      for (const [prop] of origins) {
        passed[prop] = props[prop] === undefined ? undefined : filtered[prop];
      }
      return React.createElement(Component as React.ElementType, passed);
    }
  );
  Filtered.displayName = options.tagName;
  return Filtered as unknown as ReturnType<typeof createComponent<Element, Events>>;
}
