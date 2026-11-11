//! ONNX Runtime's CoreML provider uses `@available(...)`, which needs clang's runtime
//! (`__isPlatformVersionAtLeast`). rustc links with -nodefaultlibs, so add it explicitly.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // system audio capture (Core Audio process tap, macOS 14.2+): a thin Objective-C layer
        println!("cargo:rerun-if-changed=src/mac/tap.m");
        println!("cargo:rerun-if-changed=src/mac/tap.h");
        cc::Build::new().file("src/mac/tap.m").flag("-fobjc-arc").flag("-Wno-unguarded-availability-new").flag("-Wno-unused-parameter").compile("mr_tap");
        // screen capture and the blur overlay for the "hide on screen" mode
        println!("cargo:rerun-if-changed=src/mac/screen.m");
        println!("cargo:rerun-if-changed=src/mac/screen.h");
        cc::Build::new().file("src/mac/screen.m").flag("-fobjc-arc").flag("-Wno-unguarded-availability-new").flag("-Wno-unused-parameter").compile("mr_screen");
        println!("cargo:rerun-if-changed=src/mac/window.m");
        println!("cargo:rerun-if-changed=src/mac/window.h");
        cc::Build::new().file("src/mac/window.m").flag("-fobjc-arc").flag("-Wno-unguarded-availability-new").flag("-Wno-unused-parameter").compile("mr_window");
        for f in ["Accelerate", "CoreImage", "ScreenCaptureKit", "AppKit", "CoreMedia", "CoreVideo", "CoreGraphics", "QuartzCore"] {
            println!("cargo:rustc-link-lib=framework={f}");
        }
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=Foundation");
        let out = std::process::Command::new("clang").arg("--print-runtime-dir").output();
        if let Ok(out) = out {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !dir.is_empty() {
                println!("cargo:rustc-link-search=native={dir}");
                println!("cargo:rustc-link-lib=static=clang_rt.osx");
            }
        }
    }
}
