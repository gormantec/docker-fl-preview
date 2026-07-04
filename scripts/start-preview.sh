#!/bin/bash
# start-preview.sh — Boot script for per-user Flutter preview container
#
# Mounted volume: /workspace (NAS per-user dir, shared with designer container)
# The designer writes main.dart, screens/, etc. to /workspace/{PREVIEW_USER_HASH}/current/
# Flutter watches these files and hot-reloads on change.
#
# Self-healing features:
#   1. Watches pubspec.yaml → auto-runs flutter pub get on changes
#   2. Watches commands/ dir → executes .sh scripts (for agent-driven fixes)
#   3. Writes all Flutter output to logs/preview.log on NAS for agent monitoring
#   4. Crash loop detection — prevents infinite restart cycles

PORT=${PORT:-8080}
USER_HASH=${PREVIEW_USER_HASH:-default}
WORKSPACE=/workspace/$USER_HASH/current
LOGDIR=/workspace/$USER_HASH/logs
CMDDIR=/workspace/$USER_HASH/commands
CMDOUTDIR=/workspace/$USER_HASH/commands/output
CRASH_FILE=/workspace/$USER_HASH/.crash-state

echo "[fl-preview] Starting Flutter preview on port $PORT"
echo "[fl-preview] User hash: $USER_HASH"
echo "[fl-preview] Workspace: $WORKSPACE"

# Ensure directories exist
mkdir -p "$WORKSPACE" "$LOGDIR" "$CMDDIR" "$CMDOUTDIR"

# ═══════════════════════════════════════════════════════════════
# CRASH LOOP DETECTION — prevent infinite restart cycles
# ═══════════════════════════════════════════════════════════════
CRASH_WINDOW_SEC=300
MAX_CRASHES=5

now=$(date +%s)
crash_count=0
crash_first=0

if [ -f "$CRASH_FILE" ]; then
  read -r crash_first crash_count < "$CRASH_FILE" 2>/dev/null || true
fi

if [ "$crash_first" -gt 0 ] && [ $((now - crash_first)) -lt $CRASH_WINDOW_SEC ]; then
  crash_count=$((crash_count + 1))
else
  crash_first=$now
  crash_count=1
fi

echo "$crash_first $crash_count" > "$CRASH_FILE"

if [ "$crash_count" -gt "$MAX_CRASHES" ]; then
  echo "[fl-preview] ❌ CRASH LOOP DETECTED: $crash_count crashes in $(( (now - crash_first) / 60 ))min" | tee -a "$LOGDIR/preview.log"
  cat >> "$LOGDIR/preview.log" << SOSEOF
╔══════════════════════════════════════════════════════════════╗
║  SOS: Preview container crash loop detected!               ║
║  User: $USER_HASH                                          ║
║  Crashes: $crash_count in $(( (now - crash_first) / 60 ))min                         ║
║  Time: $(date -Iseconds)                                   ║
║  Delete $CRASH_FILE to allow restart.                      ║
╚══════════════════════════════════════════════════════════════╝
SOSEOF
  sleep 120
  exit 1
fi

echo "[fl-preview] Crash count: $crash_count/$MAX_CRASHES in window" | tee -a "$LOGDIR/preview.log"

# ── Helper: run flutter pub get with output to log ──
run_pub_get() {
  echo "[fl-preview] $(date -Iseconds) pubspec.yaml changed — running flutter pub get..." | tee -a "$LOGDIR/preview.log"
  cd "$WORKSPACE"
  if flutter pub get >> "$LOGDIR/preview.log" 2>&1; then
    echo "[fl-preview] $(date -Iseconds) flutter pub get OK" | tee -a "$LOGDIR/preview.log"
  else
    echo "[fl-preview] $(date -Iseconds) flutter pub get FAILED (exit $?)" | tee -a "$LOGDIR/preview.log"
  fi
}

# Create Flutter project if not already initialized
if [ ! -f "$WORKSPACE/pubspec.yaml" ]; then
  echo "[fl-preview] First boot: creating Flutter project..."
  cd "$WORKSPACE"

  # Create minimal Flutter project structure
  mkdir -p lib web

  cat > pubspec.yaml << 'YAMLEOF'
name: preview_app
description: Flutter preview app
publish_to: 'none'
version: 0.0.1

