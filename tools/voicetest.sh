#!/usr/bin/env bash
# Called by the Voice test workflow inside the emulator runner.
set -u
model="${1:-kokoro-int8-en-v0_19}"
mode="${2:-voice}"
adb install -r "${APK:-app/build/outputs/apk/debug/app-debug.apk}"
adb logcat -G 16M || true
adb logcat -c
if [ "$mode" = "read" ]; then
  v="default"; [ "$model" != "default" ] && v="neural:$model:0"
  adb shell am start -S -n com.shelfreader/.MainActivity --es selftest_read "$v"
else
  adb shell am start -S -n com.shelfreader/.MainActivity --es selftest_voice "$model"
fi
for i in $(seq 330); do
  sleep 5
  if adb logcat -d | grep -qE "SELFTEST DONE OK|SELFTEST FAILED|Process: com.shelfreader|>>> com.shelfreader <<<|Process com.shelfreader .*has died|Killing .*com.shelfreader"; then sleep 8; break; fi
done
adb logcat -d > all.log || true
grep -E "ShelfSelfTest|ShelfReader|AndroidRuntime|DEBUG  |sherpa|onnx|FATAL|Fatal signal|backtrace|#[0-9][0-9] pc|lowmemorykiller.*shelfreader|com.shelfreader.*(died|Killing)|Process: com.shelfreader" all.log | grep -v StrictMode | tail -400 > voicetest.log
tail -60 voicetest.log
true
