# @capgo/vite-capacitor
<a href="https://capgo.app/"><img src='https://raw.githubusercontent.com/Cap-go/capgo/main/assets/capgo_banner.png' alt='Capgo - Instant updates for capacitor'/></a>

<div align="center">
  <h2><a href="https://capgo.app/?ref=plugin_vite_capacitor"> ➡️ Get Instant updates for your App with Capgo</a></h2>
  <h2><a href="https://capgo.app/consulting/?ref=plugin_vite_capacitor"> Missing a feature? We’ll build the plugin for you 💪</a></h2>
</div>

Capacitor copies `capacitor.config.json` into each native platform. During development you usually want the dev server URL injected so the native apps talk to Vite. This Vite plugin keeps those files in sync with the dev server lifecycle: when the server starts the URL is written, when it stops the files are restored.

## Install

```bash
npm install @capgo/vite-capacitor --save-dev
```

## Usage

Add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import viteCapacitor from "@capgo/vite-capacitor";

export default defineConfig({
  plugins: [
    viteCapacitor({
      platforms: ["ios", "android"],
    }),
  ],
});
```

Start Vite as usual:

```bash
npm run dev
```

The plugin will:

- detect the dev server URL once Vite is listening (respecting HTTPS and custom host/port),
- write the URL and `cleartext` flag to the native copies at `ios/App/App/capacitor.config.json` and `android/app/src/main/assets/capacitor.config.json` (if they exist),
- skip untouched files that are missing or unchanged,
- restore the original files when Vite shuts down or the process exits.

## Options

```ts
viteCapacitor({
  root?: string; // defaults to Vite's resolved root
  platforms?: Array<"ios" | "android">; // defaults to both
  iosConfigPath?: string; // default: 'ios/App/App/capacitor.config.json'
  androidConfigPath?: string; // default: 'android/app/src/main/assets/capacitor.config.json'
  additionalConfigPaths?: string[]; // extra files to keep in sync
  cleartext?: boolean; // defaults to true
  logLevel?: "silent" | "info" | "debug";
  urlOverride?: string | ((context) => string); // force a specific URL instead of auto-detecting
});
```

The shared `capacitor.config.json` at the project root is never touched. Only files that already exist on disk are modified. If you customise Capacitor's output paths you can point the plugin at your copies via `additionalConfigPaths`.

---

Built with ❤️ by the Capgo team. Need help? [Let’s talk](https://capgo.app/consulting/?ref=plugin).
