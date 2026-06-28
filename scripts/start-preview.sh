#!/bin/bash
# start-preview.sh — Boot script for per-user Flutter preview container
#
# Mounted volume: /workspace (NAS per-user dir, shared with designer container)
# The designer writes main.dart, screens/, etc. to /workspace/{PREVIEW_USER_HASH}
# Flutter watches these files and hot-reloads on change

set -e

PORT=${PORT:-8080}
USER_HASH=${PREVIEW_USER_HASH:-default}
WORKSPACE=/workspace/$USER_HASH/current

echo "[fl-preview] Starting Flutter preview on port $PORT"
echo "[fl-preview] User hash: $USER_HASH"
echo "[fl-preview] Workspace: $WORKSPACE"

# Ensure workspace exists
mkdir -p "$WORKSPACE"

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

echo "[fl-preview] Starting Flutter web-server..."
cd "$WORKSPACE"

# Start Flutter web dev server — hot-reloads on file changes
exec flutter run -d web-server --web-port "$PORT" --web-hostname 0.0.0.0
