plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.vixera.one.share"
    compileSdk = 34

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("proguard-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Tauri's Android runtime (Plugin, Invoke, JSObject, @Command). Copied into
    // ./.tauri/tauri-api by the plugin's build.rs when targeting Android.
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    // EncryptedSharedPreferences + MasterKey (Android Keystore) for secure_* commands.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
}
