# Desktop and mobile app capture

Use this for native or hybrid apps: Electron, Tauri, VS Code extension UI outside the terminal, iOS, Android, installers.

## Tools

| Platform | Capture |
|----------|---------|
| macOS | `screencapture` video, QuickTime, `ffmpeg` avfoundation |
| Windows | Xbox Game Bar, OBS, `ffmpeg` dshow/gdigrab |
| Linux | OBS, `ffmpeg` x11grab/PipeWire |
| iOS Simulator | `xcrun simctl io booted recordVideo` |
| Android Emulator | `adb shell screenrecord` or Android Studio |
| VS Code / Electron | Extension host plus OS recorder, or Playwright Electron |

## Recording

1. Install or build the exact version you advertise.
2. Prefer a clean profile or guest user.
3. Fix resolution and color profile. Kill OS notifications.
4. Keep app chrome visible: title bar, menus, tab strip, or mobile status/nav when that identifies the product.
5. Mark beats with an on-screen slate, voice timestamps, or a sidecar `{t, id, label}` from the driver.
6. Show success inside the app. A Finder/Explorer file is secondary proof only.

## Automation

- Drive the app through real IPC or CLI when you can, then record what appears.
- For store demos, script the happy path. Shoot a recovery take only if someone asked for it.
- If you later stitch webcam and app, sync clocks. Default is app-only.

## Mobile

- Simulator/emulator for CI-friendly takes. Device recording when camera or real performance matters.
- One orientation. No mid-scene rotate.
- Put the app name in the first frame (splash or nav title).

## Bad take

- Figma or mockups labeled as the shipped app
- Title bar cropped so Electron looks like any Chromium shell
- Permission dialogs and notification spam left in
- Huge idle with no state change
