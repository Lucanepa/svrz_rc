buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        // 2.2, not Tauri's template 1.9.25 (2026-11-02): the UnifiedPush
        // libraries for phone notifications bring kotlin-stdlib 2.3, which a
        // 1.9 compiler cannot read (not even Tauri's own generated activity).
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.20")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

