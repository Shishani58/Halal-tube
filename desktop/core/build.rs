//! ONNX Runtime's CoreML provider uses `@available(...)`, which needs clang's runtime
//! (`__isPlatformVersionAtLeast`). rustc links with -nodefaultlibs, so add it explicitly.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
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
