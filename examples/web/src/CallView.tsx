import { useCall } from '@signalwire/react';
import React, { useEffect, useRef } from 'react';

import type { Call } from '@signalwire/js';

const TERMINAL = new Set(['disconnected', 'destroyed', 'failed']);

/**
 * The web counterpart of SignalWireVideoView: a plain <video> fed from the
 * SDK's stream. This lives in the example rather than the package because
 * video components arrive with the phase 2 UI kit.
 */
function useStreamElement(stream: MediaStream | null): React.RefObject<HTMLVideoElement | null> {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    element.srcObject = stream;
    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  return ref;
}

export function CallView({ call, onEnded }: { call: Call; onEnded: () => void }): React.JSX.Element {
  const { status, localStream, remoteStream, isAudioMuted, setAudioMuted, hangup, error } =
    useCall(call);

  const remoteRef = useStreamElement(remoteStream);
  const localRef = useStreamElement(localStream);

  useEffect(() => {
    if (TERMINAL.has(status)) {
      onEnded();
    }
  }, [status, onEnded]);

  return (
    <main className="call">
      <video ref={remoteRef} autoPlay playsInline className="remote" />
      <video ref={localRef} autoPlay playsInline muted className="local" />

      <div className="controls">
        <span className="status">{error ? `${error.kind} error` : status}</span>
        <button onClick={() => void setAudioMuted(!isAudioMuted)}>
          {isAudioMuted ? 'Unmute' : 'Mute'}
        </button>
        <button className="danger" onClick={() => void hangup()}>
          End
        </button>
      </div>
    </main>
  );
}
