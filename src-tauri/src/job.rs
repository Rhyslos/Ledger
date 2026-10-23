//! Children die with Ledger. On Windows a program's child processes keep running when the program
//! ends, so a crash, a kill from Task Manager or an update would leave language servers, dev
//! servers, shells and test runs behind. Every process Ledger starts joins one Job Object that
//! ends them all when Ledger's handle to it closes, which Windows does however Ledger ends.
//! (Programs those processes start join too.) Elsewhere this does nothing.

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    struct Job(HANDLE);
    // The handle is only used through thread-safe Win32 calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            // Breakaway stays allowed: a browser Ledger opens can outlive it.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(h);
                return None;
            }
            Some(Job(h))
        })
        .as_ref()
        .map(|j| j.0)
    }

    pub fn adopt(pid: u32) {
        let Some(j) = job() else { return };
        unsafe {
            let p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !p.is_null() {
                AssignProcessToJobObject(j, p);
                CloseHandle(p);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn adopt(_pid: u32) {}
}

/// Puts a process Ledger just started into Ledger's job, so it ends when Ledger does.
pub fn adopt(pid: u32) {
    imp::adopt(pid)
}
