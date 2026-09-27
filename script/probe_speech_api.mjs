// Probe what THIS chromium can tell us about the Web Speech API surface.
// Serves over http://localhost, which IS a secure context, so navigator.mediaDevices exists.
import { createServer } from "node:http";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./chromium.mjs";

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><meta charset=utf-8><title>probe</title><p>probe</p>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch(chromiumLaunchOptions());
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();
page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text()}`));
await page.goto(`http://127.0.0.1:${port}/`);

const result = await page.evaluate(async () => {
  const out = {};
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  out.isSecureContext = window.isSecureContext;
  out.hasMediaDevices = Boolean(navigator.mediaDevices);
  out.speechRecognitionPresent = Boolean(SR);
  if (!SR || !navigator.mediaDevices) return out;

  out.chromeVersion = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null;

  let track = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    track = stream.getAudioTracks()[0];
    out.trackState = `${track.kind}/${track.readyState}`;
    out.appliedSettings = track.getSettings ? track.getSettings() : null;
  } catch (e) {
    out.gumError = `${e.name}: ${e.message}`;
    return out;
  }

  // Can recognition coexist with a live RTCPeerConnection carrying that track?
  try {
    const pc = new RTCPeerConnection();
    pc.addTrack(track, new MediaStream([track]));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    out.peerConnectionOk = true;
  } catch (e) {
    out.peerConnectionOk = `${e.name}: ${e.message}`;
  }

  // THE QUESTION. A TypeError means the parameter is not in the signature at all.
  // Anything else means Blink accepts a MediaStreamTrack argument.
  const r2 = new SR();
  r2.continuous = true;
  try {
    r2.start(track);
    out.startWithTrack = "ACCEPTED (no throw)";
  } catch (e) {
    out.startWithTrack = `THREW ${e.name}: ${e.message}`;
    out.startWithTrackIsTypeError = e.name === "TypeError";
  }
  try { r2.abort(); } catch { /* ignore */ }

  // Control: an obviously wrong argument type. If start() ignored its arguments entirely,
  // this would also "succeed", which would make the test above meaningless.
  const r3 = new SR();
  try {
    r3.start({ not: "a track" });
    out.startWithGarbage = "ACCEPTED (start ignores its argument: the test above proves nothing)";
  } catch (e) {
    out.startWithGarbage = `THREW ${e.name}: ${e.message}`;
    out.startWithGarbageIsTypeError = e.name === "TypeError";
  }
  try { r3.abort(); } catch { /* ignore */ }

  // On device availability for the MVP languages.
  try {
    out.availableEnUs = await SR.available({ langs: ["en-US"], processLocally: true });
    out.availableEsAr = await SR.available({ langs: ["es-AR"], processLocally: true });
  } catch (e) {
    out.availableError = `${e.name}: ${e.message}`;
  }

  // Does recognition actually produce anything in a keyless Chromium build?
  out.recognitionEvents = await new Promise((resolve) => {
    const events = [];
    const r4 = new SR();
    r4.continuous = true;
    r4.interimResults = true;
    r4.onstart = () => events.push("start");
    r4.onerror = (e) => events.push(`error:${e.error}`);
    r4.onend = () => events.push("end");
    r4.onresult = () => events.push("result");
    try { r4.start(); } catch (e) { events.push(`startThrew:${e.name}`); }
    setTimeout(() => { try { r4.abort(); } catch { /* ignore */ } resolve(events); }, 5000);
  });

  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
