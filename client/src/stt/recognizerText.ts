// Speech results only. Some recognizers leak their own sentence markers into the text they hand
// back: Chrome's cloud path produced "Scooby-Doo </S>" in an owner test (2026-11-13), which then
// sat in the transcript and went to the translator. Only these exact tokens are removed, so a
// person who SAYS something with angle brackets in it is untouched. Typed chat never comes
// through here: someone who types "</s>" meant it.

const MARKER = /<\/?(?:s|unk|eos|sil)>/gi;

export function cleanRecognizerText(text: string): string {
  return text.replace(MARKER, " ").replace(/\s+/g, " ").trim();
}
