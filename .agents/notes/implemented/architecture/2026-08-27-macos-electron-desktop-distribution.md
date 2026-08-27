# Agent Note: macOS Electron desktop distribution

Status: implemented

English | [中文](2026-08-27-macos-electron-desktop-distribution.zh.md)

## Problem

DSH needs an installable macOS client that retains the Web product's UI and client-plugin behavior, starts the complete local Host without a terminal, and can receive signed updates. The existing browser composition binds client bundle discovery, HTML boot injection, Typert Remote calls, unary API calls, and two downlink streams to `dsh-host-webserver`; replacing every carrier before the first desktop package would make installer delivery depend on a second protocol implementation.

The npm release family treats application packages as public version-locked artifacts, while a DMG application needs its own version, signing credentials, notarization, architecture outputs, and GitHub update metadata.

## Decision

`apps/desktop` is a private pnpm workspace application outside the npm DSH release family. It has an independent version and a `desktop-v*` GitHub Release workflow. The repository still treats it as an official runtime, so the ordinary prohibition on experimental runtime dependencies applies.

The Electron main process owns one `dsh web` child on `127.0.0.1:43121`. It starts the built CLI through the Electron executable in Node mode, accepts readiness only from that child's exact URL announcement, and then loads the URL in a `BrowserWindow`. The fixed origin preserves localStorage-backed drafts and appearance state. A listener already using the port is an explicit startup failure; the application never probes and adopts an existing server.

Loopback reachability is not the desktop authorization boundary. The main process creates a new 256-bit capability on every launch and gives it only to the backend bootstrap and Electron session. It crosses the process boundary through a private one-shot pipe, not argv, environment variables, or disk. A desktop-only Cordis overlay configures the Connection Host to require that capability on every owned HTTP route and WebSocket upgrade. Electron's request layer replaces any renderer-supplied spelling with the trusted value on requests to the exact desktop origin, covering both `/api` and dedicated Connection RPC routes; the capability never enters page JavaScript. Ordinary `dsh web` does not apply the overlay and retains its existing reachability-only behavior.

`apps/desktop-runtime` is a private, dependency-only pnpm workspace used solely as the desktop deployment root. Its manifest supplies the CLI and the workspace dependencies required by every shipped agent preset; its platform manifest selects the macOS arm64 and x64 native variants. The runtime-closure verifier rejects a workspace runtime or required peer dependency that this root cannot provide.

`prepare-runtime.mjs` uses pnpm's current `deploy --prod --frozen-lockfile` with `inject-workspace-packages` to stage an isolated production tree under the ignored `apps/desktop/runtime/` directory. The staging check permits pnpm's internal symlinks only when every link resolves within that directory; broken or escaping links fail the build. Electron Builder copies the verified tree to `Contents/Resources/dsh-runtime`, outside ASAR, so native executables and addons remain executable and the pnpm dependency layout remains resolvable.

This desktop release is a documented exception to the IPC direction in the [GUI layering decision](2026-07-19-gui-layering-and-rpc-protocol.md). It reuses the existing Web carrier so the same boot graph, dynamic client bundles, generic Typert routes, unary API validation, WebSocket streams, theme, and React components execute unchanged. A future IPC carrier remains possible through the existing client transport hooks, but it is not part of the shipped desktop application.

The window disables Node integration and WebView attachment, enables context isolation, Chromium sandboxing, and Web security, and restricts top-level navigation to the exact owned origin. New windows are denied; only HTTP and HTTPS targets may be handed to the system browser. Renderer permissions fail closed except sanitized clipboard writes from the main frame at that origin. The desktop response policy retains inline script and style execution because the current HTML boot injection and client bundle CSS require them. Host/Origin checks remain a separate DNS-rebinding and cross-site fence below the desktop capability check.

Application shutdown sends `SIGTERM` to the owned child and escalates to `SIGKILL` after five seconds. A bootstrap synchronously reads and closes the private launch pipe, removes `ELECTRON_RUN_AS_NODE`, and only then imports the CLI, so Host subprocesses inherit neither the descriptor nor Electron's Node-mode switch. Its parent watchdog exits the backend if Electron disappears without running normal shutdown. Startup failures and unexpected post-readiness exits are reported as native errors instead of leaving the Web client's reconnect loop running against a dead Host. The child starts with the user's home directory as its explicit working directory; project selection remains owned by the Web workspace UI.

Electron Builder produces architecture-specific DMG and ZIP targets for arm64 and x64. The DMG is the installation artifact; the ZIP, blockmaps, and `latest-mac.yml` are published beside it for `electron-updater`. A protected macOS workflow requires Developer ID signing and App Store Connect team-key notarization, verifies the app bundles and update artifacts, and creates a draft Release. Publishing that draft is the visibility boundary for automatic updates.

GitHub's updater provider resolves the repository-wide latest Release and does not filter releases by `desktop-v*`. While the fork `asherhancong/deepseek-harness` is the update repository, its Releases are therefore reserved for the desktop family. Publishing another release family there requires moving desktop updates to a dedicated repository first.

## Verification

Unit tests pin fragmented readiness parsing, refusal of near-match URLs, startup timeout and early exit diagnostics, bounded child shutdown, parent-loss handling, launch-environment scrubbing, desktop capability validation and route rejection, exact-origin navigation, and external scheme filtering. The workspace constraints test pins private desktop membership outside npm publication while retaining official-runtime dependency restrictions. Runtime checks pin the declared preset/platform closure and reject broken or escaping staged symlinks. Local unsigned checks cover the staged closure, application assembly, authenticated packaged-backend startup, and ZIP output. The local sandbox cannot give `hdiutil` the device access required to create a DMG, so DMG assembly is not claimed as local evidence; the tag workflow owns DMG creation, Developer ID, Gatekeeper, stapling, architecture, updater configuration, and update-manifest checks.

## Alternatives considered

**Load the Web distribution through `file://` and carry API traffic over IPC.** This remains the target when desktop-specific capabilities justify the transport. The current Host side still combines module discovery with Web routes, generic Typert registrations with HTTP adapters, and both event streams with WebSocket downlinks. Shipping IPC now would duplicate or split all of those mechanisms before installer behavior had an independently useful client feature.

**Choose a random loopback port on every launch.** This avoids collisions but changes the browser origin, which discards localStorage-backed drafts and presentation state between launches. A stable client must prefer a clear collision error over silent state loss.

**Run the Host composition inside Electron's main process.** In-process boot removes one child but couples Host crashes, global signal handlers, and long-running resource cleanup to the window process. A child gives the desktop owner a bounded lifecycle and preserves the installed CLI's real assembly path.

**Ship one universal application.** The runtime closure contains native executables and addons. Separate arm64 and x64 outputs keep the first release auditable and avoid merging incompatible native slices; a universal target can replace them after the complete closure has architecture coverage.

**Publish the desktop package with the npm application family.** npm publication does not distribute a signed `.app`, DMG, notarization ticket, or updater metadata. Independent desktop tags avoid forcing an installer release to share the CLI and Web package version.

## Consequences

The first desktop client is a thin native owner around the exact Web product, so UI behavior and client-plugin compatibility have one implementation. Process isolation makes startup and shutdown observable and bounded, and DMG installation plus signed GitHub updates have a dedicated release path.

The loopback server remains present while the application runs, but another local process needs the current launch's capability before it can reach the control API. Port `43121` becomes a local resource the application requires, and the renderer still depends on the Web transport's inline boot code and WebSocket behavior. The IPC transport reservation is unfulfilled, and migrating to it requires a separate decision that preserves generic RPC, stream cancellation, client bundle loading, security checks, and update compatibility.
