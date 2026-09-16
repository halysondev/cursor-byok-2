mod desktop;
#[cfg(not(dev))]
mod frontend;
mod resource_limits;
mod startup;
mod tray;
mod update;

// mimalloc proactively returns freed memory to the OS, avoiding glibc's
// retained pages that would keep RSS from falling back to the silent-start level.
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub fn run() -> std::process::ExitCode {
    if let Some(exit_code) = update::run_replacement_if_requested() {
        return exit_code;
    }
    desktop::run()
}
