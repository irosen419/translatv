// Point a <video> at a stream, and make sure it is actually playing.
//
// Two ways a self view or peer view went black with nothing wrong in the stream: the element was
// remounted and nobody set srcObject on the new one, and the element was left paused (a browser
// can pause a video whose source was swapped, or one that was offscreen). Called from a callback
// ref, so EVERY element that mounts gets the stream, and from the effects that follow the stream.

export function attachStream(video: HTMLVideoElement | null, stream: MediaStream | null): void {
  if (!video || !stream) return;
  if (video.srcObject !== stream) video.srcObject = stream;
  if (video.paused) {
    // Autoplay of a muted or already permitted stream does not reject in practice. If it ever
    // does, the next attach tries again; there is nothing better to do with the error here.
    void video.play()?.catch(() => {});
  }
}
