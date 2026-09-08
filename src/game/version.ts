/** `package.json` holds the one version number; vite.config.ts injects it here
 * as `__APP_VERSION__`. The title screen shows major.minor ("Version 0.27"), so a
 * bump in package.json moves the screen too — no second copy to forget. */
export const APP_VERSION = __APP_VERSION__;

// Keep the title stamp explicit so a running dev session shows the release being tested
// immediately; package.json remains 0.281.0, the matching build version.
export const DISPLAY_VERSION = "0.281";