environment:
  sdk: '>=3.5.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter

flutter:
  uses-material-design: true
YAMLEOF

  cat > analysis_options.yaml << 'YAMLEOF'
include: package:flutter/analysis_options.yaml
linter:
  rules:
    prefer_const_constructors: false
    prefer_const_literals_to_create_immutables: false
YAMLEOF

  cat > web/index.html << 'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
HTMLEOF

  cat > web/manifest.json << 'JSONEOF'
{"name":"Preview","short_name":"Preview","start_url":".","display":"standalone","background_color":"#0175C2","theme_color":"#0175C2","description":"Flutter preview app"}
JSONEOF
fi

# Write placeholder main.dart if none exists
if [ ! -f "$WORKSPACE/lib/main.dart" ]; then
  echo "[fl-preview] Writing placeholder main.dart..."
  mkdir -p "$WORKSPACE/lib"
  cat > "$WORKSPACE/lib/main.dart" << 'DARTEOF'
import 'package:flutter/material.dart';

void main() {
  runApp(const PreviewApp());
}

class PreviewApp extends StatelessWidget {
  const PreviewApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Preview',
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF0972D3),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(color: Color(0xFF0972D3)),
            const SizedBox(height: 16),
            Text(
              'Preview Ready',
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Add widgets to the canvas to see them here.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: const Color(0xFF8D99A8),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
DARTEOF
fi

# ═══════════════════════════════════════════════════════════════
# BACKGROUND PROCESS 1: Watch pubspec.yaml → auto flutter pub get
# Uses stat-based polling (no inotify-tools dependency)
# ═══════════════════════════════════════════════════════════════
(
  echo "[fl-preview] pubspec.yaml watcher started (pid $$)"
  pkg_file="$WORKSPACE/pubspec.yaml"
  last_mtime=$(stat -c %Y "$pkg_file" 2>/dev/null || echo 0)
  while true; do
    sleep 3
    curr_mtime=$(stat -c %Y "$pkg_file" 2>/dev/null || echo 0)
    if [ "$curr_mtime" != "$last_mtime" ] && [ "$curr_mtime" != "0" ]; then
      sleep 1  # debounce
      run_pub_get
      last_mtime=$curr_mtime
    fi
  done
) &
WATCHER_PID=$!

# ═══════════════════════════════════════════════════════════════
# BACKGROUND PROCESS 2: Watch commands/ dir → exec .sh scripts
# Uses polling (no inotify-tools dependency)
# ═══════════════════════════════════════════════════════════════
(
  echo "[fl-preview] command executor started (pid $$)"
  while true; do
    sleep 2
    for script in "$CMDDIR"/*.sh; do
      [ -f "$script" ] || continue
      script_name=$(basename "$script")
      OUTFILE="$CMDOUTDIR/${script_name%.sh}.out"
      echo "[fl-preview] $(date -Iseconds) Executing: $script_name" | tee -a "$LOGDIR/preview.log"
      chmod +x "$script"
      cd "$WORKSPACE"
      if bash "$script" > "$OUTFILE" 2>&1; then
        echo "[fl-preview] $(date -Iseconds) $script_name OK (exit 0)" | tee -a "$LOGDIR/preview.log"
        echo "EXIT_CODE=0" >> "$OUTFILE"
      else
        rc=$?
        echo "[fl-preview] $(date -Iseconds) $script_name FAILED (exit $rc)" | tee -a "$LOGDIR/preview.log"
        echo "EXIT_CODE=$rc" >> "$OUTFILE"
      fi
      mkdir -p "$CMDDIR/archive"
      mv "$script" "$CMDDIR/archive/${script_name}.$(date +%s).done"
    done
  done
) &
CMDEXEC_PID=$!

# ═══════════════════════════════════════════════════════════════
# MAIN PROCESS: Flutter web-server → logs to NAS + Docker stdout
# ═══════════════════════════════════════════════════════════════
echo "[fl-preview] Starting Flutter web-server (logs → $LOGDIR/preview.log)..."
cd "$WORKSPACE"

# Run Flutter, tee output to both Docker stdout and NAS log file
exec flutter run -d web-server --web-port "$PORT" --web-hostname 0.0.0.0 2>&1 | tee -a "$LOGDIR/preview.log"
