#!/usr/bin/env bash
# Fetches the sherpa-onnx runtime (Apache-2.0) used for natural offline voices on Android:
# native libraries for the phone's processor types and the Kotlin API file, at a pinned version.
set -euo pipefail
V=1.12.14
mkdir -p /tmp/so app/src/main/java/com/k2fsa/sherpa/onnx
curl -fsSL -o /tmp/so.tar.bz2 "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$V/sherpa-onnx-v$V-android.tar.bz2"
tar xjf /tmp/so.tar.bz2 -C /tmp/so
for abi in ${ABIS:-arm64-v8a armeabi-v7a}; do
  mkdir -p app/src/main/jniLibs/$abi
  found=$(find /tmp/so -type d -name "$abi" | head -1)
  test -n "$found"
  cp "$found"/*.so app/src/main/jniLibs/$abi/
done
ls -la app/src/main/jniLibs/*
curl -fsSL -o app/src/main/java/com/k2fsa/sherpa/onnx/Tts.kt "https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v$V/sherpa-onnx/kotlin-api/Tts.kt"
