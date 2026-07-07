# Docker Flutter Preview — Per-user Flutter live preview container
# Node.js file-server proxies to Flutter web dev server + provides file API.

FROM ghcr.io/gormantec/flutter-base:latest
WORKDIR /usr/src/app

# Workspace will be mounted at runtime: /workspace → NAS per-user dir
RUN mkdir -p /workspace /workspace/logs /workspace/commands

COPY src/ /usr/src/app/src/
COPY scripts/ /usr/src/app/scripts/
RUN chmod +x /usr/src/app/scripts/*.sh 2>/dev/null || true

ENV PREVIEW_PORT=8080
ENV FILE_API_PORT=9091
EXPOSE 8080 9091

# Start Node.js file-server (file API 9091 + reverse proxy 8080 → Flutter 8081)
CMD ["node", "/usr/src/app/src/file-server.mjs"]
