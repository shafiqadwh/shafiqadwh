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
        // 1.1 = แก้อาการติดแหง็กอยู่กับไอพีในวง LAN เมื่อทีวีต่อเน็ตมือถือ
        // เลขนี้ดูได้ที่ Settings → Apps → Wedding Slideshow บนทีวี ใช้ยืนยันว่าลง APK ใหม่แล้วจริง
        versionCode = 2
        versionName = "1.1"
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
