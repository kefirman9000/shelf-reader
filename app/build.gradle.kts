plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    testOptions { unitTests.isReturnDefaultValues = true }
    namespace = "com.shelfreader"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.shelfreader"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // A fixed key so new builds install over old ones without losing your library.
    // On GitHub it comes from the repository's secrets (SHELF_KEYSTORE / SHELF_KEYSTORE_PASSWORD, set up by the
    // build workflow). Without them, the older key file in this folder is used, or Android's own debug key.
    val ksPath = System.getenv("SHELF_KEYSTORE")?.takeIf { it.isNotBlank() }
    val ksFile = if (ksPath != null) file(ksPath) else file("shelf.keystore")
    val ksPass = if (ksPath != null) System.getenv("SHELF_KEYSTORE_PASSWORD") ?: "" else "shelfreader"
    val ksAlias = System.getenv("SHELF_KEY_ALIAS")?.takeIf { it.isNotBlank() } ?: "shelf"
    signingConfigs {
        if (ksFile.exists()) create("shared") {
            storeFile = ksFile
            storePassword = ksPass
            keyAlias = ksAlias
            keyPassword = ksPass
        }
    }

    buildTypes {
        getByName("debug") {
            if (ksFile.exists()) signingConfig = signingConfigs.getByName("shared")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = if (ksFile.exists()) signingConfigs.getByName("shared") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("com.tom-roush:pdfbox-android:2.0.27.0")
    // unpacks the downloaded voice models (.tar.bz2)
    implementation("org.apache.commons:commons-compress:1.27.1")
    testImplementation("junit:junit:4.13.2")
}
