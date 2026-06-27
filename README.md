# Flutter Preview Container

Per-user Flutter live preview. Started as a Docker Swarm service by the Flutter Designer.

## How It Works

1. Designer detects a new user → creates Swarm service `fl-pv-<userIdHash>` with this image
2. Container boots → writes placeholder main.dart → starts `flutter run -d web-server`
3. Designer writes canvas changes to shared NAS volume at `/workspace/`
4. Flutter's hot-reload detects changes → updates in <1s
5. User idle 20min → sweeper removes service

## Architecture

Same pattern as `docker-rn-preview` — shared NAS volume, file-watch hot-reload.

## Port

- **8080** — Flutter web-server

## Build

```bash
npm run build:image-force
```
