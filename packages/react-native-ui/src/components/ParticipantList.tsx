import { useCall, useObservable } from '@signalwire/react';
import React, { useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';

import type { Call, CallParticipant } from '@signalwire/js';
import type { StyleProp, ViewStyle } from 'react-native';

export interface ParticipantListProps {
  call: Call | null | undefined;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The other participants, with live talking and mute state. The SDK's list
 * includes the local user (`call.self`), who is left out here.
 *
 * Talking state comes from the SDK's `isTalking$`, not from audio analysis —
 * React Native has no `AudioContext`, so metering locally is not an option.
 */
export function ParticipantList({
  call,
  style,
  testID
}: ParticipantListProps): React.JSX.Element {
  const theme = useSignalWireTheme();
  const { participants: everyone, self } = useCall(call);
  const participants = useMemo(
    () => (self ? everyone.filter((participant) => participant.id !== self.id) : everyone),
    [everyone, self]
  );

  return (
    <FlatList
      testID={testID}
      style={style}
      data={participants}
      keyExtractor={(participant) => participant.id}
      ListEmptyComponent={
        <Text style={{ color: theme.colors.textMuted, padding: theme.spacing.lg }}>
          No one else is here yet.
        </Text>
      }
      renderItem={({ item }) => <ParticipantRow participant={item} />}
    />
  );
}

function ParticipantRow({ participant }: { participant: CallParticipant }): React.JSX.Element {
  const theme = useSignalWireTheme();
  const name = useObservable(participant.name$, participant.name);
  const audioMuted = useObservable(participant.audioMuted$, participant.audioMuted);
  const isTalking = useObservable(participant.isTalking$, participant.isTalking);

  const label = name ?? 'Participant';
  const state = audioMuted ? 'muted' : isTalking ? 'talking' : 'listening';

  return (
    <View
      testID={`sw-participant-${participant.id}`}
      // One element, so VoiceOver reads the composed label (the talking
      // state lives only there) rather than each Text in turn.
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${label}, ${state}`}
      style={[
        styles.row,
        { borderBottomColor: theme.colors.border, padding: theme.spacing.md }
      ]}
    >
      <View
        style={[
          styles.indicator,
          { backgroundColor: isTalking && !audioMuted ? theme.colors.success : 'transparent' }
        ]}
      />
      <Text style={{ color: theme.colors.text, flex: 1, fontSize: theme.typography.body }}>
        {label}
      </Text>
      {audioMuted ? (
        <Text style={{ color: theme.colors.textMuted, fontSize: theme.typography.label }}>
          Muted
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10 },
  indicator: { borderRadius: 5, height: 10, width: 10 }
});
