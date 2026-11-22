# Shrinks unused library code but keeps names, so crash reports stay readable.
-dontobfuscate

# the app itself (views and services are found by name; nothing here is large)
-keep class com.shelfreader.** { *; }
# natural voices: the native engine calls back into these classes by name
-keep class com.k2fsa.** { *; }
# PDF reading and voice unpacking load parts of themselves by name
-keep class com.tom_roush.** { *; }
-keep class org.apache.commons.compress.** { *; }

# optional parts of those libraries that the app doesn't use
-dontwarn com.gemalto.jp2.**
-dontwarn org.tukaani.xz.**
-dontwarn com.github.luben.zstd.**
-dontwarn org.brotli.dec.**
-dontwarn org.objectweb.asm.**
-dontwarn org.osgi.**
-dontwarn javax.**
-dontwarn java.awt.**
-dontwarn org.bouncycastle.**

# anything else the shrinker would complain about is optional too: warn, don't fail the build
-ignorewarnings
