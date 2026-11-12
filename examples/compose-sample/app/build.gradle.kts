// -Pslow=true builds the "before" app: 300 ms of main-thread work before the first screen, heavier rows.
plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "dev.doubletake.sample"
  compileSdk = 36
  defaultConfig {
    applicationId = "dev.doubletake.compose"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"
    buildConfigField("boolean", "SLOW", (findProperty("slow") == "true").toString())
  }
  buildFeatures {
    compose = true
    buildConfig = true
  }
  buildTypes {
    release {
      isMinifyEnabled = true
      signingConfig = signingConfigs.getByName("debug")
    }
  }
  sourceSets["main"].java.srcDir("../../../sdk/kotlin")
}

dependencies {
  val bom = platform("androidx.compose:compose-bom:2026.06.01")
  implementation(bom)
  implementation("androidx.activity:activity-compose:1.11.0")
  implementation("androidx.compose.foundation:foundation")
  implementation("androidx.compose.material3:material3")
}
