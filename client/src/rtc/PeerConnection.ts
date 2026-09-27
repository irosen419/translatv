// WebRTC via perfect negotiation.
//
// Perfect negotiation is the pattern that makes renegotiation safe when both sides can start
// one. The roles come from the server (the room creator is impolite) rather than being decided
// locally, because two peers that both think they are polite deadlock, and two that both think
// they are impolite glare at each other on every collision.
//
// The impolite peer wins a collision: it ignores an incoming offer that arrives while it has
// one outstanding. The polite peer rolls back and accepts. Exactly one side must do each.

export interface PeerCallbacks {
  onSignal(message: { kind: "offer" | "answer" | "ice"; payload: unknown }): void;
  onRemoteStream(stream: MediaStream): void;
  onStateChange(state: PeerState): void;
}

export type PeerState =
  | "new"
  | "connecting"
  | "connected"
  /** Transient. Often self heals, so the UI should not shout about it immediately. */
  | "interrupted"
  /** Recovery is being attempted via ICE restart. */
  | "recovering"
  /** Media is not coming back without a TURN relay. Text still works. */
  | "failed";

/** How long a disconnected state is tolerated before treating it as a real failure. */
const DISCONNECT_GRACE_MS = 3_000;
/** ICE restarts attempted before declaring media dead. */
const MAX_ICE_RESTARTS = 3;

export class PeerConnection {
  private pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private iceRestarts = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly remoteStream = new MediaStream();

  constructor(
    private readonly polite: boolean,
    iceServers: RTCIceServer[],
    private readonly callbacks: PeerCallbacks,
  ) {
    this.pc = this.build(iceServers);
  }

  private build(iceServers: RTCIceServer[]): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers });

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.callbacks.onSignal({ kind: "offer", payload: pc.localDescription.sdp });
        }
      } catch {
        // A failed negotiation is recoverable: the next track change or ICE restart triggers
        // another attempt.
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.callbacks.onSignal({ kind: "ice", payload: candidate.toJSON() });
    };

    pc.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      // A NEW MediaStream each time, not the accumulator itself.
      //
      // Tracks arrive one per event, so audio lands before video. React compares by reference,
      // so handing back the same mutated object on the second event is a no-op: the render that
      // would notice the video track never happens, and the peer stays behind a "joined without
      // a camera" placeholder while their video sits in a stream nothing re-read. It corrects
      // itself only if some unrelated state change happens to force a render, which makes it
      // look intermittent rather than broken.
      this.callbacks.onRemoteStream(new MediaStream(this.remoteStream.getTracks()));
    };

    pc.oniceconnectionstatechange = () => this.onIceStateChange();
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.iceRestarts = 0;
        this.clearDisconnectTimer();
        this.callbacks.onStateChange("connected");
      } else if (pc.connectionState === "connecting") {
        this.callbacks.onStateChange("connecting");
      }
    };

    return pc;
  }

  private onIceStateChange(): void {
    const state = this.pc.iceConnectionState;

    if (state === "disconnected") {
      // Do NOT react immediately. A brief disconnect is usually a network blip that heals on
      // its own, and tearing down a working call to "fix" it makes things worse.
      this.callbacks.onStateChange("interrupted");
      this.clearDisconnectTimer();
      this.disconnectTimer = setTimeout(() => this.attemptRecovery(), DISCONNECT_GRACE_MS);
      return;
    }

    if (state === "failed") {
      this.clearDisconnectTimer();
      this.attemptRecovery();
      return;
    }

    if (state === "connected" || state === "completed") {
      this.clearDisconnectTimer();
      this.iceRestarts = 0;
      this.callbacks.onStateChange("connected");
    }
  }

  private attemptRecovery(): void {
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      // Out of options. This is almost always symmetric NAT or a corporate firewall with no
      // TURN relay configured. The call degrades to text, which still works, rather than the
      // whole app appearing broken.
      this.callbacks.onStateChange("failed");
      return;
    }

    // Only the impolite peer restarts ICE. Both restarting produces duelling offers and can
    // take longer to converge than one side doing it.
    if (!this.polite) {
      this.iceRestarts += 1;
      this.callbacks.onStateChange("recovering");
      this.pc.restartIce();
    }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
  }

  /**
   * Add a track the connection did not start with, for turning a camera on mid call.
   *
   * replaceVideoTrack cannot serve this: it looks for an EXISTING video sender, and an audio
   * only join never created one. addTrack fires negotiationneeded, which the perfect negotiation
   * setup above already handles like any other renegotiation.
   */
  addVideoTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.pc.addTrack(track, stream);
  }

  /** Replace the outgoing video track without renegotiating, for a camera toggle. */
  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }

  async handleOffer(sdp: string): Promise<void> {
    const description = { type: "offer" as const, sdp };
    const collision = this.makingOffer || this.pc.signalingState !== "stable";

    // The impolite peer ignores a colliding offer; the polite peer yields. Exactly one side
    // must do each, or they either deadlock or both back off forever.
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;

    await this.pc.setRemoteDescription(description);
    await this.pc.setLocalDescription();
    if (this.pc.localDescription) {
      this.callbacks.onSignal({ kind: "answer", payload: this.pc.localDescription.sdp });
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (this.pc.signalingState !== "have-local-offer") return;
    await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  async handleIce(candidate: unknown): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate as RTCIceCandidateInit);
    } catch (error) {
      // A candidate arriving for an offer we deliberately ignored is expected, not a bug.
      if (!this.ignoreOffer) throw error;
    }
  }

  /** Connection quality, for the status indicator. */
  async stats(): Promise<{ rtt: number | null; packetsLost: number }> {
    let rtt: number | null = null;
    let packetsLost = 0;
    const report = await this.pc.getStats();
    report.forEach((entry) => {
      if (entry.type === "candidate-pair" && entry.state === "succeeded") {
        rtt = typeof entry.currentRoundTripTime === "number" ? entry.currentRoundTripTime : rtt;
      }
      if (entry.type === "inbound-rtp" && typeof entry.packetsLost === "number") {
        packetsLost += entry.packetsLost;
      }
    });
    return { rtt, packetsLost };
  }

  close(): void {
    this.clearDisconnectTimer();
    this.pc.getSenders().forEach((sender) => sender.track?.stop());
    this.pc.close();
  }
}
