plugins {
    id("com.android.application")
}

android {
    namespace = "com.shafiqadwh.weddingslideshow"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.shafiqadwh.weddingslideshow"
        // Android 5.0 — ครอบ Google TV และกล่อง Android TV เก่า ๆ ที่ยังใช้กันอยู่
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
