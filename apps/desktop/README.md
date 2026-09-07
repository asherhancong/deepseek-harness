# DSH Desktop

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` is the private Electron assembly for the signed macOS application. It presents the same client bundle graph, React components, theme tokens, and Web UI behavior as `dsh web`; this package is distributed through GitHub Releases rather than npm.

## Runtime model

The Electron main process starts the staged standalone `dsh web` runtime on the fixed loopback origin `http://127.0.0.1:43121`, waits for that owned child to print its exact readiness line, and then opens the URL in a hardened `BrowserWindow`. A fixed origin preserves browser-local drafts and appearance state across launches. A port collision fails startup instead of attaching to an unrelated process. Each launch also creates a fresh 256-bit capability: Electron injects it into HTTP and WebSocket requests to that exact desktop origin. Connection verifies it before serving the index, dispatching API requests, or opening the Gateway's `/api/remote.mux` WebSocket. Desktop launches use a clean URL and require no browser-token exchange or persistent authentication cookie; ordinary `dsh web` retains its browser authentication.

The CLI child inherits the user's home directory as its initial working directory. Workspace selection in the UI remains the authoritative way to choose project directories. A desktop bootstrap reads the capability once from a private anonymous pipe, closes that descriptor, and removes Electron's Node-mode switch before the Host can create subprocesses. Quitting the application sends `SIGTERM` to the child and escalates to `SIGKILL` after the CLI's five-second shutdown budget; a parent watchdog also terminates an orphaned Host after an abnormal Electron exit.

## Development

Build the official Host and Web artifacts before launching Electron:

```sh
pnpm run dev:desktop
```

Build unsigned local macOS installers with:

```sh
pnpm run dist:desktop
```

`apps/desktop-runtime` is a private, dependency-only deploy root for the packaged CLI. The staging script verifies its runtime and platform closure, runs pnpm's current production deploy with workspace-package injection and the frozen lockfile, and writes the result under the ignored `apps/desktop/runtime/` directory. The pnpm tree may retain internal symlinks, but staging rejects every broken link or target outside that directory. Electron Builder copies the verified tree outside the application's ASAR so native tools remain executable.

On an ordinary macOS host with working `hdiutil`, the command writes unsigned architecture-specific DMG and ZIP outputs under `apps/desktop/release/`. A restricted sandbox without `hdiutil` device access cannot complete the DMG target; successful `.app` or ZIP checks there are not evidence that a DMG was created. Gatekeeper distribution and automatic updates require the signed release workflow.

## Distribution

Desktop versions are independent of the npm `dsh-v*` release family. A `desktop-vX.Y.Z` tag whose version matches this package starts `.github/workflows/desktop-release.yml`; the workflow signs and notarizes both architecture builds and creates a draft GitHub Release.

`electron-updater` resolves the repository-wide latest GitHub Release rather than filtering by tag prefix. While updates are published from `asherhancong/deepseek-harness`, that fork's Releases must therefore be reserved for `desktop-v*` releases. Move the updater to a dedicated release repository before publishing any unrelated Release there.

| Artifact | Consumer |
|---|---|
| `DSH-<version>-arm64.dmg` / `DSH-<version>-x64.dmg` | User installation |
| Architecture-matched ZIP and blockmap files | `electron-updater` payload and differential metadata |
| `latest-mac.yml` | Automatic-update lookup, architecture selection, and checksums |

The protected `desktop-release` environment needs `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Store the Developer ID Application `.p12` and App Store Connect `.p8` as base64 in the two file-content secrets. The workflow leaves the Release as a draft; automatic update clients see it only after a maintainer publishes it.

## Security

The renderer has no Node integration, uses context isolation and Chromium sandboxing, and may navigate only within the owned loopback origin. New windows are denied; HTTP and HTTPS links open in the system browser. Permission requests fail closed except the main frame's sanitized clipboard write used by the Web UI copy action. The desktop-only response policy keeps the inline script and style allowances required by the existing module boot and dynamic CSS pipeline. The per-launch capability is owned by the Electron session and Host bootstrap; it is absent from renderer JavaScript, process arguments, environment variables, and disk, and the launch pipe is closed before Host subprocesses can inherit it. The capability check supplements the existing Host/Origin browser-trust fence, so another local process cannot use loopback reachability alone as authorization.

## Limitations

The first macOS distribution uses the Web carrier over a loopback child process, not `file://` plus IPC. The [desktop distribution decision](../../.agents/notes/implemented/architecture/2026-08-27-macos-electron-desktop-distribution.md) records why the initial release preserves the existing plugin-bundle, Typert, and bidirectional event transports. Electron 44 requires macOS 13 or newer. The fixed port means another listener on `43121` prevents startup and must be stopped before DSH Desktop can run.
