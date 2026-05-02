# Native Camera Implementation

I added a new command "Take photo natively" and its implementation.

### Changes Made

**1. `src/native-camera.ts` File creation**
Created logic to trigger the mobile OS's native camera or gallery by utilizing an invisible HTML `<input type="file" accept="image/*" multiple capture="environment">`. This gives native access safely within Obsidian. Added a `saveImagesToAttachments` utility which uses Obsidian's `this.app.fileManager.getAvailablePathForAttachment()` to store the captured photos in the vault's attachment folder.

**2. `src/plugin.ts` Modifications**
Registered the `take-photo-natively` command. Set `mobileOnly: true` as requested. The command callback awaits the captured browser `File` objects from `captureNativeCameraImages`, saves them globally, and then routes them directly into the underlying `#sym:importHandwrittenFiles` transcription logic.

**3. Added NativeCameraModal to `src/native-camera.ts`**
Created an interactive UI modal `NativeCameraModal` that tracks in-memory captured files. It allows the user to repeatedly invoke the native camera ('Take photo'), accumulating the photos. 'Cancel' clears memory and closes the modal, while 'Upload' passes the array of images natively to the vault and to `importHandwrittenFiles()`.

**4. Updated `src/plugin.ts` callback**
Changed the `take-photo-natively` command to simply trigger `new NativeCameraModal(this.app, this).open();`.

**5. Removed deprecated Camera plugin integration**
Deleted `src/camera.ts` and removed unused `captureWithCameraPluginAndImport` and `hasCameraPluginInstalled` methods from `src/plugin.ts`. Updated `src/import-modal.ts` to open the new `NativeCameraModal` directly, replacing the old external plugin dependency entirely. Renamed command to `capture-by-camera`.

**6. Fixed iOS file selection freezing bug**
Fixed a bug in `src/native-camera.ts` where `document.body.removeChild(input)` was running synchronously immediately after `input.click()`. Mobile WebKit instances destroy the pending file picker if its DOM element is removed early, preventing `onchange` from firing and leaving the modal's Promise unresolved indefinitely (causing the infinite spinner). Moved `input.remove()` to the async callback handlers and added a fallback `window.addEventListener('focus')` hook for reliable cancellation.
