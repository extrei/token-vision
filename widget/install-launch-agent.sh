#!/bin/sh
# Install (or refresh) a per-user LaunchAgent that starts the Token Vision
# menu-bar widget at login and keeps it running.
#
#   sh widget/install-launch-agent.sh            # install + start now
#   sh widget/install-launch-agent.sh --remove   # stop + uninstall
#
# Paths are derived from this script's location, so run it from the checkout
# you want launchd to use. Re-run after moving the repo or rebuilding the
# binary is not required (launchd re-reads the binary on each start), but
# re-run after moving the checkout so the plist points at the new path.
set -e

label="io.token-vision.widget"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
bin="$here/TokenVision"
plist="$HOME/Library/LaunchAgents/$label.plist"
logdir="$HOME/Library/Logs/TokenVision"
domain="gui/$(id -u)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed $label (widget stopped; plist deleted)"
  exit 0
fi

[ -x "$bin" ] || { echo "no binary at $bin — run: sh widget/build.sh" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$logdir"

# Homebrew's node must be reachable; the app also runs its streamer through a
# login shell, but launchd's own environment is minimal, so spell PATH out.
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bin</string>
    <string>$repo/src/live-usage.js</string>
  </array>
  <key>WorkingDirectory</key><string>$repo</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Relaunch after a crash, but not after Quit from the menu (exit 0). -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$logdir/widget.log</string>
  <key>StandardErrorPath</key><string>$logdir/widget.err.log</string>
</dict>
</plist>
PLIST

# A manually started widget would run alongside launchd's; hand over.
pkill -f "$bin" 2>/dev/null || true
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
echo "installed $label -> $plist"
echo "widget starts at login and is running now; quit from its menu, or remove with: sh $0 --remove"
