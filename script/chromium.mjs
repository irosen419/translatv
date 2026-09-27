// Shared Chromium launch options for the browser driving scripts.
//
// Exists because hardcoding one machine's browser path broke CI: a preinstalled Chromium lives
// at a fixed path in the dev container, and pointing Playwright straight at it worked there and
// failed everywhere else with "executable doesn't exist". The path is now a hint, not a
// requirement: use it when it is really there, otherwise let Playwright resolve its own.

import { existsSync } from "node:fs";

/**
 * Where the dev container keeps its preinstalled Chromium.
 *
 * Playwright pins a browser build per release, so a project whose Playwright version does not
 * match the preinstalled build cannot find it by itself. Pointing at this explicitly avoids
 * re-downloading a second copy locally.
 */
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/**
 * Escape hatch for reproducing one environment's browser on another.
 *
 * The e2e passed here for days while failing on CI, because the two were not running the same
 * binary at all: this container has a full Chromium to point at, and a runner without one falls
 * through to whatever Playwright resolves. Being able to say which browser to use is what turns
 * "works on my machine" into a difference someone can actually reproduce.
 */
const OVERRIDE = process.env["CHROMIUM_PATH"] || "";

/** Flags every browser script needs: fake media, and no sandbox for a containerized runner. */
export const CHROMIUM_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--no-sandbox",
  "--autoplay-policy=no-user-gesture-required",
];

/** Resolve the browser binary to use, or "" to let Playwright decide. */
function executable() {
  if (OVERRIDE) return OVERRIDE;
  if (existsSync(PREINSTALLED)) return PREINSTALLED;
  return "";
}

/**
 * Launch options for chromium.launch().
 *
 * `channel: "chromium"` is the load bearing part. A default headless launch resolves
 * chrome-headless-shell, a stripped build, rather than full Chromium. Locally that never showed
 * because executablePath pointed at a full Chromium and quietly overrode the choice; on a runner
 * with no preinstalled browser the shell was used instead, and the run died on the first click
 * with "Target crashed".
 *
 * Bisected rather than guessed, because "Target crashed" reads like a resource problem and is
 * not one. On the shell, enumerateDevices, getUserMedia for audio and for video, and constructing
 * a SpeechRecognition all work. The single call that kills the renderer is the static
 * SpeechRecognition.available(), which the prejoin screen makes to decide whether on device
 * recognition is possible: the shell has no on device speech machinery behind it. It is a hard
 * renderer crash, so the try/catch already wrapping that call cannot save it. Nothing in the app
 * is wrong, and the harness has to stop handing it a browser missing the feature under test.
 *
 * The channel is dropped when an explicit executablePath is given, since Playwright rejects
 * both together and the explicit path is the more specific instruction.
 */
export function chromiumLaunchOptions(extraArgs = []) {
  const options = { args: [...CHROMIUM_ARGS, ...extraArgs] };
  const path = executable();
  if (path) options.executablePath = path;
  else options.channel = "chromium";
  return options;
}

/** For a startup line, so a failure to launch is diagnosable from the log alone. */
export function chromiumSource() {
  if (OVERRIDE) return `CHROMIUM_PATH override at ${OVERRIDE}`;
  if (existsSync(PREINSTALLED)) return `preinstalled at ${PREINSTALLED}`;
  return "Playwright managed, channel=chromium (full build, not the headless shell)";
}
