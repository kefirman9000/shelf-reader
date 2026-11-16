#!/usr/bin/env bash
# Called by the Voice test workflow inside the emulator runner.
set -u
model="${1:-kokoro-int8-en-v0_19}"
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
adb shell am start -n com.shelfreader/.MainActivity --es selftest_voice "$model"
for i in $(seq 160); do
  sleep 5
  if adb logcat -d | grep -qE "SELFTEST DONE OK|SELFTEST FAILED|Process: com.shelfreader|>>> com.shelfreader <<<|Process com.shelfreader .*has died|Killing .*com.shelfreader"; then sleep 8; break; fi
done
adb logcat -d > all.log || true
grep -E "ShelfSelfTest|AndroidRuntime|DEBUG  |sherpa|onnx|FATAL|Fatal signal|backtrace|#[0-9][0-9] pc|lowmemorykiller.*shelfreader|com.shelfreader.*(died|Killing)|Process: com.shelfreader" all.log | grep -v StrictMode | tail -400 > voicetest.log
tail -60 voicetest.log
true
