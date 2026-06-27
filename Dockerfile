# Docker Flutter Preview — Per-user Flutter live preview container

FROM ghcr.io/gormantec/flutter-base:latest
WORKDIR /usr/src/app

# Install bash + curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends bash curl && \
    rm -rf /var/lib/apt/lists/*

# Workspace will be mounted at runtime: /workspace → NAS per-user dir
RUN mkdir -p /workspace

COPY scripts/ /usr/src/app/scripts/
RUN chmod +x /usr/src/app/scripts/start-preview.sh

ENV PORT=8080
EXPOSE 8080

# Start Flutter web dev server, watching /workspace for changes
CMD ["/usr/src/app/scripts/start-preview.sh"]
