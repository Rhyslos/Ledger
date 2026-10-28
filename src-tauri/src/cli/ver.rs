//! Version numbers from crates.io, npm and NuGet, compared the way their tools do (near enough):
//! numbers part by part (1.2 == 1.2.0), a pre-release (1.0.0-rc.1) before its release, and
//! build metadata (+abc) ignored.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ver {
    pub nums: Vec<u64>,
    pub pre: String,
}

pub fn parse(s: &str) -> Option<Ver> {
    let s = s.trim().trim_start_matches(['v', 'V', '=']);
    let s = s.split('+').next()?;
    let (core, pre) = match s.find('-') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let nums: Option<Vec<u64>> = core.split('.').map(|p| p.parse().ok()).collect();
    let nums = nums.filter(|n| !n.is_empty())?;
    Some(Ver { nums, pre: pre.to_string() })
}

fn cmp_pre(a: &str, b: &str) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    let (mut x, mut y) = (a.split('.'), b.split('.'));
    loop {
        match (x.next(), y.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) => {
                let o = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    _ => p.to_ascii_lowercase().cmp(&q.to_ascii_lowercase()),
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
        }
    }
}

impl Ord for Ver {
    fn cmp(&self, o: &Self) -> Ordering {
        let n = self.nums.len().max(o.nums.len());
        for i in 0..n {
            let c = self.nums.get(i).unwrap_or(&0).cmp(o.nums.get(i).unwrap_or(&0));
            if c != Ordering::Equal {
                return c;
            }
        }
        cmp_pre(&self.pre, &o.pre)
    }
}
impl PartialOrd for Ver {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Compares two version strings; ones that aren't versions sort as text, before real versions.
pub fn cmp(a: &str, b: &str) -> Ordering {
    match (parse(a), parse(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        _ => a.cmp(b),
    }
}

pub fn is_pre(s: &str) -> bool {
    parse(s).map(|v| !v.pre.is_empty()).unwrap_or(false)
}

/// The part that marks breaking changes: the major number, or for 0.x the minor (0.3 → 0.4
/// breaks, as Cargo and npm's ^ treat it). [major, minor] for 0.x, [major] otherwise.
fn breaking(v: &Ver) -> Vec<u64> {
    let m = v.nums.first().copied().unwrap_or(0);
    if m == 0 {
        vec![0, v.nums.get(1).copied().unwrap_or(0)]
    } else {
        vec![m]
    }
}

/// Whether moving from `from` to `to` keeps within the same breaking part (a safe update).
pub fn compatible(from: &str, to: &str) -> bool {
    match (parse(from), parse(to)) {
        (Some(a), Some(b)) => breaking(&a) == breaking(&b),
        _ => false,
    }
}

/// The newest version in `all` (stable ones, unless `pre`), and the newest compatible with `cur`.
pub fn newest<'a>(all: &'a [String], cur: &str, pre: bool) -> (Option<&'a String>, Option<&'a String>) {
    let ok = |v: &&String| pre || !is_pre(v);
    let best = all.iter().filter(ok).max_by(|a, b| cmp(a, b));
    let compat = all.iter().filter(ok).filter(|v| compatible(cur, v)).max_by(|a, b| cmp(a, b));
    (best, compat)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn order() {
        assert_eq!(cmp("1.2", "1.2.0"), Ordering::Equal);
        assert_eq!(cmp("1.10.0", "1.9.9"), Ordering::Greater);
        assert_eq!(cmp("1.0.0-rc.1", "1.0.0"), Ordering::Less);
        assert_eq!(cmp("1.0.0-alpha.2", "1.0.0-alpha.10"), Ordering::Less);
        assert_eq!(cmp("1.0.0-alpha", "1.0.0-beta"), Ordering::Less);
        assert_eq!(cmp("2.0.0+build", "2.0.0"), Ordering::Equal);
        assert_eq!(cmp("6.0.0.1", "6.0.0"), Ordering::Greater);
    }
    #[test]
    fn breaking_changes() {
        assert!(compatible("1.2.3", "1.9.0"));
        assert!(!compatible("1.2.3", "2.0.0"));
        assert!(compatible("0.3.1", "0.3.9"));
        assert!(!compatible("0.3.1", "0.4.0"));
        let all: Vec<String> = ["1.0.0", "1.4.0", "2.0.0", "2.1.0-beta"].iter().map(|s| s.to_string()).collect();
        let (best, compat) = newest(&all, "1.0.0", false);
        assert_eq!((best.map(|s| s.as_str()), compat.map(|s| s.as_str())), (Some("2.0.0"), Some("1.4.0")));
    }
}
