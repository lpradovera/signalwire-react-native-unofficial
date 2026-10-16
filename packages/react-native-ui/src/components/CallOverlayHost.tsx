import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Where call UI (the incoming-call sheet) draws when a host is mounted.
 *
 * Hosts stack: the one mounted last is used, so a host inside an app's own
 * Modal takes over while that Modal is open, and the root host gets the
 * sheet back when it closes. Module state rather than context, because a
 * Modal's content is still the same React tree but a sheet inside one screen
 * must reach a host it is not a parent of.
 */
interface Host {
  readonly setContent: (content: React.ReactNode) => void;
}

const hosts: Host[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function topHost(): Host | undefined {
  return hosts[hosts.length - 1];
}

/** The host call UI should render into, if any is mounted. */
export function useCallOverlayHost(): Host | undefined {
  return useSyncExternalStore(subscribe, topHost, topHost);
}

export interface CallOverlayHostProps {
  testID?: string;
}

/**
 * Optional root overlay for call UI.
 *
 * Mount it once, as the last child of your app's root view (inside your
 * providers). `IncomingCallSheet` then draws here, over the app, instead of
 * in a `Modal`: no second native window, so no clash with a Modal the app
 * already has open on iOS, and nothing drawn edge to edge behind Android's
 * navigation bar. To draw over one of your own Modals, mount another host
 * inside it; the latest-mounted host is used. Without any host the sheet
 * falls back to a `Modal`.
 */
export function CallOverlayHost({ testID = 'sw-call-overlay' }: CallOverlayHostProps): React.JSX.Element {
  const [content, setContent] = useState<React.ReactNode>(null);

  useEffect(() => {
    const host: Host = { setContent };
    hosts.push(host);
    notify();
    return () => {
      const index = hosts.indexOf(host);
      if (index >= 0) {
        hosts.splice(index, 1);
      }
      notify();
    };
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID={testID}>
      {content}
    </View>
  );
}
