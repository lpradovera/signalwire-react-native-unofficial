import { getCallHoldState, useSignalWire } from '@signalwire/react-native';
import { useEffect } from 'react';

import type { Call } from '@signalwire/js';

/**
 * Dev only: `EXPO_PUBLIC_SW_DEV_STATS=1` logs, every 2 s, each call's status,
 * hold state and RTP counters (inbound-rtp packetsReceived, outbound-rtp
 * packetsSent, audio), and each SDK recovery event, as `[DEVSTATS]` lines.
 * Used to check that a held call carries no media and a resumed one does.
 */
const ENABLED = process.env.EXPO_PUBLIC_SW_DEV_STATS === '1';

/** Each sender's track kind and whether it sends (`paused` while held). */
function sendersOf(call: Call): string {
  try {
    const pc = call.rtcPeerConnection as unknown as {
      getSenders?: () => Array<{ track: { kind: string } | null; getParameters(): { encodings?: Array<{ active?: boolean }> } }>;
    };
    return (pc?.getSenders?.() ?? [])
      .map((sender) => `${sender.track?.kind ?? 'none'}:${sender.getParameters().encodings?.[0]?.active === false ? 'paused' : 'on'}`)
      .join(',');
  } catch {
    return '?';
  }
}

async function rtpOf(call: Call): Promise<{ received: number; sent: number } | null> {
  const pc = call.rtcPeerConnection;
  if (!pc) {
    return null;
  }
  const report = await pc.getStats();
  let received = 0;
  let sent = 0;
  report.forEach((stat: { type?: string; kind?: string; mediaType?: string; packetsReceived?: number; packetsSent?: number }) => {
    const audio = (stat.kind ?? stat.mediaType) === 'audio';
    if (stat.type === 'inbound-rtp' && audio) {
      received += stat.packetsReceived ?? 0;
    } else if (stat.type === 'outbound-rtp' && audio) {
      sent += stat.packetsSent ?? 0;
    }
  });
  return { received, sent };
}

export function useDevStats(): void {
  const { client } = useSignalWire();

  useEffect(() => {
    if (!ENABLED || !client) {
      return undefined;
    }
    const watched = new Set<Call>();
    const subscriptions: Array<{ unsubscribe(): void }> = [];
    const timer = setInterval(() => {
      const calls = client.session?.calls ?? [];
      for (const call of calls) {
        if (!watched.has(call)) {
          watched.add(call);
          try {
            subscriptions.push(
              call.recoveryEvent$.subscribe((event) =>
                console.log(`[DEVSTATS] call=${call.id} recovery ${event.action} ${event.reason ?? ''}`)
              )
            );
          } catch {
            // A destroyed call's getters throw.
          }
        }
        let status = 'gone';
        try {
          status = call.status;
        } catch {
          // destroyed
        }
        const held = getCallHoldState().isHeld(call);
        void rtpOf(call)
          .then((rtp) =>
            console.log(
              `[DEVSTATS] call=${call.id} dir=${call.direction} status=${status} held=${held} ` +
                `in=${rtp?.received ?? '-'} out=${rtp?.sent ?? '-'} senders=${sendersOf(call)}`
            )
          )
          .catch(() => console.log(`[DEVSTATS] call=${call.id} status=${status} held=${held} stats-failed`));
      }
    }, 2000);
    return () => {
      clearInterval(timer);
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    };
  }, [client]);
}
