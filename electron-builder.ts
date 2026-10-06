// How `npm run dist:mac` packs the Mac app: a .dmg and a .zip for Apple
// silicon and for Intel, in release/.
//
// The app is the folder `scripts/build-desktop.mjs` writes, dist-electron/: the
// bundled main process, the built dashboard and a package.json of its own.
// Everything the main process needs is in its bundle, so no node_modules folder
// is packed.
//
// The first releases are not signed with a Developer ID, since there is none
// yet. The app is still signed ad hoc, as Apple silicon requires of every app
// before it runs, and so without the hardened runtime, which an ad hoc
// signature cannot carry with Electron's own frameworks. Nothing is notarized
// and nothing is published from here.

import type { Configuration } from "electron-builder";

const config: Configuration = {
  appId: "dev.agentlookout.app",
  productName: "Agent Lookout",
  copyright: "Copyright © 2026 Idris Olubisi",
  directories: {
    app: "dist-electron",
    output: "release",
    // Holds icon.png, which electron-builder turns into the app's .icns.
    buildResources: "build",
  },
  asar: true,
  // The dashboard is in English only, so Electron's other languages are left out.
  electronLanguages: ["en"],
  // Resolving to false tells electron-builder that node_modules is taken care
  // of elsewhere: the bundle holds every library, so none is installed, rebuilt or packed.
  beforeBuild: async () => false,
  // Switches in the Electron binary that turn off what the app never uses,
  // so no one can run its code another way: as a plain Node process, with
  // NODE_OPTIONS or with a debugger, or from anything but its checked archive.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.developer-tools",
    icon: "build/icon.png",
    darkModeSupport: true,
    // "-" signs ad hoc. Without it, and with no certificate, nothing is signed.
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    artifactName: "Agent-Lookout-${version}-mac-${arch}.${ext}",
    // Jump brings a Terminal or iTerm2 tab forward with osascript, which macOS
    // counts as the app itself asking, and asks the person about in these words.
    extendInfo: {
      NSAppleEventsUsageDescription:
        "Jump brings forward the Terminal or iTerm2 tab a session runs in.",
    },
  },
  dmg: {
    title: "Agent Lookout ${version}",
  },
  // A provider, so electron-builder writes latest-mac.yml beside the zips and
  // disk images: each file's name, size and SHA-512, which the app checks what
  // it downloads against. "generic" is the one provider electron-builder never
  // uploads to, whatever --publish says, so nothing is published from here.
  // The release workflow attaches the files to the GitHub release itself. The
  // address only goes into the app's app-update.yml, which nothing in it reads.
  publish: {
    provider: "generic",
    url: "https://github.com/Olanetsoft/agent-lookout/releases/latest/download",
  },
};

export default config;
