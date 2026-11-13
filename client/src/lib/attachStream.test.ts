import { describe, expect, it, vi } from "vitest";

import { attachStream } from "./attachStream.js";

function video(paused: boolean) {
  return { srcObject: null as unknown, paused, play: vi.fn(() => Promise.resolve()) };
}

describe("attachStream", () => {
  it("sets the stream on an element that has none, and plays it", () => {
    const el = video(true);
    const stream = {} as MediaStream;
    attachStream(el as unknown as HTMLVideoElement, stream);
    expect(el.srcObject).toBe(stream);
    expect(el.play).toHaveBeenCalledOnce();
  });

  it("leaves a playing element on the same stream alone", () => {
    const stream = {} as MediaStream;
    const el = { ...video(false), srcObject: stream };
    attachStream(el as unknown as HTMLVideoElement, stream);
    expect(el.play).not.toHaveBeenCalled();
  });

  it("does nothing without an element or a stream", () => {
    expect(() => attachStream(null, {} as MediaStream)).not.toThrow();
    const el = video(true);
    attachStream(el as unknown as HTMLVideoElement, null);
    expect(el.srcObject).toBeNull();
  });
});
