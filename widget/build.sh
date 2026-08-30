#!/bin/sh
# Build the Token Vision menu-bar widget. Requires Xcode Command Line Tools.
set -e
cd "$(dirname "$0")"
swiftc -O -o TokenVision TokenVisionWidget.swift
echo "built widget/TokenVision — run it with: ./widget/TokenVision &"
