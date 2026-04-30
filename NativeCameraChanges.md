# Native Camera Implementation

I added a new command "Take photo natively" and its implementation.

### Changes Made

**1. `src/native-camera.ts` File creation**
Created logic to trigger the mobile OS's native camera or gallery by utilizing an invisible HTML `<input type="file" accept="image/*" multiple capture="environment">`. This gives native access safely within Obsidian. Added a `saveImagesToAttachments` utility which uses Obsidian's `this.app.fileManager.getAvailablePathForAttachment()` to store the captured photos in the vault's attachment folder.

**2. `src/plugin.ts` Modifications**
Registered the `take-photo-natively` command. Set `mobileOnly: true` as requested. The command callback awaits the captured browser `File` objects from `captureNativeCameraImages`, saves them globally, and then routes them directly into the underlying `#sym:importHandwrittenFiles` transcription logic.