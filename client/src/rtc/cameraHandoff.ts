// Taking a freshly acquired camera track into a call that may no longer be there.
//
// This is its own module, and not a few lines inside the click handler, for one reason: the
// window it guards is opened by an await on a PERMISSION PROMPT, which a person can leave open
// for as long as they like. Everything the call owns can be torn down underneath it. That is not
// a case a component test would reach anyway, so the decision lives somewhere a unit test can.

import type { Phase } from "../state/store.js";

/** The state of the call at the moment the camera finished being acquired. */
export interface CallSnapshot {
  phase: Phase;
  /**
   * The stream the call is sending right now, or null once teardown has run.
   *
   * Checked in ADDITION to the phase because the two do not move together. Ending a chat tears
   * the local media down immediately and only reaches the "ended" phase when room.ended comes
   * back from the server, so for that gap the phase alone still says we are live.
   */
  stream: MediaStream | null;
}

/**
 * Hand a newly acquired camera track to the call it was acquired for.
 *
 * Returns the stream the track now belongs to, or null when there is no call left to give it to.
 * On null the track has ALREADY BEEN STOPPED, because nothing else holds it: the caller dropped
 * its reference at the await, teardown stops only the tracks it knew about, and a video track
 * nobody stops keeps the camera hardware light on for the life of the tab.
 *
 * On success the track goes into the EXISTING stream rather than a fresh one. The audio sender
 * was added with that stream, so reusing it keeps both senders under a single msid and the peer
 * sees one person with two tracks rather than two separate streams. Note that this returns the
 * same object it was given: the identity does not change, so a React state update alone will not
 * repaint. The self view re-renders off the hasVideo flag the caller sets, which is exactly what
 * that flag being in the effect's dependencies is for.
 */
export function adoptCameraTrack(
  track: MediaStreamTrack,
  call: CallSnapshot,
): MediaStream | null {
  if (call.phase !== "room" || !call.stream) {
    track.stop();
    return null;
  }

  call.stream.addTrack(track);
  return call.stream;
}

/**
 * Take any ENDED camera track out of the call's stream. True when one was removed.
 *
 * A track ends when the camera goes away underneath the call: another app takes it, it is
 * unplugged, the OS revokes it. The track stays in the stream, so the self view went black under
 * a button that still said the camera was on, and turning it on again did nothing, because
 * turnOnCamera refuses while the stream already holds a video track. Removing it puts the call
 * back in the "no camera" state the button knows how to leave.
 */
export function dropEndedCamera(stream: MediaStream): boolean {
  const ended = stream.getVideoTracks().filter((track) => track.readyState === "ended");
  for (const track of ended) stream.removeTrack(track);
  return ended.length > 0;
}
