import { logger, useIncomingCalls } from '@signalwire/react';
import { displayableName, useRingingPushes } from '@signalwire/react-native/ringing';
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemeContext, useSignalWireTheme } from '../theme/ThemeProvider';
import { useCallOverlayHost } from './CallOverlayHost';
import { ControlButton } from './ControlButton';

import type { Call, MediaOptions } from '@signalwire/js';

export interface IncomingCallSheetProps {
  /**
   * Media to answer with when the answer is NOT routed through the native call
   * UI. Defaults to audio only: an SDP answer cannot introduce an m-line the
   * offer lacks, so answering with video against an audio-only offer fails.
   */
  answerWith?: MediaOptions;
  onAnswered?: (call: Call) => void;
  onRejected?: (call: Call) => void;
  /**
   * Also draw calls that are ringing natively but have no SDK call yet.
   *
   * Defaults to true on Android and false on iOS, which is where the two
   * platforms genuinely differ: CallKit draws its own screen — on the lock
   * screen, over other apps — so a second sheet behind it is confusing.
   * Android's ConnectionService is registered self-managed and draws nothing
   * at all, so without this a pushed call is invisible until it times out.
   *
   * Set it explicitly if you run iOS without native call UI.
   */
  includeNativePushes?: boolean;
  testID?: string;
}

/**
 * The calls in `calls` that are still ringing and that the user has not
 * already answered or declined from this sheet.
 *
 * The SDK's incoming list holds an inbound call until it is destroyed: it is
 * still there once answered, while it is connected, and while it hangs up.
 * `status` is the synchronous truth; each call's `status$` only tells us when
 * to read it again. The SDK moves the status on only after the answer's SDP or
 * the decline's bye completes, so the calls acted on here are hidden at once.
 */
function useRingingCalls(calls: Call[]): {
  ringing: Call[];
  markHandled(call: Call): void;
  unmarkHandled(call: Call): void;
} {
  const [, setVersion] = useState(0);
  const [handled, setHandled] = useState<ReadonlySet<Call>>(() => new Set());

  useEffect(() => {
    const subscriptions = calls.map((call) =>
      call.status$.subscribe(() => setVersion((version) => version + 1))
    );
    return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
  }, [calls]);

  const markHandled = useCallback((call: Call) => {
    setHandled((previous) => new Set(previous).add(call));
  }, []);
  const unmarkHandled = useCallback((call: Call) => {
    setHandled((previous) => {
      const next = new Set(previous);
      next.delete(call);
      return next;
    });
  }, []);

  const ringing = calls.filter((call) => call.status === 'ringing' && !handled.has(call));
  return { ringing, markHandled, unmarkHandled };
}

/**
 * In-app inbound call sheet.
 *
 * With CallKit enabled the native screen usually gets there first; this covers
 * the foreground case and apps running without native call UI. It shows only a
 * call that is still ringing, and goes away as soon as the user answers or
 * declines it, so it is safe to mount permanently, over a call in progress too:
 * a second inbound call then gets the sheet.
 */
export function IncomingCallSheet({
  answerWith = { audio: true, video: false },
  onAnswered,
  onRejected,
  includeNativePushes = Platform.OS === 'android',
  testID
}: IncomingCallSheetProps): React.JSX.Element | null {
  const theme = useSignalWireTheme();
  const { calls, answer, reject } = useIncomingCalls();
  const { ringing: ringingCalls, markHandled, unmarkHandled } = useRingingCalls(calls);
  const { ringing, answer: answerPush, reject: rejectPush } = useRingingPushes();
  const call = ringingCalls[0];
  // The SDK call wins when both exist: they are the same call once it has
  // fused, and the SDK object is the one that can actually be answered.
  const push = call ? undefined : includeNativePushes ? ringing[0] : undefined;

  if (!call && !push) {
    return null;
  }

  // Never the backend's "_undef_" placeholder or a raw Fabric/SIP address.
  const source = call ?? push;
  const callerName =
    displayableName(source?.fromName, 'IncomingCallSheet') ??
    displayableName(source?.from, 'IncomingCallSheet') ??
    'Unknown caller';

  const sheet = (
    <ThemeContext.Provider value={theme}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <SheetBody
          callerName={callerName}
          onDecline={() => {
            if (call) {
              markHandled(call);
              void reject(call).then(() => onRejected?.(call));
            } else if (push) {
              rejectPush(push.uuid);
            }
          }}
          onAnswer={() => {
            if (call) {
              markHandled(call);
              answer(call, answerWith).then(
                () => onAnswered?.(call),
                (error: unknown) => {
                  // Offer it again if it is still ringing.
                  logger.warn('Answering the incoming call failed:', error);
                  unmarkHandled(call);
                }
              );
            } else if (push) {
              // The same intent a native answer applies, so both paths
              // converge and whatever places the call picks it up.
              answerPush(push.uuid);
            }
          }}
        />
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );

  return <SheetPlacement sheet={sheet} testID={testID} />;
}

/**
 * Draws the sheet in the mounted {@link CallOverlayHost}, or in a `Modal`
 * when there is none. A Modal is a window of its own, drawn edge to edge on
 * Android 15 and later, so the app's SafeAreaProvider does not reach it: the
 * sheet brings its own, in both places.
 */
function SheetPlacement({
  sheet,
  testID
}: {
  sheet: React.ReactNode;
  testID?: string;
}): React.JSX.Element | null {
  const host = useCallOverlayHost();

  useEffect(() => {
    if (!host) {
      return;
    }
    host.setContent(
      <View style={StyleSheet.absoluteFill} testID={testID}>
        {sheet}
      </View>
    );
  });
  useEffect(() => {
    if (!host) {
      return;
    }
    return () => host.setContent(null);
  }, [host]);

  if (host) {
    return null;
  }
  return (
    <Modal transparent animationType="slide" visible testID={testID}>
      {sheet}
    </Modal>
  );
}

function SheetBody({
  callerName,
  onAnswer,
  onDecline
}: {
  callerName: string;
  onAnswer: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  const theme = useSignalWireTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.backdrop, { backgroundColor: theme.colors.scrim }]}>
      <View
        testID="sw-incoming-sheet"
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.background,
            borderTopLeftRadius: theme.radii.md * 2,
            borderTopRightRadius: theme.radii.md * 2,
            gap: theme.spacing.sm,
            padding: theme.spacing.xl,
            // Clear the home indicator and Android's navigation bar.
            paddingBottom: theme.spacing.xl + insets.bottom
          }
        ]}
      >
        <Text style={{ color: theme.colors.textMuted, fontSize: theme.typography.label }}>
          Incoming call
        </Text>
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.text, fontSize: theme.typography.title, fontWeight: '700' }}
        >
          {callerName}
        </Text>

        <View style={[styles.actions, { gap: theme.spacing.md, marginTop: theme.spacing.lg }]}>
          <ControlButton
            testID="sw-decline"
            label="Decline"
            variant="danger"
            style={styles.action}
            onPress={onDecline}
          />
          <ControlButton
            testID="sw-answer"
            label="Answer"
            variant="accent"
            style={styles.action}
            onPress={onAnswer}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {},
  actions: { flexDirection: 'row' },
  action: { flex: 1 }
});
